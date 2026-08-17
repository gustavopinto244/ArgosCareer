import { z } from "zod";
import { Posting, Seniority } from "../../posting/domain/posting";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { hashExtractionInput } from "../domain/extraction-input-hash";
import { htmlToText } from "../domain/html-to-text";
import { truncateDescription } from "../domain/text-truncation";
import { Requirement } from "../domain/types";
import { AskModel, parseModelOutputWithRetries } from "./llm-output";
import { buildStageAPrompt, STAGE_A_PROMPT_VERSION } from "./prompts";

/**
 * A real extracted requirement is a short phrase ("Cursando Ciência da
 * Computação", "Inglês intermediário"); 500 chars is generous enough for the
 * longest legitimate one while still bounding the worst case (docs/audit
 * AC-017 / PR-010). Capping array length alone (`DEFAULT_MAX_REQUIREMENTS_PER_POSTING`)
 * leaves each element's size unbounded, which still lets a single
 * requirement blow up Stage B's per-requirement prompt (`REQUIREMENT_TEXT`,
 * `prompts.ts`) and the log label built from it (`stage-b-matcher.ts`).
 */
export const MAX_REQUIREMENT_TEXT_CHARS = 500;
export const MAX_REQUIREMENT_CATEGORY_CHARS = 100;

const RequirementSchema = z.object({
  text: z.string().min(1).max(MAX_REQUIREMENT_TEXT_CHARS),
  category: z.string().min(1).max(MAX_REQUIREMENT_CATEGORY_CHARS),
  weight: z.enum(["blocking", "mandatory", "desirable"]),
  /**
   * ADR-015. Defaulted rather than required: a model that omits the field is
   * not producing invalid output, and the default is the conservative
   * reading — marking a requirement unverifiable removes it from scoring, so
   * silence must not be able to delete requirements.
   */
  verifiable: z.boolean().default(true),
});

const SENIORITY_VALUES = [
  "internship",
  "trainee",
  "junior",
  "mid",
  "senior",
] as const;

/**
 * A real posting extracts to somewhere between a handful and ~15
 * requirements; 40 is a safety ceiling against a degenerate or adversarial
 * model output, not a realistic legitimate count (docs/audit AC-017 —
 * "definir limite de requirements por posting"). Bounded via the schema
 * itself, not a separate check: an over-limit array is `invalid_output`,
 * which routes through the retry/repair budget and, if the model keeps
 * overproducing, into the review section exactly like any other extraction
 * that never validated (ADR-006) — no separate chunking/quarantine
 * machinery needed, because that path already exists and already does the
 * right thing.
 */
export const DEFAULT_MAX_REQUIREMENTS_PER_POSTING = 40;

/**
 * A rough, deliberately generous char-based proxy for a token budget — this
 * project has no tokenizer dependency (docs/audit AC-017), and a real
 * Stage A description is a few KB at most (measured against Sólides'
 * richest fixture, ~5KB of real markup). 12,000 characters leaves ample
 * headroom while still bounding the worst case: a pathological or
 * adversarial description cannot make a single Stage A call arbitrarily
 * expensive or slow.
 */
export const DEFAULT_MAX_DESCRIPTION_CHARS = 12_000;

function buildExtractionOutputSchema(maxRequirements: number) {
  return z.object({
    requirements: z.array(RequirementSchema).max(maxRequirements),
    seniority: z.enum(SENIORITY_VALUES).nullable(),
    experienceYears: z.number().int().nonnegative().nullable(),
  });
}

export type ExtractionResult =
  | {
      readonly ok: true;
      readonly requirements: readonly Requirement[];
      readonly seniority: Seniority | null;
      readonly experienceYears: number | null;
      /** True when the posting's description had to be cut to fit
       * `maxDescriptionChars` (docs/audit AC-017) — the model saw less than
       * the real posting said. Always present, never silent. */
      readonly inputTruncated: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "extraction_failed";
      readonly attempts: number;
    };

/**
 * Stage A (docs/04-scoring-model.md, v2 prompt: `05-domain-model.md`'s
 * seniority/experienceYears fields): reads a posting's title and
 * description, returns its declared requirements plus its stated seniority
 * level. Cached whole by `(fingerprint, promptVersion, contentHash)`
 * (ADR-007, docs/audit AC-006) — a cache hit never calls the model at all,
 * which is what makes re-matching across many M7 configurations
 * affordable. `contentHash` (`hashExtractionInput`) is what makes the
 * cache correct rather than merely fast: `fingerprint` alone does not
 * change when a company edits a posting's description, so without it a
 * re-collected posting with new requirement text kept serving the
 * extraction of the old text.
 */
export class StageAExtractor {
  private readonly outputSchema: ReturnType<typeof buildExtractionOutputSchema>;

  constructor(
    private readonly ask: AskModel,
    private readonly extractionsRepo: ExtractionsRepository,
    private readonly promptVersion: string = STAGE_A_PROMPT_VERSION,
    /** Which model `ask` actually calls (docs/audit AC-007) — part of the
     * cache key so switching `LLM_MODEL` cannot silently reuse a different
     * model's extraction. Defaulted for tests that do not care about model
     * identity; `build-scorer.ts` always passes the real configured value. */
    private readonly model: string = "unknown",
    /** docs/audit AC-017 — bounds the description sent to the model, not a
     * scoring-output config: an engineering safety limit, the same kind of
     * default `OpenRouterClientOptions.timeoutMs` is, not a `criteria.yaml`
     * knob. */
    private readonly maxDescriptionChars: number = DEFAULT_MAX_DESCRIPTION_CHARS,
    maxRequirementsPerPosting: number = DEFAULT_MAX_REQUIREMENTS_PER_POSTING,
  ) {
    this.outputSchema = buildExtractionOutputSchema(maxRequirementsPerPosting);
  }

  async extract(
    posting: Posting,
    now: () => Date = () => new Date(),
  ): Promise<ExtractionResult> {
    // Normalized and bounded before anything else touches it -- the content
    // hash, the cache lookup, and the prompt itself all see exactly the same
    // text, which is what makes `inputTruncated` an honest fact about what
    // the model actually received rather than about the raw posting
    // (docs/audit AC-017).
    const normalizedTitle = htmlToText(posting.title).text;
    let normalizedDescription: string | null = null;
    let inputTruncated = false;
    if (posting.description) {
      const { text } = htmlToText(posting.description);
      const bounded = truncateDescription(text, this.maxDescriptionChars);
      normalizedDescription = bounded.text;
      inputTruncated = bounded.truncated;
    }

    const contentHash = hashExtractionInput(
      normalizedTitle,
      normalizedDescription,
    );
    const cached = this.extractionsRepo.find(
      posting.fingerprint,
      this.promptVersion,
      this.model,
      contentHash,
    );
    if (cached) {
      return {
        ok: true,
        requirements: cached.requirements,
        seniority: cached.seniority,
        experienceYears: cached.experienceYears,
        inputTruncated,
      };
    }

    // No description is not something the model can extract requirements
    // from — asking it anyway costs a call to be told what we already know.
    // Deliberately still not cached, even though contentHash would now
    // correctly distinguish "no description" from any later real one
    // (AC-006 fixed the staleness case this comment used to warn about):
    // writing a row for a result derivable from `!posting.description`
    // alone is pure overhead, not a correctness need.
    if (!normalizedDescription?.trim()) {
      return {
        ok: true,
        requirements: [],
        seniority: null,
        experienceYears: null,
        inputTruncated: false,
      };
    }

    // Building the prompt reads the template off disk, so it can fail for
    // reasons that have nothing to do with the model — and until now it did
    // so by throwing straight through `ApiScorer.score`, which promises the
    // opposite. `attempts: 0` is literal: the model was never asked.
    let prompt: string;
    try {
      prompt = buildStageAPrompt(normalizedTitle, normalizedDescription);
    } catch {
      return { ok: false, reason: "extraction_failed", attempts: 0 };
    }

    const result = await parseModelOutputWithRetries(
      this.outputSchema,
      this.ask,
      prompt,
      { operationLabel: `stage-a:${posting.fingerprint}` },
    );

    if (!result.ok) {
      return {
        ok: false,
        reason: "extraction_failed",
        attempts: result.attempts,
      };
    }

    this.extractionsRepo.upsert(
      posting.fingerprint,
      this.promptVersion,
      this.model,
      contentHash,
      result.data,
      now(),
    );
    return { ok: true, ...result.data, inputTruncated };
  }
}

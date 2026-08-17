import { z } from "zod";
import { Posting, Seniority } from "../../posting/domain/posting";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { hashExtractionInput } from "../domain/extraction-input-hash";
import { Requirement } from "../domain/types";
import { AskModel, parseModelOutputWithRetries } from "./llm-output";
import { buildStageAPrompt, STAGE_A_PROMPT_VERSION } from "./prompts";

const RequirementSchema = z.object({
  text: z.string().min(1),
  category: z.string().min(1),
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

const ExtractionOutputSchema = z.object({
  requirements: z.array(RequirementSchema),
  seniority: z.enum(SENIORITY_VALUES).nullable(),
  experienceYears: z.number().int().nonnegative().nullable(),
});

export type ExtractionResult =
  | {
      readonly ok: true;
      readonly requirements: readonly Requirement[];
      readonly seniority: Seniority | null;
      readonly experienceYears: number | null;
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
  constructor(
    private readonly ask: AskModel,
    private readonly extractionsRepo: ExtractionsRepository,
    private readonly promptVersion: string = STAGE_A_PROMPT_VERSION,
    /** Which model `ask` actually calls (docs/audit AC-007) — part of the
     * cache key so switching `LLM_MODEL` cannot silently reuse a different
     * model's extraction. Defaulted for tests that do not care about model
     * identity; `build-scorer.ts` always passes the real configured value. */
    private readonly model: string = "unknown",
  ) {}

  async extract(
    posting: Posting,
    now: () => Date = () => new Date(),
  ): Promise<ExtractionResult> {
    const contentHash = hashExtractionInput(posting.title, posting.description);
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
      };
    }

    // No description is not something the model can extract requirements
    // from — asking it anyway costs a call to be told what we already know.
    // Deliberately still not cached, even though contentHash would now
    // correctly distinguish "no description" from any later real one
    // (AC-006 fixed the staleness case this comment used to warn about):
    // writing a row for a result derivable from `!posting.description`
    // alone is pure overhead, not a correctness need.
    if (!posting.description?.trim()) {
      return {
        ok: true,
        requirements: [],
        seniority: null,
        experienceYears: null,
      };
    }

    // Building the prompt reads the template off disk, so it can fail for
    // reasons that have nothing to do with the model — and until now it did
    // so by throwing straight through `ApiScorer.score`, which promises the
    // opposite. `attempts: 0` is literal: the model was never asked.
    let prompt: string;
    try {
      prompt = buildStageAPrompt(posting.title, posting.description);
    } catch {
      return { ok: false, reason: "extraction_failed", attempts: 0 };
    }

    const result = await parseModelOutputWithRetries(
      ExtractionOutputSchema,
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
    return { ok: true, ...result.data };
  }
}

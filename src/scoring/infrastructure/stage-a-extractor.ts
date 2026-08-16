import { z } from "zod";
import { Posting, Seniority } from "../../posting/domain/posting";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
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
 * level. Cached whole by `(fingerprint, promptVersion)` (ADR-007) — a cache
 * hit never calls the model at all, which is what makes re-matching across
 * many M7 configurations affordable.
 */
export class StageAExtractor {
  constructor(
    private readonly ask: AskModel,
    private readonly extractionsRepo: ExtractionsRepository,
    private readonly promptVersion: string = STAGE_A_PROMPT_VERSION,
  ) {}

  async extract(
    posting: Posting,
    now: () => Date = () => new Date(),
  ): Promise<ExtractionResult> {
    const cached = this.extractionsRepo.find(
      posting.fingerprint,
      this.promptVersion,
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
    // Deliberately NOT cached: the cache key is (fingerprint, promptVersion)
    // and carries no notion of "which description this was extracted from",
    // so persisting this empty result would keep being served after the
    // description arrives. That is exactly the trap that produced four
    // silently contentless postings in the first calibration run (ADR-014);
    // the posting stays uncached and re-extracts for free once it has text.
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
      result.data,
      now(),
    );
    return { ok: true, ...result.data };
  }
}

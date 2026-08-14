import { z } from "zod";
import { Posting } from "../../posting/domain/posting";
import { ExtractionsRepository } from "../../persistence/infrastructure/extractions-repository";
import { Requirement } from "../domain/types";
import { AskModel, parseModelOutputWithRetries } from "./llm-output";
import { buildStageAPrompt, STAGE_A_PROMPT_VERSION } from "./prompts";

const RequirementSchema = z.object({
  text: z.string().min(1),
  category: z.string().min(1),
  weight: z.enum(["blocking", "mandatory", "desirable"]),
});
const RequirementArraySchema = z.array(RequirementSchema);

export type ExtractionResult =
  | { readonly ok: true; readonly requirements: readonly Requirement[] }
  | {
      readonly ok: false;
      readonly reason: "extraction_failed";
      readonly attempts: number;
    };

/**
 * Stage A (docs/04-scoring-model.md): reads a posting's title and
 * description, returns its declared requirements. Cached by
 * `(fingerprint, promptVersion)` (ADR-007) — a posting's requirements do not
 * change, so a cache hit never calls the model at all, which is what makes
 * re-matching across many M7 configurations affordable.
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
    if (cached) return { ok: true, requirements: cached };

    const prompt = buildStageAPrompt(posting.title, posting.description);
    const result = await parseModelOutputWithRetries(
      RequirementArraySchema,
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
    return { ok: true, requirements: result.data };
  }
}

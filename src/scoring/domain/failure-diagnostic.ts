/**
 * Safe, content-free diagnostics for a failed LLM operation. These values
 * may be persisted in `posting_events.metadata`; prompts, model output and
 * profile evidence deliberately do not belong here.
 */
export type LlmFailureCategory =
  | "timeout"
  | "networkError"
  | "rateLimited"
  | "serverError"
  | "providerError"
  | "authError"
  | "configError"
  | "requestError"
  | "invalidEnvelope"
  | "invalidOutput"
  | "httpError"
  | "circuitOpen";

export type LlmFailureKind =
  | "transport_failed"
  | "permanent_error"
  | "output_invalid_json"
  | "output_schema_rejected"
  | "prompt_build_failed";

export interface LlmFailureDiagnostic {
  readonly kind: LlmFailureKind;
  readonly category?: LlmFailureCategory;
  readonly errorType?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly finishReason?: string;
  readonly generationId?: string;
  readonly httpStatus?: number;
  readonly lastAttemptLatencyMs?: number;
}

export interface ScoringFailureDiagnostic extends LlmFailureDiagnostic {
  readonly stage: "stage-a" | "stage-b";
}

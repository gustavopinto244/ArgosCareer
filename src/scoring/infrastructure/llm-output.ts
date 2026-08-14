import { z } from "zod";

/** Calls a model with a prompt and returns its raw text response. */
export type AskModel = (prompt: string) => Promise<string>;

export type LlmParseResult<T> =
  | { readonly ok: true; readonly data: T; readonly attempts: number }
  | {
      readonly ok: false;
      readonly reason: "invalid_output";
      readonly attempts: number;
      readonly lastError: string;
    };

const FENCE_PATTERN = /^```[a-zA-Z]*\n?|\n?```$/g;

/**
 * ADR-006 step 1: strip markdown fences and surrounding prose, trim to the
 * outermost JSON object or array. Lossless and shape-preserving only — no
 * field invention, no enum guessing. If no bracket is found, the input is
 * returned trimmed and `JSON.parse` fails naturally on it.
 */
export function normalizeModelOutput(raw: string): string {
  const withoutFences = raw.trim().replace(FENCE_PATTERN, "").trim();

  const firstBrace = withoutFences.indexOf("{");
  const firstBracket = withoutFences.indexOf("[");
  const candidates = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (candidates.length === 0) return withoutFences;

  const start = Math.min(...candidates);
  const closeChar = withoutFences[start] === "{" ? "}" : "]";
  const end = withoutFences.lastIndexOf(closeChar);
  if (end === -1 || end < start) return withoutFences;

  return withoutFences.slice(start, end + 1);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function buildRetryPrompt(originalPrompt: string, error: string): string {
  return `${originalPrompt}\n\nYour previous response was invalid: ${error}\nRespond again with only the corrected JSON, no other text.`;
}

/**
 * ADR-006's full policy: normalize, validate with Zod, retry a bounded
 * number of times with the validation error fed back into the prompt, then
 * fail as a value. `maxAttempts` defaults to 3 (2 retries), per the ADR.
 *
 * Never throws — the caller gets a typed result, matching every other port
 * in this project (CollectorPort, NotifierPort).
 */
export async function parseModelOutputWithRetries<T>(
  schema: z.ZodType<T>,
  ask: AskModel,
  initialPrompt: string,
  maxAttempts = 3,
): Promise<LlmParseResult<T>> {
  let prompt = initialPrompt;
  let lastError = "no attempts made";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = await ask(prompt);
    } catch (cause) {
      // A transport failure (timeout, non-2xx) is not "invalid_output" in
      // spirit, but it is bounded by the same attempt budget and never
      // thrown past this loop — matching every other port's failure-as-value
      // convention (CollectorPort, NotifierPort).
      lastError = `Request failed: ${(cause as Error).message}`;
      prompt = buildRetryPrompt(initialPrompt, lastError);
      continue;
    }
    const normalized = normalizeModelOutput(raw);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(normalized);
    } catch (cause) {
      lastError = `Output was not valid JSON: ${(cause as Error).message}`;
      prompt = buildRetryPrompt(initialPrompt, lastError);
      continue;
    }

    const result = schema.safeParse(parsedJson);
    if (result.success) {
      return { ok: true, data: result.data, attempts: attempt };
    }

    lastError = describeIssues(result.error);
    prompt = buildRetryPrompt(initialPrompt, lastError);
  }

  return {
    ok: false,
    reason: "invalid_output",
    attempts: maxAttempts,
    lastError,
  };
}

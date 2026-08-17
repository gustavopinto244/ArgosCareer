import { z } from "zod";

/**
 * Honest identification per OpenRouter's convention (the same etiquette
 * `GupyCollector`'s User-Agent follows, CLAUDE.md §6) — these headers are
 * informational for OpenRouter's own dashboards, not required for auth.
 */
const APP_URL = "https://github.com/gustavopinto244/ArgosCareer";
const APP_TITLE = "ArgosCareer";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Tolerant on purpose (same reasoning as `GupyJobSchema`): this is a
 * third-party API and only the one field actually used is required.
 */
const ChatCompletionResponseSchema = z
  .object({
    // Deliberately no `.min(1)` here (docs/audit AC-015): a response with a
    // genuinely empty `choices` array — content filtered, no completion
    // returned — is still a structurally valid envelope, and OpenRouter can
    // still report real `usage` for it. Enforcing "at least one choice" at
    // the schema level made the whole envelope fail validation together
    // with `usage`, silently discarding usage the provider already
    // reported. `complete()` below checks `choices[0]` itself and treats a
    // missing first choice as its own failure — a business-rule check, not
    // a shape one.
    choices: z.array(
      z
        .object({
          message: z.object({ content: z.string() }).passthrough(),
        })
        .passthrough(),
    ),
    /**
     * Optional on purpose, like every other field read off a third-party
     * response here: usage accounting is reported by OpenRouter but is not
     * something a call should fail over if a provider omits it.
     */
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        cost: z.number().optional(),
        prompt_tokens_details: z
          .object({ cached_tokens: z.number().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * How one `complete()` attempt ended — tracked independently of `calls`
 * (docs/audit/AUDIT_REPORT.md AC-015): `calls` only ever counted a fully
 * successful round trip, so a timeout, a network error, an HTTP error, a
 * malformed body, or an unexpected shape were all invisible to
 * `getUsage()` — the provider may have processed and billed a request
 * this client never counted as an attempt at all.
 */
export type AttemptOutcome =
  | "success"
  | "httpError"
  | "timeout"
  | "networkError"
  | "invalidEnvelope"
  | "invalidOutput";

const ZERO_OUTCOMES: Readonly<Record<AttemptOutcome, number>> = {
  success: 0,
  httpError: 0,
  timeout: 0,
  networkError: 0,
  invalidEnvelope: 0,
  invalidOutput: 0,
};

/** Running totals across every call this client has made. */
export interface UsageTotals {
  /** Successful round trips only — kept for backward compatibility with
   * every existing caller (the M7 calibration script, ADR-014). */
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly costUsd: number;
  /** Every `complete()` invocation that reached the network, regardless of
   * outcome — `attempts >= calls` always, and the gap is exactly what
   * `calls` alone could never show (AC-015). */
  readonly attempts: number;
  readonly attemptsByOutcome: Readonly<Record<AttemptOutcome, number>>;
  /** Attempts for which no `usage` object was ever available to add to
   * `costUsd` — includes every non-success outcome (no parseable body to
   * read usage from) and the rare case of a 2xx, schema-valid response
   * that simply omitted `usage` (OpenRouter's own field is optional). A
   * `costUsd` of 0 with a nonzero count here means "unknown," not "free." */
  readonly attemptsWithoutUsage: number;
}

type FetchLike = typeof fetch;

export interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Injected for tests — no test ever makes a real network call
   * (docs/07-testing-strategy.md). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * A single chat-completion call against OpenRouter's OpenAI-compatible
 * endpoint (ADR-012). One attempt, no retry — retries live one layer up, in
 * `parseModelOutputWithRetries`, which treats a rejected call the same as a
 * malformed response and folds it into the same bounded attempt budget.
 *
 * Throws on any failure (non-2xx, malformed body, empty `choices`) rather
 * than returning a result type: this class has exactly one caller
 * (`AskModel`), and that caller already wraps every invocation in a
 * try/catch (`llm-output.ts`) — a second failure-as-value layer here would
 * just be forwarded, not handled.
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  private calls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedPromptTokens = 0;
  private costUsd = 0;
  private attempts = 0;
  private attemptsByOutcome: Record<AttemptOutcome, number> = {
    ...ZERO_OUTCOMES,
  };
  private attemptsWithoutUsage = 0;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * What this client has spent so far. Exposed as a getter rather than
   * threaded through `AskModel`'s return type: usage is an operational
   * concern of the transport, and making every caller carry it would push a
   * billing detail into the scoring stages, which have no business knowing
   * about it. Read by the M7 calibration script so one run's cost — and
   * whether the prompt cache is actually being hit — is visible rather than
   * inferred (ADR-014).
   */
  getUsage(): UsageTotals {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedPromptTokens: this.cachedPromptTokens,
      costUsd: this.costUsd,
      attempts: this.attempts,
      attemptsByOutcome: { ...this.attemptsByOutcome },
      attemptsWithoutUsage: this.attemptsWithoutUsage,
    };
  }

  async complete(prompt: string): Promise<string> {
    // Counted before the network call, not after a successful one — this is
    // the direct fix for AC-015: every attempt that reaches the network is
    // now visible, regardless of how it ends.
    this.attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": APP_URL,
          "X-Title": APP_TITLE,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      // Our own abort (timeout) vs. anything else (DNS, connection reset,
      // TLS) — both are "no response," but distinguishing them is exactly
      // what a retry/backoff policy one layer up needs (AC-016 is the
      // matching finding for using it; this only records it).
      this.attemptsByOutcome[
        controller.signal.aborted ? "timeout" : "networkError"
      ] += 1;
      this.attemptsWithoutUsage += 1;
      throw cause;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.attemptsByOutcome.httpError += 1;
      this.attemptsWithoutUsage += 1;
      throw new Error(
        `OpenRouter responded ${response.status}: ${body}`.trim(),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      this.attemptsByOutcome.invalidEnvelope += 1;
      this.attemptsWithoutUsage += 1;
      throw new Error("Malformed OpenRouter response body", { cause });
    }

    const parsed = ChatCompletionResponseSchema.safeParse(json);
    // Captured before the shape check below, deliberately — a response that
    // is a valid chat-completion envelope but fails Stage A/B's own schema
    // one layer up still spent real usage, and this is the one place that
    // usage is ever visible (REMEDIATION_PLAN.md AC-015: "persistir usage
    // retornado pelo provider mesmo quando o conteúdo falhar posteriormente
    // no schema Stage A/B").
    const usage = parsed.success ? parsed.data.usage : undefined;
    if (usage) {
      this.promptTokens += usage.prompt_tokens ?? 0;
      this.completionTokens += usage.completion_tokens ?? 0;
      this.cachedPromptTokens +=
        usage.prompt_tokens_details?.cached_tokens ?? 0;
      this.costUsd += usage.cost ?? 0;
    } else {
      this.attemptsWithoutUsage += 1;
    }

    const firstChoice = parsed.success ? parsed.data.choices[0] : undefined;
    if (!firstChoice) {
      this.attemptsByOutcome.invalidOutput += 1;
      throw new Error("Unexpected OpenRouter response shape");
    }

    this.calls += 1;
    this.attemptsByOutcome.success += 1;

    return firstChoice.message.content;
  }
}

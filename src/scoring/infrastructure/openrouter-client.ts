import { z } from "zod";
import { CircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker";

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
 *
 * Split from a single `httpError` bucket into the taxonomy AC-016 asks for
 * (`docs/audit/AUDIT_REPORT.md`): each category implies a different retry
 * policy one layer up (`llm-output.ts`) — `rateLimited`/`serverError`/
 * `providerError` are worth backing off and retrying, `authError`/
 * `configError` are not (retrying a bad API key or a malformed request
 * forever wastes budget on something no amount of waiting fixes).
 */
export type AttemptOutcome =
  | "success"
  | "timeout"
  | "networkError"
  | "rateLimited"
  | "serverError"
  | "providerError"
  | "authError"
  | "configError"
  | "invalidEnvelope"
  | "invalidOutput"
  /** Fallback for a non-2xx status this classifier has no more specific
   * bucket for (e.g. an unexpected 3xx). Kept rather than folded into one
   * of the categories above so an unanticipated status is still visible as
   * its own thing instead of silently miscounted. */
  | "httpError";

const ZERO_OUTCOMES: Readonly<Record<AttemptOutcome, number>> = {
  success: 0,
  timeout: 0,
  networkError: 0,
  rateLimited: 0,
  serverError: 0,
  providerError: 0,
  authError: 0,
  configError: 0,
  invalidEnvelope: 0,
  invalidOutput: 0,
  httpError: 0,
};

/**
 * Everything `complete()` can throw, tagged with the category above plus
 * whatever the retry layer needs to act on it: a parsed, clamped
 * `Retry-After` when the provider sent a trustworthy one, and the raw HTTP
 * status for logging. `parseModelOutputWithRetries` (`llm-output.ts`) is
 * this class's one real consumer.
 */
export class LlmTransportError extends Error {
  readonly category: FailureCategory;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(
    message: string,
    category: FailureCategory,
    options?: {
      cause?: unknown;
      retryAfterMs?: number | undefined;
      status?: number;
    },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "LlmTransportError";
    this.category = category;
    this.retryAfterMs = options?.retryAfterMs;
    this.status = options?.status;
  }
}

/**
 * `circuitOpen` is not a network attempt (`CircuitBreaker.beforeCall`
 * refuses the call before `fetch` is ever reached) so it is not a member of
 * `AttemptOutcome`, which `getUsage()` documents as strictly "reached the
 * network." It is still a failure category the retry layer needs to
 * classify, hence its own union rather than reusing `AttemptOutcome`.
 */
export type FailureCategory =
  Exclude<AttemptOutcome, "success"> | "circuitOpen";

/**
 * Which categories are worth retrying at all. `authError` and `configError`
 * are the two AC-016 names explicitly as permanent — no `Retry-After`,
 * no backoff, no amount of waiting turns a bad API key or a malformed
 * request into a valid one.
 */
const TRANSIENT_CATEGORIES: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>([
    "timeout",
    "networkError",
    "rateLimited",
    "serverError",
    "providerError",
    "invalidEnvelope",
    "invalidOutput",
    "httpError",
    "circuitOpen",
  ]);

export function isTransientFailure(category: FailureCategory): boolean {
  return TRANSIENT_CATEGORIES.has(category);
}

/**
 * Whether a failure is evidence the *provider itself* is degraded — as
 * opposed to evidence about one specific request or response (docs/audit
 * PR-009). Deliberately a narrower set than `isTransientFailure`: a
 * connection failure, a timeout, a rate limit, or a 5xx says something
 * about the transport as a whole, which is exactly what
 * `CircuitBreaker` — one shared instance protecting every concurrent Stage
 * B worker (ADR-022) — needs to open on. A malformed envelope or an
 * unexpected empty-`choices` response (`invalidEnvelope`/`invalidOutput`)
 * is a fact about *that one response* — content filtering or a one-off
 * hiccup for a specific prompt — and five of those in a row said nothing
 * reliable about whether the next, unrelated posting's call would succeed.
 * Before this distinction existed, both unconditionally called
 * `onFailure(true)`, so five content-filtered answers across five
 * unrelated postings could trip the shared breaker and block every other
 * posting's calls for the full cooldown — the exact "systemic" failure the
 * breaker is supposed to reserve itself for.
 */
const BREAKER_TRIPPING_CATEGORIES: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>([
    "timeout",
    "networkError",
    "rateLimited",
    "serverError",
    "providerError",
  ]);

export function isBreakerTrippingFailure(category: FailureCategory): boolean {
  return BREAKER_TRIPPING_CATEGORIES.has(category);
}

/**
 * 401/403 (bad or revoked credentials) and 429 get their own category each;
 * 502/503/504 are OpenRouter's own documented vocabulary for "the upstream
 * model provider is unavailable," distinct enough from a generic 500 to be
 * worth its own bucket; 408 (Request Timeout) reuses the same category this
 * client's own `AbortController` timeout uses — both mean "no timely
 * response," and treating 408 as a permanent `configError` (docs/audit
 * PR-009) meant a legitimately retryable status was never retried; anything
 * else non-2xx falls to `configError` (permanent — a 4xx is almost always a
 * malformed or unsupported request, not something retrying fixes) or
 * `serverError` (transient, the safe default for an unclassified 5xx).
 */
function classifyHttpStatus(
  status: number,
): Exclude<AttemptOutcome, "success"> {
  if (status === 401 || status === 403) return "authError";
  if (status === 408) return "timeout";
  if (status === 429) return "rateLimited";
  if (status === 502 || status === 503 || status === 504)
    return "providerError";
  if (status >= 500) return "serverError";
  if (status >= 400) return "configError";
  return "httpError";
}

/** Clamp so an untrustworthy or huge `Retry-After` cannot stall a nightly
 * batch run for a single posting — "quando confiável" (AC-016) means bounded,
 * not blindly obeyed. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * `Retry-After` is either a delta in seconds or an HTTP-date (RFC 9110
 * §10.2.3). Returns `undefined` — not zero — for anything that fails to
 * parse as either, so the caller falls back to its own computed backoff
 * instead of treating "couldn't parse" as "retry immediately."
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return seconds >= 0
      ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
      : undefined;
  }

  const dateMs = Date.parse(header);
  if (Number.isNaN(dateMs)) return undefined;
  const deltaMs = dateMs - Date.now();
  return Math.min(Math.max(deltaMs, 0), MAX_RETRY_AFTER_MS);
}

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
  /** Calls the circuit breaker (docs/audit AC-016) refused outright, before
   * `fetch` was ever reached — not part of `attempts`, which is documented
   * above as strictly "reached the network." A run where this climbs while
   * `attempts` stays flat means the provider was down long enough to trip
   * the breaker, not that requests are merely failing individually. */
  readonly blockedByCircuit: number;
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
  /** Injected for tests, so a breaker trip can be asserted without waiting
   * out a real cooldown (docs/audit AC-016). Defaults to one shared instance
   * per client, protecting every call this client makes — across Stage A
   * and Stage B alike, since `build-scorer.ts` constructs exactly one
   * `OpenRouterClient` per run and both stages call through it. */
  circuitBreaker?: CircuitBreaker;
}

/**
 * A single chat-completion call against OpenRouter's OpenAI-compatible
 * endpoint (ADR-012). One attempt, no retry — retries live one layer up, in
 * `parseModelOutputWithRetries`, which classifies the typed
 * `LlmTransportError` this method throws and decides whether, and how long,
 * to wait before trying again (docs/audit AC-016; ADR-035).
 *
 * Throws on any failure (non-2xx, malformed body, empty `choices`, or the
 * circuit breaker refusing the call) rather than returning a result type:
 * this class has exactly one caller (`AskModel`), and that caller already
 * wraps every invocation in a try/catch (`llm-output.ts`) — a second
 * failure-as-value layer here would just be forwarded, not handled.
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;

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
  private blockedByCircuit = 0;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
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
      blockedByCircuit: this.blockedByCircuit,
    };
  }

  async complete(prompt: string): Promise<string> {
    try {
      this.circuitBreaker.beforeCall();
    } catch (cause) {
      // Refused before `fetch` is ever reached -- not an "attempt" by this
      // class's own definition of the word, so it is tracked separately
      // rather than inflating `attemptsByOutcome`.
      this.blockedByCircuit += 1;
      throw new LlmTransportError(
        (cause as CircuitBreakerOpenError).message,
        "circuitOpen",
        {
          cause,
          retryAfterMs: (cause as CircuitBreakerOpenError).retryAfterMs,
        },
      );
    }

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
      // TLS) — both are "no response," but distinguishing them is what the
      // retry/backoff policy one layer up needs (docs/audit AC-016).
      const category = controller.signal.aborted ? "timeout" : "networkError";
      this.attemptsByOutcome[category] += 1;
      this.attemptsWithoutUsage += 1;
      this.circuitBreaker.onFailure(isBreakerTrippingFailure(category));
      throw new LlmTransportError((cause as Error).message, category, {
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const category = classifyHttpStatus(response.status);
      this.attemptsByOutcome[category] += 1;
      this.attemptsWithoutUsage += 1;
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      );
      this.circuitBreaker.onFailure(isBreakerTrippingFailure(category));
      throw new LlmTransportError(
        `OpenRouter responded ${response.status}: ${body}`.trim(),
        category,
        { status: response.status, retryAfterMs },
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      this.attemptsByOutcome.invalidEnvelope += 1;
      this.attemptsWithoutUsage += 1;
      // A content/response-shape problem, not evidence the provider is
      // down (docs/audit PR-009) — see isBreakerTrippingFailure.
      this.circuitBreaker.onFailure(
        isBreakerTrippingFailure("invalidEnvelope"),
      );
      throw new LlmTransportError(
        "Malformed OpenRouter response body",
        "invalidEnvelope",
        { cause },
      );
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
      // Same reasoning as invalidEnvelope above (docs/audit PR-009): a
      // content-filtered or empty-choices response is a fact about this
      // one call, not the provider as a whole.
      this.circuitBreaker.onFailure(isBreakerTrippingFailure("invalidOutput"));
      throw new LlmTransportError(
        "Unexpected OpenRouter response shape",
        "invalidOutput",
      );
    }

    this.calls += 1;
    this.attemptsByOutcome.success += 1;
    this.circuitBreaker.onSuccess();

    return firstChoice.message.content;
  }
}

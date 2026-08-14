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
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

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

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(prompt: string): Promise<string> {
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
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `OpenRouter responded ${response.status}: ${body}`.trim(),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new Error("Malformed OpenRouter response body", { cause });
    }

    const parsed = ChatCompletionResponseSchema.safeParse(json);
    const firstChoice = parsed.success ? parsed.data.choices[0] : undefined;
    if (!firstChoice) {
      throw new Error("Unexpected OpenRouter response shape");
    }

    return firstChoice.message.content;
  }
}

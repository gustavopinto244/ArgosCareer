import { z } from "zod";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 180_000;

/** Tolerant: Ollama's /api/chat response, only the field actually used is
 * required (same reasoning as GupyJobSchema/ChatCompletionResponseSchema —
 * a local server's shape can still change under us). */
const ChatResponseSchema = z
  .object({
    message: z.object({ content: z.string() }).passthrough(),
  })
  .passthrough();

type FetchLike = typeof fetch;

export interface OllamaClientOptions {
  model: string;
  baseUrl?: string;
  /** Injected for tests — no test ever makes a real network call
   * (docs/07-testing-strategy.md). Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * A single chat call against a local Ollama server. CLAUDE.md §5: Atlas
 * budgets ~150 MB at rest and Ollama peaks around 3.2 GB, so the model must
 * not sit loaded between batches — `complete` deliberately does not pass
 * `keep_alive`, leaving Ollama's own default (model stays warm briefly for
 * the next call in the same batch); `unload` sends the documented signal
 * (empty `messages`, `keep_alive: 0`) to evict it immediately once a batch
 * finishes, rather than waiting out the idle timeout.
 *
 * Throws on failure, same division of responsibility as `OpenRouterClient`:
 * the caller (`AskModel` via `llm-output.ts`) already wraps every call in a
 * try/catch and folds a rejection into the same bounded retry budget.
 */
export class OllamaClient {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OllamaClientOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async complete(prompt: string): Promise<string> {
    const json = await this.chat(
      [{ role: "user", content: prompt }],
      undefined,
    );

    const parsed = ChatResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("Unexpected Ollama response shape");
    }
    return parsed.data.message.content;
  }

  /** Evicts the model from memory immediately — call once a batch is done
   * (CLAUDE.md §5's OLLAMA_KEEP_ALIVE=0 requirement). Never throws: an
   * unload failure just means the model stays loaded a little longer, not
   * a reason to fail whatever batch just finished. */
  async unload(): Promise<void> {
    try {
      await this.chat([], 0);
    } catch {
      // Best-effort — see above.
    }
  }

  private async chat(
    messages: readonly { role: string; content: string }[],
    keepAlive: number | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama responded ${response.status}: ${body}`.trim());
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new Error("Malformed Ollama response body", { cause });
    }
  }
}

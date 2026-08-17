import { Digest } from "../domain/digest";
import { NotifierPort, NotifyResult } from "../domain/ports/notifier.port";
import { renderDigestText } from "../domain/render-digest";
import { TelegramConfig } from "./telegram-config";

/** Telegram's hard limit on a single `sendMessage` call's `text` field. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * Telegram rate-limits a single chat to roughly one message per second
 * (docs/11-known-issues.md B3) — this pause between consecutive chunk sends
 * is what keeps a large digest from tripping that limit in the first place,
 * distinct from the 429 retry below, which handles it if it happens anyway.
 */
const DEFAULT_PACING_MS = 1_100;
/** Bounded — an unbounded retry loop on a persistently rate-limited chat
 * would never finish, and ADR-007's "notified only after a successful send"
 * rule already means an exhausted chunk just re-sends the whole digest next
 * run rather than losing it (docs/11 B3). */
const DEFAULT_MAX_RETRIES = 3;
/** Defensive cap on how long a single `retry_after` wait is allowed to
 * sleep, regardless of what Telegram states — a malformed or unexpectedly
 * large value must not stall a run indefinitely. */
const DEFAULT_RETRY_AFTER_CAP_MS = 30_000;
/** Used when a 429 response carries no parseable `retry_after` at all —
 * conservative rather than zero, since the whole point is backing off. */
const DEFAULT_RETRY_AFTER_MS = 5_000;
/** Explicit per-request timeout (docs/audit AC-022) — without one, a
 * request that never resolves (a hung TCP connection, not an HTTP error
 * Telegram itself returns) could hold the delivery run's `RunLock` open
 * indefinitely, blocking every later scheduled run behind it. Same
 * AbortController pattern `GupyCollector`/`OpenRouterClient` already use. */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface TelegramNotifierOptions {
  readonly pacingMs?: number;
  readonly maxRetries?: number;
  readonly retryAfterCapMs?: number;
  readonly timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Telegram's actual 429 body shape:
 * `{"ok":false,"error_code":429,"description":"...","parameters":{"retry_after":5}}`
 * (`retry_after` in seconds). Null on anything unparseable — the caller
 * falls back to `DEFAULT_RETRY_AFTER_MS` rather than guessing.
 */
async function parseRetryAfterMs(response: Response): Promise<number | null> {
  try {
    const body: unknown = await response.json();
    const seconds = (body as { parameters?: { retry_after?: unknown } } | null)
      ?.parameters?.retry_after;
    return typeof seconds === "number" && seconds >= 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The plain-text-send capability, factored out so a caller (M10's
 * `executeStudyPlan`) can depend on "something that can send text" and be
 * given a fake in tests, without depending on the concrete `TelegramNotifier`
 * class or widening `NotifierPort` itself — that port's one method is
 * shaped around a `Digest`, and a study plan is not one, same reasoning
 * `sendText`'s own doc comment already gives.
 */
export interface TextNotifier {
  sendText(text: string): Promise<NotifyResult>;
}

const SECTION_SEPARATOR = "\n\n---\n\n";
const ENTRY_SEPARATOR = "\n\n";

/**
 * Greedily packs `parts` into chunks joined by `separator`, each no longer
 * than `limit`. A part that alone exceeds `limit` is passed through
 * unsplit — the caller is expected to have already tried splitting it more
 * finely before falling back to this.
 */
function pack(
  parts: readonly string[],
  separator: string,
  limit: number,
): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? `${current}${separator}${part}` : part;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits a rendered digest into `sendMessage`-sized chunks. Splits on
 * section boundaries first; a single section that alone exceeds the limit
 * (not expected at M6's posting volumes) is split further on its entry
 * boundaries instead of being sent oversized and rejected by Telegram.
 */
export function splitForTelegram(
  text: string,
  limit: number = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  const sections = text.split(SECTION_SEPARATOR);
  const oversized = sections.some((section) => section.length > limit);
  if (!oversized) return pack(sections, SECTION_SEPARATOR, limit);

  const finer = sections.flatMap((section) =>
    section.length > limit ? section.split(ENTRY_SEPARATOR) : [section],
  );
  return pack(finer, ENTRY_SEPARATOR, limit);
}

/**
 * A direct, dumb Telegram client (docs/02-architecture.md) — no framework,
 * no agent, no dependency on anything else running. Failure is returned as a
 * value, never thrown, matching CollectorPort and ScorerPort (principle 1):
 * a delivery failure must not crash the caller, which decides whether to
 * retry.
 */
export class TelegramNotifier implements NotifierPort, TextNotifier {
  private readonly pacingMs: number;
  private readonly maxRetries: number;
  private readonly retryAfterCapMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    options: TelegramNotifierOptions = {},
  ) {
    this.pacingMs = options.pacingMs ?? DEFAULT_PACING_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryAfterCapMs =
      options.retryAfterCapMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async notify(digest: Digest): Promise<NotifyResult> {
    return this.sendChunks(splitForTelegram(renderDigestText(digest)));
  }

  /**
   * Plain-text send, for the M8 scheduler's alerts (`docs/08-observability.md`)
   * — delivered through this same client rather than a separate channel, so
   * there is nothing extra to configure or keep alive. Not part of
   * `NotifierPort`: that port's one method is shaped around a `Digest`, and
   * an alert is not one — this is a sibling capability of the concrete
   * Telegram client, not a new abstraction.
   */
  async sendText(text: string): Promise<NotifyResult> {
    return this.sendChunks(splitForTelegram(text));
  }

  /**
   * Paced per docs/11-known-issues.md B3: a pause before every chunk after
   * the first, not only on failure — the point is staying under Telegram's
   * rate limit in the first place, not just recovering after tripping it.
   */
  private async sendChunks(chunks: readonly string[]): Promise<NotifyResult> {
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(this.pacingMs);
      const result = await this.sendMessage(chunks[i]!);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private async sendMessage(text: string): Promise<NotifyResult> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.config.chatId, text }),
          signal: controller.signal,
        });
      } catch (cause) {
        return {
          ok: false,
          error: { message: "Telegram request failed", cause },
        };
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429) {
        const retryAfterMs =
          (await parseRetryAfterMs(response.clone())) ?? DEFAULT_RETRY_AFTER_MS;
        if (attempt < this.maxRetries) {
          await sleep(Math.min(retryAfterMs, this.retryAfterCapMs));
          continue;
        }
        return {
          ok: false,
          error: {
            message: `Telegram request failed: 429, exhausted ${this.maxRetries} retries`,
          },
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          ok: false,
          error: {
            message:
              `Telegram request failed: ${response.status} ${body}`.trim(),
          },
        };
      }

      return { ok: true };
    }

    // Unreachable — the loop above always returns before exhausting its
    // bound (the 429 branch returns once attempt === maxRetries). Kept for
    // TypeScript's control-flow analysis, not a real code path.
    return {
      ok: false,
      error: { message: "Telegram request failed: exhausted retries" },
    };
  }
}

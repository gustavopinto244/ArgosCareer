import { Digest } from "../domain/digest";
import { NotifierPort, NotifyResult } from "../domain/ports/notifier.port";
import { renderDigestText } from "../domain/render-digest";
import { TelegramConfig } from "./telegram-config";

/** Telegram's hard limit on a single `sendMessage` call's `text` field. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

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
export class TelegramNotifier implements NotifierPort {
  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async notify(digest: Digest): Promise<NotifyResult> {
    const chunks = splitForTelegram(renderDigestText(digest));

    for (const chunk of chunks) {
      const result = await this.sendMessage(chunk);
      if (!result.ok) return result;
    }
    return { ok: true };
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
    const chunks = splitForTelegram(text);
    for (const chunk of chunks) {
      const result = await this.sendMessage(chunk);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  private async sendMessage(text: string): Promise<NotifyResult> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.config.chatId, text }),
      });
    } catch (cause) {
      return {
        ok: false,
        error: { message: "Telegram request failed", cause },
      };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        error: {
          message: `Telegram request failed: ${response.status} ${body}`.trim(),
        },
      };
    }

    return { ok: true };
  }
}

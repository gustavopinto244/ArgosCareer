export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
}

export class TelegramConfigError extends Error {}

/**
 * Fails loudly at startup (docs/09-configuration.md) rather than letting a
 * missing credential surface later as an opaque Telegram 401. Never logs
 * `env`'s values — only which key was absent.
 */
export function loadTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();

  if (!botToken) {
    throw new TelegramConfigError("TELEGRAM_BOT_TOKEN is not set");
  }
  if (!chatId) {
    throw new TelegramConfigError("TELEGRAM_CHAT_ID is not set");
  }

  return { botToken, chatId };
}

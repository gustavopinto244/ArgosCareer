import { describe, expect, it } from "vitest";
import {
  loadTelegramConfig,
  TelegramConfigError,
} from "../../../src/delivery/infrastructure/telegram-config";

describe("loadTelegramConfig", () => {
  it("returns the trimmed token and chat id when both are set", () => {
    const config = loadTelegramConfig({
      TELEGRAM_BOT_TOKEN: " 123:abc ",
      TELEGRAM_CHAT_ID: " 456 ",
    });
    expect(config).toEqual({ botToken: "123:abc", chatId: "456" });
  });

  it("throws naming TELEGRAM_BOT_TOKEN when it is missing", () => {
    expect(() => loadTelegramConfig({ TELEGRAM_CHAT_ID: "456" })).toThrowError(
      TelegramConfigError,
    );
    expect(() => loadTelegramConfig({ TELEGRAM_CHAT_ID: "456" })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
  });

  it("throws naming TELEGRAM_CHAT_ID when it is missing", () => {
    expect(() => loadTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:abc" })).toThrow(
      /TELEGRAM_CHAT_ID/,
    );
  });

  it("treats a blank string the same as missing", () => {
    expect(() =>
      loadTelegramConfig({
        TELEGRAM_BOT_TOKEN: "   ",
        TELEGRAM_CHAT_ID: "456",
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createPosting } from "../../../src/posting/domain/posting";
import { ScoreOutcome } from "../../../src/scoring/domain/types";
import { Digest, ScoredPosting } from "../../../src/delivery/domain/digest";
import {
  TelegramNotifier,
  splitForTelegram,
} from "../../../src/delivery/infrastructure/telegram-notifier";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

const NOW = new Date("2026-08-14T03:00:00Z");
const CONFIG = { botToken: "123:abc", chatId: "456" };

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "1",
    company: "Empresa X",
    title: "Estágio em Desenvolvimento Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    sourceUrl: "https://example.org/vagas/1",
    collectedAt: NOW,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    rawPayload: {},
    ...overrides,
  });
}

function outcome(overrides: Partial<ScoreOutcome> = {}): ScoreOutcome {
  return {
    score: 62,
    verdict: "review",
    breakdown: {
      mandatoryCoverage: 1,
      desirableCoverage: 1,
      trackAlignment: 1,
    },
    blockingFailure: null,
    lowConfidence: true,
    criticalGaps: [],
    ...overrides,
  };
}

function emptyDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    runId: "run-1",
    generatedAt: NOW,
    recommended: [],
    review: [],
    periodBlocked: [],
    summary: {
      collected: 0,
      deduplicated: 0,
      filtered: 0,
      scored: 0,
      failedSources: [],
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("splitForTelegram", () => {
  it("returns a single chunk when the whole text fits under the limit", () => {
    const chunks = splitForTelegram("a\n\n---\n\nb\n\n---\n\nc");
    expect(chunks).toEqual(["a\n\n---\n\nb\n\n---\n\nc"]);
  });

  it("splits into multiple chunks when sections together exceed the limit", () => {
    const section = "x".repeat(3000);
    const text = [section, section, section].join("\n\n---\n\n");
    const chunks = splitForTelegram(text, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
    expect(chunks.join("")).toContain(section);
  });

  it("splits a single oversized section on its entry boundaries", () => {
    const entry = "y".repeat(2000);
    const oversizedSection = [entry, entry, entry].join("\n\n");
    const chunks = splitForTelegram(oversizedSection, 4096);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

describe("TelegramNotifier — success", () => {
  it("sends one request for a digest that fits in one message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts to the sendMessage endpoint with the configured chat id and bot token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    await notifier.notify(emptyDigest());

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(init.body as string) as {
      chat_id: string;
      text: string;
    };
    expect(body.chat_id).toBe("456");
    expect(body.text).toContain("Resumo da execução");
  });

  it("sends one request per chunk for a digest large enough to need several", async () => {
    const scored: ScoredPosting = { posting: posting(), outcome: outcome() };
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...scored,
      posting: posting({
        sourceId: String(i),
        sourceUrl: `https://example.org/${i}`,
      }),
    }));
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest({ review: many }));

    expect(result.ok).toBe(true);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("TelegramNotifier — failure, never throws", () => {
  it("returns ok:false with the status and body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Forbidden: bot was blocked", { status: 403 }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("403");
      expect(result.error.message).toContain("bot was blocked");
    }
  });

  it("returns ok:false, not a throw, when fetch itself rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Telegram request failed");
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("stops sending further chunks once one chunk fails", async () => {
    const scored: ScoredPosting = { posting: posting(), outcome: outcome() };
    const many = Array.from({ length: 80 }, (_, i) => ({
      ...scored,
      posting: posting({
        sourceId: String(i),
        sourceUrl: `https://example.org/${i}`,
      }),
    }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.notify(emptyDigest({ review: many }));

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("TelegramNotifier.sendText — M8 alerts", () => {
  it("posts plain text to the same sendMessage endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.sendText("gupy: 2 consecutive runs failed.");

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe("gupy: 2 consecutive runs failed.");
  });

  it("returns ok:false, not a throw, on a failed send", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const notifier = new TelegramNotifier(CONFIG, fetchImpl);

    const result = await notifier.sendText("alert");

    expect(result.ok).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { OllamaClient } from "../../../src/scoring/infrastructure/ollama-client";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function client(fetchImpl: typeof fetch): OllamaClient {
  return new OllamaClient({ model: "qwen3:4b", fetchImpl });
}

describe("OllamaClient.complete — success", () => {
  it("returns the message content", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: { role: "assistant", content: "pong" } }),
    );
    await expect(client(fetchImpl).complete("ping")).resolves.toBe("pong");
  });

  it("posts to /api/chat with the model and a single user message, streaming disabled", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: { content: "x" } }),
    );
    await client(fetchImpl).complete("say hi");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
      keep_alive?: number;
    };
    expect(body.model).toBe("qwen3:4b");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
    expect(body.stream).toBe(false);
    expect(body.keep_alive).toBeUndefined();
  });

  it("respects a custom baseUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: { content: "x" } }),
    );
    const c = new OllamaClient({
      model: "qwen3:4b",
      baseUrl: "http://atlas.local:11434",
      fetchImpl,
    });
    await c.complete("prompt");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://atlas.local:11434/api/chat");
  });
});

describe("OllamaClient.complete — failure, throws with a clear message", () => {
  it("throws with the status and body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("model not found", { status: 404 }),
    );
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /404.*model not found/s,
    );
  });

  it("throws on a malformed (non-JSON) response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json"));
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /malformed/i,
    );
  });

  it("throws when the response has no message field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ done: true }));
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /unexpected/i,
    );
  });

  it("throws when fetch itself rejects (server not running)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /ECONNREFUSED/,
    );
  });

  it("aborts and throws once the timeout elapses", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("This operation was aborted"));
          });
        }),
    );
    const c = new OllamaClient({
      model: "qwen3:4b",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    });
    await expect(c.complete("prompt")).rejects.toThrow(/aborted/i);
  });
});

describe("OllamaClient.unload", () => {
  it("sends an empty-messages request with keep_alive: 0", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: { content: "" }, done_reason: "unload" }),
    );
    await client(fetchImpl).unload();

    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      messages: unknown[];
      keep_alive: number;
    };
    expect(body.messages).toEqual([]);
    expect(body.keep_alive).toBe(0);
  });

  it("never throws, even when the request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(client(fetchImpl).unload()).resolves.toBeUndefined();
  });
});

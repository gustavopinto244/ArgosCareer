import { describe, expect, it, vi } from "vitest";
import { OpenRouterClient } from "../../../src/scoring/infrastructure/openrouter-client";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function client(fetchImpl: typeof fetch): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: "test-key",
    model: "test/model",
    fetchImpl,
  });
}

describe("OpenRouterClient.complete — success", () => {
  it("returns the first choice's message content", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "hello" } }] }),
    );

    await expect(client(fetchImpl).complete("prompt")).resolves.toBe("hello");
  });

  it("posts the model, messages, and bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    await client(fetchImpl).complete("say hi");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("test/model");
    expect(body.messages).toEqual([{ role: "user", content: "say hi" }]);
  });

  it("respects a custom baseUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      baseUrl: "http://localhost:1234/v1",
      fetchImpl,
    });
    await c.complete("prompt");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
  });
});

describe("OpenRouterClient.complete — failure, throws with a clear message", () => {
  it("throws with the status and body on a non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("insufficient credits", { status: 402 }),
    );
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /402.*insufficient credits/s,
    );
  });

  it("throws on a malformed (non-JSON) response body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /malformed/i,
    );
  });

  it("throws when the response has an empty choices array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /unexpected/i,
    );
  });

  it("throws when the response is missing choices entirely", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /unexpected/i,
    );
  });

  it("throws when fetch itself rejects (network failure)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    await expect(client(fetchImpl).complete("prompt")).rejects.toThrow(
      /connection reset/,
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
    const c = new OpenRouterClient({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5,
    });

    await expect(c.complete("prompt")).rejects.toThrow(/aborted/i);
  });
});

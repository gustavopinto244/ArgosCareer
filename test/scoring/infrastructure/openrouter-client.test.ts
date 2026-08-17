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

describe("OpenRouterClient.getUsage — attempt accounting (docs/audit AC-015)", () => {
  it("counts a successful call under both calls and attempts", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: "x" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
      }),
    );
    const c = client(fetchImpl);
    await c.complete("prompt");

    const usage = c.getUsage();
    expect(usage.calls).toBe(1);
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome).toEqual({
      success: 1,
      httpError: 0,
      timeout: 0,
      networkError: 0,
      invalidEnvelope: 0,
      invalidOutput: 0,
    });
    expect(usage.attemptsWithoutUsage).toBe(0);
    expect(usage.costUsd).toBeCloseTo(0.001);
  });

  it("counts a non-2xx response as an attempt, not just a thrown error", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("insufficient credits", { status: 402 }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.calls).toBe(0);
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.httpError).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
  });

  it("counts a malformed body as an attempt", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.invalidEnvelope).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
  });

  it("counts an unexpected shape as an attempt, distinct from invalidEnvelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.invalidOutput).toBe(1);
  });

  it("counts a network failure (fetch throws) as an attempt", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.networkError).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
  });

  it("counts a timeout as its own outcome, distinct from a generic network error", async () => {
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
    await expect(c.complete("prompt")).rejects.toThrow();

    const usage = c.getUsage();
    expect(usage.attempts).toBe(1);
    expect(usage.attemptsByOutcome.timeout).toBe(1);
    expect(usage.attemptsByOutcome.networkError).toBe(0);
  });

  it("captures usage from a 2xx envelope even when the chat shape is invalid (AC-015)", async () => {
    // The regression this guards: a response that is valid JSON and even
    // has a real `usage` block, but happens to have no choices — the
    // provider still reported (and presumably billed) real usage, which
    // must not be thrown away just because Stage A/B's shape check fails.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        choices: [],
        usage: { prompt_tokens: 20, completion_tokens: 0, cost: 0.002 },
      }),
    );
    const c = client(fetchImpl);
    await expect(c.complete("prompt")).rejects.toThrow(/unexpected/i);

    const usage = c.getUsage();
    expect(usage.calls).toBe(0);
    expect(usage.promptTokens).toBe(20);
    expect(usage.costUsd).toBeCloseTo(0.002);
    expect(usage.attemptsWithoutUsage).toBe(0);
  });

  it("counts a successful response with no usage field as attemptsWithoutUsage", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "x" } }] }),
    );
    const c = client(fetchImpl);
    await c.complete("prompt");

    const usage = c.getUsage();
    expect(usage.calls).toBe(1);
    expect(usage.attemptsWithoutUsage).toBe(1);
    expect(usage.costUsd).toBe(0);
  });

  it("accumulates attempts and outcomes across multiple calls on the same client", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response("boom", { status: 500 })
        : jsonResponse({
            choices: [{ message: { content: "x" } }],
            usage: { cost: 0.001 },
          });
    });
    const c = client(fetchImpl);

    await expect(c.complete("p1")).rejects.toThrow();
    await c.complete("p2");

    const usage = c.getUsage();
    expect(usage.attempts).toBe(2);
    expect(usage.calls).toBe(1);
    expect(usage.attemptsByOutcome).toEqual({
      success: 1,
      httpError: 1,
      timeout: 0,
      networkError: 0,
      invalidEnvelope: 0,
      invalidOutput: 0,
    });
    expect(usage.attemptsWithoutUsage).toBe(1);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SolidesCollector } from "../../../src/posting/infrastructure/solides-collector";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function curatedFixture(): unknown {
  const path = join(process.cwd(), "test", "fixtures", "solides-jobs.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

// Test-only overrides so contract tests don't sit through real backoff
// delays or the 1.5s inter-page interval.
const FAST_OPTIONS = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1, 1],
};

describe("SolidesCollector — never throws", () => {
  it("returns an error result on a non-200 response, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("500");
  });

  it("returns an error result on a 4xx without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("404");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an error result when the request times out, never throwing", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(
              new DOMException("The operation was aborted.", "AbortError"),
            );
          });
        }),
    );
    const collector = new SolidesCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on a malformed (non-JSON) body, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>not json</html>", { status: 200 }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("Malformed");
  });

  it("returns an error result on an empty body, never throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on a response shaped without a nested data array, never throwing", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { notData: [] } }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("shape");
  });

  it("returns an error result when the connection is reset, never throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on invalid criteria, never throwing", async () => {
    const fetchImpl = vi.fn();
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: "not a number" });

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("Invalid");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps postings from a successful first page when the second page fails (docs/audit AC-004)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          data: {
            data: Array.from({ length: 10 }, (_, i) => ({
              id: i,
              title: "Estágio",
            })),
          },
        });
      }
      return new Response("Server Error", { status: 500 });
    });
    const collector = new SolidesCollector({
      fetchImpl,
      timeoutMs: 50,
      requestIntervalMs: 0,
      backoffDelaysMs: [1, 1],
    });

    const result = await collector.collect({ maxResults: 20 });

    expect(result.postings).toHaveLength(10);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("Sólides request failed");
  });
});

describe("SolidesCollector — retry and backoff", () => {
  it("retries a 5xx and succeeds once the server recovers", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 2) return new Response("Server Error", { status: 503 });
      return jsonResponse(curatedFixture());
    });
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 4 });

    expect(result.error).toBeUndefined();
    expect(result.postings.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
  });

  it("gives up and reports an error after exhausting all backoff attempts", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 503 }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(
      FAST_OPTIONS.backoffDelaysMs.length + 1,
    );
  });
});

describe("SolidesCollector — successful collection", () => {
  it("wraps every valid item from the curated fixture as a RawPosting", async () => {
    const fixture = curatedFixture() as { data: { data: { id: number }[] } };
    const items = fixture.data.data;
    const fetchImpl = vi.fn(async () => jsonResponse(fixture));
    const collector = new SolidesCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    const result = await collector.collect({ maxResults: items.length });

    expect(result.error).toBeUndefined();
    expect(result.source).toBe("solides");
    expect(result.postings).toHaveLength(items.length);
    expect(result.postings.map((p) => p.sourceId).sort()).toEqual(
      items.map((j) => String(j.id)).sort(),
    );
    for (const posting of result.postings) {
      expect(posting.source).toBe("solides");
      expect(posting.payload).toBeDefined();
    }
  });

  it("sends the honest User-Agent header, never a forged browser one", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { data: [] } }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({});

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was not called");
    const [, init] = call as [string, RequestInit];
    const userAgent = (init.headers as Record<string, string>)["User-Agent"];
    expect(userAgent).toContain("ArgosCareer");
    expect(userAgent).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("always requests take=10, regardless of maxResults or pageSize", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { data: [] } }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({ maxResults: 3 });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was not called");
    const [url] = call as [string];
    expect(new URL(url).searchParams.get("take")).toBe("10");
  });

  it("translates a bare RJ-metro city into Sólides's 'Cidade - UF' format", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({ data: { data: [] } }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({ city: "Niterói" });

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetchImpl was not called");
    const [url] = call as [string];
    expect(new URL(url).searchParams.get("locations")).toBe("Niterói - RJ");
  });

  it("stops paginating once a short page signals the last page", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { data: [{ id: 1, title: "Estágio X" }] } }),
    );
    const collector = new SolidesCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    const result = await collector.collect({ maxResults: 50 });

    expect(result.postings).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(false);
  });

  it("reports truncated: true when the cap is hit on a full page (docs/audit AC-013)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          data: Array.from({ length: 10 }, (_, i) => ({ id: i, title: "x" })),
        },
      }),
    );
    const collector = new SolidesCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    // take is fixed at 10 — maxResults exactly matching one full page means
    // the cap, not the source, ends the run.
    const result = await collector.collect({ maxResults: 10 });

    expect(result.postings).toHaveLength(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
  });

  it("returns exactly maxResults items, not a whole extra page past it (docs/audit PR-015)", async () => {
    // The real bug: with take fixed at 10, maxResults: 15 used to fetch two
    // full pages (the pre-fetch check compared page count against
    // maxResults, not the running scanned total) and return 20.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          data: Array.from({ length: 10 }, (_, i) => ({ id: i, title: "x" })),
        },
      }),
    );
    const collector = new SolidesCollector({
      fetchImpl,
      ...FAST_OPTIONS,
      requestIntervalMs: 0,
    });

    const result = await collector.collect({ maxResults: 15 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.postings).toHaveLength(15);
    expect(result.receivedCount).toBe(15);
    expect(result.truncated).toBe(true);
  });

  it("skips an individual malformed item without failing the whole collection", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          data: [
            { id: 1, title: "Estágio válido" },
            { missingIdAndTitle: true },
          ],
        },
      }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 2 });

    expect(result.error).toBeUndefined();
    expect(result.postings).toHaveLength(1);
    expect(result.postings[0]?.sourceId).toBe("1");
  });

  it("reports receivedCount and schemaRejectedCount (docs/audit AC-012)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          data: [
            { id: 1, title: "Estágio válido" },
            { missingIdAndTitle: true },
          ],
        },
      }),
    );
    const collector = new SolidesCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: 2 });

    expect(result.receivedCount).toBe(2);
    expect(result.schemaRejectedCount).toBe(1);
  });
});

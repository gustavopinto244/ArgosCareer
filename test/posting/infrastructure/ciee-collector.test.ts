import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CieeCollector } from "../../../src/posting/infrastructure/ciee-collector";

// No test makes a real network call (docs/07-testing-strategy.md) — fetch is
// injected and faked for every scenario below.

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function curatedFixture(): { content: unknown[] } {
  const path = join(process.cwd(), "test", "fixtures", "ciee-jobs.json");
  return JSON.parse(readFileSync(path, "utf8")) as { content: unknown[] };
}

const FAST_OPTIONS = {
  timeoutMs: 50,
  requestIntervalMs: 0,
  backoffDelaysMs: [1, 1],
};

describe("CieeCollector — never throws", () => {
  it("returns an error result on a non-200 response, never throwing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Server Error", { status: 500 }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error?.message).toContain("500");
  });

  it("returns an error result on a 4xx without retrying", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Not Found", { status: 404 }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.error?.message).toContain("404");
    // A 4xx means the request is wrong; retrying wastes the source's time.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an error result when the request times out, never throwing", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );
    const collector = new CieeCollector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...FAST_OPTIONS,
    });

    const result = await collector.collect({});

    expect(result.postings).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it("returns an error result on a malformed (non-JSON) body, never throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>nope</html>"));
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.error?.message).toContain("Malformed");
  });

  it("returns an error result on a response with no content array, never throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ unexpected: true }));
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.error?.message).toContain("Unexpected");
  });

  it("returns an error result when the connection is reset, never throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.error?.message).toContain("ECONNRESET");
  });

  it("returns an error result on invalid criteria, never throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: [] }));
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ maxResults: -5 });

    expect(result.error?.message).toContain("Invalid CIEE collection criteria");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CieeCollector — client-side filtering", () => {
  // CIEE ignores every filter parameter, so narrowing is this collector's
  // job. These are the tests that prove it actually narrows.

  it("keeps only university-level postings by default", async () => {
    const fixture = curatedFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...fixture, last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    // The fixture holds one SU posting and three EM ones: ensino médio is
    // ineligible for a university course, not merely a worse fit.
    expect(result.postings).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it("filters by city against the posting's own location", async () => {
    const fixture = curatedFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...fixture, last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const rio = await collector.collect({ city: "Rio de Janeiro" });
    expect(rio.postings).toHaveLength(1);

    const elsewhere = await collector.collect({ city: "Curitiba" });
    expect(elsewhere.postings).toHaveLength(0);
    expect(elsewhere.error).toBeUndefined();
  });

  it("filters by jobName against areaProfissional, CIEE's role taxonomy", async () => {
    const fixture = curatedFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...fixture, last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const hit = await collector.collect({ jobName: "Informática" });
    expect(hit.postings).toHaveLength(1);

    const miss = await collector.collect({ jobName: "Gastronomia" });
    expect(miss.postings).toHaveLength(0);
  });

  it("can be asked for other education levels explicitly", async () => {
    const fixture = curatedFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...fixture, last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({ educationLevels: ["EM"] });

    expect(result.postings).toHaveLength(3);
  });
});

describe("CieeCollector — successful collection", () => {
  it("wraps every kept item from the curated fixture as a RawPosting", async () => {
    const fixture = curatedFixture();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ...fixture, last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.source).toBe("ciee");
    for (const posting of result.postings) {
      expect(posting.source).toBe("ciee");
      expect(posting.sourceId).toMatch(/^\d+$/);
      expect(posting.payload).toBeTypeOf("object");
    }
  });

  it("sends the honest User-Agent header, never a forged browser one", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [], last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({});

    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const ua = (call[1].headers as Record<string, string>)["User-Agent"];
    expect(ua).toContain("ArgosCareer");
    expect(ua).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it("stops paginating once the envelope reports the last page", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ codigoVaga: 1 }], last: true }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    await collector.collect({ educationLevels: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips an individual malformed item without failing the whole page", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [{ codigoVaga: 1, nivelEscolar: "SU" }, { nothing: true }],
        last: true,
      }),
    );
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.postings).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it("retries a 5xx and succeeds once the server recovers", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response("boom", { status: 503 })
        : jsonResponse({ content: [], last: true });
    });
    const collector = new CieeCollector({ fetchImpl, ...FAST_OPTIONS });

    const result = await collector.collect({});

    expect(result.error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

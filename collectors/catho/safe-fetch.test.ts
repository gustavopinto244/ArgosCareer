import { describe, expect, it, vi } from "vitest";
import { fetchAllowedCathoText } from "./safe-fetch";

const ALLOWED = "https://www.catho.com.br/sitemap-index.xml";
const UA = "ArgosCareer/test";

describe("fetchAllowedCathoText", () => {
  it("follows an allowed relative redirect manually", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/sitemap2/sitemap_vagas_1.xml" },
        }),
      )
      .mockResolvedValueOnce(new Response("<xml />", { status: 200 }));

    await expect(
      fetchAllowedCathoText(ALLOWED, { fetchImpl, userAgent: UA }),
    ).resolves.toBe("<xml />");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "https://www.catho.com.br/sitemap2/sitemap_vagas_1.xml",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("rejects a redirect target before issuing a request to it", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      }),
    );

    await expect(
      fetchAllowedCathoText(ALLOWED, { fetchImpl, userAgent: UA }),
    ).rejects.toThrow(/disallowed Catho URL/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a streamed response even without Content-Length", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("123456", { status: 200 }));

    await expect(
      fetchAllowedCathoText(ALLOWED, {
        fetchImpl,
        userAgent: UA,
        maxBytes: 5,
      }),
    ).rejects.toThrow(/exceeds 5 bytes/);
  });

  it("aborts a sitemap request that exceeds its deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    await expect(
      fetchAllowedCathoText(ALLOWED, {
        fetchImpl,
        userAgent: UA,
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts a sitemap body that stalls after response headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<xml>"));
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      fetchAllowedCathoText(ALLOWED, {
        fetchImpl,
        userAgent: UA,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ maxRedirects: -1 }, /maxRedirects/],
    [{ maxBytes: 0 }, /maxBytes/],
  ] as const)(
    "rejects invalid bounds before fetching",
    async (bounds, error) => {
      const fetchImpl = vi.fn<typeof fetch>();
      await expect(
        fetchAllowedCathoText(ALLOWED, {
          fetchImpl,
          userAgent: UA,
          ...bounds,
        }),
      ).rejects.toThrow(error);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});

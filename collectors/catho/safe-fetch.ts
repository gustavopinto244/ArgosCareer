import { isAllowedCathoUrl } from "./state";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly userAgent: string;
}

export async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      { once: true },
    );
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, total));
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

/** Exact-origin, redirect-by-redirect sitemap fetch. `redirect: "manual"`
 * ensures a disallowed Location is rejected before the network request is
 * issued, rather than inspected after global fetch has already followed it. */
export async function fetchAllowedCathoText(
  initialUrl: string,
  options: SafeFetchOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("maxRedirects must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedCathoUrl(currentUrl)) {
      throw new Error(`disallowed Catho URL: ${currentUrl}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        headers: { "User-Agent": options.userAgent },
        redirect: "manual",
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        if (hop === maxRedirects) throw new Error("too many Catho redirects");
        const location = response.headers.get("location");
        if (!location) throw new Error("Catho redirect has no Location header");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${currentUrl} responded ${response.status}`);
      }
      // The deadline covers the body stream too, not only receipt of HTTP
      // headers; a server that sends headers and stalls must still abort.
      return await readResponseTextBounded(
        response,
        maxBytes,
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("too many Catho redirects");
}

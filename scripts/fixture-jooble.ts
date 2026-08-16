/**
 * Hits the real Jooble API and records the response for schema discovery.
 * A script, never run by CI, never called by a test
 * (docs/07-testing-strategy.md) — `test/fixtures/jooble-raw.json` is
 * gitignored and carries real company names and posting content.
 *
 * Run: JOOBLE_API_KEY=<key> npm run fixture:jooble
 *
 * The key is free but requires registering at https://jooble.org/api/about.
 * That page sits behind Cloudflare's bot challenge, so it has to be opened
 * in a normal browser — automated requests to it get `Just a moment...`.
 *
 * The API endpoint itself is NOT challenged, which is the fact that makes
 * this source worth building at all. Probed 2026-08-16:
 *
 *   POST /api/about                  -> 403, <title>Just a moment...</title>,
 *                                       cf-mitigated: challenge   (bot block)
 *   POST /api/<invalid-key>          -> 403, <title>Error 403</title>,
 *                                       no Cloudflare markers     (auth)
 *
 * The second is Jooble's own application rejecting a bad key, not the edge
 * rejecting a bot. A valid key should therefore get through from here.
 * `robots.txt` disallows `/employer/api` and says nothing about `/api`.
 *
 * The response shape is deliberately NOT assumed anywhere in this script.
 * It prints what came back so a tolerant Zod schema can be fitted to it —
 * the same protocol M3 used for Gupy and M11 used for CIEE (CLAUDE.md §15:
 * do not invent a fact that can be checked).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const OUTPUT_PATH = join(
  __dirname,
  "..",
  "test",
  "fixtures",
  "jooble-raw.json",
);

async function main(): Promise<void> {
  const key = process.env.JOOBLE_API_KEY?.trim();
  if (!key) {
    console.error(
      "JOOBLE_API_KEY is not set. Register free at https://jooble.org/api/about\n" +
        "(open it in a browser — that page is behind a bot challenge), then:\n" +
        "  JOOBLE_API_KEY=<key> npm run fixture:jooble",
    );
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`https://jooble.org/api/${key}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      keywords: "estágio desenvolvimento",
      location: "Rio de Janeiro",
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`Jooble responded ${response.status} ${response.statusText}`);
    console.error(text.slice(0, 400));
    process.exitCode = 1;
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    console.error("Jooble did not return JSON. First 400 characters:");
    console.error(text.slice(0, 400));
    process.exitCode = 1;
    return;
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(body, null, 2), "utf8");

  const envelope = body as Record<string, unknown>;
  console.log(`Wrote the response to ${OUTPUT_PATH}`);
  console.log("Envelope keys:", Object.keys(envelope).sort().join(", "));

  // Find whichever key holds the array of postings without assuming its name.
  const arrayKey = Object.keys(envelope).find((k) =>
    Array.isArray(envelope[k]),
  );
  if (!arrayKey) {
    console.log("No array field found — inspect the file by hand.");
    return;
  }
  const items = envelope[arrayKey] as Record<string, unknown>[];
  console.log(`Postings live under "${arrayKey}" (${items.length} items).`);
  console.log(
    "Posting keys:",
    items[0] ? Object.keys(items[0]).sort().join(", ") : "(empty)",
  );

  const nullable = new Set<string>();
  for (const item of items) {
    for (const [k, v] of Object.entries(item)) {
      if (v === null || v === "") nullable.add(k);
    }
  }
  console.log(
    "Fields observed null or empty at least once:",
    [...nullable].sort().join(", ") || "(none)",
  );
}

void main();

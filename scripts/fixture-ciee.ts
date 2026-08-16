/**
 * Hits the real CIEE jobs API and records the response for schema discovery.
 * A script, never run by CI, never called by a test
 * (docs/07-testing-strategy.md) — `test/fixtures/ciee-raw.json` is gitignored
 * and carries real company names and posting content.
 *
 * Run: npm run fixture:ciee
 *
 * CIEE's board is a Spring-style paginated envelope and, unlike Gupy's,
 * ignores every filter parameter tried (`uf`, `cidade`, `nivelEscolar`,
 * `descricao`, `palavraChave` all return the same 5,718 total). Narrowing is
 * therefore the collector's job, client-side. This script deliberately pulls
 * a few pages rather than one, so the recorded sample contains enough
 * variation — different states, education levels and empty-field shapes — to
 * fit a tolerant schema against.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ENDPOINT = "https://api.ciee.org.br/vagas/vitrine-vaga/publicadas";
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const OUTPUT_PATH = join(__dirname, "..", "test", "fixtures", "ciee-raw.json");
const PAGES = 3;
const PAGE_SIZE = 100;
const REQUEST_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const pages: unknown[] = [];

  for (let page = 0; page < PAGES; page += 1) {
    if (page > 0) await sleep(REQUEST_INTERVAL_MS);

    const url = new URL(ENDPOINT);
    url.searchParams.set("size", String(PAGE_SIZE));
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(
        `CIEE responded ${response.status} ${response.statusText}`,
      );
    }
    pages.push(await response.json());
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(pages, null, 2), "utf8");

  const first = pages[0] as { content?: unknown[]; totalElements?: number };
  const items = first.content ?? [];
  const sample = items[0];

  console.log(`Wrote ${pages.length} pages to ${OUTPUT_PATH}`);
  console.log(`Board reports ${first.totalElements} postings in total.`);
  console.log(
    "Envelope keys:",
    Object.keys(first as object)
      .sort()
      .join(", "),
  );
  console.log(
    "Posting keys:",
    sample && typeof sample === "object"
      ? Object.keys(sample).sort().join(", ")
      : sample,
  );

  // Which fields are ever null across the sample — the tolerant schema has to
  // allow exactly these, and guessing is what ADR-014 was written about.
  const nullable = new Set<string>();
  for (const p of pages as { content?: Record<string, unknown>[] }[]) {
    for (const item of p.content ?? []) {
      for (const [key, value] of Object.entries(item)) {
        if (value === null) nullable.add(key);
      }
    }
  }
  console.log(
    "Fields observed null at least once:",
    [...nullable].sort().join(", "),
  );
}

void main();

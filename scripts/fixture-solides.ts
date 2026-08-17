/**
 * Hits the real Sólides Vagas jobs API and records the response for schema
 * discovery. A script, never run by CI, never called by a test
 * (docs/07-testing-strategy.md) — `test/fixtures/solides-raw.json` is
 * gitignored and may embed recruiter names and real posting content.
 *
 * Endpoint found by inspecting the real network request `vagas.solides.com.br`
 * makes client-side (the page itself is a Next.js SPA whose HTML and
 * `_next/data` payload both carry no job data — the list is fetched from
 * this API after load). `take` is not configurable: any value other than 10
 * silently returns `count: 0`, verified against the live API before this
 * script was written.
 *
 * Run: npm run fixture:solides
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ENDPOINT = "https://apigw.solides.com.br/jobs/v3/portal-vacancies-new";
const USER_AGENT =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";
const OUTPUT_PATH = join(
  __dirname,
  "..",
  "test",
  "fixtures",
  "solides-raw.json",
);

async function main(): Promise<void> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("title", "estagio");
  url.searchParams.set("locations", "Rio de Janeiro - RJ");
  url.searchParams.set("take", "10");
  url.searchParams.set("page", "1");

  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Sólides responded ${response.status} ${response.statusText}`,
    );
  }

  const body: unknown = await response.json();
  writeFileSync(OUTPUT_PATH, JSON.stringify(body, null, 2), "utf8");

  const envelope = body as { data?: { data?: unknown[]; count?: number } };
  const items = envelope.data?.data ?? [];
  const first = items[0];
  console.log(`Wrote ${items.length} postings to ${OUTPUT_PATH}`);
  console.log(`Total matching (data.count): ${envelope.data?.count}`);
  console.log(
    "First item keys:",
    first && typeof first === "object" ? Object.keys(first).sort() : first,
  );
}

void main();

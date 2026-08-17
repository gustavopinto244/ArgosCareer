/**
 * Collects Catho postings via a real headless browser and pushes them to
 * argos-career's authenticated ingest endpoint.
 *
 * See docs/adr/032-catho-collector-headless-browser.md for the full
 * discovery record. Unlike Indeed (ADR-028), this collector does NOT break
 * CLAUDE.md §6's polite-collector rules: `robots.txt` only disallows
 * Catho's *search* path (`/buscar/vagas/`), which this script never
 * touches, and Playwright's real Chromium User-Agent is an honest
 * statement of what it is, not a forged one — individual posting pages
 * (`/vagas/<slug>/<id>/`) return a plain 403 to a non-browser UA but are
 * not disallowed by robots.txt at all.
 *
 * The one real cost this shape has that Gupy/Sólides don't: there is no
 * server-side search, so there is no way to ask Catho for only
 * Rio-de-Janeiro-metro internships. Every candidate posting (title-filtered
 * from the sitemap) has to be opened once to learn its real city. Bounded
 * per run (MAX_PAGES_PER_RUN) rather than run to completion in one process —
 * a state file tracks which posting IDs have already been visited
 * (ingested or found expired) so repeated runs make incremental progress
 * through the backlog instead of re-walking it, and so a normal run, once
 * the backlog is drained, only touches what's actually new.
 *
 * One run, one exit — matches the "ephemeral container" shape
 * `collectors/indeed` already established. Never on the critical path: a
 * failure here means Catho's postings are stale until the next scheduled
 * run (principle 1, extended to a source that lives outside the app
 * entirely).
 *
 * Required environment:
 *   ARGOS_API_URL   e.g. http://100.x.x.x:3000 (Atlas's Tailscale address)
 *   ARGOS_API_KEY   the same Bearer key every other API caller uses
 *
 * Optional environment (defaults below):
 *   MAX_PAGES_PER_RUN, REQUEST_INTERVAL_MS, SEEN_IDS_PATH, TITLE_PATTERN
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SITEMAP_INDEX = "https://www.catho.com.br/sitemap-index.xml";
// Only the fresh, numbered "sitemap_vagas_N.xml" set (regenerated daily,
// confirmed via discovery) — not the legacy `sitemap_vagas_emprego.xml`
// (dated 2011, company-profile URLs, not postings) and not the gzipped
// `busca-vagas/sitemapN.xml.gz` set (unconfirmed content, not fetched
// during discovery — revisit if the numbered set ever stops being enough).
const SITEMAP_ENTRY_PATTERN = /\/sitemap2\/sitemap_vagas_\d+\.xml$/;

const DEFAULT_TITLE_PATTERN =
  "estagio|estagiario|estagiaria|estágio|estagiário|estagiária|trainee";
const DEFAULT_MAX_PAGES_PER_RUN = 300;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_SEEN_IDS_PATH = "/data/catho-seen-ids.json";
const FETCH_UA =
  "ArgosCareer/0.1.0 (+https://github.com/gustavopinto244/ArgosCareer; personal internship search bot)";

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} is required`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SitemapCandidate {
  id: string;
  url: string;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": FETCH_UA } });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }
  return response.text();
}

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim());
}

/**
 * A candidate's stable ID is the numeric segment at the end of its sitemap
 * URL (`/vagas/<slug>/<id>/`) — independent of Catho's own internal "offer"
 * ID scheme, which the page never exposes to a plain sitemap read.
 */
function toCandidate(url: string): SitemapCandidate | null {
  const match = /\/vagas\/[^/]+\/(\d+)\/?$/.exec(url);
  return match ? { id: match[1]!, url } : null;
}

async function discoverCandidates(
  titlePattern: RegExp,
): Promise<SitemapCandidate[]> {
  const indexXml = await fetchText(SITEMAP_INDEX);
  const sitemapUrls = extractLocs(indexXml).filter((url) =>
    SITEMAP_ENTRY_PATTERN.test(url),
  );
  console.log(`sitemap index: ${sitemapUrls.length} vaga sitemap(s) found`);

  const candidates: SitemapCandidate[] = [];
  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchText(sitemapUrl);
    const urls = extractLocs(xml);
    for (const url of urls) {
      if (!titlePattern.test(url)) continue;
      const candidate = toCandidate(url);
      if (candidate) candidates.push(candidate);
    }
    console.log(`${sitemapUrl}: ${urls.length} urls scanned`);
  }
  return candidates;
}

function loadSeenIds(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    console.warn(
      `WARNING: could not parse ${path}, starting with an empty seen-set`,
    );
    return new Set();
  }
}

function saveSeenIds(path: string, ids: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...ids].sort()), "utf8");
}

interface CollectedPosting {
  sourceId: string;
  payload: {
    id: string;
    url: string;
    pageTitle: string;
    jobPosting: unknown;
  };
}

/**
 * Opens one posting page with a real Chromium browser and extracts its
 * `application/ld+json` `JobPosting` markup and page `<title>`.
 *
 * Returns `null` — not a throw — when the page redirects away from its own
 * URL (an expired posting falling back to the generic listing, confirmed
 * during discovery) or carries no JSON-LD at all. The caller still marks
 * the ID as seen either way: revisiting a confirmed-expired posting on the
 * next run wastes a page load for no gain.
 */
async function collectOne(
  page: import("playwright").Page,
  candidate: SitemapCandidate,
): Promise<CollectedPosting | null> {
  const response = await page.goto(candidate.url, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  if (!response || !response.ok()) return null;

  const finalUrl = page.url();
  if (!finalUrl.includes(`/${candidate.id}`)) {
    // Redirected away from its own posting path — expired, per discovery.
    return null;
  }

  const jobPosting = await page.evaluate(() => {
    const script = document.querySelector('script[type="application/ld+json"]');
    if (!script?.textContent) return null;
    try {
      return JSON.parse(script.textContent) as unknown;
    } catch {
      return null;
    }
  });
  if (!jobPosting) return null;

  const pageTitle = await page.title();

  return {
    sourceId: candidate.id,
    payload: { id: candidate.id, url: candidate.url, pageTitle, jobPosting },
  };
}

async function main(): Promise<void> {
  const titlePattern = new RegExp(
    env("TITLE_PATTERN", DEFAULT_TITLE_PATTERN),
    "i",
  );
  const maxPagesPerRun = Number(
    env("MAX_PAGES_PER_RUN", String(DEFAULT_MAX_PAGES_PER_RUN)),
  );
  const requestIntervalMs = Number(
    env("REQUEST_INTERVAL_MS", String(DEFAULT_REQUEST_INTERVAL_MS)),
  );
  const seenIdsPath = env("SEEN_IDS_PATH", DEFAULT_SEEN_IDS_PATH);
  const apiUrl = requiredEnv("ARGOS_API_URL").replace(/\/$/, "");
  const apiKey = requiredEnv("ARGOS_API_KEY");

  const seenIds = loadSeenIds(seenIdsPath);
  console.log(`seen-ids: ${seenIds.size} known from previous runs`);

  const candidates = await discoverCandidates(titlePattern);
  const unseen = candidates.filter((c) => !seenIds.has(c.id));
  console.log(
    `candidates: ${candidates.length} title-matched, ${unseen.length} not yet seen`,
  );

  const batch = unseen.slice(0, maxPagesPerRun);
  if (batch.length === 0) {
    console.log("nothing new to collect, exiting");
    return;
  }
  console.log(`collecting ${batch.length} posting(s) this run`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const postings: CollectedPosting[] = [];
  // IDs resolved either way (collected or confirmed-expired) — safe to mark
  // seen, since revisiting either wastes a page load for no gain. IDs that
  // errored transiently (timeout, network blip) are deliberately excluded:
  // they stay unseen so the next run retries them from the same candidate
  // list, rather than being silently dropped forever.
  const resolvedIds = new Set<string>();

  try {
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await sleep(requestIntervalMs);
      const candidate = batch[i]!;
      try {
        const result = await collectOne(page, candidate);
        resolvedIds.add(candidate.id);
        if (result) postings.push(result);
      } catch (error) {
        console.warn(`WARNING: ${candidate.url} failed: ${String(error)}`);
      }
    }
  } finally {
    await browser.close();
  }

  const expired = resolvedIds.size - postings.length;
  console.log(
    `done: ${postings.length} collected, ${expired} expired/redirected, ` +
      `${batch.length - resolvedIds.size} errored (will retry next run)`,
  );

  for (const id of resolvedIds) seenIds.add(id);
  saveSeenIds(seenIdsPath, seenIds);

  if (postings.length === 0) {
    console.log("nothing to ingest, exiting");
    return;
  }

  const body = {
    source: "catho",
    postings: postings.map((p) => ({
      sourceId: p.sourceId,
      payload: p.payload,
    })),
  };
  const response = await fetch(`${apiUrl}/runs/collect/external`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  console.log(`ingest: HTTP ${response.status}`);
  console.log((await response.text()).slice(0, 2000));
  if (!response.ok) process.exit(1);
}

void main();

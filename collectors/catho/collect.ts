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
 * not disallowed by robots.txt at all. Auditing this collector live
 * (`docs/audit/AUDIT-PRE-DEPLOY-2026-08-17.md`) found that Playwright's
 * default headless Chromium gets the *same* 403 Catho gives a non-browser
 * client — a deeper, fingerprint-based block this collector does not yet
 * get past. Do not deploy/schedule this until that is resolved; the
 * checkpoint fixes below are correct and worth having regardless of when
 * that happens.
 *
 * The one real cost this shape has that Gupy/Sólides don't: there is no
 * server-side search, so there is no way to ask Catho for only
 * Rio-de-Janeiro-metro internships. Every candidate posting (title-filtered
 * from the sitemap) has to be opened once to learn its real city. Bounded
 * per run (MAX_PAGES_PER_RUN) rather than run to completion in one process —
 * `state.ts`'s checkpoint tracks which posting IDs have already reached a
 * terminal or in-progress state, so repeated runs make incremental progress
 * through the backlog instead of re-walking it, and so a normal run, once
 * the backlog is drained, only touches what's actually new.
 *
 * Checkpoint semantics (`state.ts`, fixing AUDIT_REPORT.md AC-001/AC-002):
 * an ID only becomes "ingested" — permanently done — after argos-career's
 * API confirms the POST with a 2xx. A page load that fails, times out, or
 * gets a non-2xx (including the 403 above) is "retryable," not "expired":
 * only a 2xx response that lands on the bare `/vagas` listing counts as a
 * confirmed expiration. A payload that was fetched but never successfully
 * ingested stays queued in the state file and is retried on ingest alone —
 * no page reload needed — on the next run.
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
 *   MAX_PAGES_PER_RUN, REQUEST_INTERVAL_MS, STATE_PATH, TITLE_PATTERN
 */
import { chromium } from "playwright";
import {
  CathoState,
  applyPageOutcome,
  classifyPageResult,
  collectedPayloadsPendingIngest,
  isAllowedCathoUrl,
  loadState,
  markIngested,
  needsPageFetch,
  saveStateAtomic,
} from "./state";

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
const DEFAULT_STATE_PATH = "/data/catho-state.json";
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
 *
 * `isAllowedCathoUrl` runs first, before the path regex even matters
 * (docs/audit AC-034): the sitemap is an external, unauthenticated source,
 * and a compromised or malformed `<loc>` entry pointing anywhere other than
 * `https://www.catho.com.br` must never reach `page.goto` — a real SSRF
 * shape from the browser's network position, not a hypothetical one.
 */
function toCandidate(url: string): SitemapCandidate | null {
  if (!isAllowedCathoUrl(url)) return null;
  const match = /\/vagas\/[^/]+\/(\d+)\/?$/.exec(url);
  return match ? { id: match[1]!, url } : null;
}

async function discoverCandidates(
  titlePattern: RegExp,
): Promise<SitemapCandidate[]> {
  const indexXml = await fetchText(SITEMAP_INDEX);
  // `isAllowedCathoUrl` first, same discipline `toCandidate` already
  // applies to posting URLs (docs/audit PR-020) — the sitemap index is
  // fetched from a fixed, trusted URL, but its *content* is external,
  // unauthenticated data. A compromised or malformed `<loc>` entry
  // matching the path suffix alone used to be handed straight to
  // `fetchText` (a plain `fetch` from this process, not even routed
  // through Playwright), with no host check at all.
  const sitemapUrls = extractLocs(indexXml).filter(
    (url) => isAllowedCathoUrl(url) && SITEMAP_ENTRY_PATTERN.test(url),
  );
  console.log(`sitemap index: ${sitemapUrls.length} vaga sitemap(s) found`);

  const candidates: SitemapCandidate[] = [];
  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchText(sitemapUrl);
    const urls = extractLocs(xml);
    for (const url of urls) {
      if (!titlePattern.test(url)) continue;
      const candidate = toCandidate(url);
      if (candidate) {
        candidates.push(candidate);
      } else if (!isAllowedCathoUrl(url)) {
        // Never opened (AC-034) -- logged so a compromised/malformed
        // sitemap entry is visible in run output, not silently dropped.
        console.warn(`rejected candidate URL (disallowed host): ${url}`);
      }
    }
    console.log(`${sitemapUrl}: ${urls.length} urls scanned`);
  }
  return candidates;
}

/**
 * Opens one posting page with a real Chromium browser and gathers the raw
 * signals `classifyPageResult` (state.ts) needs — this function makes no
 * classification decision itself, only observes.
 */
async function loadCandidatePage(
  page: import("playwright").Page,
  candidate: SitemapCandidate,
): Promise<{
  httpStatus: number | null;
  finalUrl: string;
  jsonLd: unknown;
  pageTitle: string;
}> {
  let response;
  try {
    response = await page.goto(candidate.url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  } catch {
    return {
      httpStatus: null,
      finalUrl: candidate.url,
      jsonLd: null,
      pageTitle: "",
    };
  }
  if (!response) {
    return {
      httpStatus: null,
      finalUrl: candidate.url,
      jsonLd: null,
      pageTitle: "",
    };
  }

  const httpStatus = response.status();
  const finalUrl = page.url();
  if (httpStatus < 200 || httpStatus >= 300) {
    return { httpStatus, finalUrl, jsonLd: null, pageTitle: "" };
  }

  const jsonLd = await page.evaluate(() => {
    const script = document.querySelector('script[type="application/ld+json"]');
    if (!script?.textContent) return null;
    try {
      return JSON.parse(script.textContent) as unknown;
    } catch {
      return null;
    }
  });
  const pageTitle = await page.title();

  return { httpStatus, finalUrl, jsonLd, pageTitle };
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
  const statePath = env("STATE_PATH", DEFAULT_STATE_PATH);
  const apiUrl = requiredEnv("ARGOS_API_URL").replace(/\/$/, "");
  const apiKey = requiredEnv("ARGOS_API_KEY");

  let state: CathoState = loadState(statePath);
  console.log(
    `state: ${Object.keys(state.entries).length} known id(s) from previous runs`,
  );

  const candidates = await discoverCandidates(titlePattern);
  const eligible = candidates.filter((c) => needsPageFetch(state, c.id));
  const toFetch = eligible.slice(0, maxPagesPerRun);
  // MAX_PAGES_PER_RUN cutting real candidates is genuine truncation, not
  // the sitemap running dry (docs/audit PR-015) -- the remainder is not
  // lost, just deferred to a later run's own budget, but this run left
  // something uncollected that a later one needs to be watched for.
  const truncated = eligible.length > maxPagesPerRun;
  console.log(
    `candidates: ${candidates.length} title-matched, ${toFetch.length} need a page load this run`,
  );

  if (toFetch.length > 0) {
    console.log(`fetching ${toFetch.length} page(s) this run`);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    // Blocks a disallowed redirect *before* the request for it is ever
    // issued (docs/audit PR-020) -- checking `page.url()` only after
    // `page.goto` resolves, as `classifyPageResult` still does below, means
    // the request to the redirect target already happened by the time
    // that check runs. Every request this page makes goes through here,
    // including each hop of a redirect chain (Playwright treats them as
    // separate requests) -- fine to be this broad, since the only things
    // this collector reads are the document itself and an inline
    // `application/ld+json` script (`loadCandidatePage`), never a
    // same-page third-party resource.
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (isAllowedCathoUrl(url)) {
        await route.continue();
      } else {
        console.warn(`blocked disallowed-host request: ${url}`);
        await route.abort();
      }
    });
    const outcomeCounts = { collected: 0, expired: 0, retryable: 0 };

    try {
      for (let i = 0; i < toFetch.length; i++) {
        if (i > 0) await sleep(requestIntervalMs);
        const candidate = toFetch[i]!;
        const signals = await loadCandidatePage(page, candidate);
        const outcome = classifyPageResult({ ...signals, candidate });
        outcomeCounts[outcome.kind] += 1;
        state = applyPageOutcome(state, candidate.id, outcome);
      }
    } finally {
      await browser.close();
    }

    console.log(
      `page results: ${outcomeCounts.collected} collected, ` +
        `${outcomeCounts.expired} confirmed expired, ` +
        `${outcomeCounts.retryable} retryable (will retry, or quarantine after ` +
        `repeated failures)`,
    );
    // Durable checkpoint before attempting ingest — a payload that was
    // fetched is saved to disk now, so a crash or a failed ingest POST
    // right after this never means reopening the page (AC-001).
    saveStateAtomic(statePath, state);
  } else {
    console.log("no new pages to fetch this run");
  }

  const pending = collectedPayloadsPendingIngest(state);
  if (pending.length === 0) {
    console.log("nothing pending ingest, exiting");
    return;
  }
  console.log(`ingesting ${pending.length} payload(s) pending confirmation`);

  const body = {
    source: "catho",
    postings: pending.map((p) => ({ sourceId: p.id, payload: p })),
    truncated,
  };
  let response: Response;
  try {
    response = await fetch(`${apiUrl}/runs/collect/external`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Network failure: the payloads stay "collected" in the already-saved
    // state file — nothing to undo, next run retries the ingest alone.
    console.error(`ERROR: ingest request failed: ${String(error)}`);
    process.exit(1);
  }

  console.log(`ingest: HTTP ${response.status}`);
  console.log((await response.text()).slice(0, 2000));

  if (!response.ok) {
    // Same as a network failure — 409 (RunLock busy), 429, 5xx, or any
    // other non-2xx all leave the batch "collected," retried whole on the
    // next scheduled run (every 30 min) rather than discarded (AC-001).
    console.error(
      `ERROR: ingest not confirmed (HTTP ${response.status}) — ${pending.length} ` +
        `payload(s) stay queued for the next run`,
    );
    process.exit(1);
  }

  state = markIngested(
    state,
    pending.map((p) => p.id),
  );
  saveStateAtomic(statePath, state);
  console.log(`confirmed: ${pending.length} payload(s) marked ingested`);
}

void main();

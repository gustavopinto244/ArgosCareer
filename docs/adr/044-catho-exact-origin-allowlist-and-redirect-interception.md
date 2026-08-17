# ADR-044 — Exact-origin allowlist and redirect interception for the Catho collector

## Status

Accepted

## Date

2026-08-17

## Context

`collectors/catho/collect.ts` runs a real headless browser (ADR-032)
against URLs read out of Catho's own sitemap XML — external, unauthenticated
data this project does not control. An earlier fix (`AUDIT_REPORT.md`
AC-034) added `isAllowedCathoUrl` (`state.ts`) and applied it to every
sitemap-derived posting candidate before `page.goto`, closing the most
obvious shape of the risk: a compromised or malformed `<loc>` entry
pointing the browser somewhere other than Catho.

A post-remediation audit (`docs/audit`, PR-020) found the fix incomplete in
three ways, all still real SSRF-shaped access from the collector's network
position:

1. **Child sitemap URLs were never checked at all.** `discoverCandidates`
   fetches the sitemap index from a fixed, trusted `SITEMAP_INDEX`
   constant, then reads `<loc>` entries out of _its_ content — the actual
   child sitemap URLs — and filtered those only by a path-suffix regex
   (`SITEMAP_ENTRY_PATTERN`), never by host, before handing them to a plain
   `fetch()`. The same class of untrusted `<loc>` entry AC-034 fixed for
   posting candidates was still live one level up.
2. **The allowlist didn't check the port.** `isAllowedCathoUrl`'s own
   docstring claimed "exactly `https://www.catho.com.br`, nothing else,"
   but checked only `URL.hostname`, which never includes the port —
   `https://www.catho.com.br:9999/...` passed.
3. **A redirect's target was fetched before it was checked.** `page.goto`
   follows a server-side redirect transparently; `classifyPageResult`
   checks `page.url()` (the _final_ URL) only after navigation completes.
   By the time that check ran, the request to wherever the redirect
   pointed had already happened, and `loadCandidatePage` had already run
   `page.evaluate` against whatever page loaded.

## Considered options

### Leave child-sitemap fetching unchecked, since `SITEMAP_INDEX` itself is trusted

Rejected — the constant being trusted says nothing about its _content_.
The whole reason AC-034 exists is that this project fetches Catho's
sitemap XML precisely because it does not control it; the index and its
children are the same trust boundary.

### Check `finalUrl` after navigation only (status quo)

Rejected as insufficient, not wrong — the existing `isAllowedCathoUrl(finalUrl)`
check in `classifyPageResult` stays and still matters as a second layer.
But "checked after the fact" cannot prevent the request itself, which is
the actual resource the SSRF concern is about — a redirect target inside
Atlas's network already received one HTTP request by the time this check
runs, regardless of what the collector does next.

### Exact-origin allowlist (port included) plus Playwright request interception (chosen)

`isAllowedCathoUrl` gains a port check. Sitemap child URLs go through the
same function sitemap-derived candidates already did. `page.route("**/*", ...)`
intercepts every request the page makes — including each hop of a
redirect chain, which Playwright models as separate requests — and aborts
anything not matching the exact allowed origin _before_ it is issued.

## Decision

- **`isAllowedCathoUrl`** (`state.ts`) now also requires `parsed.port === ""`
  — the scheme-default-port sentinel `URL` itself normalizes to, so
  `https://www.catho.com.br:443/...` still passes (explicit default port
  stated) and any other port does not.
- **`discoverCandidates`** (`collect.ts`) filters sitemap child URLs with
  `isAllowedCathoUrl(url) && SITEMAP_ENTRY_PATTERN.test(url)`, the host
  check first, before any of them reach `fetchText`.
- **`page.route("**/*", ...)`**, installed once per page right after
  `browser.newPage()`, `route.abort()`s any request whose URL fails
  `isAllowedCathoUrl` and `route.continue()`s the rest, logging a warning
  for every blocked request. Safe to be this broad — `loadCandidatePage`
  only ever reads the document itself and an inline
  `application/ld+json` script tag, never a same-page third-party
  resource, and navigation uses `waitUntil: "domcontentloaded"`, not
  `networkidle`, so nothing this collector needs depends on a third-party
  request succeeding.
- `classifyPageResult`'s existing post-navigation `isAllowedCathoUrl(finalUrl)`
  check is unchanged and stays as a second, independent layer — request
  interception blocks the _fetch_, the final-URL check catches anything
  that somehow still lands off-host (a same-origin response that sets
  `document.location` via JavaScript rather than an HTTP redirect, for
  instance, which `page.route` alone would not see).

## Consequences

- **Real cost: a legitimate off-host resource on an otherwise-genuine
  Catho page now fails to load**, rather than merely being irrelevant to
  what this collector reads. Given what `loadCandidatePage` actually uses
  (document HTML + one inline script tag), this is expected to be
  invisible in practice, but is a real behavior change worth naming
  plainly rather than hiding.
- **No test coverage for the two `collect.ts` changes** (sitemap child-URL
  filtering, `page.route` interception) — consistent with the existing
  gap this file already has: `collect.ts`'s `main()` orchestration has no
  unit test today, only `state.ts`'s pure functions do
  (`state.test.ts`). The port-check hardening in `isAllowedCathoUrl`
  itself is fully covered there.
- **Reversal cost:** low. The port check is one added clause; the
  sitemap-filter change is one added condition; `page.route` is a single
  self-contained block removable without touching anything else in
  `main()`.

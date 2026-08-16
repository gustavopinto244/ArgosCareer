/**
 * Express's default JSON body limit (100kb) rejected the Indeed collector's
 * first real batch outright — 50 postings' full descriptions comfortably
 * exceed it (ADR-027's ingest endpoint). Every other route on this app
 * sends a small, structural body; only this one carries a batch of
 * externally-collected postings, so a generous shared limit costs nothing
 * elsewhere and avoids a second body-parser config just for one route.
 *
 * Its own module, not defined inline in `main.ts`: that file runs
 * `bootstrap()` as a top-level side effect with no `require.main === module`
 * guard, so importing anything from it — even just a constant — boots the
 * real application. The test suite needs this exact value (to prove the
 * limit is what's actually configured, not the framework default hiding a
 * regression) without that side effect.
 */
export const JSON_BODY_LIMIT = "10mb";

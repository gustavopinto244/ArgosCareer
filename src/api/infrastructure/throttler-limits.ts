/**
 * Rate limits for the shared-bearer-key API boundary (docs/audit AC-021):
 * one key authorizes n8n, host-side collectors and Hermes alike, and a
 * leaked key previously had no request-rate ceiling at all — the caller
 * could hit `/runs/deliver` (real OpenRouter spend, a real Telegram send)
 * or `/runs/collect/external` (up to a 10 MB batch, ADR-027) in a tight
 * loop with nothing to slow it down beyond `RunLock`'s "not two at once,"
 * which says nothing about back-to-back sequential calls.
 *
 * Deliberately not a full per-caller credential scope (ADR-017's own
 * documented upgrade path — Cloudflare Access/JWT — "if a second consumer
 * or public exposure ever arrives, not built now"): this project has one
 * trusted operator behind every caller sharing the key, so the goal here
 * is bounding blast radius from a leak, not distinguishing legitimate
 * callers from each other.
 */

/** Applied globally, to every route, via `ThrottlerModule.forRoot` — a
 * generous ceiling for ordinary read/write traffic (`GET /runs`, `POST
 * /runs/discard`, MCP tool calls), not tuned around any one endpoint. */
export const DEFAULT_THROTTLER_TTL_MS = 60_000;
export const DEFAULT_THROTTLER_LIMIT = 20;

/**
 * Enforced in `RunsService.enforceExpensiveOperationLimit`, not via
 * `@Throttle` on `RunsController` — `collect`/`deliver`/`ingestExternal`
 * are each also reachable through `McpController`'s single `/mcp` route,
 * where a per-HTTP-route decorator on `RunsController` alone would never
 * see MCP-triggered calls at all. A shared `ThrottlerStorage.increment`
 * call, keyed per operation, means a REST call and an MCP tool call
 * against the same operation draw from the same budget.
 *
 * Sized against real usage, not arbitrarily tight — the nightly scheduler
 * calls each of `collect`/`deliver` at most once per cycle (ADR-009), and
 * a host-side collector timer fires at most a few times a day, so three
 * calls in ten minutes is already several multiples of any legitimate
 * pattern.
 */
export const EXPENSIVE_THROTTLE = {
  limit: 3,
  ttl: 10 * 60_000,
};

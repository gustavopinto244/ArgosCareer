/**
 * Protects a shared transport (one `OpenRouterClient` per run, docs/audit
 * AC-016) from being hammered by many concurrent Stage B requirement calls
 * (ADR-022) when the provider itself is down, not just the one request in
 * front of it. Without this, `runBounded`'s workers each independently
 * retry-with-backoff their own call, and the aggregate request rate across
 * all of them can still amount to a storm against a provider that is
 * already failing systemically.
 *
 * Deliberately NOT per-operation: one instance lives inside `OpenRouterClient`
 * and is shared by every call that client makes, across both Stage A and
 * Stage B, because "the provider is down" is a fact about the transport, not
 * about any one posting or requirement.
 */
export type CircuitState = "closed" | "open" | "half_open";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreakerOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(
      `Circuit breaker open (provider treated as systemically failing) — retry after ${retryAfterMs}ms`,
    );
    this.name = "CircuitBreakerOpenError";
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive transient failures required to open the circuit. */
  readonly failureThreshold?: number;
  /** How long the circuit stays open before allowing one trial call through. */
  readonly cooldownMs?: number;
  /** Injectable clock (ms epoch) — tests never wait a real 30s cooldown. */
  readonly now?: () => number;
}

/**
 * A standard closed/open/half-open breaker. Only *transient* failures
 * (`isTransientFailure` in `openrouter-client.ts`) count toward opening it —
 * a single posting's bad API key is a config problem local to that request,
 * not evidence the provider is down for everyone, so `onFailure(false)` is a
 * no-op rather than something that should ever be able to trip the breaker.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Call before making the real request. Throws `CircuitBreakerOpenError`
   * to short-circuit the call entirely — no network reached, no attempt
   * counted — while the cooldown has not yet elapsed. Once it has, allows
   * exactly one trial call through (half-open) without resetting the
   * failure count, so a single lucky success does not immediately re-arm a
   * still-failing provider.
   */
  beforeCall(): void {
    if (this.state !== "open") return;
    const elapsed = this.now() - this.openedAt;
    if (elapsed < this.cooldownMs) {
      throw new CircuitBreakerOpenError(this.cooldownMs - elapsed);
    }
    this.state = "half_open";
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  onFailure(transient: boolean): void {
    if (!transient) return;

    if (this.state === "half_open") {
      // The trial call also failed -- the provider is still down. Re-open
      // and restart the cooldown rather than requiring the full threshold
      // to accumulate again.
      this.state = "open";
      this.openedAt = this.now();
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }
}

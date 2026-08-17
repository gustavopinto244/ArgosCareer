import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../../../src/scoring/infrastructure/circuit-breaker";

describe("CircuitBreaker", () => {
  it("stays closed and never throws while failures stay below the threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    breaker.onFailure(true);
    breaker.onFailure(true);
    expect(() => breaker.beforeCall()).not.toThrow();
    expect(breaker.getState()).toBe("closed");
  });

  it("opens after the failure threshold is reached, blocking further calls", () => {
    const clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 10_000,
      now: () => clock,
    });

    breaker.onFailure(true);
    breaker.onFailure(true);
    breaker.onFailure(true);

    expect(breaker.getState()).toBe("open");
    expect(() => breaker.beforeCall()).toThrow(CircuitBreakerOpenError);
  });

  it("does not count a non-transient (permanent) failure toward the threshold", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });

    breaker.onFailure(false);
    breaker.onFailure(false);
    breaker.onFailure(false);

    expect(breaker.getState()).toBe("closed");
    expect(() => breaker.beforeCall()).not.toThrow();
  });

  it("a success resets the consecutive failure count", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });

    breaker.onFailure(true);
    breaker.onFailure(true);
    breaker.onSuccess();
    breaker.onFailure(true);
    breaker.onFailure(true);

    // Two failures since the reset -- still below the threshold of 3.
    expect(breaker.getState()).toBe("closed");
  });

  it("reports the remaining cooldown on CircuitBreakerOpenError", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: () => clock,
    });

    breaker.onFailure(true);
    clock = 4_000;

    let error: unknown;
    try {
      breaker.beforeCall();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(CircuitBreakerOpenError);
    expect((error as CircuitBreakerOpenError).retryAfterMs).toBe(6_000);
  });

  it("allows exactly one trial call through once the cooldown elapses (half-open)", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: () => clock,
    });

    breaker.onFailure(true);
    clock = 10_000;

    expect(() => breaker.beforeCall()).not.toThrow();
    expect(breaker.getState()).toBe("half_open");
  });

  it("a successful trial call closes the breaker and resets the failure count", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: () => clock,
    });

    breaker.onFailure(true);
    clock = 10_000;
    breaker.beforeCall();
    breaker.onSuccess();

    expect(breaker.getState()).toBe("closed");
    expect(() => breaker.beforeCall()).not.toThrow();
  });

  it("a failed trial call reopens the breaker and restarts the cooldown", () => {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      now: () => clock,
    });

    breaker.onFailure(true);
    clock = 10_000;
    breaker.beforeCall(); // half-open trial
    breaker.onFailure(true); // trial failed

    expect(breaker.getState()).toBe("open");
    // Cooldown restarted from clock=10_000, not still counting from 0.
    clock = 15_000;
    expect(() => breaker.beforeCall()).toThrow(CircuitBreakerOpenError);
    clock = 20_000;
    expect(() => breaker.beforeCall()).not.toThrow();
  });
});

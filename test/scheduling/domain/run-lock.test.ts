import { describe, expect, it } from "vitest";
import { RunLock, runExclusive } from "../../../src/scheduling/domain/run-lock";

describe("RunLock", () => {
  it("acquires a free kind and reports it active", () => {
    const lock = new RunLock();
    expect(lock.tryAcquire("collect")).toBe(true);
    expect(lock.isActive("collect")).toBe(true);
  });

  it("refuses to acquire a kind already held", () => {
    const lock = new RunLock();
    lock.tryAcquire("collect");
    expect(lock.tryAcquire("collect")).toBe(false);
  });

  it("different kinds do not contend with each other", () => {
    const lock = new RunLock();
    expect(lock.tryAcquire("collect")).toBe(true);
    expect(lock.tryAcquire("dedup")).toBe(true);
    expect(lock.tryAcquire("scoreAndDeliver")).toBe(true);
  });

  it("becomes acquirable again after release", () => {
    const lock = new RunLock();
    lock.tryAcquire("collect");
    lock.release("collect");
    expect(lock.isActive("collect")).toBe(false);
    expect(lock.tryAcquire("collect")).toBe(true);
  });

  it("releasing a kind that was never held is a no-op, not an error", () => {
    const lock = new RunLock();
    expect(() => lock.release("collect")).not.toThrow();
    expect(lock.isActive("collect")).toBe(false);
  });
});

describe("runExclusive", () => {
  it("runs fn and returns its result when the kind is free", async () => {
    const lock = new RunLock();
    const result = await runExclusive(lock, "collect", async () => 42);
    expect(result).toEqual({ ok: true, result: 42 });
  });

  it("returns { ok: false } without calling fn when the kind is already held", async () => {
    const lock = new RunLock();
    lock.tryAcquire("collect");
    let called = false;

    const result = await runExclusive(lock, "collect", async () => {
      called = true;
      return 1;
    });

    expect(result).toEqual({ ok: false });
    expect(called).toBe(false);
  });

  it("releases the lock after fn resolves, allowing a subsequent call", async () => {
    const lock = new RunLock();
    await runExclusive(lock, "collect", async () => "first");

    const second = await runExclusive(lock, "collect", async () => "second");
    expect(second).toEqual({ ok: true, result: "second" });
  });

  it("releases the lock even when fn throws, rather than holding it forever", async () => {
    // The exact regression class ADR-024 exists to avoid repeating —
    // #49 fixed a throw leaving a *run row* open forever; the lock must not
    // reintroduce the same shape of bug at a different layer.
    const lock = new RunLock();

    await expect(
      runExclusive(lock, "scoreAndDeliver", async () => {
        throw new Error("prompt template missing");
      }),
    ).rejects.toThrow("prompt template missing");

    expect(lock.isActive("scoreAndDeliver")).toBe(false);
    const after = await runExclusive(
      lock,
      "scoreAndDeliver",
      async () => "recovered",
    );
    expect(after).toEqual({ ok: true, result: "recovered" });
  });

  it("two concurrent callers for the same kind: only one actually runs fn", async () => {
    const lock = new RunLock();
    let inFlight = 0;
    let peak = 0;

    const task = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return "done";
    };

    const [a, b] = await Promise.all([
      runExclusive(lock, "scoreAndDeliver", task),
      runExclusive(lock, "scoreAndDeliver", task),
    ]);

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(peak).toBe(1);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import {
  parsePostingEventMetadata,
  PostingEventsRepository,
} from "../../src/persistence/infrastructure/posting-events-repository";

let dir: string;
let repository: PostingEventsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-posting-events-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new PostingEventsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PostingEventsRepository", () => {
  it("records an event and finds it by run", () => {
    repository.record({
      runId: "run-1",
      fingerprint: "fp-1",
      stage: "prefilter",
      outcome: "rejected",
      reason: "title_blocked",
      criteriaHash: "abc123",
      occurredAt: new Date("2026-08-14T03:00:00Z"),
    });

    const rows = repository.findByRun("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-1",
      fingerprint: "fp-1",
      stage: "prefilter",
      outcome: "rejected",
      reason: "title_blocked",
      criteriaHash: "abc123",
    });
    expect(rows[0]?.occurredAt).toEqual(new Date("2026-08-14T03:00:00Z"));
  });

  it("defaults reason and criteriaHash to null when omitted", () => {
    repository.record({
      runId: "run-1",
      fingerprint: "fp-1",
      stage: "delivery",
      outcome: "delivered",
      occurredAt: new Date(),
    });

    const [row] = repository.findByRun("run-1");
    expect(row?.reason).toBeNull();
    expect(row?.criteriaHash).toBeNull();
  });

  it("records raw rejection identity and structured metadata before a fingerprint exists", () => {
    repository.record({
      runId: "run-1",
      source: "indeed",
      sourceId: "raw-17",
      stage: "normalize",
      outcome: "rejected",
      reason: "invalid_publication_date",
      metadata: { schemaVersion: 1, queryIndex: 2 },
      occurredAt: new Date(),
    });

    const [row] = repository.findByRun("run-1");
    expect(row).toMatchObject({
      fingerprint: null,
      source: "indeed",
      sourceId: "raw-17",
    });
    expect(parsePostingEventMetadata(row!)).toEqual({
      schemaVersion: 1,
      queryIndex: 2,
    });
    expect(parsePostingEventMetadata({ metadata: "not json" })).toBeNull();
  });

  it("findByRun only returns events for that run", () => {
    repository.record({
      runId: "run-1",
      fingerprint: "fp-1",
      stage: "prefilter",
      outcome: "passed",
      occurredAt: new Date(),
    });
    repository.record({
      runId: "run-2",
      fingerprint: "fp-2",
      stage: "prefilter",
      outcome: "passed",
      occurredAt: new Date(),
    });

    expect(repository.findByRun("run-1")).toHaveLength(1);
    expect(repository.findByRun("run-2")).toHaveLength(1);
  });

  it("findByFingerprint returns a posting's history across runs, most recent first", () => {
    repository.record({
      runId: "run-1",
      fingerprint: "fp-1",
      stage: "prefilter",
      outcome: "rejected",
      reason: "expired",
      occurredAt: new Date("2026-08-10T03:00:00Z"),
    });
    repository.record({
      runId: "run-2",
      fingerprint: "fp-1",
      stage: "prefilter",
      outcome: "passed",
      occurredAt: new Date("2026-08-14T03:00:00Z"),
    });

    const history = repository.findByFingerprint("fp-1");
    expect(history).toHaveLength(2);
    expect(history[0]?.runId).toBe("run-2");
    expect(history[1]?.runId).toBe("run-1");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPosting } from "../../src/posting/domain/posting";
import {
  createDatabase,
  runMigrations,
} from "../../src/persistence/infrastructure/db";
import { PostingsRepository } from "../../src/persistence/infrastructure/postings-repository";

// Real temporary SQLite files, not a mock (docs/07-testing-strategy.md).
let dir: string;
let repository: PostingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-postings-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new PostingsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function posting(overrides: Partial<Parameters<typeof createPosting>[0]> = {}) {
  return createPosting({
    source: "gupy",
    sourceId: "123",
    company: "Empresa X",
    title: "Estágio Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: new Date("2026-08-14T03:00:00Z"),
    firstSeenAt: new Date("2026-08-14T03:00:00Z"),
    lastSeenAt: new Date("2026-08-14T03:00:00Z"),
    rawPayload: { id: 123 },
    ...overrides,
  });
}

describe("PostingsRepository.upsert", () => {
  it("inserts a new posting, reporting wasNew: true", () => {
    const result = repository.upsert(posting());
    expect(result.wasNew).toBe(true);
    expect(repository.count()).toBe(1);
  });

  it("a second upsert of the same fingerprint leaves firstSeenAt unchanged and moves lastSeenAt — the mandated ADR-007 amendment test", () => {
    const first = repository.upsert(
      posting({
        collectedAt: new Date("2026-08-10T03:00:00Z"),
        firstSeenAt: new Date("2026-08-10T03:00:00Z"),
        lastSeenAt: new Date("2026-08-10T03:00:00Z"),
      }),
    );

    const second = repository.upsert(
      posting({
        collectedAt: new Date("2026-08-14T03:00:00Z"),
        firstSeenAt: new Date("2026-08-14T03:00:00Z"),
        lastSeenAt: new Date("2026-08-14T03:00:00Z"),
      }),
    );

    expect(second.wasNew).toBe(false);
    expect(second.posting.firstSeenAt).toEqual(first.posting.firstSeenAt);
    expect(second.posting.firstSeenAt).toEqual(
      new Date("2026-08-10T03:00:00Z"),
    );
    expect(second.posting.lastSeenAt).toEqual(new Date("2026-08-14T03:00:00Z"));
    expect(repository.count()).toBe(1);
  });

  it("a third upsert continues to preserve the original firstSeenAt", () => {
    repository.upsert(
      posting({ firstSeenAt: new Date("2026-08-01T00:00:00Z") }),
    );
    repository.upsert(
      posting({ firstSeenAt: new Date("2026-08-05T00:00:00Z") }),
    );
    const third = repository.upsert(
      posting({ firstSeenAt: new Date("2026-08-10T00:00:00Z") }),
    );

    expect(third.posting.firstSeenAt).toEqual(new Date("2026-08-01T00:00:00Z"));
  });

  it("updates non-identity fields on a re-sighting — a posting can be edited by the employer", () => {
    repository.upsert(posting({ title: "Estágio Backend" }));
    const second = repository.upsert(
      // Same fingerprint requires same company/title/city, so change
      // something that does not participate in the fingerprint instead.
      posting({ workMode: "remote" }),
    );

    expect(second.posting.workMode).toBe("remote");
  });

  it("keeps two postings with different fingerprints as separate rows", () => {
    repository.upsert(posting({ sourceId: "1" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));

    expect(repository.count()).toBe(2);
  });

  it("retains the raw payload across an upsert", () => {
    const result = repository.upsert(
      posting({ rawPayload: { id: 123, note: "original" } }),
    );
    expect(result.posting.rawPayload).toEqual({ id: 123, note: "original" });
  });
});

describe("PostingsRepository.findByFingerprint / findByCompany", () => {
  it("finds a stored posting by fingerprint", () => {
    const { posting: stored } = repository.upsert(posting());
    const found = repository.findByFingerprint(stored.fingerprint);
    expect(found?.company).toBe("Empresa X");
  });

  it("returns null for a fingerprint that was never stored", () => {
    expect(repository.findByFingerprint("does-not-exist")).toBeNull();
  });

  it("finds every posting from a given company", () => {
    repository.upsert(posting({ sourceId: "1", title: "Estágio Backend" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));
    repository.upsert(
      posting({ sourceId: "3", company: "Outra Empresa", title: "Estágio X" }),
    );

    expect(repository.findByCompany("Empresa X")).toHaveLength(2);
  });
});

describe("PostingsRepository — nothing is ever deleted", () => {
  it("upserting one posting does not remove an unrelated one", () => {
    repository.upsert(posting({ sourceId: "1" }));
    repository.upsert(posting({ sourceId: "2", title: "Estágio Frontend" }));

    repository.upsert(posting({ sourceId: "1" }));

    expect(repository.count()).toBe(2);
  });

  it("markDuplicate flags a row without removing it — rejected postings are retained, not deleted", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );

    repository.markDuplicate(b.posting.fingerprint, a.posting.fingerprint);

    expect(repository.count()).toBe(2);
    expect(repository.findByFingerprint(b.posting.fingerprint)).not.toBeNull();
  });
});

describe("PostingsRepository.findUnnotified / markNotified", () => {
  it("includes a freshly upserted posting", () => {
    repository.upsert(posting());
    expect(repository.findUnnotified()).toHaveLength(1);
  });

  it("excludes a posting once markNotified has run — never notified twice", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.markNotified(stored.fingerprint, new Date());

    expect(repository.findUnnotified()).toHaveLength(0);
    expect(
      repository
        .findUnnotified()
        .find((p) => p.fingerprint === stored.fingerprint),
    ).toBeUndefined();
  });

  it("re-upserting a notified posting does not un-notify it", () => {
    const { posting: stored } = repository.upsert(posting());
    repository.markNotified(
      stored.fingerprint,
      new Date("2026-08-10T00:00:00Z"),
    );

    repository.upsert(posting({ workMode: "remote" }));

    expect(repository.findUnnotified()).toHaveLength(0);
  });

  it("excludes a posting already flagged as a duplicate, even if unnotified", () => {
    const a = repository.upsert(posting({ sourceId: "1" }));
    const b = repository.upsert(
      posting({ sourceId: "2", title: "Estágio Frontend" }),
    );
    repository.markDuplicate(b.posting.fingerprint, a.posting.fingerprint);

    const unnotified = repository.findUnnotified();
    expect(unnotified).toHaveLength(1);
    expect(unnotified[0]?.fingerprint).toBe(a.posting.fingerprint);
  });
});

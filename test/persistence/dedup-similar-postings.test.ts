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
import {
  DEFAULT_DEDUP_CONFIG,
  dedupSimilarPostings,
} from "../../src/persistence/application/dedup-similar-postings";

let dir: string;
let repository: PostingsRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "argos-dedup-"));
  const db = createDatabase(join(dir, "argos.db"));
  runMigrations(db);
  repository = new PostingsRepository(db);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insert(overrides: Partial<Parameters<typeof createPosting>[0]>) {
  const posting = createPosting({
    source: "gupy",
    sourceId: overrides.sourceId ?? "1",
    company: "Empresa X",
    title: "Estágio Backend",
    location: { kind: "known", city: "Rio de Janeiro" },
    workMode: "hybrid",
    collectedAt: new Date("2026-08-10T00:00:00Z"),
    firstSeenAt: new Date("2026-08-10T00:00:00Z"),
    lastSeenAt: new Date("2026-08-10T00:00:00Z"),
    rawPayload: {},
    ...overrides,
  });
  return repository.upsert(posting).posting;
}

describe("dedupSimilarPostings", () => {
  it("marks a same-company, similarly-titled, in-window posting as a duplicate", () => {
    const canonical = insert({ sourceId: "1", title: "Estágio Back-End" });
    insert({
      sourceId: "2",
      title: "Estágio Back End (Rio de Janeiro)",
      firstSeenAt: new Date("2026-08-12T00:00:00Z"),
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.scanned).toBe(2);
    expect(outcome.markedDuplicate).toBe(1);

    const active = repository.findActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.fingerprint).toBe(canonical.fingerprint);
  });

  it("does not mark postings from different companies as duplicates, regardless of title", () => {
    insert({ sourceId: "1", company: "Empresa X", title: "Estágio Backend" });
    insert({ sourceId: "2", company: "Empresa Y", title: "Estágio Backend" });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.markedDuplicate).toBe(0);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("does not mark same-company postings with dissimilar titles as duplicates", () => {
    insert({ sourceId: "1", title: "Estágio Backend" });
    insert({ sourceId: "2", title: "Vendedor de Loja" });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.markedDuplicate).toBe(0);
  });

  it("does not mark a similar posting outside the time window as a duplicate", () => {
    insert({
      sourceId: "1",
      title: "Estágio Back-End",
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    });
    insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-01T00:00:00Z"),
    });

    const outcome = dedupSimilarPostings(repository, {
      ...DEFAULT_DEDUP_CONFIG,
      windowDays: 14,
    });

    expect(outcome.markedDuplicate).toBe(0);
  });

  it("keeps the earliest-seen posting as canonical, regardless of insertion order", () => {
    insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-12T00:00:00Z"),
    });
    const earlier = insert({
      sourceId: "1",
      title: "Estágio Back-End",
      firstSeenAt: new Date("2026-08-10T00:00:00Z"),
    });

    dedupSimilarPostings(repository);

    const active = repository.findActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.fingerprint).toBe(earlier.fingerprint);
  });

  it("is a no-op the second time it runs over the same corpus — independently re-runnable without re-collecting", () => {
    insert({ sourceId: "1", title: "Estágio Back-End" });
    insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-11T00:00:00Z"),
    });

    const first = dedupSimilarPostings(repository);
    const second = dedupSimilarPostings(repository);

    expect(first.markedDuplicate).toBe(1);
    expect(second.markedDuplicate).toBe(0);
    expect(second.scanned).toBe(1);
  });

  it("never deletes a row — a marked duplicate is still findable by fingerprint", () => {
    insert({ sourceId: "1", title: "Estágio Back-End" });
    const duplicate = insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-11T00:00:00Z"),
    });

    dedupSimilarPostings(repository);

    expect(repository.findByFingerprint(duplicate.fingerprint)).not.toBeNull();
    expect(repository.count()).toBe(2);
  });
});

describe("dedupSimilarPostings — locations must not contradict", () => {
  // The bug this covers, measured on the real corpus 2026-08-16: 267 of 406
  // marked duplicates were postings in DIFFERENT cities. A company hiring
  // the same role in two cities is hiring twice, and flagging one discards a
  // real opening — including a "Pessoa Desenvolvedora Backend Python" in Rio.

  it("does not merge the same role at the same company in two cities", () => {
    insert({
      sourceId: "1",
      title: "Consultor de Desenvolvimento",
      location: { kind: "known", city: "São Paulo" },
    });
    insert({
      sourceId: "2",
      title: "Consultor de Desenvolvimento",
      location: { kind: "known", city: "Belo Horizonte" },
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.markedDuplicate).toBe(0);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("still merges the same role at the same company in the same city", () => {
    // Titles must differ after normalization, or layer 1 catches them on the
    // fingerprint and layer 2 never gets a look — "Backend" and "Back-end"
    // normalize identically, which is itself the point of layer 1.
    insert({ sourceId: "1", title: "Estágio em Desenvolvimento Backend" });
    insert({
      sourceId: "2",
      title: "Estágio em Desenvolvimento Backend Júnior",
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.markedDuplicate).toBe(1);
  });

  it("does not merge when only one side states a city", () => {
    // Exactly the shape that ate the real Backend Python posting: the
    // canonical had no city at all, so nothing contradicted and everything
    // merged. Unknown is not agreement.
    insert({
      sourceId: "1",
      title: "Pessoa Desenvolvedora Backend Python",
      location: { kind: "unknown" },
    });
    insert({
      sourceId: "2",
      title: "Pessoa Desenvolvedora Backend Python",
      location: { kind: "known", city: "Rio de Janeiro" },
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.markedDuplicate).toBe(0);
  });

  it("merges when both sides are equally unknown — nothing contradicts", () => {
    insert({
      sourceId: "1",
      title: "Estágio em Dados",
      location: { kind: "unknown" },
    });
    insert({
      sourceId: "2",
      title: "Estágio em Dados Analytics",
      location: { kind: "unknown" },
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.markedDuplicate).toBe(1);
  });
});

describe("PostingsRepository.clearDuplicateFlags", () => {
  it("restores flagged postings whole, so a corrected pass can re-decide", () => {
    insert({ sourceId: "1", title: "Estágio em Dados" });
    insert({ sourceId: "2", title: "Estágio em Dados Analytics" });
    dedupSimilarPostings(repository);
    expect(repository.findActive()).toHaveLength(1);

    const cleared = repository.clearDuplicateFlags();

    // Nothing was ever deleted — markDuplicate only sets a column — so the
    // posting comes back intact rather than needing re-collection.
    expect(cleared).toBe(1);
    expect(repository.findActive()).toHaveLength(2);
  });
});

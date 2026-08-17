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

// Shadow mode (docs/audit PR-006, ADR-010 Amendment 3): layer 2 no longer
// calls `markDuplicate`. Every match is logged as a `shadowCandidate`
// instead, and both postings stay active — `markedDuplicate` is always 0
// and `findActive()` never excludes anything this function touches.
describe("dedupSimilarPostings", () => {
  it("logs a same-company, similarly-titled, in-window posting as a shadow candidate, without excluding either posting", () => {
    const canonical = insert({ sourceId: "1", title: "Estágio Back-End" });
    const candidate = insert({
      sourceId: "2",
      title: "Estágio Back End (Rio de Janeiro)",
      firstSeenAt: new Date("2026-08-12T00:00:00Z"),
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.scanned).toBe(2);
    expect(outcome.markedDuplicate).toBe(0);
    expect(outcome.shadowCandidates).toEqual([
      expect.objectContaining({
        candidateFingerprint: candidate.fingerprint,
        canonicalFingerprint: canonical.fingerprint,
      }),
    ]);

    const active = repository.findActive();
    expect(active).toHaveLength(2);
  });

  it("does not log postings from different companies as shadow candidates, regardless of title", () => {
    insert({ sourceId: "1", company: "Empresa X", title: "Estágio Backend" });
    insert({ sourceId: "2", company: "Empresa Y", title: "Estágio Backend" });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toHaveLength(0);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("groups a company with a legal-entity suffix together with its bare name, so cross-source variants are compared (docs/audit AC-014)", () => {
    // The real scenario: "Empresa X" on LinkedIn, "Empresa X S.A." on Gupy
    // -- the same real company, one source stating the legal suffix and the
    // other omitting it. Previously grouped separately, so this pair was
    // never even title-compared.
    const canonical = insert({
      sourceId: "1",
      company: "Empresa X",
      title: "Estágio Back-End",
    });
    const candidate = insert({
      sourceId: "2",
      company: "Empresa X S.A.",
      title: "Estágio Back End (Rio de Janeiro)",
      firstSeenAt: new Date("2026-08-12T00:00:00Z"),
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toEqual([
      expect.objectContaining({
        candidateFingerprint: candidate.fingerprint,
        canonicalFingerprint: canonical.fingerprint,
      }),
    ]);
  });

  it("still keeps two genuinely different companies apart even when one carries a legal suffix", () => {
    insert({
      sourceId: "1",
      company: "Empresa X S.A.",
      title: "Estágio Backend",
    });
    insert({
      sourceId: "2",
      company: "Empresa Y S.A.",
      title: "Estágio Backend",
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toHaveLength(0);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("does not log same-company postings with dissimilar titles as shadow candidates", () => {
    insert({ sourceId: "1", title: "Estágio Backend" });
    insert({ sourceId: "2", title: "Vendedor de Loja" });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toHaveLength(0);
  });

  it("does not match two unrelated same-company postings whose titles are both pure stopwords (docs/audit AC-011)", () => {
    // The real false-positive this guards against: "Estágio" and "Trainee"
    // both reduce to nothing once stopwords are stripped, and used to score
    // a perfect 1 (identical) -- merging a technical internship with an
    // unrelated corporate trainee program at the same company.
    insert({ sourceId: "1", title: "Estágio" });
    insert({
      sourceId: "2",
      title: "Trainee",
      firstSeenAt: new Date("2026-08-12T00:00:00Z"),
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toHaveLength(0);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("does not log a similar posting outside the time window as a shadow candidate", () => {
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

    expect(outcome.shadowCandidates).toHaveLength(0);
  });

  it("names the earliest-seen posting as canonical in the shadow candidate, regardless of insertion order", () => {
    const later = insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-12T00:00:00Z"),
    });
    const earlier = insert({
      sourceId: "1",
      title: "Estágio Back-End",
      firstSeenAt: new Date("2026-08-10T00:00:00Z"),
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toEqual([
      expect.objectContaining({
        canonicalFingerprint: earlier.fingerprint,
        candidateFingerprint: later.fingerprint,
      }),
    ]);
    // Neither posting is excluded -- shadow mode never touches `findActive`.
    expect(repository.findActive()).toHaveLength(2);
  });

  it("logs the same shadow candidate every time it runs over an unchanged corpus -- re-running is safe and repeatable", () => {
    insert({ sourceId: "1", title: "Estágio Back-End" });
    insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-11T00:00:00Z"),
    });

    const first = dedupSimilarPostings(repository);
    const second = dedupSimilarPostings(repository);

    expect(first.shadowCandidates).toHaveLength(1);
    expect(second.shadowCandidates).toHaveLength(1);
    expect(second.scanned).toBe(2);
  });

  it("never deletes or excludes a row -- both postings stay findable and active", () => {
    insert({ sourceId: "1", title: "Estágio Back-End" });
    const other = insert({
      sourceId: "2",
      title: "Estágio Back End",
      firstSeenAt: new Date("2026-08-11T00:00:00Z"),
    });

    dedupSimilarPostings(repository);

    expect(repository.findByFingerprint(other.fingerprint)).not.toBeNull();
    expect(repository.count()).toBe(2);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("bounds comparisons per posting and reports when diagnostic candidates were truncated", () => {
    for (let index = 0; index < 4; index += 1) {
      insert({
        sourceId: String(index),
        title: `Estágio Backend nível ${index}`,
        firstSeenAt: new Date(`2026-08-${10 + index}T00:00:00Z`),
      });
    }

    const outcome = dedupSimilarPostings(repository, {
      ...DEFAULT_DEDUP_CONFIG,
      maxComparisonsPerPosting: 1,
    });

    expect(outcome.scanned).toBe(4);
    expect(outcome.comparisonTruncatedCount).toBe(2);
    expect(repository.findActive()).toHaveLength(4);
  });
});

describe("dedupSimilarPostings — locations must not contradict", () => {
  // The bug this covers, measured on the real corpus 2026-08-16: 267 of 406
  // marked duplicates were postings in DIFFERENT cities, back when this
  // function still merged destructively. A company hiring the same role in
  // two cities is hiring twice, and treating one as a shadow candidate of
  // the other would still be a wrong signal even though nothing is excluded
  // anymore.

  it("does not log the same role at the same company in two cities as a shadow candidate", () => {
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

    expect(outcome.shadowCandidates).toHaveLength(0);
    expect(repository.findActive()).toHaveLength(2);
  });

  it("still logs the same role at the same company in the same city", () => {
    // Titles must differ after normalization, or layer 1 catches them on the
    // fingerprint and layer 2 never gets a look — "Backend" and "Back-end"
    // normalize identically, which is itself the point of layer 1.
    insert({ sourceId: "1", title: "Estágio em Desenvolvimento Backend" });
    insert({
      sourceId: "2",
      title: "Estágio em Desenvolvimento Backend Júnior",
    });

    const outcome = dedupSimilarPostings(repository);

    expect(outcome.shadowCandidates).toHaveLength(1);
  });

  it("does not log a shadow candidate when only one side states a city", () => {
    // Exactly the shape that ate the real Backend Python posting under the
    // old destructive behavior: the canonical had no city at all, so
    // nothing contradicted and everything merged. Unknown is not agreement.
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

    expect(outcome.shadowCandidates).toHaveLength(0);
  });

  it("logs a shadow candidate when both sides are equally unknown — nothing contradicts", () => {
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

    expect(outcome.shadowCandidates).toHaveLength(1);
  });
});

describe("PostingsRepository.clearDuplicateFlags", () => {
  it("restores flagged postings whole, so a corrected pass can re-decide", () => {
    // `dedupSimilarPostings` itself never calls `markDuplicate` anymore
    // (shadow mode) -- this simulates a flag set by a pre-shadow-mode run,
    // which `clearDuplicateFlags` must still be able to undo.
    const a = insert({ sourceId: "1", title: "Estágio em Dados" });
    const b = insert({ sourceId: "2", title: "Estágio em Dados Analytics" });
    repository.markDuplicate(b.fingerprint, a.fingerprint);
    expect(repository.findActive()).toHaveLength(1);

    const cleared = repository.clearDuplicateFlags();

    // Nothing was ever deleted — markDuplicate only sets a column — so the
    // posting comes back intact rather than needing re-collection.
    expect(cleared).toBe(1);
    expect(repository.findActive()).toHaveLength(2);
  });
});

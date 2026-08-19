import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCieeVaga } from "../../../src/posting/infrastructure/ciee-normalizer";
import { RawPosting } from "../../../src/posting/domain/raw-posting";

const NOW = new Date("2026-08-16T03:00:00Z");

function fixtureItems(): Record<string, unknown>[] {
  const path = join(process.cwd(), "test", "fixtures", "ciee-jobs.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { content: unknown[] })
    .content as Record<string, unknown>[];
}

function raw(payload: unknown, sourceId = "9000001"): RawPosting {
  return { source: "ciee", sourceId, payload };
}

describe("normalizeCieeVaga", () => {
  it("normalizes the curated Rio posting into a valid Posting", () => {
    const item = fixtureItems()[0]!;
    const posting = normalizeCieeVaga(raw(item), NOW);

    expect(posting).not.toBeNull();
    expect(posting?.source).toBe("ciee");
    expect(posting?.company).toBe("ALFA SERVICOS DIGITAIS LTDA");
    expect(posting?.location).toEqual({
      kind: "known",
      city: "Rio de Janeiro",
    });
  });

  it("composes a title from the two facts the source states", () => {
    // CIEE publishes no title. `tipoVaga` says it is an internship and
    // `areaProfissional` says in what — so the title reports both, rather
    // than borrowing `descricao`, which is the employer's line of business.
    const item = fixtureItems()[0]!;
    const posting = normalizeCieeVaga(raw(item), NOW);

    expect(posting?.title).toBe("Estágio em Informática");
  });

  it("puts the activities into description, where stage A can read them", () => {
    const item = fixtureItems()[0]!;
    const posting = normalizeCieeVaga(raw(item), NOW);

    expect(posting?.description).toContain("Atividades:");
    expect(posting?.description).toContain("Semestre exigido:");
    expect(posting?.description).toContain("Bolsa-auxílio:");
  });

  it("never includes nivelEscolar — always 'SU' by ciee-collector.ts's own filter, so it is pure noise Stage A cannot evidence (docs/11-known-issues.md B9)", () => {
    const item = fixtureItems()[0]!;
    expect((item as { nivelEscolar?: string }).nivelEscolar).toBe("SU");

    const posting = normalizeCieeVaga(raw(item), NOW);

    expect(posting?.description).not.toContain("Nível escolar");
    expect(posting?.description).not.toContain("SU");
  });

  it("reports publishedAt and sourceUrl as null — the source states neither", () => {
    // Verified absent across all 300 postings of the real capture. ADR-019
    // lets a null publishedAt through the recency window deliberately.
    const item = fixtureItems()[0]!;
    const posting = normalizeCieeVaga(raw(item), NOW);

    expect(posting?.publishedAt).toBeNull();
    expect(posting?.sourceUrl).toBeNull();
    expect(posting?.workMode).toBe("unknown");
  });

  it("survives a posting with no semester window and no stipend", () => {
    const items = fixtureItems();
    const noSemester = items.find(
      (i) =>
        (i.requisitos as { semestreInicio?: unknown })?.semestreInicio == null,
    )!;
    const posting = normalizeCieeVaga(raw(noSemester), NOW);

    expect(posting).not.toBeNull();
    expect(posting?.description).not.toContain("Semestre exigido:");
  });

  it("returns null rather than throwing when the company is missing", () => {
    const posting = normalizeCieeVaga(
      raw({ codigoVaga: 1, areaProfissional: "Informática" }),
      NOW,
    );
    expect(posting).toBeNull();
  });

  it("returns null rather than throwing on a payload that is not a posting", () => {
    expect(normalizeCieeVaga(raw({ nothing: true }), NOW)).toBeNull();
    expect(normalizeCieeVaga(raw("not an object"), NOW)).toBeNull();
  });

  it("falls back to a bare Estágio title when the area is missing", () => {
    const posting = normalizeCieeVaga(
      raw({ codigoVaga: 1, nomeEmpresa: "EXEMPLO LTDA", tipoVaga: "ESTAGIO" }),
      NOW,
    );
    expect(posting?.title).toBe("Estágio");
  });

  it("treats an unknown city as unknown rather than inventing one", () => {
    const posting = normalizeCieeVaga(
      raw({
        codigoVaga: 1,
        nomeEmpresa: "EXEMPLO LTDA",
        tipoVaga: "ESTAGIO",
        areaProfissional: "Informática",
        local: { cidade: null, uf: null },
      }),
      NOW,
    );
    expect(posting?.location).toEqual({ kind: "unknown" });
  });
});

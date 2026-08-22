import { describe, expect, it } from "vitest";
import { classifyTrack } from "../../../src/prefilter/domain/classify-track";
import { computeTrackAlignment } from "../../../src/scoring/domain/score";
import { TrackWeights } from "../../../src/scoring/domain/types";

const tracks = {
  dev: ["backend", "back-end", "node"],
  security: ["segurança", "firewall"],
  automation: ["automação", "devops"],
};

const trackWeights: TrackWeights = {
  dev: 1.0,
  security: 1.0,
  automation: 0.7,
  unknown: 0.4,
};

describe("classifyTrack", () => {
  it("classifies a title matching one track's keywords", () => {
    expect(classifyTrack("Estágio em Desenvolvimento Backend", tracks)).toEqual(
      ["dev"],
    );
  });

  it("matches a hyphenated config keyword against an unhyphenated title", () => {
    expect(classifyTrack("Estágio Back-End Developer", tracks)).toEqual([
      "dev",
    ]);
  });

  it("returns an empty array when no track keyword matches", () => {
    expect(classifyTrack("Estágio Financeiro", tracks)).toEqual([]);
  });

  it("returns every track that matches, for a title spanning more than one", () => {
    const result = classifyTrack(
      "Estágio DevSecOps — Backend e Segurança",
      tracks,
    );
    expect(result.sort()).toEqual(["dev", "security"].sort());
  });

  it("is case-insensitive and accent-insensitive", () => {
    expect(classifyTrack("ESTÁGIO EM SEGURANÇA DA INFORMAÇÃO", tracks)).toEqual(
      ["security"],
    );
  });

  it("feeds directly into computeTrackAlignment", () => {
    const matched = classifyTrack("Estágio em Desenvolvimento Backend", tracks);
    expect(computeTrackAlignment(matched, trackWeights)).toBe(1.0);
  });

  it("an unmatched title falls back to the unknown weight via computeTrackAlignment", () => {
    const matched = classifyTrack("Estágio Financeiro", tracks);
    expect(computeTrackAlignment(matched, trackWeights)).toBe(0.4);
  });

  it("a multi-track match picks the highest weight via computeTrackAlignment", () => {
    const matched = classifyTrack(
      "Estágio DevSecOps — Automação e Segurança",
      tracks,
    );
    expect(computeTrackAlignment(matched, trackWeights)).toBe(1.0);
  });
});

/**
 * docs/11-known-issues.md B10. Both real postings found `track_unknown` in
 * production despite being genuinely on-track: CIEE's/Gupy's title-only
 * classification had no keyword for "degree name" or "database" phrasing,
 * only for the framework/language vocabulary a dev-focused title usually
 * uses.
 */
describe("classifyTrack — degree-name and database phrasing (B10)", () => {
  const devTracks = {
    dev: [
      "backend",
      "sistemas de informação",
      "ciência da computação",
      "redes de computadores",
      "banco de dados",
      "sql server",
    ],
    security: ["segurança"],
    automation: ["automação"],
  };

  it("classifies a CS/SI/networking catch-all degree list as dev", () => {
    expect(
      classifyTrack(
        "Estágio | Redes de Computadores, Sistemas de Informação, Ciência da Computação e afins",
        devTracks,
      ),
    ).toEqual(["dev"]);
  });

  it("classifies a database internship as dev", () => {
    expect(
      classifyTrack(
        "Estagiário em Banco de Dados SQL Server - Exclusiva Rio de Janeiro",
        devTracks,
      ),
    ).toEqual(["dev"]);
  });
});

/**
 * ADR-015. "Desenvolvimento" and "segurança" are the two most overloaded
 * words in Brazilian job titles, and both produced 1.0 track alignment on
 * postings hand-labelled 0 in the first calibration run.
 */
describe("classifyTrack — exclusions veto a keyword match", () => {
  const tracks = {
    dev: ["desenvolvimento", "backend"],
    security: ["segurança"],
    automation: ["devops"],
  };
  const exclusions = {
    dev: ["desenvolvimento de embalagens"],
    security: ["segurança do trabalho"],
    automation: [],
  };

  it("rejects packaging development despite the 'desenvolvimento' keyword", () => {
    expect(
      classifyTrack(
        "ESTAGIÁRIO DE DESENVOLVIMENTO DE EMBALAGENS",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });

  it("rejects occupational safety despite the 'segurança' keyword", () => {
    expect(
      classifyTrack(
        "ESTÁGIO - SEGURANÇA DO TRABALHO - JPGA",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });

  it("still classifies genuine software development", () => {
    expect(
      classifyTrack("Estágio em Desenvolvimento Backend", tracks, exclusions),
    ).toEqual(["dev"]);
  });

  it("matches exclusions regardless of accents and casing", () => {
    expect(
      classifyTrack("estagio de seguranca do trabalho", tracks, exclusions),
    ).toEqual([]);
  });

  it("treats omitted exclusions as no exclusions at all", () => {
    expect(classifyTrack("Estágio em Desenvolvimento Backend", tracks)).toEqual(
      ["dev"],
    );
  });
});

// Real false positives observed in the production corpus (2026-08-19,
// docs/11-known-issues.md B8): the canonical exclusion phrase existed
// already but a real title's wording did not literally match it — a
// reversed word order and a joining "e" lost to "&" normalization.
describe("classifyTrack — exclusion phrasing variants found in real postings", () => {
  const tracks = { dev: ["desenvolvimento"], security: [], automation: [] };
  const exclusions = {
    dev: [
      "pesquisa e desenvolvimento",
      "pesquisa desenvolvimento",
      "humano desenvolvimento",
    ],
    security: [],
    automation: [],
  };

  it("rejects a cosmetics R&D internship whose '&' loses the joining 'e'", () => {
    expect(
      classifyTrack(
        "Estagiário de Pesquisa & Desenvolvimento",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });

  it("rejects a Psychology internship where 'Humano Desenvolvimento' is the staffing agency's name, word order reversed", () => {
    expect(
      classifyTrack(
        "ESTAGIÁRIO NA ÁREA DE PSICOLOGIA - Sem experiência (Humano Desenvolvimento)",
        tracks,
        exclusions,
      ),
    ).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  normalizeTitle,
  titleMatchesAny,
} from "../../../src/prefilter/domain/title-match";

describe("normalizeTitle", () => {
  it("turns punctuation into a space, unlike the fingerprint normalizer", () => {
    // The whole point: "Estagiário(a)" must keep a boundary after
    // "estagiario" so a whole-word match can find it.
    expect(normalizeTitle("Estagiário(a)")).toBe("estagiario a");
    expect(normalizeTitle("Estágio - Service Desk")).toBe(
      "estagio service desk",
    );
  });

  it("strips accents, lowercases and collapses whitespace", () => {
    expect(normalizeTitle("  ESTÁGIO   Nível  Superior ")).toBe(
      "estagio nivel superior",
    );
  });
});

describe("titleMatchesAny — the substring bug this exists to fix", () => {
  const blocklist = [
    "sênior",
    "pleno",
    "especialista",
    "tech lead",
    "III",
    "IV",
  ];

  it.each([
    ["Estágio Nível Superior - TI - Segurança da Informação", "nível"],
    ["Estágio Universitário - Suporte TI", "universitário"],
    ["Programa de Estágio | Vaga Afirmativa", "afirmativa"],
    ["Jovem Aprendiz Administrativo", "administrativo"],
    ["Programa de Estágio | Engenharia Civil", "civil"],
    ["Estágio de Suporte Executivo", "executivo"],
    ["Banco Talentos | Diversas Áreas", "diversas"],
  ])("does not let 'IV' block %s (was matching inside %s)", (title) => {
    expect(titleMatchesAny(title, blocklist)).toBe(false);
  });

  it("still blocks a real roman-numeral seniority marker", () => {
    expect(titleMatchesAny("Analista III - Desenvolvimento", blocklist)).toBe(
      true,
    );
    expect(titleMatchesAny("Analista de Sistemas IV", blocklist)).toBe(true);
  });

  it("still blocks the ordinary seniority words", () => {
    expect(titleMatchesAny("Desenvolvedor Backend Sênior", blocklist)).toBe(
      true,
    );
    expect(titleMatchesAny("Analista Pleno (PHP & React)", blocklist)).toBe(
      true,
    );
  });

  it("matches a multi-word term as a phrase", () => {
    expect(titleMatchesAny("Engineering Tech Lead", blocklist)).toBe(true);
    expect(titleMatchesAny("Tech Support", blocklist)).toBe(false);
  });
});

describe("titleMatchesAny — required terms", () => {
  const required = [
    "estágio",
    "estágios",
    "estagiário",
    "estagiária",
    "intern",
    "internship",
  ];

  it.each([
    "Estágio em Desenvolvimento Backend",
    "Estagiário(a) de Fisiologia",
    "Pessoa Estagiária em Desenvolvimento Backend",
    "Banco de Talentos - TI - Estágios e Efetivos",
    "Software Engineering Intern",
    "Backend Internship 2026",
  ])("matches the real internship title %s", (title) => {
    expect(titleMatchesAny(title, required)).toBe(true);
  });

  it.each([
    ["Pessoa Coordenadora de Auditoria Interna", "interna"],
    ["Especialista de Controles Internos", "internos"],
    ["DevOps Engineer - International Project", "International"],
  ])("does not treat %s as an internship (was matching %s)", (title) => {
    expect(titleMatchesAny(title, required)).toBe(false);
  });
});

describe("titleMatchesAny — edges", () => {
  it("is false for an empty term list", () => {
    expect(titleMatchesAny("Estágio em Backend", [])).toBe(false);
  });

  it("ignores a term that normalizes to nothing, rather than matching everything", () => {
    // A punctuation-only term would normalize to "" and, unguarded, ` `
    // would be found in every padded title.
    expect(titleMatchesAny("Estágio em Backend", ["---"])).toBe(false);
  });
});

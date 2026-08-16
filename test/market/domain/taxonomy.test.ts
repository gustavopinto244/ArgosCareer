import { describe, expect, it } from "vitest";
import { findSkills, Taxonomy } from "../../../src/market/domain/taxonomy";

const TAXONOMY: Taxonomy = {
  skills: [
    { canonical: "PostgreSQL", aliases: ["Postgres", "Postgre"] },
    { canonical: "Docker", aliases: ["containers"] },
    { canonical: "Automated testing", aliases: ["unit testing"] },
    { canonical: "Go", aliases: ["Golang"] },
  ],
};

describe("findSkills", () => {
  it("collapses alias variants to the canonical name", () => {
    expect(findSkills("Experience with Postgres required", TAXONOMY)).toEqual([
      "PostgreSQL",
    ]);
    expect(findSkills("postgresql or postgre", TAXONOMY)).toEqual([
      "PostgreSQL",
    ]);
  });

  it("is case, accent and whitespace insensitive", () => {
    expect(findSkills("  POSTGRES   ", TAXONOMY)).toEqual(["PostgreSQL"]);
  });

  it("matches a multi-word alias as a substring", () => {
    expect(
      findSkills("Familiarity with unit testing practices", TAXONOMY),
    ).toEqual(["Automated testing"]);
  });

  it("matches a single-word alias only on whole-word boundaries", () => {
    expect(findSkills("algorithm design", TAXONOMY)).toEqual([]);
    expect(findSkills("proficient in Go", TAXONOMY)).toEqual(["Go"]);
  });

  it("finds every distinct skill mentioned, with no duplicates", () => {
    const text = "Docker, containers, and PostgreSQL experience required";
    expect(findSkills(text, TAXONOMY).sort()).toEqual(
      ["Docker", "PostgreSQL"].sort(),
    );
  });

  it("returns an empty array for text mentioning no known skill", () => {
    expect(findSkills("communication and teamwork", TAXONOMY)).toEqual([]);
  });

  it("returns an empty array for empty or whitespace-only text", () => {
    expect(findSkills("", TAXONOMY)).toEqual([]);
    expect(findSkills("   ", TAXONOMY)).toEqual([]);
  });
});

describe("findSkills — casamento por palavra inteira (auditoria A-1)", () => {
  const TAX: Taxonomy = {
    skills: [
      { canonical: "REST", aliases: ["REST API"] },
      { canonical: "Node.js", aliases: ["NodeJS"] },
      { canonical: "CI/CD", aliases: ["continuous integration"] },
      { canonical: "Go", aliases: ["Golang"] },
    ],
  };

  it("does not match REST inside an unrelated word", () => {
    // The bug this replaced: "REST API" normalizes to "rest api", which is a
    // substring of "fo|rest api|ario", so a beekeeping internship counted as
    // REST experience.
    expect(findSkills("Estágio em manejo de forest apiario", TAX)).toEqual([]);
  });

  it("still matches a term that genuinely stands as its own word — the accepted limit", () => {
    // Not a false positive to fix: "rest" really is a whole word here. A
    // whole-word matcher cannot tell this apart from the architectural style,
    // and pretending otherwise would need an NLP pipeline this project has no
    // reason to carry.
    expect(findSkills("Vaga na floresta: rest apiario", TAX)).toEqual(["REST"]);
  });

  it("still matches the alias standing on its own", () => {
    expect(findSkills("Estágio Backend com REST API", TAX)).toEqual(["REST"]);
  });

  it("gains punctuation-insensitivity the old matcher lacked", () => {
    // Neither spelling was listed twice in the taxonomy; the matcher handles it.
    expect(findSkills("Experiência com Node.js", TAX)).toEqual(["Node.js"]);
    expect(findSkills("Experiência com NodeJS", TAX)).toEqual(["Node.js"]);
    expect(findSkills("Pipeline CI/CD", TAX)).toEqual(["CI/CD"]);
  });

  it("matches a multi-word alias as a phrase, not a substring", () => {
    expect(findSkills("Conhecimento em continuous integration", TAX)).toEqual([
      "CI/CD",
    ]);
    expect(findSkills("discontinuous integration testing", TAX)).toEqual([]);
  });

  it("keeps a short alias from matching inside a longer word", () => {
    expect(findSkills("São Gonçalo, Rio de Janeiro", TAX)).toEqual([]);
    expect(findSkills("Experiência com Go", TAX)).toEqual(["Go"]);
  });
});

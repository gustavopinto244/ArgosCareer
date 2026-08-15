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

import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  normalize,
} from "../../../src/posting/domain/fingerprint";

describe("normalize", () => {
  it("lowercases", () => {
    expect(normalize("BackEnd")).toBe("backend");
  });

  it("strips accents", () => {
    expect(normalize("Estágio")).toBe("estagio");
  });

  it("strips punctuation", () => {
    expect(normalize("Node.js, TypeScript!")).toBe("nodejs typescript");
  });

  it("collapses internal whitespace and trims", () => {
    expect(normalize("  Rio   de   Janeiro  ")).toBe("rio de janeiro");
  });

  it("combines all four rules", () => {
    expect(normalize("  Estágio, Back-End!!  ")).toBe("estagio backend");
  });
});

describe("computeFingerprint", () => {
  it("is stable for the same normalized input", () => {
    const a = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    const b = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    expect(a).toBe(b);
  });

  it("is stable across superficial differences that normalize away", () => {
    const a = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    const b = computeFingerprint(
      "  EMPRESA   X  ",
      "estágio, backend!",
      "  RIO   DE   JANEIRO  ",
    );
    expect(a).toBe(b);
  });

  it("strips punctuation without inserting a space, so a hyphenated title is a different key than its spaced form — the known gap layer 2 similarity exists to catch (docs/02-architecture.md)", () => {
    const spaced = computeFingerprint("Empresa X", "Back End", "");
    const hyphenated = computeFingerprint("Empresa X", "Back-End", "");
    expect(hyphenated).not.toBe(spaced);
  });

  it("differs when company differs", () => {
    const a = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    const b = computeFingerprint(
      "Empresa Y",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    expect(a).not.toBe(b);
  });

  it("differs when title differs", () => {
    const a = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    const b = computeFingerprint(
      "Empresa X",
      "Estágio Frontend",
      "Rio de Janeiro",
    );
    expect(a).not.toBe(b);
  });

  it("differs when city differs", () => {
    const a = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    const b = computeFingerprint("Empresa X", "Estágio Backend", "Niteroi");
    expect(a).not.toBe(b);
  });

  it("accepts an empty city for an unknown location without throwing", () => {
    expect(() =>
      computeFingerprint("Empresa X", "Estágio Backend", ""),
    ).not.toThrow();
  });

  it("produces a 64-character hex sha256 digest", () => {
    const fingerprint = computeFingerprint(
      "Empresa X",
      "Estágio Backend",
      "Rio de Janeiro",
    );
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

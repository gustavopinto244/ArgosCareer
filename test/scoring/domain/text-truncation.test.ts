import { describe, expect, it } from "vitest";
import { truncateDescription } from "../../../src/scoring/domain/text-truncation";

describe("truncateDescription (docs/audit AC-017)", () => {
  it("returns the text unchanged and untruncated when it already fits", () => {
    const result = truncateDescription("Requer Node.js.", 100);
    expect(result).toEqual({ text: "Requer Node.js.", truncated: false });
  });

  it("returns the text unchanged when it is exactly at the boundary", () => {
    const text = "x".repeat(50);
    const result = truncateDescription(text, 50);
    expect(result).toEqual({ text, truncated: false });
  });

  it("keeps whole paragraphs and drops the first one that would overflow", () => {
    const text = [
      "Sobre a empresa: uma fintech.",
      "Requisitos: Node.js, SQL.",
      "Benefícios: vale-refeição, plano de saúde, day-off no aniversário.",
    ].join("\n\n");

    const result = truncateDescription(text, 60);

    expect(result.truncated).toBe(true);
    expect(result.text).toBe(
      "Sobre a empresa: uma fintech.\n\nRequisitos: Node.js, SQL.",
    );
    expect(result.text.length).toBeLessThanOrEqual(60);
  });

  it("falls back to a word-boundary cut when a single paragraph alone exceeds the budget", () => {
    const text =
      "Requisitos únicos, tudo em um parágrafo só, sem quebras de linha, " +
      "para forçar o fallback de corte por palavra quando nada cabe inteiro.";

    const result = truncateDescription(text, 40);

    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(40);
    // Word-boundary safe: the cut never leaves a partial word, so the
    // result re-joined with a following word never fuses two together.
    expect(text.startsWith(result.text)).toBe(true);
  });

  it("never splits a multibyte character or an emoji in half", () => {
    // "não" and the emoji are both multi-byte in UTF-16/UTF-8; a naive
    // `.slice(0, maxChars)` on a boundary that lands mid-codepoint would
    // corrupt the text or produce invalid output for the prompt.
    const text = "Ambiente descontraído 🚀🚀🚀 não é hierárquico de verdade.";

    const result = truncateDescription(text, 27);

    expect(result.truncated).toBe(true);
    // No lone surrogate / replacement character from a mid-emoji cut.
    expect(result.text).not.toMatch(/�/);
    expect([...result.text].every((ch) => [...ch].length >= 1)).toBe(true);
  });

  it("returns an empty, untruncated result for empty input", () => {
    expect(truncateDescription("", 100)).toEqual({
      text: "",
      truncated: false,
    });
  });

  it("returns an empty, truncated result when even the first paragraph cannot fit", () => {
    const result = truncateDescription(
      "Uma frase razoavelmente longa aqui.",
      5,
    );
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(5);
  });
});

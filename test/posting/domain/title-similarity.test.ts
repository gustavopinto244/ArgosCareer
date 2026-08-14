import { describe, expect, it } from "vitest";
import { computeTitleSimilarity } from "../../../src/posting/domain/title-similarity";

describe("computeTitleSimilarity", () => {
  it("is 1 for identical titles", () => {
    expect(computeTitleSimilarity("Estágio Backend", "Estágio Backend")).toBe(
      1,
    );
  });

  it("is 1 for titles that normalize identically despite superficial differences", () => {
    expect(
      computeTitleSimilarity("  ESTÁGIO   Backend  ", "estágio backend"),
    ).toBe(1);
  });

  it("is well below the default threshold for two titles about unrelated roles", () => {
    // Character-bigram similarity is never exactly 0 for two non-empty
    // strings — some incidental overlap ("a ", "e ") is normal. What matters
    // is that it stays clear of the dedup threshold.
    const similarity = computeTitleSimilarity(
      "Estágio Backend",
      "Vendedor de Loja",
    );
    expect(similarity).toBeLessThan(0.35);
  });

  it("is symmetric", () => {
    const a = computeTitleSimilarity("Estágio Backend Rio", "Estágio Backend");
    const b = computeTitleSimilarity("Estágio Backend", "Estágio Backend Rio");
    expect(a).toBe(b);
  });

  it("scores the canonical layer-2 example from docs/02-architecture.md above the default threshold", () => {
    // "Estágio em Back-end" and "Estagiário Backend (Rio de Janeiro)" are
    // documented as the same job under different fingerprints — this is the
    // pair layer 2 exists to catch.
    const similarity = computeTitleSimilarity(
      "Estágio em Back-end",
      "Estagiário Backend (Rio de Janeiro)",
    );
    expect(similarity).toBeCloseTo(0.4, 2);
    expect(similarity).toBeGreaterThan(0.35);
  });

  it("scores hyphen-vs-space variation of the same title higher than the docs example, since the words actually match", () => {
    const similarity = computeTitleSimilarity(
      "Estágio Back-End",
      "Estágio Back End (Rio de Janeiro)",
    );
    expect(similarity).toBeCloseTo(0.538, 2);
  });

  it("scores two different tracks lower than the default threshold, so Backend and Frontend do not collapse into one posting", () => {
    // Without stopword removal, the shared boilerplate word "Estágio" alone
    // used to push this above 0.6 — higher than the genuine duplicate pair
    // above. This is the regression that motivated stripping it.
    const similarity = computeTitleSimilarity(
      "Estágio Backend",
      "Estágio Frontend",
    );
    expect(similarity).toBeCloseTo(0.308, 2);
    expect(similarity).toBeLessThan(0.35);
  });

  it("is unaffected by word order, since two posters may phrase the same role differently", () => {
    const a = computeTitleSimilarity(
      "Backend Estágio Rio",
      "Estágio Rio Backend",
    );
    expect(a).toBe(1);
  });

  it("treats two titles reduced to nothing but stopwords as identical rather than dividing by zero", () => {
    expect(computeTitleSimilarity("Estágio", "Estagiário")).toBe(1);
    expect(computeTitleSimilarity("de em", "para na")).toBe(1);
  });
});

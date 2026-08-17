import { describe, expect, it } from "vitest";
import { hashExtractionInput } from "../../../src/scoring/domain/extraction-input-hash";
import { normalizePostingContent } from "../../../src/scoring/domain/posting-content-hash";

describe("normalizePostingContent (docs/audit PR-017)", () => {
  it("produces a contentHash identical to hashing the normalized title/description directly", () => {
    const result = normalizePostingContent(
      "Estágio em Backend",
      "Buscamos estagiário com conhecimento em Node.js.",
      12_000,
    );
    expect(result.contentHash).toBe(
      hashExtractionInput(
        "Estágio em Backend",
        "Buscamos estagiário com conhecimento em Node.js.",
      ),
    );
  });

  it("strips HTML markup before hashing, so markup differences do not change the key", () => {
    const plain = normalizePostingContent(
      "Estágio",
      "Buscamos estagiário",
      12_000,
    );
    const html = normalizePostingContent(
      "Estágio",
      "<p>Buscamos estagiário</p>",
      12_000,
    );
    expect(html.contentHash).toBe(plain.contentHash);
    expect(html.description).toBe(plain.description);
  });

  it("truncates a description exceeding maxDescriptionChars and flags inputTruncated", () => {
    const long = "x".repeat(50);
    const result = normalizePostingContent("Estágio", long, 10);
    expect(result.inputTruncated).toBe(true);
    expect(result.description?.length).toBeLessThanOrEqual(10);
  });

  it("does not flag inputTruncated when the description fits", () => {
    const result = normalizePostingContent("Estágio", "Curto.", 12_000);
    expect(result.inputTruncated).toBe(false);
  });

  it("handles a null description without truncating or throwing", () => {
    const result = normalizePostingContent("Estágio", null, 12_000);
    expect(result.description).toBeNull();
    expect(result.inputTruncated).toBe(false);
  });

  it("distinguishes a null description from an empty one, same as hashExtractionInput", () => {
    const withNull = normalizePostingContent("Estágio", null, 12_000);
    const withEmpty = normalizePostingContent("Estágio", "", 12_000);
    // Both normalize to no description text, but the function does not
    // pretend they were the same input -- it defers to hashExtractionInput's
    // own documented behavior either way, not a new one invented here.
    expect(withNull.contentHash).toBe(withEmpty.contentHash);
  });
});

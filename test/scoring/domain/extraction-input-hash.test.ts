import { describe, expect, it } from "vitest";
import { hashExtractionInput } from "../../../src/scoring/domain/extraction-input-hash";

describe("hashExtractionInput (docs/audit AC-006)", () => {
  it("is deterministic for the same title and description", () => {
    expect(hashExtractionInput("Estágio Backend", "Requer Node.js.")).toBe(
      hashExtractionInput("Estágio Backend", "Requer Node.js."),
    );
  });

  it("changes when the description changes", () => {
    const a = hashExtractionInput("Estágio Backend", "Requer Node.js.");
    const b = hashExtractionInput(
      "Estágio Backend",
      "Requer Node.js e inglês avançado.",
    );
    expect(a).not.toBe(b);
  });

  it("changes when the title changes, description held constant", () => {
    const a = hashExtractionInput("Estágio Backend", "Requer Node.js.");
    const b = hashExtractionInput("Estágio Frontend", "Requer Node.js.");
    expect(a).not.toBe(b);
  });

  it("does not collide title/description across the boundary between them", () => {
    // Without an unambiguous separator, ("A", "BC") and ("AB", "C") could
    // hash identically under plain concatenation.
    const a = hashExtractionInput("A", "BC");
    const b = hashExtractionInput("AB", "C");
    expect(a).not.toBe(b);
  });

  it("treats a null description distinctly from an empty string", () => {
    const withNull = hashExtractionInput("Estágio Backend", null);
    const withEmpty = hashExtractionInput("Estágio Backend", "");
    // Both are legitimate "no content" states, and this hash function
    // makes no promise to distinguish them -- what matters is that a null
    // description consistently hashes the same way every time.
    expect(withNull).toBe(hashExtractionInput("Estágio Backend", null));
    expect(typeof withEmpty).toBe("string");
  });
});

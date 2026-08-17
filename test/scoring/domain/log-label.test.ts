import { describe, expect, it } from "vitest";
import { sanitizeLogLabel } from "../../../src/scoring/domain/log-label";

describe("sanitizeLogLabel (docs/audit PR-010)", () => {
  it("leaves a short, plain label unchanged", () => {
    expect(sanitizeLogLabel("Node.js")).toBe("Node.js");
  });

  it("strips newlines so one requirement cannot forge extra log lines", () => {
    expect(sanitizeLogLabel("Node.js\nWARN [Forged] fake line")).toBe(
      "Node.js WARN [Forged] fake line",
    );
  });

  it("strips carriage returns, tabs and other C0 control characters", () => {
    expect(sanitizeLogLabel("Node.js\r\t\x07bell")).toBe("Node.js bell");
  });

  it("strips DEL (0x7f)", () => {
    expect(sanitizeLogLabel("Node\x7f.js")).toBe("Node .js");
  });

  it("collapses runs of whitespace left behind by stripped control characters", () => {
    expect(sanitizeLogLabel("a\n\n\nb")).toBe("a b");
  });

  it("truncates long text and marks the cut with an ellipsis", () => {
    const longText = "x".repeat(100);
    const result = sanitizeLogLabel(longText, 60);
    expect(result).toBe(`${"x".repeat(60)}…`);
    expect(result.length).toBe(61);
  });

  it("does not truncate text exactly at the limit", () => {
    const text = "x".repeat(60);
    expect(sanitizeLogLabel(text, 60)).toBe(text);
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeLogLabel("  Node.js  ")).toBe("Node.js");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeLogLabel("")).toBe("");
  });

  it("uses a default cap of 60 characters", () => {
    const longText = "y".repeat(200);
    expect(sanitizeLogLabel(longText).length).toBe(61);
  });
});

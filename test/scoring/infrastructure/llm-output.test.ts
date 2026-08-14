import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  normalizeModelOutput,
  parseModelOutputWithRetries,
} from "../../../src/scoring/infrastructure/llm-output";

const Schema = z.object({
  status: z.enum(["met", "partial", "not_met"]),
});

describe("normalizeModelOutput", () => {
  it("passes through already-clean JSON unchanged", () => {
    expect(normalizeModelOutput('{"status":"met"}')).toBe('{"status":"met"}');
  });

  it("strips a markdown fence with a json language tag", () => {
    const raw = '```json\n{"status":"met"}\n```';
    expect(normalizeModelOutput(raw)).toBe('{"status":"met"}');
  });

  it("strips a bare markdown fence with no language tag", () => {
    const raw = '```\n{"status":"met"}\n```';
    expect(normalizeModelOutput(raw)).toBe('{"status":"met"}');
  });

  it("trims prose surrounding the JSON object", () => {
    const raw = 'Here is the result:\n{"status":"met"}\nHope that helps!';
    expect(normalizeModelOutput(raw)).toBe('{"status":"met"}');
  });

  it("trims to the outermost array when the JSON is a list", () => {
    const raw = 'Sure, here you go: [{"status":"met"}] — done.';
    expect(normalizeModelOutput(raw)).toBe('[{"status":"met"}]');
  });

  it("returns the trimmed input unchanged when no bracket is found", () => {
    expect(normalizeModelOutput("  not json at all  ")).toBe("not json at all");
  });
});

describe("parseModelOutputWithRetries — success", () => {
  it("returns the parsed data on the first valid attempt", async () => {
    const ask = vi.fn(async () => '{"status":"met"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt");

    expect(result).toEqual({ ok: true, data: { status: "met" }, attempts: 1 });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("recovers on the second attempt after a truncated first response", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status": "met"')
      .mockResolvedValueOnce('{"status":"partial"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.status).toBe("partial");
      expect(result.attempts).toBe(2);
    }
  });

  it("recovers from an invented enum value on retry", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"probably"}')
      .mockResolvedValueOnce('{"status":"met"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
  });

  it("feeds the validation error back into the retry prompt", async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"status":"probably"}')
      .mockResolvedValueOnce('{"status":"met"}');
    await parseModelOutputWithRetries(Schema, ask, "original prompt");

    const secondCallPrompt = ask.mock.calls[1]?.[0] as string;
    expect(secondCallPrompt).toContain("original prompt");
    expect(secondCallPrompt).toContain("invalid");
  });
});

describe("parseModelOutputWithRetries — exhausted retries, never throws", () => {
  it("returns ok:false after maxAttempts on truncated JSON that never parses", async () => {
    const ask = vi.fn(async () => '{"status": "met"');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", 3);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_output");
      expect(result.attempts).toBe(3);
      expect(result.lastError).toContain("not valid JSON");
    }
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("returns ok:false after maxAttempts when the model repeats the same invalid enum", async () => {
    const ask = vi.fn(async () => '{"status":"maybe"}');
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", 3);

    expect(result.ok).toBe(false);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("respects a custom maxAttempts", async () => {
    const ask = vi.fn(async () => "not json");
    const result = await parseModelOutputWithRetries(Schema, ask, "prompt", 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.attempts).toBe(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

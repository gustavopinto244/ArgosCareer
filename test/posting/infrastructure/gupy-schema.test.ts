import { describe, expect, it } from "vitest";
import {
  GupyJobSchema,
  GupyResponseEnvelopeSchema,
} from "../../../src/posting/infrastructure/gupy-schema";

describe("GupyJobSchema", () => {
  it("accepts a minimal item with only id and name", () => {
    const result = GupyJobSchema.safeParse({ id: 1, name: "Estágio Backend" });
    expect(result.success).toBe(true);
  });

  it("rejects an item with no id", () => {
    const result = GupyJobSchema.safeParse({ name: "Estágio Backend" });
    expect(result.success).toBe(false);
  });

  it("rejects an item with no name", () => {
    const result = GupyJobSchema.safeParse({ id: 1 });
    expect(result.success).toBe(false);
  });

  it("accepts id as either a number or a string — observed as a number, kept tolerant", () => {
    expect(GupyJobSchema.safeParse({ id: 1, name: "x" }).success).toBe(true);
    expect(GupyJobSchema.safeParse({ id: "1", name: "x" }).success).toBe(true);
  });

  it("accepts an item with no badges field at all", () => {
    const result = GupyJobSchema.safeParse({ id: 1, name: "x" });
    expect(result.success).toBe(true);
  });

  it("accepts an item with badges present", () => {
    const result = GupyJobSchema.safeParse({
      id: 1,
      name: "x",
      badges: { friendlyBadge: true, isPWD: false },
    });
    expect(result.success).toBe(true);
  });

  it("preserves unknown fields via passthrough, for a future Gupy field this schema does not yet know about", () => {
    const result = GupyJobSchema.parse({
      id: 1,
      name: "x",
      someBrandNewField: "not in the schema",
    });
    expect(result).toMatchObject({ someBrandNewField: "not in the schema" });
  });

  it("accepts an open-ended type value, not restricted to the ones already observed", () => {
    const result = GupyJobSchema.safeParse({
      id: 1,
      name: "x",
      type: "vacancy_type_something_not_yet_seen",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null applicationDeadline, city, state or country", () => {
    const result = GupyJobSchema.safeParse({
      id: 1,
      name: "x",
      applicationDeadline: null,
      city: null,
      state: null,
      country: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("GupyResponseEnvelopeSchema", () => {
  it("accepts an envelope with data and pagination", () => {
    const result = GupyResponseEnvelopeSchema.safeParse({
      data: [{ id: 1, name: "x" }],
      pagination: { total: 1, limit: 10, offset: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an envelope with no pagination field", () => {
    const result = GupyResponseEnvelopeSchema.safeParse({ data: [] });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope whose data is not an array", () => {
    const result = GupyResponseEnvelopeSchema.safeParse({
      data: "not an array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a response with no data field at all", () => {
    const result = GupyResponseEnvelopeSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

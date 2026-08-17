import { describe, expect, it } from "vitest";
import {
  SolidesJobSchema,
  SolidesResponseEnvelopeSchema,
} from "../../../src/posting/infrastructure/solides-schema";

describe("SolidesJobSchema", () => {
  it("accepts a minimal item with only id and title", () => {
    const result = SolidesJobSchema.safeParse({
      id: 1,
      title: "Estágio Backend",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an item with no id", () => {
    const result = SolidesJobSchema.safeParse({ title: "Estágio Backend" });
    expect(result.success).toBe(false);
  });

  it("rejects an item with no title", () => {
    const result = SolidesJobSchema.safeParse({ id: 1 });
    expect(result.success).toBe(false);
  });

  it("accepts id as either a number or a string — observed as a number, kept tolerant", () => {
    expect(SolidesJobSchema.safeParse({ id: 1, title: "x" }).success).toBe(
      true,
    );
    expect(SolidesJobSchema.safeParse({ id: "1", title: "x" }).success).toBe(
      true,
    );
  });

  it("accepts an item with a full city object", () => {
    const result = SolidesJobSchema.safeParse({
      id: 1,
      title: "x",
      city: { id: 3243, name: "Rio de Janeiro", state_id: 19 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null city, never observed but schema-tolerant", () => {
    const result = SolidesJobSchema.safeParse({
      id: 1,
      title: "x",
      city: null,
    });
    expect(result.success).toBe(true);
  });

  it("preserves unknown fields via passthrough, for a future Sólides field this schema does not yet know about", () => {
    const result = SolidesJobSchema.parse({
      id: 1,
      title: "x",
      someBrandNewField: "not in the schema",
    });
    expect(result).toMatchObject({ someBrandNewField: "not in the schema" });
  });

  it("accepts an open-ended jobType value, not restricted to 'presencial'", () => {
    const result = SolidesJobSchema.safeParse({
      id: 1,
      title: "x",
      jobType: "hibrido",
    });
    expect(result.success).toBe(true);
  });

  it("accepts homeOffice true or false", () => {
    expect(
      SolidesJobSchema.safeParse({ id: 1, title: "x", homeOffice: true })
        .success,
    ).toBe(true);
    expect(
      SolidesJobSchema.safeParse({ id: 1, title: "x", homeOffice: false })
        .success,
    ).toBe(true);
  });
});

describe("SolidesResponseEnvelopeSchema", () => {
  it("accepts the real nested envelope shape", () => {
    const result = SolidesResponseEnvelopeSchema.safeParse({
      success: true,
      errors: [],
      data: { data: [{ id: 1, title: "x" }], count: 1, totalPages: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an envelope with no count or totalPages field", () => {
    const result = SolidesResponseEnvelopeSchema.safeParse({
      data: { data: [] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an envelope whose data.data is not an array", () => {
    const result = SolidesResponseEnvelopeSchema.safeParse({
      data: { data: "not an array" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a response with no data field at all", () => {
    const result = SolidesResponseEnvelopeSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a response whose data field has no nested data array", () => {
    const result = SolidesResponseEnvelopeSchema.safeParse({
      data: { count: 0 },
    });
    expect(result.success).toBe(false);
  });
});

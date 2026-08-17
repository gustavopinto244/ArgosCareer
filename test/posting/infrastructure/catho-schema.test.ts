import { describe, expect, it } from "vitest";
import {
  CathoJobPostingLdSchema,
  CathoPostingEnvelopeSchema,
} from "../../../src/posting/infrastructure/catho-schema";

describe("CathoJobPostingLdSchema", () => {
  it("accepts a minimal item with only a title", () => {
    const result = CathoJobPostingLdSchema.safeParse({
      title: "Estágio Backend",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an item with no title", () => {
    const result = CathoJobPostingLdSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts the real observed schema.org JobPosting shape", () => {
    const result = CathoJobPostingLdSchema.safeParse({
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      title: "Estágio Técnico Mecânica",
      description: "Descrição da vaga",
      datePosted: "2026-06-15T23:59:59Z",
      employmentType: "",
      hiringOrganization: {
        "@type": "Organization",
        name: "MILLS",
        logo: "//example.com/logo.svg",
      },
      jobLocation: [
        {
          "@type": "Place",
          address: {
            "@type": "PostalAddress",
            streetAddress: "",
            addressLocality: "São Paulo",
            addressRegion: "SP",
            postalCode: "13148-150",
            addressCountry: "Brasil",
          },
        },
      ],
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "BRL",
        value: { "@type": "QuantitativeValue", minValue: 2000, maxValue: 2000 },
      },
    });
    expect(result.success).toBe(true);
  });

  it("preserves unknown fields via passthrough", () => {
    const result = CathoJobPostingLdSchema.parse({
      title: "x",
      someBrandNewField: "not in the schema",
    });
    expect(result).toMatchObject({ someBrandNewField: "not in the schema" });
  });

  it("accepts an item with no jobLocation at all", () => {
    const result = CathoJobPostingLdSchema.safeParse({ title: "x" });
    expect(result.success).toBe(true);
  });
});

describe("CathoPostingEnvelopeSchema", () => {
  it("accepts a real envelope with id, url, pageTitle and jobPosting", () => {
    const result = CathoPostingEnvelopeSchema.safeParse({
      id: 37070531,
      url: "https://www.catho.com.br/vagas/estagio-tecnico-mecanica/37070531/",
      pageTitle: "Vaga de Emprego de Estágio Técnico Mecânica, Paulinia /",
      jobPosting: { title: "Estágio Técnico Mecânica" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts id as either a number or a string", () => {
    expect(
      CathoPostingEnvelopeSchema.safeParse({
        id: "37070531",
        jobPosting: { title: "x" },
      }).success,
    ).toBe(true);
  });

  it("rejects an envelope with no jobPosting field", () => {
    const result = CathoPostingEnvelopeSchema.safeParse({ id: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects an envelope whose jobPosting has no title", () => {
    const result = CathoPostingEnvelopeSchema.safeParse({
      id: 1,
      jobPosting: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts an envelope with no url or pageTitle", () => {
    const result = CathoPostingEnvelopeSchema.safeParse({
      id: 1,
      jobPosting: { title: "x" },
    });
    expect(result.success).toBe(true);
  });
});

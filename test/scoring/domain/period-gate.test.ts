import { describe, expect, it } from "vitest";
import {
  detectPeriodGate,
  extractMinimumPeriod,
} from "../../../src/scoring/domain/period-gate";
import { Requirement } from "../../../src/scoring/domain/types";

function requirement(text: string): Requirement {
  return { text, category: "general", weight: "blocking" };
}

describe("extractMinimumPeriod", () => {
  it("reads 'a partir do Nº período' phrasing", () => {
    expect(
      extractMinimumPeriod(
        "Estar cursando a partir do 4º período de Educação Física.",
      ),
    ).toBe(4);
  });

  it("reads 'do Nº períodos em diante' phrasing", () => {
    expect(
      extractMinimumPeriod(
        "Cursando do 3º períodos em diante do Ensino Superior em Engenharia de Materiais.",
      ),
    ).toBe(3);
  });

  it("reads 'semestre exigido: N a M' phrasing, taking the minimum", () => {
    expect(extractMinimumPeriod("Semestre exigido: 4 a 9")).toBe(4);
  });

  it("reads 'a partir do Nº semestre' phrasing", () => {
    expect(
      extractMinimumPeriod("Disponibilidade a partir do 5º semestre."),
    ).toBe(5);
  });

  it("returns null for text with no period phrasing", () => {
    expect(
      extractMinimumPeriod("Cursar graduação em Ciências Contábeis"),
    ).toBeNull();
  });

  it("returns null for a bare 'período' mention with no trigger phrase", () => {
    expect(
      extractMinimumPeriod("Disponibilidade de 6 horas por período do dia."),
    ).toBeNull();
  });

  it("returns null for a parsed number outside the valid [1, 8] range", () => {
    expect(
      extractMinimumPeriod("Estar cursando a partir do 12º período."),
    ).toBeNull();
  });
});

describe("detectPeriodGate", () => {
  const opensAtLabel = (period: number) => `label-for-period-${period}`;

  it("returns null when there is more than one blocking failure", () => {
    const result = detectPeriodGate(
      [
        requirement("Estar cursando a partir do 4º período."),
        requirement("Ter CNH categoria B."),
      ],
      { status: "in_progress", period: 2 },
      opensAtLabel,
    );
    expect(result).toBeNull();
  });

  it("returns null when the sole blocking failure is not a period gate", () => {
    const result = detectPeriodGate(
      [requirement("Ter CNH categoria B.")],
      { status: "in_progress", period: 2 },
      opensAtLabel,
    );
    expect(result).toBeNull();
  });

  it("returns null when the candidate has already reached the required period", () => {
    const result = detectPeriodGate(
      [requirement("Estar cursando a partir do 2º período.")],
      { status: "in_progress", period: 4 },
      opensAtLabel,
    );
    expect(result).toBeNull();
  });

  it("returns null when the candidate has already completed the course", () => {
    const result = detectPeriodGate(
      [requirement("Estar cursando a partir do 4º período.")],
      { status: "completed" },
      opensAtLabel,
    );
    expect(result).toBeNull();
  });

  it("returns a gate when the sole blocking failure is a not-yet-reached period", () => {
    const result = detectPeriodGate(
      [requirement("Estar cursando a partir do 4º período.")],
      { status: "in_progress", period: 2 },
      opensAtLabel,
    );
    expect(result).toEqual({
      minimumPeriod: 4,
      opensAtLabel: "label-for-period-4",
    });
  });

  it("returns a gate for a candidate who has not started the course yet", () => {
    const result = detectPeriodGate(
      [requirement("Estar cursando a partir do 1º período.")],
      { status: "not_started" },
      opensAtLabel,
    );
    expect(result).toEqual({
      minimumPeriod: 1,
      opensAtLabel: "label-for-period-1",
    });
  });
});

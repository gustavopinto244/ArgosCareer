import { describe, expect, it } from "vitest";
import { classifyTrack } from "../../../src/prefilter/domain/classify-track";
import { computeTrackAlignment } from "../../../src/scoring/domain/score";
import { TrackWeights } from "../../../src/scoring/domain/types";

const tracks = {
  dev: ["backend", "back-end", "node"],
  security: ["segurança", "firewall"],
  automation: ["automação", "devops"],
};

const trackWeights: TrackWeights = {
  dev: 1.0,
  security: 1.0,
  automation: 0.7,
  unknown: 0.4,
};

describe("classifyTrack", () => {
  it("classifies a title matching one track's keywords", () => {
    expect(classifyTrack("Estágio em Desenvolvimento Backend", tracks)).toEqual(
      ["dev"],
    );
  });

  it("matches a hyphenated config keyword against an unhyphenated title", () => {
    expect(classifyTrack("Estágio Back-End Developer", tracks)).toEqual([
      "dev",
    ]);
  });

  it("returns an empty array when no track keyword matches", () => {
    expect(classifyTrack("Estágio Financeiro", tracks)).toEqual([]);
  });

  it("returns every track that matches, for a title spanning more than one", () => {
    const result = classifyTrack(
      "Estágio DevSecOps — Backend e Segurança",
      tracks,
    );
    expect(result.sort()).toEqual(["dev", "security"].sort());
  });

  it("is case-insensitive and accent-insensitive", () => {
    expect(classifyTrack("ESTÁGIO EM SEGURANÇA DA INFORMAÇÃO", tracks)).toEqual(
      ["security"],
    );
  });

  it("feeds directly into computeTrackAlignment", () => {
    const matched = classifyTrack("Estágio em Desenvolvimento Backend", tracks);
    expect(computeTrackAlignment(matched, trackWeights)).toBe(1.0);
  });

  it("an unmatched title falls back to the unknown weight via computeTrackAlignment", () => {
    const matched = classifyTrack("Estágio Financeiro", tracks);
    expect(computeTrackAlignment(matched, trackWeights)).toBe(0.4);
  });

  it("a multi-track match picks the highest weight via computeTrackAlignment", () => {
    const matched = classifyTrack(
      "Estágio DevSecOps — Automação e Segurança",
      tracks,
    );
    expect(computeTrackAlignment(matched, trackWeights)).toBe(1.0);
  });
});

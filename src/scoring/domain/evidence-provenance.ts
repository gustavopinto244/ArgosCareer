import { Profile } from "../../profile/domain/profile";

/**
 * The prompt renders each evidence line as `- [Competency] text` so the model
 * knows which competency it belongs to, and the model quotes back what it was
 * shown — sometimes including that decoration, sometimes not. Stripping it
 * before comparison is what makes both forms resolve to the same profile
 * line; measured against the first real calibration run, 15 of 22 quotes
 * carried the tag and silently failed to resolve without this.
 */
const EVIDENCE_TAG_PATTERN = /^\s*-?\s*\[[^\]]+\]\s*/;

export function stripEvidenceTag(evidence: string): string {
  return evidence.replace(EVIDENCE_TAG_PATTERN, "").trim();
}

/**
 * Every evidence line actually authored in the profile, keyed by its
 * tag-stripped text — the one canonical index both `recommendation.ts`'s
 * reverse lookup and Stage B's evidence-provenance check
 * (`stage-b-matcher.ts`, docs/audit AC-008) read from, so "is this quote
 * real" is answered the same way in both places.
 */
export function buildProfileEvidenceIndex(
  profile: Profile,
): ReadonlyMap<string, string> {
  const evidenceToCompetency = new Map<string, string>();
  for (const competency of profile.competencies) {
    for (const evidence of competency.evidence) {
      evidenceToCompetency.set(stripEvidenceTag(evidence), competency.name);
    }
  }
  return evidenceToCompetency;
}

/**
 * Whether a quote the model returned actually appears in the profile it was
 * shown — the enforcement `SECURITY.md` already claims ("every `met`
 * requires a verbatim quote from the profile... it cannot manufacture
 * evidence that is not in the profile") but that, until this function
 * existed, nothing in the code checked. `MatchOutputSchema` only validated
 * that `evidence` was a non-empty string; a prompt-injected instruction
 * returning syntactically valid JSON with fabricated evidence text passed
 * straight through to `createMatch` and counted toward `mandatoryCoverage`.
 *
 * Exact string match only, after `stripEvidenceTag` — no fuzzy matching,
 * no substring containment. A quote that is *close* to a real profile line
 * but not identical is exactly as unverifiable as one invented outright;
 * loosening this to "sounds similar" would reopen the same hole with extra
 * steps.
 */
export function isKnownProfileEvidence(
  evidence: string,
  profile: Profile,
): boolean {
  return buildProfileEvidenceIndex(profile).has(stripEvidenceTag(evidence));
}

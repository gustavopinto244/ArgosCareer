import { Profile } from "../../profile/domain/profile";
import { buildEvidenceCatalog } from "./evidence-catalog";

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
 * Every evidence line actually shown to the model, keyed by its tag-stripped
 * text — built from `buildEvidenceCatalog` (docs/audit AC-017 §5 PR-001), the
 * same canonical list `prompts.ts` renders into `PROFILE_EVIDENCE`. Before
 * that unification, this index covered only `profile.competencies[].evidence`
 * while the prompt also rendered academic-enrollment and declared-field
 * lines — a model correctly quoting one of those back verbatim failed this
 * check and was coerced to `not_met`. Reading both sides from one function is
 * what makes that class of regression structurally impossible to reintroduce:
 * "is this quote real" is now answered from the same list "what did the model
 * see" was rendered from.
 *
 * `today` matters only for the academic-enrollment entry's period, and
 * defaults the same way every other undated call in this codebase does
 * (`new Date()` at the point of use) — callers that need it consistent with
 * a specific prompt render (`StageBMatcher.askOne`) pass the same `now()`
 * to both.
 */
export function buildProfileEvidenceIndex(
  profile: Profile,
  today: Date = new Date(),
): ReadonlyMap<string, string> {
  const evidenceToTag = new Map<string, string>();
  for (const entry of buildEvidenceCatalog(profile, today)) {
    evidenceToTag.set(stripEvidenceTag(entry.text), entry.tag);
  }
  return evidenceToTag;
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
 *
 * This proves the quote is *real* — it does not prove the quote is
 * *relevant to the requirement being judged* (docs/audit PR-005): a
 * genuine, verbatim profile line can still be attached to the wrong
 * requirement by a model that a prompt injection in the posting talked
 * into it. That is a second, independent invariant this function does not
 * and cannot check on its own — see ADR-037's discussion of why closing it
 * fully would require either a second, independently-trustworthy
 * verification pass or a requirement-to-competency taxonomy this project
 * does not have yet, and why the delimiting `buildStageAPrompt`/
 * `buildStageBPrompt` now do is a mitigation, not a proof.
 */
export function isKnownProfileEvidence(
  evidence: string,
  profile: Profile,
  today: Date = new Date(),
): boolean {
  return buildProfileEvidenceIndex(profile, today).has(
    stripEvidenceTag(evidence),
  );
}

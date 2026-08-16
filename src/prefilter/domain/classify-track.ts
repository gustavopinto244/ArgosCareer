import { keywordMatchesText } from "./title-match";
import { ProfileTrack } from "../../profile/domain/profile";
import { Track } from "../../scoring/domain/types";
import { Criteria } from "./criteria";

/**
 * Deterministic, keyword-based track classification (docs/04-scoring-model.md
 * §trackAlignment), run in the pre-filter before any LLM call. Feeds
 * `computeTrackAlignment` directly — an empty result here is exactly the
 * "unknown" case that function already falls back to.
 *
 * Matches against the posting's **title only**. `Posting` does not retain a
 * full description (docs/05-domain-model.md scopes it out for now), and
 * title-only matching proved sufficient against real Gupy data during this
 * milestone's development — see ADR-011. Revisit if `unknown` classification
 * turns out to be common once there is real run data to look at.
 *
 * Whole-word matching via `keywordMatchesText`, **not** substring
 * (ADR-011 Amendment 2). Substring matching was the original design and was
 * measurably wrong here for the same reason it was wrong in the title
 * blocklist: `soc` matched inside "social"/"societário"/"sociais" and `api`
 * inside "fisioterapia"/"capital", classifying a physiotherapy internship
 * as `dev`. `keywordMatchesText` still matches `back-end` against
 * "Backend Developer" — hyphen-insensitivity was the real reason substring
 * matching was chosen, and it is preserved by its collapsed-word pass.
 */
export function classifyTrack(
  title: string,
  tracks: Criteria["tracks"],
  exclusions: Criteria["trackExclusions"] = {
    dev: [],
    security: [],
    automation: [],
  },
): Track[] {
  const matches = (keyword: string) => keywordMatchesText(title, keyword);

  const profileTracks = Object.keys(tracks) as ProfileTrack[];
  return profileTracks.filter((track) => {
    // An exclusion outranks a keyword: "ESTAGIÁRIO DE DESENVOLVIMENTO DE
    // EMBALAGENS" contains "desenvolvimento" and is not a software posting
    // (ADR-015). Checked first so the cheap negative wins before the
    // positive is even considered.
    if ((exclusions[track] ?? []).some(matches)) return false;
    return tracks[track].some(matches);
  });
}

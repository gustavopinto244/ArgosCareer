/**
 * Bounds and strips untrusted text before it becomes part of an operational
 * log label (docs/audit PR-010): `stage-b:<fingerprint>:<requirement.text>`
 * put attacker-controlled description text — the source of every extracted
 * `Requirement.text` — straight into every retry/failure log line, unbounded
 * and unescaped: attacker-influenced text with no bound on length or content
 * reaching a log sink. Control characters (including newlines) are stripped
 * so one requirement cannot forge extra log lines or inject terminal escape
 * sequences; the result is capped short because a
 * label's job is a human's eyeball-scan correlation aid, not a transcript —
 * `RequirementSchema`'s own `MAX_REQUIREMENT_TEXT_CHARS` bound
 * (`stage-a-extractor.ts`) already prevents unbounded growth upstream, this
 * is the second, independent bound at the point the text actually reaches a
 * log line.
 */

// eslint-disable-next-line no-control-regex -- deliberately matching C0 controls (incl. newline/tab) and DEL to strip them.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function sanitizeLogLabel(text: string, maxChars = 60): string {
  const stripped = text.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return stripped.length > maxChars
    ? `${stripped.slice(0, maxChars)}…`
    : stripped;
}

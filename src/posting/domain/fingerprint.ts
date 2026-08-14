import { createHash } from "node:crypto";

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}\s]/gu;

/**
 * lowercase -> strip accents -> strip punctuation -> collapse whitespace.
 * Order matters: NFD decomposition must run before the combining-mark strip,
 * or an accented letter survives as base letter + mark instead of collapsing
 * to the bare letter.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(NON_ALPHANUMERIC, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The deduplication key across sources. Frozen once postings are persisted
 * (docs/05-domain-model.md): changing this function changes every fingerprint
 * already stored, which silently re-notifies the entire history.
 *
 * `city` is the empty string for a posting whose location is unknown — an
 * unknown location does not disqualify a posting from fingerprinting, it just
 * narrows the key to company and title.
 */
export function computeFingerprint(
  company: string,
  title: string,
  city: string,
): string {
  const normalized = normalize(company) + normalize(title) + normalize(city);
  return createHash("sha256").update(normalized).digest("hex");
}

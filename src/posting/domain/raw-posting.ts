/**
 * Exactly what a source returned. Shape belongs to the source, not to
 * ArgosCareer — `payload` is retained verbatim and validated tolerantly by
 * whichever collector produced it (see docs/05-domain-model.md).
 *
 * Deliberately separate from `Posting`: collapsing the two would make a
 * source's field rename break every later stage instead of only
 * normalization.
 */
export interface RawPosting {
  readonly source: string;
  readonly sourceId: string;
  readonly payload: unknown;
}

import { computeFingerprint } from "./fingerprint";

export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";

export type Location =
  | { readonly kind: "known"; readonly city: string }
  | { readonly kind: "unknown" };

export type Seniority = "internship" | "trainee" | "junior" | "mid" | "senior";

/**
 * The normalized domain entity. Every stage after normalization consumes
 * only this — never `RawPosting` (docs/05-domain-model.md).
 *
 * `seniority` and `experienceYears` are extracted during stage A (M7) and are
 * absent until then; they exist on the type now so scoring and the pre-filter
 * can be written against a stable shape instead of retrofitted later.
 */
export interface Posting {
  readonly source: string;
  readonly sourceId: string;
  readonly fingerprint: string;
  readonly company: string;
  readonly title: string;
  readonly location: Location;
  readonly workMode: WorkMode;
  readonly seniority: Seniority | null;
  readonly experienceYears: number | null;
  /** Null when the source did not state one — absence is not evidence the
   * posting never expires, and the pre-filter's expiry rule treats it as
   * such (M5): unknown, not automatically pass or fail. */
  readonly applicationDeadline: Date | null;
  /** Null when the source did not provide a link. The digest (M6) treats a
   * posting with no link as undeliverable-without-a-fallback — see
   * `docs/02-architecture.md`'s "link is mandatory" rule. */
  readonly sourceUrl: string | null;
  readonly collectedAt: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly rawPayload: unknown;
}

export type CreatePostingInput = {
  source: string;
  sourceId: string;
  company: string;
  title: string;
  location: Location;
  workMode: WorkMode;
  seniority?: Seniority | null;
  experienceYears?: number | null;
  applicationDeadline?: Date | null;
  sourceUrl?: string | null;
  collectedAt: Date;
  firstSeenAt: Date;
  lastSeenAt: Date;
  rawPayload: unknown;
};

/**
 * Enforces the invariants in docs/05-domain-model.md at construction:
 * company/title/source/sourceId non-empty, fingerprint derived and stable.
 *
 * Throws on violation. This is not a port boundary — ports return failure as
 * a value (docs/05), but a domain factory rejecting invalid input at
 * construction is ordinary validation, not a pipeline stage that principle 1
 * requires to survive.
 */
export function createPosting(input: CreatePostingInput): Posting {
  const source = input.source.trim();
  const sourceId = input.sourceId.trim();
  const company = input.company.trim();
  const title = input.title.trim();

  if (!source) throw new Error("Posting.source must not be empty");
  if (!sourceId) throw new Error("Posting.sourceId must not be empty");
  if (!company) throw new Error("Posting.company must not be empty");
  if (!title) throw new Error("Posting.title must not be empty");

  const city = input.location.kind === "known" ? input.location.city : "";

  return {
    source,
    sourceId,
    company,
    title,
    location: input.location,
    workMode: input.workMode,
    seniority: input.seniority ?? null,
    experienceYears: input.experienceYears ?? null,
    applicationDeadline: input.applicationDeadline ?? null,
    sourceUrl: input.sourceUrl ?? null,
    collectedAt: input.collectedAt,
    firstSeenAt: input.firstSeenAt,
    lastSeenAt: input.lastSeenAt,
    rawPayload: input.rawPayload,
    fingerprint: computeFingerprint(company, title, city),
  };
}

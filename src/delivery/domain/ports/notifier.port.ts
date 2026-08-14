import { Digest } from "../digest";

export interface NotificationError {
  readonly message: string;
  readonly cause?: unknown;
}

export type NotifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: NotificationError };

/**
 * Failure as a value, matching CollectorPort and ScorerPort
 * (docs/05-domain-model.md) — a delivery failure must not throw across the
 * port boundary; the caller decides whether to retry.
 */
export interface NotifierPort {
  notify(digest: Digest): Promise<NotifyResult>;
}

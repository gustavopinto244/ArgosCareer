import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Db } from "../../persistence/infrastructure/db";
import { PostingsRepository } from "../../persistence/infrastructure/postings-repository";
import { DATABASE } from "./database.provider";

/**
 * The one implementation of "discard this posting" (M9-adjacent, pulled
 * forward from Phase 2 feedback work) — `PostingsController` (REST) and
 * `McpController` (MCP) both call this, matching the discipline
 * `RunsService` already established for stage re-execution.
 *
 * `NotFoundException` is a plain `Error` subclass with a `.message`, thrown
 * here rather than in the controller so it works outside an HTTP request
 * context too — the same translation `RunsService`'s docblock explains.
 */
@Injectable()
export class PostingsService {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  /**
   * Marks a posting as permanently rejected by a human decision — never a
   * scoring outcome, and never touched by a profile edit or a re-run
   * (`postings-repository.ts`'s `discard`). `reason` is optional free text,
   * not read by anything downstream.
   */
  discard(fingerprint: string, reason: string | undefined) {
    const repo = new PostingsRepository(this.db);
    const found = repo.discard(fingerprint, new Date(), reason ?? null);
    if (!found) {
      throw new NotFoundException(`No posting with fingerprint ${fingerprint}`);
    }
    return { fingerprint, discarded: true };
  }
}

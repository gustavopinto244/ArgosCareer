import { createHash, timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";

const BEARER_PREFIX = "Bearer ";

/**
 * Every route requires `Authorization: Bearer <API_KEY>` (M9, CLAUDE.md
 * §10) — Hermes reaches this API from a different machine over Tailscale,
 * so unlike the CLI or the scheduler (same box, no network boundary), this
 * surface needs real authentication. A single fixed key, not JWT/Cloudflare
 * Access: one trusted consumer, simple to audit. Recorded as the deliberate
 * starting point in the M9 ADR, with the upgrade path named.
 *
 * Applied globally via `APP_GUARD` (`ApiModule`) — every route is
 * authenticated by default, not opt-in per controller, so a new endpoint
 * added later cannot forget it.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expectedDigest: Buffer;

  constructor() {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      // docs/09-configuration.md rule 1: fail at startup, never lazily. A
      // guard that silently accepted every request because the key was
      // unset would be worse than the process refusing to boot.
      throw new Error("API_KEY is not set (required for the HTTP API, M9)");
    }
    this.expectedDigest = digest(apiKey);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException(
        "Missing or malformed Authorization header",
      );
    }

    const provided = header.slice(BEARER_PREFIX.length);
    // Both sides hashed to a fixed-length digest before comparing: a raw
    // `timingSafeEqual` on the tokens themselves throws on unequal length
    // (rejecting a short guess faster than a long one, a timing leak of
    // exactly the kind this function exists to prevent) and hashing first
    // removes the length signal entirely, not just the length mismatch.
    if (!timingSafeEqual(digest(provided), this.expectedDigest)) {
      throw new UnauthorizedException("Invalid API key");
    }

    return true;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

import { Body, Controller, Param, Post } from "@nestjs/common";
import { PostingsService } from "./postings.service";

export interface DiscardBody {
  readonly reason?: string;
}

/**
 * A human decision, not a run — deliberately its own controller rather than
 * a route bolted onto `RunsController`, whose docblock scopes itself to
 * "read-only run inspection and stage re-execution." Discarding a posting
 * is neither.
 */
@Controller("postings")
export class PostingsController {
  constructor(private readonly postings: PostingsService) {}

  @Post(":fingerprint/discard")
  discard(
    @Param("fingerprint") fingerprint: string,
    @Body() body: DiscardBody = {},
  ) {
    return this.postings.discard(fingerprint, body.reason);
  }
}

import { Controller, Post } from "@nestjs/common";
import { MarketService } from "./market.service";

/**
 * M10's on-demand surface, thin over `MarketService` — same shape as
 * `RunsController` over `RunsService` (M9). A `POST`, not `GET`, even
 * though it only reads: generating and sending the plan is a real action
 * with a real Telegram side effect, matching `POST /runs/deliver`'s
 * precedent for "this does something, not just reports something."
 */
@Controller("market")
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Post("study-plan")
  studyPlan() {
    return this.market.studyPlan();
  }
}

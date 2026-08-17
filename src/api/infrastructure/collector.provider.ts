import { FactoryProvider } from "@nestjs/common";
import { CollectorResolver } from "../../cli/main";
import { collectorFor } from "../../posting/infrastructure/collector-registry";

/**
 * `POST /runs/collect` (M9) needs a real collector resolver in production
 * and a fake one in tests — the same reason `DATABASE`/`NOTIFIER` are
 * factory providers rather than constructed inline in the controller.
 * Overridden with `.overrideProvider(COLLECTOR)` in `runs.controller.test.ts`
 * so the suite never makes a real network request.
 *
 * Resolves by `query.source`, the same registry `SchedulerService` and the
 * CLI already use (`collectorFor`, `src/posting/infrastructure/
 * collector-registry.ts`) — previously this provided a single hardcoded
 * `GupyCollector`, so a REST/MCP `collect` call with a `ciee`/`solides`
 * query silently ran it through Gupy instead (docs/audit AC-003).
 */
export const COLLECTOR = Symbol("COLLECTOR");

export const collectorProvider: FactoryProvider<CollectorResolver> = {
  provide: COLLECTOR,
  useFactory: (): CollectorResolver => collectorFor,
};

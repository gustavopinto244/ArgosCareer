import { FactoryProvider } from "@nestjs/common";
import { CollectorPort } from "../../posting/domain/ports/collector.port";
import { GupyCollector } from "../../posting/infrastructure/gupy-collector";

/**
 * `POST /runs/collect` (M9) needs a real `CollectorPort` in production and
 * a fake one in tests — the same reason `DATABASE`/`NOTIFIER` are factory
 * providers rather than constructed inline in the controller. Overridden
 * with `.overrideProvider(COLLECTOR)` in `runs.controller.test.ts` so the
 * suite never makes a real Gupy request.
 */
export const COLLECTOR = Symbol("COLLECTOR");

export const collectorProvider: FactoryProvider<CollectorPort> = {
  provide: COLLECTOR,
  useFactory: (): CollectorPort => new GupyCollector(),
};

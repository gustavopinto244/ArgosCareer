import { Provider } from "@nestjs/common";
import { RunLock } from "../domain/run-lock";

export const RUN_LOCK = Symbol("RUN_LOCK");

/**
 * A module-level singleton, not a per-module `useFactory` — `RunLock` has no
 * dependencies to construct from (no DB, no config), and `SchedulerService`
 * and `RunsService` must share the literal same instance to guard against
 * each other. `SchedulingModule` and `ApiModule` are siblings under
 * `AppModule`, neither importing the other, so a `useFactory` registered
 * independently in each would build two unrelated locks that never see one
 * another's state — the exact bug this exists to prevent. Both modules
 * provide the same token pointing at this one exported object instead.
 */
export const runLock = new RunLock();

export const runLockProvider: Provider = {
  provide: RUN_LOCK,
  useValue: runLock,
};

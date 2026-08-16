import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { runLockProvider } from "./run-lock.provider";
import { SchedulerService } from "./scheduler.service";

/**
 * M8: the two independent crons ADR-009 specifies, live. `ScheduleModule.forRoot()`
 * is what makes `SchedulerRegistry` injectable — required for
 * `SchedulerService`'s dynamic job registration (`onModuleInit`).
 *
 * `runLockProvider` is registered here **and** in `ApiModule` (ADR-024) —
 * both point at the same exported singleton, not two independent locks.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SchedulerService, runLockProvider],
})
export class SchedulingModule {}

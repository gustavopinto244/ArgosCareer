import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { SchedulerService } from "./scheduler.service";

/**
 * M8: the two independent crons ADR-009 specifies, live. `ScheduleModule.forRoot()`
 * is what makes `SchedulerRegistry` injectable — required for
 * `SchedulerService`'s dynamic job registration (`onModuleInit`).
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SchedulerService],
})
export class SchedulingModule {}

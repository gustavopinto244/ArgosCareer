import { Module } from "@nestjs/common";
import { SchedulingModule } from "./scheduling/infrastructure/scheduling.module";

/**
 * M8 is the first real occupant — the two ADR-009 crons. HTTP arrives in M9.
 */
@Module({
  imports: [SchedulingModule],
})
export class AppModule {}

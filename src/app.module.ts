import { Module } from "@nestjs/common";
import { ApiModule } from "./api/infrastructure/api.module";
import { SchedulingModule } from "./scheduling/infrastructure/scheduling.module";

/**
 * M8 added the two ADR-009 crons; M9 adds the HTTP surface (`ApiModule`) —
 * one process, both concerns, per `docs/08-observability.md`'s "one
 * process, sequential stages" ethos.
 */
@Module({
  imports: [SchedulingModule, ApiModule],
})
export class AppModule {}

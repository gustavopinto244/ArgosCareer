import { Module } from "@nestjs/common";

/**
 * Empty for now — feature modules land as their milestones build them
 * (profile config in M2, persistence in M4, delivery in M6, scheduling in
 * M8, HTTP in M9). This establishes the module-graph pattern from
 * CLAUDE.md before anything depends on it.
 */
@Module({})
export class AppModule {}

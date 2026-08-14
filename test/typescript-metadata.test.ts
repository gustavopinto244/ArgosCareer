import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";

/**
 * Nest's DI resolves constructor parameter types from metadata that
 * `emitDecoratorMetadata` emits (CLAUDE.md §4, ADR-002). This was flagged as
 * unverified under a compiler other than the pinned TypeScript 6 line; this
 * test is the regression check for exactly that mechanism, kept permanently
 * rather than thrown away once the reassessment ran.
 */
class Dependency {
  readonly marker = "dependency";
}

@Injectable()
class Consumer {
  constructor(public readonly dependency: Dependency) {}
}

describe("TypeScript decorator metadata", () => {
  it("emits design:paramtypes for a constructor-injected dependency", () => {
    const paramTypes: unknown[] = Reflect.getMetadata(
      "design:paramtypes",
      Consumer,
    );
    expect(paramTypes).toEqual([Dependency]);
  });

  it("lets Nest's DI container resolve a constructor-injected dependency end to end", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [Dependency, Consumer],
    }).compile();

    const consumer = moduleRef.get(Consumer);
    expect(consumer.dependency).toBeInstanceOf(Dependency);
    expect(consumer.dependency.marker).toBe("dependency");

    await moduleRef.close();
  });
});

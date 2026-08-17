import { and, eq, isNull, lt, ne, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  DeliveryCheckpointPort,
  PreparedDelivery,
} from "../../delivery/domain/ports/delivery-checkpoint.port";
import { Db } from "./db";
import { deliveryChunks, deliveryOperations } from "./schema";

function chunkId(operationId: string, index: number): string {
  return createHash("sha256").update(`${operationId}:${index}`).digest("hex");
}

export class DeliveryOperationsRepository implements DeliveryCheckpointPort {
  constructor(private readonly db: Db) {}

  prepare(
    channelKey: string,
    contentHash: string,
    chunks: readonly string[],
    now: Date,
  ): PreparedDelivery {
    const operationId = createHash("sha256")
      .update(`${channelKey}\0${contentHash}`)
      .digest("hex");

    this.db.transaction((tx) => {
      tx.insert(deliveryOperations)
        .values({
          operationId,
          channelKey,
          contentHash,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      chunks.forEach((body, index) => {
        tx.insert(deliveryChunks)
          .values({
            id: chunkId(operationId, index),
            operationId,
            chunkIndex: index,
            contentHash: createHash("sha256").update(body).digest("hex"),
            body,
            status: "pending",
          })
          .onConflictDoNothing()
          .run();
      });
    });

    const rows = this.db
      .select()
      .from(deliveryChunks)
      .where(eq(deliveryChunks.operationId, operationId))
      .orderBy(deliveryChunks.chunkIndex)
      .all();
    if (
      rows.length !== chunks.length ||
      rows.some((row, index) => row.body !== chunks[index])
    ) {
      throw new Error("delivery checkpoint content does not match operation");
    }
    return {
      operationId,
      chunks: rows.map((row) => ({
        index: row.chunkIndex,
        body: row.body,
        state: row.status as
          "pending" | "failed" | "sending" | "uncertain" | "confirmed",
      })),
    };
  }

  startChunk(operationId: string, index: number, startedAt: Date): void {
    const row = this.db
      .select({ attempts: deliveryChunks.attempts })
      .from(deliveryChunks)
      .where(
        and(
          eq(deliveryChunks.operationId, operationId),
          eq(deliveryChunks.chunkIndex, index),
        ),
      )
      .get();
    this.db
      .update(deliveryChunks)
      .set({
        status: "sending",
        attempts: (row?.attempts ?? 0) + 1,
        lastError: null,
      })
      .where(
        and(
          eq(deliveryChunks.operationId, operationId),
          eq(deliveryChunks.chunkIndex, index),
        ),
      )
      .run();
    this.db
      .update(deliveryOperations)
      .set({ status: "in_progress", updatedAt: startedAt })
      .where(eq(deliveryOperations.operationId, operationId))
      .run();
  }

  claim(
    operationId: string,
    owner: string,
    now: Date,
    leaseMs: number,
  ): boolean {
    const result = this.db
      .update(deliveryOperations)
      .set({
        claimedBy: owner,
        claimExpiresAt: new Date(now.getTime() + leaseMs),
        status: "in_progress",
        updatedAt: now,
      })
      .where(
        and(
          eq(deliveryOperations.operationId, operationId),
          ne(deliveryOperations.status, "complete"),
          or(
            isNull(deliveryOperations.claimedBy),
            eq(deliveryOperations.claimedBy, owner),
            lt(deliveryOperations.claimExpiresAt, now),
          ),
        ),
      )
      .run();
    return result.changes === 1;
  }

  confirmChunk(
    operationId: string,
    index: number,
    messageId: number | null,
    confirmedAt: Date,
  ): void {
    this.db
      .update(deliveryChunks)
      .set({
        status: "confirmed",
        confirmedAt,
        telegramMessageId: messageId,
        lastError: null,
      })
      .where(
        and(
          eq(deliveryChunks.operationId, operationId),
          eq(deliveryChunks.chunkIndex, index),
        ),
      )
      .run();
  }

  failChunk(
    operationId: string,
    index: number,
    error: string,
    now: Date,
  ): void {
    this.db
      .update(deliveryChunks)
      .set({
        status: "failed",
        lastError: error,
      })
      .where(
        and(
          eq(deliveryChunks.operationId, operationId),
          eq(deliveryChunks.chunkIndex, index),
        ),
      )
      .run();
    this.db
      .update(deliveryOperations)
      .set({ status: "failed", updatedAt: now })
      .where(eq(deliveryOperations.operationId, operationId))
      .run();
  }

  markChunkUncertain(
    operationId: string,
    index: number,
    error: string,
    now: Date,
  ): void {
    this.db
      .update(deliveryChunks)
      .set({ status: "uncertain", lastError: error })
      .where(
        and(
          eq(deliveryChunks.operationId, operationId),
          eq(deliveryChunks.chunkIndex, index),
        ),
      )
      .run();
    this.db
      .update(deliveryOperations)
      .set({ status: "failed", updatedAt: now })
      .where(eq(deliveryOperations.operationId, operationId))
      .run();
  }

  complete(operationId: string, completedAt: Date): void {
    this.db
      .update(deliveryOperations)
      .set({
        status: "complete",
        completedAt,
        updatedAt: completedAt,
        claimedBy: null,
        claimExpiresAt: null,
      })
      .where(eq(deliveryOperations.operationId, operationId))
      .run();
  }

  release(operationId: string, owner: string, now: Date): void {
    this.db
      .update(deliveryOperations)
      .set({ claimedBy: null, claimExpiresAt: null, updatedAt: now })
      .where(
        and(
          eq(deliveryOperations.operationId, operationId),
          eq(deliveryOperations.claimedBy, owner),
        ),
      )
      .run();
  }

  /** Manual resolution for the one state no transport can decide safely:
   * the request may have reached Telegram, but its acknowledgement was lost.
   * "confirmed" skips that chunk forever; "retry" explicitly accepts the
   * duplicate risk and makes it sendable again. */
  reconcileUncertainChunk(
    operationId: string,
    index: number,
    resolution: "confirmed" | "retry",
    reconciledAt: Date,
    messageId: number | null = null,
  ): void {
    this.db.transaction((tx) => {
      const row = tx
        .select({ status: deliveryChunks.status })
        .from(deliveryChunks)
        .where(
          and(
            eq(deliveryChunks.operationId, operationId),
            eq(deliveryChunks.chunkIndex, index),
          ),
        )
        .get();
      if (!row) throw new Error("delivery operation/chunk was not found");
      if (row.status !== "uncertain" && row.status !== "sending") {
        throw new Error(
          `delivery chunk is ${row.status}; only uncertain/sending chunks can be reconciled`,
        );
      }

      tx.update(deliveryChunks)
        .set(
          resolution === "confirmed"
            ? {
                status: "confirmed",
                confirmedAt: reconciledAt,
                telegramMessageId: messageId,
                lastError: "manually reconciled as confirmed",
              }
            : {
                status: "pending",
                confirmedAt: null,
                telegramMessageId: null,
                lastError:
                  "manual retry authorized after uncertain acknowledgement",
              },
        )
        .where(
          and(
            eq(deliveryChunks.operationId, operationId),
            eq(deliveryChunks.chunkIndex, index),
          ),
        )
        .run();

      const remaining = tx
        .select({ status: deliveryChunks.status })
        .from(deliveryChunks)
        .where(eq(deliveryChunks.operationId, operationId))
        .all();
      const complete =
        remaining.length > 0 &&
        remaining.every((chunk) => chunk.status === "confirmed");
      tx.update(deliveryOperations)
        .set({
          status: complete ? "complete" : "pending",
          updatedAt: reconciledAt,
          completedAt: complete ? reconciledAt : null,
          claimedBy: null,
          claimExpiresAt: null,
        })
        .where(eq(deliveryOperations.operationId, operationId))
        .run();
    });
  }
}

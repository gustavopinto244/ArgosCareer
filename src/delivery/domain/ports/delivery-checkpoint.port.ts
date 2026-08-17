export interface DeliveryChunkCheckpoint {
  readonly index: number;
  readonly body: string;
  readonly state: "pending" | "failed" | "sending" | "uncertain" | "confirmed";
}

export interface PreparedDelivery {
  readonly operationId: string;
  readonly chunks: readonly DeliveryChunkCheckpoint[];
}

/** Persistence boundary used by TelegramNotifier. The transport owns when a
 * chunk is confirmed; SQLite owns crash recovery and cross-process claims. */
export interface DeliveryCheckpointPort {
  prepare(
    channelKey: string,
    contentHash: string,
    chunks: readonly string[],
    now: Date,
  ): PreparedDelivery;
  claim(
    operationId: string,
    owner: string,
    now: Date,
    leaseMs: number,
  ): boolean;
  startChunk(operationId: string, index: number, startedAt: Date): void;
  confirmChunk(
    operationId: string,
    index: number,
    messageId: number | null,
    confirmedAt: Date,
  ): void;
  failChunk(operationId: string, index: number, error: string, now: Date): void;
  markChunkUncertain(
    operationId: string,
    index: number,
    error: string,
    now: Date,
  ): void;
  complete(operationId: string, completedAt: Date): void;
  release(operationId: string, owner: string, now: Date): void;
}

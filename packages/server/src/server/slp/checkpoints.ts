import type { Logger } from "pino";

import {
  SlpCheckpointSchema,
  SlpRecordStore,
  type SlpCheckpointContent,
  type SlpCheckpointRecord,
} from "./store.js";

export interface SlpCheckpointStoreOptions {
  directory: string;
  logger: Logger;
  now: () => Date;
}

export interface SlpCheckpointWrite {
  groupId: string;
  slotId: string;
  generationId: string;
  agentId: string;
  content: SlpCheckpointContent;
  coveredMailIds: string[];
}

/**
 * The slot's current checkpoint, rewritten in place by the agent that owns
 * the slot, and the immutable copy a transfer takes at its switch. Design:
 * docs/slp/handoff.md#checkpoint.
 */
export class SlpCheckpointStore {
  private readonly store: SlpRecordStore<SlpCheckpointRecord>;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly records = new Map<string, SlpCheckpointRecord>();

  constructor(options: SlpCheckpointStoreOptions) {
    this.store = new SlpRecordStore(options.directory, SlpCheckpointSchema);
    this.logger = options.logger;
    this.now = options.now;
  }

  async recover(): Promise<void> {
    for (const { id, result } of await this.store.list()) {
      if (result instanceof Error) {
        this.logger.error({ checkpointId: id, err: result }, "SLP checkpoint record unreadable");
        continue;
      }
      this.records.set(result.id, result);
    }
  }

  current(slotId: string): SlpCheckpointRecord | null {
    return this.records.get(slotId) ?? null;
  }

  finalized(transferId: string): SlpCheckpointRecord | null {
    return this.records.get(transferId) ?? null;
  }

  async writeCurrent(input: SlpCheckpointWrite): Promise<SlpCheckpointRecord> {
    const previous = this.current(input.slotId);
    const at = this.now().toISOString();
    const record: SlpCheckpointRecord = {
      id: input.slotId,
      kind: "current",
      groupId: input.groupId,
      slotId: input.slotId,
      generationId: input.generationId,
      agentId: input.agentId,
      revision: (previous?.revision ?? 0) + 1,
      content: input.content,
      coveredMailIds: input.coveredMailIds,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    await this.persist(record);
    return record;
  }

  /** Copies the slot's current checkpoint under the transfer id. Idempotent per transfer. */
  async finalize(slotId: string, transferId: string): Promise<SlpCheckpointRecord> {
    const existing = this.finalized(transferId);
    if (existing) return existing;
    const current = this.current(slotId);
    if (!current) throw new Error(`Slot ${slotId} has no checkpoint to finalize`);
    const record: SlpCheckpointRecord = {
      ...current,
      id: transferId,
      kind: "finalized",
      updatedAt: this.now().toISOString(),
    };
    await this.persist(record);
    return record;
  }

  private async persist(record: SlpCheckpointRecord): Promise<void> {
    await this.store.write(record);
    this.records.set(record.id, record);
  }
}

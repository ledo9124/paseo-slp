import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { SlpMailbox } from "./mailbox.js";
import {
  newSlpId,
  SlpHandbackSchema,
  SlpRecordStore,
  type SlpHandbackOutcome,
  type SlpHandbackRecord,
} from "./store.js";

export interface SlpHandbackRegisterOptions {
  directory: string;
  logger: Logger;
  agentManager: Pick<AgentManager, "subscribe" | "getLastAssistantMessage">;
  agentStorage: Pick<AgentStorage, "get">;
  mailbox: Pick<SlpMailbox, "enqueue">;
  now: () => Date;
}

export interface SlpHandbackRegistration {
  groupId: string;
  peerSlotId: string;
  peerGenerationId: string;
  peerAgentId: string;
  ownerSlotId: string;
}

/**
 * The durable logical handback: registered before the Peer exists, re-armed
 * at boot, and addressed to the owner slot's mailbox so it can never cancel
 * the owner's live turn or bind to a retired generation. This replaces
 * `setupFinishNotification` for SLP Peers; see
 * docs/slp/handoff.md#relationships-and-background-work for why that channel
 * cannot carry it.
 */
export class SlpHandbackRegister {
  private readonly store: SlpRecordStore<SlpHandbackRecord>;
  private readonly logger: Logger;
  private readonly agentManager: SlpHandbackRegisterOptions["agentManager"];
  private readonly agentStorage: SlpHandbackRegisterOptions["agentStorage"];
  private readonly mailbox: SlpHandbackRegisterOptions["mailbox"];
  private readonly now: () => Date;
  private readonly records = new Map<string, SlpHandbackRecord>();
  private readonly watchers = new Map<string, () => void>();
  /** Serializes every state change for one handback. */
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(options: SlpHandbackRegisterOptions) {
    this.store = new SlpRecordStore(options.directory, SlpHandbackSchema);
    this.logger = options.logger;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.mailbox = options.mailbox;
    this.now = options.now;
  }

  list(): SlpHandbackRecord[] {
    return Array.from(this.records.values());
  }

  getForPeer(peerAgentId: string): SlpHandbackRecord | null {
    for (const record of this.records.values()) {
      if (record.peerAgentId === peerAgentId) return record;
    }
    return null;
  }

  /** Persist the handback before the Peer is created, then watch for the Peer. */
  async register(registration: SlpHandbackRegistration): Promise<SlpHandbackRecord> {
    const at = this.now().toISOString();
    const record: SlpHandbackRecord = {
      id: newSlpId("hb"),
      ...registration,
      state: "armed",
      transferInProgress: false,
      notice: null,
      createdAt: at,
      updatedAt: at,
    };
    const persisted = await this.persist(record);
    this.arm(record.id, record.peerAgentId);
    return persisted;
  }

  /**
   * A transfer of the Peer slot starts: the retiring generation's close must
   * not fire as a failure. Cleared by supersede or by the transfer's abort.
   */
  async setTransferInProgress(peerAgentId: string, inProgress: boolean): Promise<void> {
    const record = this.getForPeer(peerAgentId);
    if (!record || record.state !== "armed") return;
    await this.inLane(record.id, async () => {
      await this.persist({ ...record, transferInProgress: inProgress });
    });
  }

  /** The Peer generation was replaced; its successor registers its own record. */
  async supersede(peerAgentId: string, transferId: string): Promise<void> {
    const record = this.getForPeer(peerAgentId);
    if (!record || record.state !== "armed") return;
    this.stopWatching(record.id);
    await this.inLane(record.id, async () => {
      await this.persist({ ...baseOf(record), state: "superseded", transferId });
    });
  }

  /** The Peer was never created; nothing will ever hand back. */
  async abandon(peerAgentId: string): Promise<void> {
    const record = this.getForPeer(peerAgentId);
    if (!record || record.state !== "armed") return;
    this.stopWatching(record.id);
    await this.inLane(record.id, async () => {
      await this.persist({
        ...baseOf(record),
        state: "abandoned",
        abandonedAt: this.now().toISOString(),
      });
    });
  }

  /**
   * Boot: an armed handback whose Peer was never created is abandoned; one
   * whose Peer exists lost its turn with the daemon, so the owner is told and
   * the watch is re-armed; a fired handback whose mail was not yet queued is
   * queued now.
   */
  async recover(peerExists: (record: SlpHandbackRecord) => boolean): Promise<void> {
    for (const { id, result } of await this.store.list()) {
      if (result instanceof Error) {
        this.logger.error({ handbackId: id, err: result }, "SLP handback record unreadable");
        continue;
      }
      this.records.set(result.id, result);
    }
    for (const record of this.records.values()) {
      if (record.state === "armed" && !peerExists(record)) {
        await this.abandon(record.peerAgentId);
      } else if (record.state === "armed") {
        this.arm(record.id, record.peerAgentId);
        await this.inLane(record.id, () => this.notifyInterrupted(record));
      } else if (record.state === "fired") {
        await this.inLane(record.id, () => this.queueHandback(record));
      }
    }
  }

  dispose(): void {
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
  }

  private arm(id: string, peerAgentId: string): void {
    this.stopWatching(id);
    let hasSeenRunning = false;
    const stop = this.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const lifecycle = event.agent.lifecycle;
        if (lifecycle === "running") {
          if (event.agent.pendingPermissions.size === 0) hasSeenRunning = true;
          return;
        }
        // A stop, close or error while the Peer's slot is being handed off is
        // transfer-related, not a result; the successor's own record fires later.
        if (this.records.get(id)?.transferInProgress) return;
        if (lifecycle === "error") {
          this.fire(id, "errored");
        } else if (lifecycle === "idle" && hasSeenRunning) {
          this.fire(id, "finished");
        } else if (lifecycle === "closed") {
          this.fire(id, "closed");
        }
      },
      { agentId: peerAgentId, replayState: false },
    );
    this.watchers.set(id, stop);
  }

  private stopWatching(id: string): void {
    this.watchers.get(id)?.();
    this.watchers.delete(id);
  }

  private fire(id: string, reason: SlpHandbackOutcome["reason"]): void {
    this.stopWatching(id);
    void this.inLane(id, async () => {
      const record = this.records.get(id);
      if (record?.state !== "armed") return;
      const fired: SlpHandbackRecord = {
        ...baseOf(record),
        state: "fired",
        outcome: { reason, at: this.now().toISOString() },
      };
      await this.persist(fired);
      await this.queueHandback(fired);
    });
  }

  /** The mail id is derived from the handback, so re-queueing after a crash is a no-op. */
  private async queueHandback(
    record: Extract<SlpHandbackRecord, { state: "fired" }>,
  ): Promise<void> {
    const mail = await this.mailbox.enqueue({
      id: `${record.id}:handback`,
      groupId: record.groupId,
      slotId: record.ownerSlotId,
      fromSlotId: record.peerSlotId,
      kind: "handback",
      prompt: await this.describe(record, describeOutcome(record.outcome.reason)),
    });
    await this.persist({
      ...baseOf(record),
      state: "delivered",
      outcome: record.outcome,
      mailId: mail.id,
    });
  }

  private async notifyInterrupted(
    record: Extract<SlpHandbackRecord, { state: "armed" }>,
  ): Promise<void> {
    const at = this.now().toISOString();
    const mail = await this.mailbox.enqueue({
      id: `${record.id}:interrupted:${at}`,
      groupId: record.groupId,
      slotId: record.ownerSlotId,
      fromSlotId: record.peerSlotId,
      kind: "interrupted",
      prompt: await this.describe(
        record,
        "interrupted. The daemon restarted before this Peer's turn completed; the turn is lost. Re-drive the Peer or replace the assignment. Its handback will still arrive when a later turn ends.",
      ),
    });
    await this.persist({ ...record, notice: { mailId: mail.id, at } });
  }

  private async describe(record: SlpHandbackRecord, outcome: string): Promise<string> {
    const peer = await this.agentStorage.get(record.peerAgentId);
    const title = peer?.title ?? record.peerAgentId;
    const lastMessage = await this.agentManager.getLastAssistantMessage(record.peerAgentId);
    const lines = [
      `SLP handback ${record.id}`,
      `Peer: ${title} (${record.peerAgentId})`,
      `Outcome: ${outcome}`,
      lastMessage ? `Last message:\n${lastMessage}` : "Last message: (none)",
    ];
    return formatSystemNotificationPrompt(lines.join("\n"));
  }

  private async persist(record: SlpHandbackRecord): Promise<SlpHandbackRecord> {
    const next = { ...record, updatedAt: this.now().toISOString() };
    await this.store.write(next);
    this.records.set(next.id, next);
    return next;
  }

  private inLane<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      (error: unknown) => {
        this.logger.error({ handbackId: id, err: error }, "SLP handback operation failed");
      },
    );
    this.lanes.set(id, tail);
    void tail.finally(() => {
      if (this.lanes.get(id) === tail) this.lanes.delete(id);
    });
    return run;
  }
}

/** Identity and registration fields, shared by every state. */
function baseOf(record: SlpHandbackRecord) {
  return {
    id: record.id,
    groupId: record.groupId,
    peerSlotId: record.peerSlotId,
    peerGenerationId: record.peerGenerationId,
    peerAgentId: record.peerAgentId,
    ownerSlotId: record.ownerSlotId,
    transferInProgress: record.transferInProgress,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function describeOutcome(reason: SlpHandbackOutcome["reason"]): string {
  switch (reason) {
    case "finished":
      return "finished; the last message below is the handback.";
    case "errored":
      return "errored before handing back.";
    case "closed":
      return "was closed before handing back.";
  }
}

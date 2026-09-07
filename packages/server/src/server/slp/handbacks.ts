import type { Logger } from "pino";

import { ensureAgentLoaded, type AgentLoaderManager } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentRequests } from "../agent/requests/index.js";
import {
  newSlpId,
  SlpHandbackStore,
  type SlpHandbackOutcome,
  type SlpHandbackRecord,
} from "./store.js";

export type SlpHandbackAgentManager = AgentLoaderManager &
  Pick<
    AgentManager,
    "subscribe" | "getLastAssistantMessage" | "admitForegroundTurn" | "waitForAgentEvent"
  >;

export interface SlpHandbackRegisterOptions {
  directory: string;
  logger: Logger;
  agentManager: SlpHandbackAgentManager;
  agentStorage: AgentStorage;
  agentRequests: Pick<AgentRequests, "send">;
  /** The slot's current active agent, read at delivery time. Null while the slot has no active generation. */
  resolveSlotAgent: (groupId: string, slotId: string) => string | null;
  now: () => Date;
}

export interface SlpHandbackRegistration {
  groupId: string;
  peerSlotId: string;
  peerGenerationId: string;
  peerAgentId: string;
  ownerSlotId: string;
}

/** The message a record currently owes its owner. */
interface OwedMessage {
  messageId: string;
  kind: "handback" | "interrupted";
}

/**
 * The durable logical handback: registered before the Peer exists, re-armed
 * at boot, addressed to a slot rather than an agent, and delivered through
 * turn admission so a handback never cancels the owner's live turn. This
 * replaces `setupFinishNotification` for SLP Peers; see
 * docs/slp/handoff.md#relationships-and-background-work for why that channel
 * cannot carry it.
 */
export class SlpHandbackRegister {
  private readonly store: SlpHandbackStore;
  private readonly logger: Logger;
  private readonly agentManager: SlpHandbackAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly agentRequests: Pick<AgentRequests, "send">;
  private readonly resolveSlotAgent: SlpHandbackRegisterOptions["resolveSlotAgent"];
  private readonly now: () => Date;
  private readonly records = new Map<string, SlpHandbackRecord>();
  private readonly watchers = new Map<string, () => void>();
  /** Serializes every state change and delivery for one handback. */
  private readonly lanes = new Map<string, Promise<unknown>>();

  constructor(options: SlpHandbackRegisterOptions) {
    this.store = new SlpHandbackStore(options.directory);
    this.logger = options.logger;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.agentRequests = options.agentRequests;
    this.resolveSlotAgent = options.resolveSlotAgent;
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
    await this.persist(record);
    this.arm(record.id, record.peerAgentId);
    return record;
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
   * the watch is re-armed; a fired handback whose delivery is still owed is
   * delivered to the slot's current agent.
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
        await this.inLane(record.id, async () => {
          if (record.notice?.receipt === "pending") return;
          const at = this.now().toISOString();
          await this.persist({
            ...record,
            notice: { messageId: `${record.id}:interrupted:${at}`, receipt: "pending" },
          });
        });
        void this.inLane(record.id, () => this.deliver(record.id));
      } else if (record.state === "fired") {
        void this.inLane(record.id, () => this.deliver(record.id));
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
        if (lifecycle === "error") {
          this.fire(id, "errored");
        } else if (lifecycle === "idle" && hasSeenRunning) {
          this.fire(id, "finished");
        } else if (lifecycle === "closed" && !this.records.get(id)?.transferInProgress) {
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
      await this.persist({
        ...baseOf(record),
        state: "fired",
        outcome: { reason, at: this.now().toISOString() },
        delivery: { messageId: `${record.id}:handback` },
      });
      await this.deliver(id);
    });
  }

  /**
   * Resolve the owner now, not at registration. A busy owner that cannot be
   * steered keeps the delivery pending and retries when it goes idle; the
   * journal discards the declined attempt, so no receipt turns uncertain.
   */
  private async deliver(id: string): Promise<void> {
    const record = this.records.get(id);
    const owed = record ? owedMessage(record) : null;
    if (!record || !owed) return;
    const ownerAgentId = this.resolveSlotAgent(record.groupId, record.ownerSlotId);
    if (!ownerAgentId) {
      this.logger.warn(
        { handbackId: record.id, ownerSlotId: record.ownerSlotId },
        "SLP handback owner slot has no active generation; delivery stays pending",
      );
      return;
    }
    const body = await this.describe(record, owed.kind);
    let result: "sent" | "declined";
    try {
      result = await this.agentRequests.send({
        agentId: ownerAgentId,
        messageId: owed.messageId,
        request: { handbackId: record.id, kind: owed.kind },
        prepare: async () => {
          await ensureAgentLoaded(ownerAgentId, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.logger,
          });
        },
        send: async () => {
          const admission = await this.agentManager.admitForegroundTurn(ownerAgentId, body, {
            steer: true,
            clientMessageId: owed.messageId,
          });
          return admission.status === "busy" ? "declined" : undefined;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "agent_request_outcome_unknown") {
        await this.settle(record, owed, "uncertain");
        this.logger.warn(
          { handbackId: record.id, ownerAgentId },
          "SLP handback acceptance is uncertain",
        );
        return;
      }
      this.logger.error(
        { handbackId: record.id, ownerAgentId, err: error },
        "SLP handback delivery failed",
      );
      return;
    }
    if (result === "declined") {
      this.retryWhenIdle(record.id, ownerAgentId);
      return;
    }
    await this.settle(record, owed, "accepted");
  }

  private async settle(
    record: SlpHandbackRecord,
    owed: OwedMessage,
    receipt: "accepted" | "uncertain",
  ): Promise<void> {
    if (record.state === "fired") {
      await this.persist({
        ...baseOf(record),
        state: "delivered",
        outcome: record.outcome,
        delivery: { messageId: owed.messageId, receipt },
      });
    } else if (record.state === "armed") {
      await this.persist({ ...record, notice: { messageId: owed.messageId, receipt } });
    }
  }

  /**
   * The owner's turn is over when the manager reports it not busy with no
   * foreground run pending; a pending permission is reported instead of
   * waited on, so that case waits for the permission to clear first.
   */
  private retryWhenIdle(id: string, ownerAgentId: string): void {
    void this.awaitOwnerTurnEnd(ownerAgentId)
      .then(() => this.inLane(id, () => this.deliver(id)))
      .catch((error: unknown) => {
        this.logger.error(
          { handbackId: id, ownerAgentId, err: error },
          "SLP handback retry failed",
        );
      });
  }

  private async awaitOwnerTurnEnd(ownerAgentId: string): Promise<void> {
    for (;;) {
      const result = await this.agentManager.waitForAgentEvent(ownerAgentId);
      if (!result.permission) return;
      await new Promise<void>((resolve) => {
        const stop = this.agentManager.subscribe(
          (event) => {
            if (event.type !== "agent_state" || event.agent.pendingPermissions.size > 0) return;
            stop();
            resolve();
          },
          { agentId: ownerAgentId, replayState: false },
        );
      });
    }
  }

  private async describe(record: SlpHandbackRecord, kind: OwedMessage["kind"]): Promise<string> {
    const peer = await this.agentStorage.get(record.peerAgentId);
    const title = peer?.title ?? record.peerAgentId;
    const lastMessage = await this.agentManager.getLastAssistantMessage(record.peerAgentId);
    const outcome =
      record.state === "fired" && kind === "handback"
        ? describeOutcome(record.outcome.reason)
        : "interrupted. The daemon restarted before this Peer's turn completed; the turn is lost. Re-drive the Peer or replace the assignment. Its handback will still arrive when a later turn ends.";
    const lines = [
      `SLP handback ${record.id}`,
      `Peer: ${title} (${record.peerAgentId})`,
      `Outcome: ${outcome}`,
      lastMessage ? `Last message:\n${lastMessage}` : "Last message: (none)",
    ];
    return formatSystemNotificationPrompt(lines.join("\n"));
  }

  private async persist(record: SlpHandbackRecord): Promise<void> {
    const next = { ...record, updatedAt: this.now().toISOString() };
    await this.store.write(next);
    this.records.set(next.id, next);
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

function owedMessage(record: SlpHandbackRecord): OwedMessage | null {
  switch (record.state) {
    case "fired":
      return { messageId: record.delivery.messageId, kind: "handback" };
    case "armed":
      return record.notice?.receipt === "pending"
        ? { messageId: record.notice.messageId, kind: "interrupted" }
        : null;
    case "delivered":
    case "abandoned":
      return null;
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

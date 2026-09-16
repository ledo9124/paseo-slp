import type { Logger } from "pino";

import { ensureAgentLoaded, type AgentLoaderManager } from "../agent/agent-loading.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { newSlpId, SlpMailSchema, SlpRecordStore, type SlpMailRecord } from "./store.js";
import { nextTurnBoundary } from "./turn-boundary.js";

export type SlpMailboxAgentManager = AgentLoaderManager &
  Pick<AgentManager, "admitForegroundTurn" | "subscribe">;

/** What the slot looks like at dispatch time. */
export type SlpSlotDestination =
  | { status: "active"; agentId: string; generationId: string }
  | { status: "held"; reason: string }
  | { status: "empty" };

export interface SlpMailboxOptions {
  directory: string;
  logger: Logger;
  agentManager: SlpMailboxAgentManager;
  agentStorage: AgentStorage;
  resolveSlot: (groupId: string, slotId: string) => SlpSlotDestination;
  now: () => Date;
  /** Called after every durable mail-state change; the service fans it out to clients. */
  onChange?: (groupId: string) => void;
}

/**
 * How many times one message may fail before admission is reached before the
 * loop stops working the slot. A failure there leaves nothing durable, so the
 * message stays `queued`, which is already the honest record of a send that
 * has not been delivered; giving up defers it to the next wake-up or to the
 * pump every restart performs, rather than retrying forever behind a log.
 */
export const SLP_DISPATCH_ATTEMPTS = 5;
const SLP_DISPATCH_RETRY_STEP_MS = 10;

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface SlpMailInput {
  /** Stable message id; an existing id returns the existing record instead of a duplicate. */
  id?: string;
  groupId: string;
  slotId: string;
  fromSlotId: string | null;
  kind: SlpMailRecord["kind"];
  prompt: AgentPromptInput;
}

/**
 * The slot mailbox: durable, keyed by slot, dispatched one message at a time
 * through turn admission, so mail never interrupts the recipient and a
 * generation switch does not migrate or lose it. Design:
 * docs/slp/architecture.md#admission.
 */
export class SlpMailbox {
  private readonly store: SlpRecordStore<SlpMailRecord>;
  private readonly logger: Logger;
  private readonly agentManager: SlpMailboxAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly resolveSlot: SlpMailboxOptions["resolveSlot"];
  private readonly now: () => Date;
  private readonly onChange: (groupId: string) => void;
  private readonly records = new Map<string, SlpMailRecord>();
  /** One dispatch loop per slot; `close` waits on these. */
  private readonly pumps = new Map<string, Promise<void>>();
  /**
   * Slots with a live loop. Set before the loop starts, unlike `pumps`, which
   * is only assigned once `drain` yields; a pump re-entered from inside the
   * loop would otherwise start a second one and orphan the first.
   */
  private readonly running = new Set<string>();
  /** Wake-ups a live loop has not accounted for yet. Read as it exits. */
  private readonly wakes = new Set<string>();
  private closing = false;
  /** Resolved by `close`, so a loop parked on a turn boundary stops waiting. */
  private readonly closed: Promise<void>;
  private announceClosed: () => void = () => undefined;
  private nextSequence = 0;

  constructor(options: SlpMailboxOptions) {
    this.store = new SlpRecordStore(options.directory, SlpMailSchema);
    this.logger = options.logger;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.resolveSlot = options.resolveSlot;
    this.now = options.now;
    this.onChange = options.onChange ?? (() => undefined);
    this.closed = new Promise<void>((resolve) => {
      this.announceClosed = resolve;
    });
  }

  list(): SlpMailRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.sequence - b.sequence);
  }

  get(id: string): SlpMailRecord | null {
    return this.records.get(id) ?? null;
  }

  /** Durable before the receipt is returned; dispatch starts in the background. */
  async enqueue(input: SlpMailInput): Promise<SlpMailRecord> {
    const existing = input.id ? this.records.get(input.id) : null;
    if (existing) return existing;
    const at = this.now().toISOString();
    const record: SlpMailRecord = {
      id: input.id ?? newSlpId("mail"),
      groupId: input.groupId,
      slotId: input.slotId,
      fromSlotId: input.fromSlotId,
      kind: input.kind,
      prompt: input.prompt,
      sequence: this.nextSequence++,
      state: "queued",
      createdAt: at,
      updatedAt: at,
    };
    const persisted = await this.persist(record);
    this.pump(record.groupId, record.slotId);
    return persisted;
  }

  /**
   * Boot: a message the daemon died while dispatching may have reached the
   * provider, so it becomes `uncertain` and is retained, never replayed.
   * Queued mail resumes dispatch.
   */
  async recover(): Promise<void> {
    for (const { id, result } of await this.store.list()) {
      if (result instanceof Error) {
        this.logger.error({ mailId: id, err: result }, "SLP mail record unreadable");
        continue;
      }
      this.records.set(result.id, result);
      this.nextSequence = Math.max(this.nextSequence, result.sequence + 1);
    }
    for (const record of this.records.values()) {
      if (record.state === "dispatching") {
        await this.persist({
          ...record,
          state: "uncertain",
          reason: "daemon restarted during dispatch",
        });
        this.logger.warn({ mailId: record.id }, "SLP mail acceptance is uncertain after restart");
      }
    }
    const pumped = new Set<string>();
    for (const record of this.list()) {
      const key = `${record.groupId}/${record.slotId}`;
      if (pumped.has(key)) continue;
      pumped.add(key);
      this.pump(record.groupId, record.slotId);
    }
  }

  /**
   * Stop dispatching and wait for the loops already running. A loop waiting
   * for a busy recipient's turn to end would never return on its own, so it
   * is released here; its mail stays `queued` for the next daemon.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.announceClosed();
    while (this.pumps.size > 0) {
      await Promise.all(this.pumps.values());
    }
  }

  /**
   * Re-check a slot whose destination changed (a hold lifted, a generation
   * activated). The wake-up is recorded before the live loop is consulted,
   * and a loop reads that record after it releases the slot, so a wake-up
   * landing in the window between the loop's last look at the queue and its
   * exit restarts it instead of being dropped with no loop left to honour it.
   */
  pump(groupId: string, slotId: string): void {
    if (this.closing) return;
    const key = `${groupId}/${slotId}`;
    this.wakes.add(key);
    if (this.running.has(key)) return;
    this.start(groupId, slotId, key);
  }

  /**
   * Restarting only on a recorded wake-up is what keeps a slot whose loop
   * exited on a hold from spinning: that exit leaves its message queued, so a
   * loop that re-checked the queue instead would re-enter itself forever.
   */
  private start(groupId: string, slotId: string, key: string): void {
    this.wakes.delete(key);
    this.running.add(key);
    const run = this.drain(groupId, slotId)
      .catch((error: unknown) => {
        this.logger.error({ groupId, slotId, err: error }, "SLP mail dispatch failed");
      })
      .finally(() => {
        this.running.delete(key);
        this.pumps.delete(key);
        if (this.wakes.delete(key) && !this.closing) this.start(groupId, slotId, key);
      });
    this.pumps.set(key, run);
  }

  private async drain(groupId: string, slotId: string): Promise<void> {
    let failures = 0;
    for (;;) {
      if (this.closing) return;
      const next = this.nextQueued(groupId, slotId);
      if (!next) return;
      const destination = this.resolveSlot(groupId, slotId);
      if (destination.status !== "active") {
        this.logger.info(
          { mailId: next.id, slotId, destination: destination.status },
          "SLP mail waits for its slot",
        );
        return;
      }
      // Subscribed before the attempt so a boundary crossed during it is not missed.
      const boundary = nextTurnBoundary(this.agentManager, destination.agentId);
      try {
        const outcome = await this.dispatch(next, destination);
        failures = 0;
        if (outcome === "busy") await Promise.race([boundary.reached, this.closed]);
      } catch (error) {
        failures += 1;
        if (failures >= SLP_DISPATCH_ATTEMPTS) {
          this.logger.error(
            { mailId: next.id, groupId, slotId, failures, err: error },
            "SLP mail delivery deferred to the next wake-up",
          );
          return;
        }
        this.logger.warn(
          { mailId: next.id, groupId, slotId, failures, err: error },
          "SLP mail dispatch failed before admission; retrying",
        );
        await Promise.race([pause(SLP_DISPATCH_RETRY_STEP_MS * failures), this.closed]);
      } finally {
        boundary.stop();
      }
    }
  }

  /** Sequence order, except that an activation notice goes before whatever queued during the transfer. */
  private nextQueued(groupId: string, slotId: string): SlpMailRecord | null {
    let candidate: SlpMailRecord | null = null;
    for (const record of this.records.values()) {
      if (record.groupId !== groupId || record.slotId !== slotId || record.state !== "queued") {
        continue;
      }
      if (!candidate || precedes(record, candidate)) candidate = record;
    }
    return candidate;
  }

  /**
   * The attempt is durable before the provider is asked. `busy` is the one
   * admission answer that proves no provider call happened, so only it
   * returns the message to `queued`.
   */
  private async dispatch(
    record: SlpMailRecord,
    destination: Extract<SlpSlotDestination, { status: "active" }>,
  ): Promise<"accepted" | "busy" | "uncertain"> {
    await ensureAgentLoaded(destination.agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
    const attempt = {
      id: newSlpId("attempt"),
      generationId: destination.generationId,
      agentId: destination.agentId,
      at: this.now().toISOString(),
    };
    await this.persist({ ...record, state: "dispatching", attempt });
    let admission: Awaited<ReturnType<AgentManager["admitForegroundTurn"]>>;
    try {
      admission = await this.agentManager.admitForegroundTurn(destination.agentId, record.prompt, {
        clientMessageId: record.id,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.persist({ ...record, state: "uncertain", attempt, reason });
      this.logger.error({ mailId: record.id, err: error }, "SLP mail dispatch errored");
      return "uncertain";
    }
    if (admission.status === "busy") {
      await this.persist({ ...record, state: "queued" });
      return "busy";
    }
    await this.persist({
      ...record,
      state: "accepted",
      attempt,
      acceptedAt: this.now().toISOString(),
    });
    return "accepted";
  }

  private async persist(record: SlpMailRecord): Promise<SlpMailRecord> {
    const next = { ...record, updatedAt: this.now().toISOString() };
    await this.store.write(next);
    this.records.set(next.id, next);
    this.onChange(next.groupId);
    return next;
  }
}

function precedes(a: SlpMailRecord, b: SlpMailRecord): boolean {
  const aFirst = a.kind === "activation";
  const bFirst = b.kind === "activation";
  if (aFirst !== bFirst) return aFirst;
  return a.sequence < b.sequence;
}

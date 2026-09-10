import type { Logger } from "pino";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { AgentRequests } from "../agent/requests/index.js";
import type { SlpCheckpointStore } from "./checkpoints.js";
import {
  SlpNotCandidateError,
  SlpTransferBlockedError,
  SlpTransferRefusedError,
} from "./errors.js";
import type { SlpHandbackRegister } from "./handbacks.js";
import { buildHistoryTail } from "./history-tail.js";
import type { SlpMailbox } from "./mailbox.js";
import {
  newSlpId,
  SLP_GROUP_LABEL,
  SlpRecordStore,
  SlpTransferSchema,
  type SlpCheckpointRecord,
  type SlpGenerationRecord,
  type SlpGroupRecord,
  type SlpMailRecord,
  type SlpSlotRecord,
  type SlpTransferCandidate,
  type SlpTransferRecord,
  type SlpTransferStop,
} from "./store.js";
import { nextTurnBoundary } from "./turn-boundary.js";

/** Everything the create funnel needs to make one generation's agent under a preassigned id. */
export interface SlpMemberCreationInput {
  agentId: string;
  groupId: string;
  workspaceId: string;
  title: string;
  source: {
    provider: string;
    cwd: string;
    model: string | null;
    modeId: string | null;
    thinkingOptionId: string | null;
    providerOptions: AgentSessionConfig["providerOptions"] | null;
  };
  systemPrompt: string;
  labels: Record<string, string>;
}

export interface SlpTransferHost {
  logger: Logger;
  now: () => Date;
  agentManager: Pick<
    AgentManager,
    | "subscribe"
    | "getAgent"
    | "cancelAgentRun"
    | "closeAgent"
    | "updateAgentMetadata"
    | "admitForegroundTurn"
    | "getLastAssistantMessage"
    | "archiveSnapshot"
    | "fetchTimeline"
  >;
  agentStorage: Pick<AgentStorage, "get">;
  agentRequests: Pick<AgentRequests, "create">;
  handbacks: Pick<SlpHandbackRegister, "setTransferInProgress" | "supersede" | "register">;
  mailbox: Pick<SlpMailbox, "pump" | "list" | "enqueue">;
  checkpoints: SlpCheckpointStore;
  getGroup(groupId: string): SlpGroupRecord;
  persistGroup(group: SlpGroupRecord): Promise<void>;
  freezeGroup(group: SlpGroupRecord, reason: string): Promise<void>;
  /** Called after every durable transfer-phase change; the service fans it out to clients. */
  onGroupChanged(groupId: string): void;
  /** Composes the role prompt for the next generation of a slot. */
  composePrompt(
    group: SlpGroupRecord,
    slot: SlpSlotRecord,
    generationNumber: number,
  ): Promise<{ systemPrompt: string; instructionsVersion: string }>;
  createMemberAgent(input: SlpMemberCreationInput): Promise<void>;
}

type TransferIn<P extends SlpTransferRecord["phase"]> = Extract<SlpTransferRecord, { phase: P }>;

/**
 * Same-role handoff of one slot: stop the source, prepare a candidate from
 * the slot's checkpoint, switch the group's active generation, re-point owned
 * Peers, retire the source. The group's active-generation pointer is the
 * commit; this journal is the manifest boot recovery reconciles against it.
 * Design: docs/slp/handoff.md.
 */
export class SlpTransfers {
  private readonly store: SlpRecordStore<SlpTransferRecord>;
  private readonly host: SlpTransferHost;
  private readonly records = new Map<string, SlpTransferRecord>();
  /** Resolves when the candidate of that transfer acknowledges readiness. */
  private readonly readiness = new Map<string, () => void>();

  constructor(directory: string, host: SlpTransferHost) {
    this.store = new SlpRecordStore(directory, SlpTransferSchema);
    this.host = host;
  }

  list(): SlpTransferRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  forCandidate(agentId: string): SlpTransferRecord | null {
    for (const record of this.records.values()) {
      if (candidateOf(record)?.agentId === agentId) return record;
    }
    return null;
  }

  async recover(): Promise<void> {
    for (const { id, result } of await this.store.list()) {
      if (result instanceof Error) {
        this.host.logger.error({ transferId: id, err: result }, "SLP transfer record unreadable");
        continue;
      }
      this.records.set(result.id, result);
    }
  }

  /**
   * Persist intent and hold the slot; nothing external is touched here. The
   * rest runs in the background and ends `completed` or `blocked`.
   */
  async request(input: {
    group: SlpGroupRecord;
    slot: SlpSlotRecord;
    source: SlpGenerationRecord;
    checkpoint: SlpCheckpointRecord;
    reason: string;
  }): Promise<SlpTransferRecord> {
    const { group, slot, source } = input;
    if (group.status !== "ready" || group.hold) {
      throw new SlpTransferRefusedError(slot.id, `group is ${group.hold?.kind ?? group.status}`);
    }
    if (await this.isArchived(source.agentId)) {
      throw new SlpTransferRefusedError(slot.id, "the source agent is archived");
    }
    const at = this.host.now().toISOString();
    const record: SlpTransferRecord = {
      id: newSlpId("tr"),
      groupId: group.id,
      slotId: slot.id,
      sourceGenerationId: source.id,
      sourceAgentId: source.agentId,
      reason: input.reason,
      checkpointRevision: input.checkpoint.revision,
      phase: "requested",
      createdAt: at,
      updatedAt: at,
    };
    await this.persist(record);
    group.hold = { kind: "transfer", slotId: slot.id, transferId: record.id, since: at };
    await this.host.persistGroup(group);
    if (slot.role === "peer") await this.host.handbacks.setTransferInProgress(source.agentId, true);
    void this.run(record.id);
    return record;
  }

  /** Called from the candidate's `slp_ready` tool; the runner stops its turn and switches. */
  async acknowledgeReadiness(candidateAgentId: string): Promise<SlpTransferRecord> {
    const record = this.forCandidate(candidateAgentId);
    if (!record) throw new SlpNotCandidateError(candidateAgentId);
    if (record.phase !== "preparing") {
      throw new SlpTransferRefusedError(record.slotId, `its candidate is already ${record.phase}`);
    }
    const ready = await this.persist({ ...record, phase: "ready" });
    this.readiness.get(record.id)?.();
    return ready;
  }

  /**
   * Boot: the group pointer decides, for a blocked transfer too, so a restart
   * is the repair. Still at the source: restore it as the owner and retire
   * the candidate. Already at the candidate: roll forward. Neither: freeze
   * the group rather than guess.
   */
  async reconcile(group: SlpGroupRecord, transferId: string): Promise<void> {
    const record = this.records.get(transferId);
    const slot = record ? group.slots[record.slotId] : undefined;
    if (!record || !slot) {
      await this.host.freezeGroup(group, `transfer ${transferId} has no readable record`);
      return;
    }
    const candidate = candidateOf(record);
    if (record.phase === "completed" || record.phase === "aborted") {
      await this.host.freezeGroup(
        group,
        `transfer ${transferId} is ${record.phase} but still holds the slot`,
      );
      return;
    }
    if (slot.activeGenerationId === record.sourceGenerationId) {
      await this.abort(record, "daemon restarted before the active-generation switch");
      return;
    }
    const stop = stopOf(record);
    if (candidate && stop && slot.activeGenerationId === candidate.generationId) {
      if (record.phase !== "switched") {
        await this.persist({
          ...record,
          phase: "switched",
          candidate,
          stop,
          switchedAt: this.host.now().toISOString(),
        });
      }
      void this.run(record.id);
      return;
    }
    await this.host.freezeGroup(
      group,
      `transfer ${transferId} matches neither its source nor its candidate generation`,
    );
  }

  private async run(id: string): Promise<void> {
    try {
      let record = this.require(id);
      if (record.phase === "requested") record = await this.stop(record);
      if (record.phase === "stopped") record = await this.prepare(record);
      if (record.phase === "preparing") record = await this.awaitReady(record);
      if (record.phase === "ready") record = await this.switch(record);
      if (record.phase === "switched") await this.complete(record);
    } catch (error) {
      await this.block(id, error);
    }
  }

  /** The manager's acknowledged cancellation is the stop evidence, not the adapter's. */
  /**
   * The stop is also when the tail is read: everything the source's timeline
   * holds after its checkpoint, from the same daemon epoch. A timeline rebuilt
   * since the checkpoint anchors nothing, so the transfer blocks rather than
   * guess where the checkpoint fell.
   */
  private async stop(record: TransferIn<"requested">): Promise<TransferIn<"stopped">> {
    await this.untilNotRunning(record.sourceAgentId);
    const agent = this.host.agentManager.getAgent(record.sourceAgentId);
    const pendingPermissions = agent?.pendingPermissions.size ?? 0;
    if (agent) {
      const cancellation = await this.host.agentManager.cancelAgentRun(record.sourceAgentId);
      if (cancellation.status === "refused") {
        throw new SlpTransferBlockedError(
          record.id,
          "stopping",
          "the source refused to stop; its turn is still running",
        );
      }
    }
    if (await this.isArchived(record.sourceAgentId)) {
      throw new SlpTransferBlockedError(
        record.id,
        "stopping",
        "the source agent was archived before the transfer could stop it",
      );
    }
    const checkpoint = this.requireCheckpoint(record, "stopping");
    if (!this.host.agentManager.getAgent(record.sourceAgentId)) {
      throw new SlpTransferBlockedError(record.id, "stopping", "the source agent is not loaded");
    }
    const fetched = this.host.agentManager.fetchTimeline(record.sourceAgentId, {
      direction: "after",
      cursor: checkpoint.timelineCursor,
      limit: 0,
    });
    if (fetched.staleCursor || fetched.gap) {
      throw new SlpTransferBlockedError(
        record.id,
        "stopping",
        "the source's history after its checkpoint is unavailable; its timeline was rebuilt since the checkpoint",
      );
    }
    const historyTail = buildHistoryTail(checkpoint.timelineCursor, fetched.epoch, fetched.rows);
    return this.persist({
      ...record,
      phase: "stopped",
      stop: { pendingPermissions, historyTail },
    });
  }

  private requireCheckpoint(
    record: SlpTransferRecord,
    phase: "stopping" | "preparing",
  ): SlpCheckpointRecord {
    const checkpoint = this.host.checkpoints.current(record.slotId);
    if (!checkpoint || checkpoint.revision < record.checkpointRevision) {
      throw new SlpTransferBlockedError(record.id, phase, "the slot's checkpoint is missing");
    }
    return checkpoint;
  }

  /**
   * The candidate generation is durable in the group before its agent
   * exists, under the creation journal so a retry cannot create a second
   * candidate. Its first turn is receive-only preparation.
   */
  private async prepare(record: TransferIn<"stopped">): Promise<TransferIn<"preparing">> {
    const { group, slot } = this.locate(record);
    const sourceRecord = await this.host.agentStorage.get(record.sourceAgentId);
    if (!sourceRecord)
      throw new SlpTransferBlockedError(
        record.id,
        "preparing",
        "the source agent record is missing",
      );
    const checkpoint = this.requireCheckpoint(record, "preparing");
    const generationNumber = slot.generations.length + 1;
    const prompt = await this.host.composePrompt(group, slot, generationNumber);
    const agentId = await this.host.agentRequests.create({
      key: `slp-transfer:${record.id}`,
      request: { transferId: record.id, slotId: slot.id },
      findAgent: async (id) =>
        this.host.agentManager.getAgent(id) != null ||
        (await this.host.agentStorage.get(id)) !== null,
      create: async (id) => {
        const at = this.host.now().toISOString();
        const generation: SlpGenerationRecord = {
          id: newSlpId("gen"),
          number: generationNumber,
          agentId: id,
          state: "preparing",
          instructionsVersion: prompt.instructionsVersion,
          createdAt: at,
          activatedAt: null,
          retiredAt: null,
        };
        slot.generations.push(generation);
        await this.host.persistGroup(group);
        await this.persist({
          ...record,
          phase: "preparing",
          candidate: { generationId: generation.id, agentId: id },
        });
        await this.host.createMemberAgent({
          agentId: id,
          groupId: group.id,
          workspaceId: group.workspaceId,
          title: sourceRecord.title ?? slot.role,
          source: {
            provider: sourceRecord.provider,
            cwd: sourceRecord.cwd,
            model: sourceRecord.config?.model ?? null,
            modeId: sourceRecord.lastModeId ?? sourceRecord.config?.modeId ?? null,
            thinkingOptionId: sourceRecord.config?.thinkingOptionId ?? null,
            providerOptions: sourceRecord.config?.providerOptions ?? null,
          },
          systemPrompt: prompt.systemPrompt,
          labels: this.candidateLabels(group, slot),
        });
      },
    });
    const generation = slot.generations.find((entry) => entry.agentId === agentId);
    if (!generation) throw new Error(`candidate ${agentId} has no generation in its slot`);
    const preparing: SlpTransferCandidate = { generationId: generation.id, agentId };
    const persisted = await this.persist({ ...record, phase: "preparing", candidate: preparing });
    const admission = await this.host.agentManager.admitForegroundTurn(
      preparing.agentId,
      await this.describeHandoff(record, slot, checkpoint),
    );
    if (admission.status === "busy") {
      throw new SlpTransferBlockedError(
        record.id,
        "preparing",
        "the candidate was busy before its preparation turn",
      );
    }
    return persisted;
  }

  private async awaitReady(record: TransferIn<"preparing">): Promise<TransferIn<"ready">> {
    const acknowledged = new Promise<void>((resolve) => {
      this.readiness.set(record.id, resolve);
    });
    try {
      if (this.require(record.id).phase === "preparing") await acknowledged;
    } finally {
      this.readiness.delete(record.id);
    }
    const ready = this.require(record.id);
    if (ready.phase !== "ready") throw new Error(`transfer left readiness in phase ${ready.phase}`);
    // Readiness is acknowledged from inside the preparation turn; stop that turn.
    await this.untilNotRunning(ready.candidate.agentId);
    const cancellation = await this.host.agentManager.cancelAgentRun(ready.candidate.agentId);
    if (cancellation.status === "refused") {
      throw new SlpTransferBlockedError(
        record.id,
        "ready",
        "the candidate refused to stop its preparation turn",
      );
    }
    return ready;
  }

  /** The group write is the commit; the checkpoint copy is taken just before it. */
  private async switch(record: TransferIn<"ready">): Promise<TransferIn<"switched">> {
    const { group, slot, source } = this.locate(record);
    if (await this.isArchived(record.sourceAgentId)) {
      throw new SlpTransferBlockedError(
        record.id,
        "switching",
        "the source agent was archived during preparation",
      );
    }
    if (await this.isArchived(record.candidate.agentId)) {
      throw new SlpTransferBlockedError(
        record.id,
        "switching",
        "the candidate agent was archived during preparation",
      );
    }
    const candidate = slot.generations.find((entry) => entry.id === record.candidate.generationId);
    if (!candidate) throw new Error("the candidate generation is missing from its slot");
    await this.host.checkpoints.finalize(slot.id, record.id);
    const at = this.host.now().toISOString();
    source.state = "retired";
    source.retiredAt = at;
    candidate.state = "active";
    candidate.activatedAt = at;
    slot.activeGenerationId = candidate.id;
    await this.host.persistGroup(group);
    return this.persist({ ...record, phase: "switched", switchedAt: at });
  }

  /**
   * Everything after the switch rolls forward: re-point owned Peers and read
   * each back, retire the source, move the handback, lift the hold, drain.
   */
  private async complete(record: TransferIn<"switched">): Promise<void> {
    const { group, slot } = this.locate(record);
    const successorId = record.candidate.agentId;
    if (slot.role === "lead") {
      for (const peerSlot of Object.values(group.slots)) {
        if (peerSlot.ownerSlotId !== slot.id) continue;
        for (const generation of peerSlot.generations) {
          if (generation.state === "retired") continue;
          await this.host.agentManager.updateAgentMetadata(generation.agentId, {
            labels: { [PARENT_AGENT_ID_LABEL]: successorId },
          });
          const stored = await this.host.agentStorage.get(generation.agentId);
          if (stored?.labels[PARENT_AGENT_ID_LABEL] !== successorId) {
            throw new SlpTransferBlockedError(
              record.id,
              "completing",
              `Peer ${generation.agentId} did not take the new parent`,
            );
          }
        }
      }
    }
    await this.host.agentManager.closeAgent(record.sourceAgentId);
    if (slot.role === "peer") {
      await this.host.handbacks.supersede(record.sourceAgentId, record.id);
      if (!slot.ownerSlotId) throw new Error(`Peer slot ${slot.id} has no owner`);
      await this.host.handbacks.register({
        groupId: group.id,
        peerSlotId: slot.id,
        peerGenerationId: record.candidate.generationId,
        peerAgentId: successorId,
        ownerSlotId: slot.ownerSlotId,
      });
    }
    const successor = slot.generations.find((entry) => entry.id === record.candidate.generationId);
    if (!successor) throw new Error("the successor generation is missing from its slot");
    // Durable before the hold lifts, keyed by the transfer so a roll-forward
    // re-running this step cannot queue a second notice.
    await this.host.mailbox.enqueue({
      id: `activation_${record.id}`,
      groupId: group.id,
      slotId: slot.id,
      fromSlotId: null,
      kind: "activation",
      prompt: this.describeActivation(record, slot, successor.number),
    });
    group.hold = null;
    await this.host.persistGroup(group);
    await this.persist({
      ...record,
      phase: "completed",
      completedAt: this.host.now().toISOString(),
    });
    this.host.logger.info({ transferId: record.id, slotId: slot.id }, "SLP handoff completed");
    for (const slotId of Object.keys(group.slots)) this.host.mailbox.pump(group.id, slotId);
  }

  /** Held visibly. The slot stays held; nothing is undone. */
  private async block(id: string, error: unknown): Promise<void> {
    const record = this.require(id);
    if (record.phase === "completed" || record.phase === "blocked" || record.phase === "aborted") {
      this.host.logger.error({ transferId: id, err: error }, "SLP transfer failed after settling");
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    await this.persist({
      ...record,
      phase: "blocked",
      candidate: candidateOf(record),
      stop: stopOf(record),
      blockedReason: reason,
    });
    this.host.logger.error({ transferId: id, reason }, "SLP transfer blocked");
  }

  /** Before the switch the source is still the owner: retire the candidate and lift the hold. */
  private async abort(record: SlpTransferRecord, reason: string): Promise<void> {
    const { group, slot } = this.locate(record);
    const candidate = candidateOf(record);
    if (candidate) {
      const generation = slot.generations.find((entry) => entry.id === candidate.generationId);
      if (generation && generation.state !== "retired") {
        generation.state = "retired";
        generation.retiredAt = this.host.now().toISOString();
      }
    }
    group.hold = null;
    await this.host.persistGroup(group);
    if (slot.role === "peer") {
      await this.host.handbacks.setTransferInProgress(record.sourceAgentId, false);
    }
    await this.persist({
      ...record,
      phase: "aborted",
      candidate,
      stop: stopOf(record),
      abortedReason: reason,
    });
    if (candidate && (await this.host.agentStorage.get(candidate.agentId))) {
      await this.host.agentManager.closeAgent(candidate.agentId);
      await this.host.agentManager.archiveSnapshot(
        candidate.agentId,
        this.host.now().toISOString(),
      );
    }
    this.host.logger.warn({ transferId: record.id, reason }, "SLP transfer aborted");
    for (const slotId of Object.keys(group.slots)) this.host.mailbox.pump(group.id, slotId);
  }

  private candidateLabels(group: SlpGroupRecord, slot: SlpSlotRecord): Record<string, string> {
    const labels: Record<string, string> = { [SLP_GROUP_LABEL]: group.id };
    const owner = slot.ownerSlotId ? group.slots[slot.ownerSlotId] : undefined;
    const ownerGeneration = owner?.generations.find(
      (entry) => entry.id === owner.activeGenerationId,
    );
    if (ownerGeneration) labels[PARENT_AGENT_ID_LABEL] = ownerGeneration.agentId;
    return labels;
  }

  /**
   * What the candidate reads before acknowledging: the checkpoint, what the
   * daemon knows that the checkpoint cannot, and the mail accepted after it.
   */
  /** The successor learns it holds the slot from the runtime, not from the shape of its next prompt. */
  private describeActivation(
    record: TransferIn<"switched">,
    slot: SlpSlotRecord,
    generationNumber: number,
  ): string {
    return formatSystemNotificationPrompt(
      [
        `SLP activation: transfer ${record.id} is complete. You are now the active generation ${generationNumber} of slot ${slot.id}; the previous generation is retired.`,
        "You have product execution authority from this message on. Mail to your slot resumes after it. Continue from the checkpoint's next action; if nothing is pending, end your turn.",
      ].join("\n"),
    );
  }

  private async describeHandoff(
    record: TransferIn<"stopped">,
    slot: SlpSlotRecord,
    checkpoint: SlpCheckpointRecord,
  ): Promise<string> {
    const { group } = this.locate(record);
    const lastMessage = await this.host.agentManager.getLastAssistantMessage(record.sourceAgentId);
    const covered = new Set(checkpoint.coveredMailIds);
    const uncovered = this.host.mailbox
      .list()
      .filter(
        (mail) => mail.slotId === slot.id && mail.state === "accepted" && !covered.has(mail.id),
      )
      .map((mail) => `- ${mail.kind} ${mail.id}: ${describeMailPrompt(mail.prompt)}`);
    const peers = Object.values(group.slots)
      .filter((entry) => entry.ownerSlotId === slot.id)
      .map((entry) => {
        const active = entry.generations.find((gen) => gen.id === entry.activeGenerationId);
        return `- slot ${entry.id}: ${active ? `agent ${active.agentId} (active)` : "no active generation"}`;
      });
    const tail = record.stop.historyTail;
    const activity = tail.entries.map((entry) => `- ${entry.text}`);
    let omitted = "";
    if (tail.omitted > 0) omitted = ` (${tail.omitted} earlier entries omitted)`;
    const content = checkpoint.content;
    const lines = [
      `SLP handoff ${record.id}: you are the candidate for slot ${slot.id}.`,
      "Read this context, name anything missing, then call slp_ready and end your turn. Do no product work until you are activated.",
      "",
      `Reason for handoff: ${record.reason}`,
      `Checkpoint revision ${checkpoint.revision} by generation ${checkpoint.generationId} at ${checkpoint.updatedAt}`,
      `Objective: ${content.objective}`,
      `Constraints: ${content.constraints ?? "(none recorded)"}`,
      `Decisions and reasons: ${content.decisions ?? "(none recorded)"}`,
      `Work done: ${content.workDone ?? "(none recorded)"}`,
      `Work remaining: ${content.workRemaining ?? "(none recorded)"}`,
      `Evidence and artifacts: ${content.evidence ?? "(none recorded)"}`,
      `Unknowns: ${content.unknowns ?? "(none recorded)"}`,
      `Next action: ${content.nextAction}`,
      `Notes: ${content.notes ?? "(none)"}`,
      "",
      `Pending permissions at stop: ${record.stop.pendingPermissions}`,
      `Source's last message: ${lastMessage ?? "(none)"}`,
      `Source activity after the checkpoint${omitted}:${listOrNone(activity)}`,
      `Mail accepted after the checkpoint:${listOrNone(uncovered)}`,
      `Peers you own; their assignments continue and must not be recreated:${listOrNone(peers)}`,
    ];
    return formatSystemNotificationPrompt(lines.join("\n"));
  }

  private async untilNotRunning(agentId: string): Promise<void> {
    for (;;) {
      const boundary = nextTurnBoundary(this.host.agentManager, agentId);
      try {
        const agent = this.host.agentManager.getAgent(agentId);
        if (agent?.lifecycle !== "running") return;
        await boundary.reached;
      } finally {
        boundary.stop();
      }
    }
  }

  private async isArchived(agentId: string): Promise<boolean> {
    const stored = await this.host.agentStorage.get(agentId);
    return stored?.archivedAt != null;
  }

  private locate(record: SlpTransferRecord): {
    group: SlpGroupRecord;
    slot: SlpSlotRecord;
    source: SlpGenerationRecord;
  } {
    const group = this.host.getGroup(record.groupId);
    const slot = group.slots[record.slotId];
    if (!slot) throw new Error(`slot ${record.slotId} is missing from group ${group.id}`);
    if (group.hold?.kind !== "transfer" || group.hold.transferId !== record.id) {
      throw new Error(`group ${group.id} no longer holds transfer ${record.id}`);
    }
    const source = slot.generations.find((entry) => entry.id === record.sourceGenerationId);
    if (!source) throw new Error(`source generation ${record.sourceGenerationId} is missing`);
    return { group, slot, source };
  }

  private require(id: string): SlpTransferRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown SLP transfer ${id}`);
    return record;
  }

  private async persist<T extends SlpTransferRecord>(record: T): Promise<T> {
    const next = { ...record, updatedAt: this.host.now().toISOString() };
    await this.store.write(next);
    this.records.set(next.id, next);
    this.host.onGroupChanged(next.groupId);
    return next;
  }
}

function candidateOf(record: SlpTransferRecord): SlpTransferCandidate | null {
  return "candidate" in record ? record.candidate : null;
}

function stopOf(record: SlpTransferRecord): SlpTransferStop | null {
  return "stop" in record ? record.stop : null;
}

function listOrNone(lines: string[]): string {
  if (lines.length === 0) return " (none)";
  return `\n${lines.join("\n")}`;
}

function describeMailPrompt(prompt: SlpMailRecord["prompt"]): string {
  return typeof prompt === "string" ? prompt : "(structured prompt)";
}

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { AgentManager, DestructiveOperationGate } from "../agent/agent-manager.js";
import type { AgentRequests } from "../agent/requests/index.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { SlpCreationHook, SlpPeerCreation } from "../agent/create-agent/create.js";
import type { SlpToolAuthority } from "../agent/tools/types.js";
import {
  isTargetAllowed,
  isToolVisibleToRole,
  SLP_AGENT_TARGET_TOOLS,
  SLP_CONTROL_TOOLS,
  SLP_PREPARATION_TOOLS,
  type SlpRelation,
} from "./authority.js";
import { SlpCheckpointStore } from "./checkpoints.js";
import {
  SlpDelegationUnavailableError,
  SlpGenerationRetiredError,
  SlpGroupFrozenError,
  SlpGroupHeldError,
  SlpInitializationConflictError,
  SlpPreparationPolicyError,
  SlpRoleAuthorityError,
  SlpTransferRefusedError,
} from "./errors.js";
import { SlpHandbackRegister } from "./handbacks.js";
import {
  SlpMailbox,
  type SlpMailboxAgentManager,
  type SlpMailInput,
  type SlpSlotDestination,
} from "./mailbox.js";
import {
  composeSlpSystemPrompt,
  loadSlpInstructions,
  resolveBundledSlpRolesDir,
  type SlpInstructions,
} from "./instructions.js";
import {
  newSlpGroupId,
  newSlpId,
  SLP_GROUP_LABEL,
  SlpGroupStore,
  type SlpCheckpointContent,
  type SlpGenerationRecord,
  type SlpGroupRecord,
  type SlpHandbackRecord,
  type SlpInitializationRecord,
  type SlpMailRecord,
  type SlpSlotRecord,
  type SlpTransferRecord,
  type SlpWorkspaceMode,
} from "./store.js";
import { SlpTransfers, type SlpMemberCreationInput, type SlpTransferHost } from "./transfer.js";

export { SLP_GROUP_LABEL } from "./store.js";

export interface SlpInitializeGroupInput {
  workspaceId: string;
  mode: SlpWorkspaceMode;
  initialMessage: { messageId: string; text: string };
  lead: SlpInitializationRecord["lead"];
}

export interface SlpServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: SlpMailboxAgentManager &
    SlpTransferHost["agentManager"] &
    Pick<AgentManager, "setDestructiveOperationGate" | "setTurnAdmissionGate">;
  agentStorage: AgentStorage;
  agentRequests: Pick<AgentRequests, "create" | "send">;
  /** Creates one generation's agent under the preassigned id. Bootstrap binds the create funnel. */
  createMemberAgent: (input: SlpMemberCreationInput) => Promise<void>;
  /**
   * Whether created agents receive Paseo tools. A Lead without them has no
   * delegation route, so group initialization refuses instead of producing one.
   */
  isDelegationToolingEnabled: () => boolean;
  /** Where the role instruction files live; defaults to the bundled copy of docs/slp/roles. */
  instructionsDir?: string;
  now?: () => Date;
}

interface FrozenUnknownGroup {
  groupId: string;
  workspaceId: string | null;
  agentIds: string[];
  reason: string;
}

/**
 * Daemon-owned SLP groups: identity, fixed workspace mode, initialization,
 * role instructions, Peer creation with its handback, boot recovery and the
 * destructive-operation gate. Membership is authority; labels are only a
 * projection. See docs/slp/architecture.md.
 */
export class SlpService implements SlpCreationHook, SlpToolAuthority {
  private readonly store: SlpGroupStore;
  private readonly mailbox: SlpMailbox;
  private readonly handbacks: SlpHandbackRegister;
  private readonly checkpoints: SlpCheckpointStore;
  private readonly transfers: SlpTransfers;
  private readonly logger: Logger;
  private readonly agentManager: SlpServiceOptions["agentManager"];
  private readonly agentStorage: SlpServiceOptions["agentStorage"];
  private readonly agentRequests: SlpServiceOptions["agentRequests"];
  private readonly createMemberAgent: SlpServiceOptions["createMemberAgent"];
  private readonly isDelegationToolingEnabled: SlpServiceOptions["isDelegationToolingEnabled"];
  private readonly instructionsDir: string;
  private instructionsLoad: Promise<SlpInstructions> | null = null;
  private readonly now: () => Date;
  private readonly groups = new Map<string, SlpGroupRecord>();
  /** Records recovery could not fully parse. They keep their gate and nothing else. */
  private readonly unknownGroups = new Map<string, FrozenUnknownGroup>();
  private readonly workspaceTails = new Map<string, Promise<unknown>>();

  constructor(options: SlpServiceOptions) {
    this.store = new SlpGroupStore(`${options.paseoHome}/slp/groups`);
    this.logger = options.logger.child({ module: "slp" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.agentRequests = options.agentRequests;
    this.createMemberAgent = options.createMemberAgent;
    this.isDelegationToolingEnabled = options.isDelegationToolingEnabled;
    this.instructionsDir = options.instructionsDir ?? resolveBundledSlpRolesDir();
    this.now = options.now ?? (() => new Date());
    this.mailbox = new SlpMailbox({
      directory: `${options.paseoHome}/slp/mail`,
      logger: this.logger,
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      resolveSlot: (groupId, slotId) => this.resolveSlot(groupId, slotId),
      now: this.now,
    });
    this.handbacks = new SlpHandbackRegister({
      directory: `${options.paseoHome}/slp/handbacks`,
      logger: this.logger,
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      mailbox: this.mailbox,
      now: this.now,
    });
    this.checkpoints = new SlpCheckpointStore({
      directory: `${options.paseoHome}/slp/checkpoints`,
      logger: this.logger,
      now: this.now,
    });
    this.transfers = new SlpTransfers(`${options.paseoHome}/slp/transfers`, {
      logger: this.logger,
      now: this.now,
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      agentRequests: options.agentRequests,
      handbacks: this.handbacks,
      mailbox: this.mailbox,
      checkpoints: this.checkpoints,
      getGroup: (groupId) => {
        const group = this.groups.get(groupId);
        if (!group) throw new Error(`unknown SLP group ${groupId}`);
        return group;
      },
      persistGroup: (group) => this.persist(group),
      freezeGroup: (group, reason) => this.freeze(group, reason),
      composePrompt: async (group, slot, generationNumber) => {
        const instructions = await this.instructions();
        return {
          instructionsVersion: instructions.version,
          systemPrompt: composeSlpSystemPrompt(instructions, {
            role: slot.role,
            groupId: group.id,
            workspaceId: group.workspaceId,
            slotId: slot.id,
            generationNumber,
            mode: group.mode,
          }),
        };
      },
      createMemberAgent: (input) => this.createMemberAgent(input),
    });
    this.agentManager.setDestructiveOperationGate(this.destructiveOperationGate());
    this.agentManager.setTurnAdmissionGate({
      assertTurnAllowed: (agentId) => {
        const group = this.getGroupForAgent(agentId);
        if (group && membershipOf(group, agentId).generation.state === "retired") {
          throw new SlpGenerationRetiredError(agentId, group.id);
        }
      },
    });
  }

  getGroup(groupId: string): SlpGroupRecord | null {
    return this.groups.get(groupId) ?? null;
  }

  getGroupForWorkspace(workspaceId: string): SlpGroupRecord | null {
    for (const group of this.groups.values()) {
      if (group.workspaceId === workspaceId) return group;
    }
    return null;
  }

  getGroupForAgent(agentId: string): SlpGroupRecord | null {
    for (const group of this.groups.values()) {
      if (groupAgentIds(group).includes(agentId)) return group;
    }
    return null;
  }

  listHandbacks(): SlpHandbackRecord[] {
    return this.handbacks.list();
  }

  listMail(): SlpMailRecord[] {
    return this.mailbox.list();
  }

  listTransfers(): SlpTransferRecord[] {
    return this.transfers.list();
  }

  /** Queue mail for a slot. The receipt promises retained input, not execution. */
  deliverMail(input: SlpMailInput): Promise<SlpMailRecord> {
    return this.mailbox.enqueue(input);
  }

  isToolAllowed(callerAgentId: string, tool: string): boolean {
    const group = this.getGroupForAgent(callerAgentId);
    if (!group) return !SLP_CONTROL_TOOLS.has(tool);
    return isToolVisibleToRole(membershipOf(group, callerAgentId).slot.role, tool);
  }

  assertToolExecutionAllowed(callerAgentId: string, tool: string): void {
    const group = this.getGroupForAgent(callerAgentId);
    if (!group) return;
    const { generation } = membershipOf(group, callerAgentId);
    if (generation.state === "retired")
      throw new SlpGenerationRetiredError(callerAgentId, group.id);
    if (generation.state === "preparing" && !SLP_PREPARATION_TOOLS.has(tool)) {
      throw new SlpPreparationPolicyError(callerAgentId, tool);
    }
  }

  /** The agent supplies the content; the daemon attaches identity and the mail watermark. */
  async recordCheckpoint(
    callerAgentId: string,
    content: SlpCheckpointContent,
  ): Promise<{ checkpointId: string; revision: number }> {
    const group = this.requireGroupForAgent(callerAgentId);
    const { slot, generation } = membershipOf(group, callerAgentId);
    if (slot.activeGenerationId !== generation.id) {
      throw new SlpRoleAuthorityError(
        callerAgentId,
        slot.role,
        "write a checkpoint while inactive",
      );
    }
    const record = await this.checkpoints.writeCurrent({
      groupId: group.id,
      slotId: slot.id,
      generationId: generation.id,
      agentId: callerAgentId,
      content,
      coveredMailIds: this.mailbox
        .list()
        .filter((mail) => mail.slotId === slot.id && mail.state === "accepted")
        .map((mail) => mail.id),
    });
    return { checkpointId: record.id, revision: record.revision };
  }

  /**
   * Explicit same-role handoff of the caller's own slot. The caller must
   * hold the slot and have written a checkpoint as this generation; the
   * transfer starts from that checkpoint, never from a prompt for one.
   */
  async requestHandoff(callerAgentId: string, reason: string): Promise<{ transferId: string }> {
    const group = this.requireGroupForAgent(callerAgentId);
    const { slot, generation } = membershipOf(group, callerAgentId);
    if (slot.activeGenerationId !== generation.id) {
      throw new SlpRoleAuthorityError(callerAgentId, slot.role, "hand off a slot it does not hold");
    }
    const checkpoint = this.checkpoints.current(slot.id);
    if (checkpoint?.generationId !== generation.id) {
      throw new SlpTransferRefusedError(slot.id, "write a checkpoint before requesting a handoff");
    }
    const transfer = await this.transfers.request({
      group,
      slot,
      source: generation,
      checkpoint,
      reason,
    });
    return { transferId: transfer.id };
  }

  async acknowledgeReadiness(callerAgentId: string): Promise<{ transferId: string }> {
    const transfer = await this.transfers.acknowledgeReadiness(callerAgentId);
    return { transferId: transfer.id };
  }

  assertAgentTargetAllowed(callerAgentId: string, tool: string, targetAgentId: string): void {
    if (!SLP_AGENT_TARGET_TOOLS.has(tool)) return;
    const group = this.getGroupForAgent(callerAgentId);
    if (!group) return;
    const caller = membershipOf(group, callerAgentId);
    const relation = relationOf(group, caller.slot, targetAgentId);
    if (!isTargetAllowed(caller.slot.role, tool, relation)) {
      throw new SlpRoleAuthorityError(
        callerAgentId,
        caller.slot.role,
        `${tool} on ${targetAgentId} (${relation})`,
      );
    }
  }

  /**
   * Agent-to-agent sends inside a group are mail to the target's slot, so a
   * retired generation's id still reaches the current owner and a busy
   * recipient is never interrupted. Direction policy lives in authority.ts.
   */
  async routeSend(input: {
    callerAgentId: string;
    targetAgentId: string;
    prompt: string;
  }): Promise<{ mailId: string } | null> {
    const group = this.getGroupForAgent(input.callerAgentId);
    if (!group) return null;
    this.assertAgentTargetAllowed(input.callerAgentId, "send_agent_prompt", input.targetAgentId);
    const caller = membershipOf(group, input.callerAgentId);
    const target = membershipOf(group, input.targetAgentId);
    const mail = await this.mailbox.enqueue({
      groupId: group.id,
      slotId: target.slot.id,
      fromSlotId: caller.slot.id,
      kind: "message",
      prompt: input.prompt,
    });
    return { mailId: mail.id };
  }

  /** Stops watching agents. Tests use it to end a daemon; bootstrap never needs it. */
  dispose(): void {
    this.handbacks.dispose();
  }

  /**
   * Group gate before per-agent lanes: callers read this before entering a
   * lifecycle lane, never from inside one. The hold is persisted state, so a
   * transfer waiting on a provider still refuses archive without holding a
   * promise chain across that wait.
   */
  private destructiveOperationGate(): DestructiveOperationGate {
    return {
      assertAgentOperationAllowed: (agentId, operation) => {
        const group = this.getGroupForAgent(agentId);
        // Creation under a preassigned id clears that id's state first. A
        // preparing generation has no agent yet, so that clear destroys nothing.
        const preparing =
          group !== null && membershipOf(group, agentId).generation.state === "preparing";
        if (group && !(operation === "delete" && preparing)) this.assertGroupNotHeld(group);
        for (const unknown of this.unknownGroups.values()) {
          if (unknown.agentIds.includes(agentId)) {
            throw new SlpGroupHeldError(unknown.groupId, "frozen", unknown.reason);
          }
        }
      },
      assertWorkspaceOperationAllowed: (workspaceId) => {
        const group = this.getGroupForWorkspace(workspaceId);
        if (group) this.assertGroupNotHeld(group);
        for (const unknown of this.unknownGroups.values()) {
          if (unknown.workspaceId === workspaceId) {
            throw new SlpGroupHeldError(unknown.groupId, "frozen", unknown.reason);
          }
        }
      },
    };
  }

  /** A transfer holds only its own slot; initialization and a freeze hold every slot. */
  private assertSlotNotHeld(group: SlpGroupRecord, slotId: string): void {
    if (group.hold?.kind === "transfer" && group.hold.slotId !== slotId) return;
    this.assertGroupNotHeld(group);
  }

  private assertGroupNotHeld(group: SlpGroupRecord): void {
    if (group.status === "frozen") {
      throw new SlpGroupHeldError(group.id, "frozen", group.freeze?.reason ?? null);
    }
    if (group.hold?.kind === "transfer") {
      throw new SlpGroupHeldError(group.id, "transferring", group.hold.slotId);
    }
    if (group.hold?.kind === "initialization" || group.status === "initializing") {
      throw new SlpGroupHeldError(group.id, "initializing", null);
    }
  }

  /**
   * Choose the fixed mode and deliver the first Human message through one
   * recoverable operation. Retries and concurrent clients for the same
   * workspace converge on one group; a different mode or message is a
   * visible conflict. Provider failure after acceptance leaves the group
   * `initializing`, and recovery retries without a new decision.
   */
  initializeGroup(input: SlpInitializeGroupInput): Promise<SlpGroupRecord> {
    return this.serializeByWorkspace(input.workspaceId, async () => {
      const existing = this.getGroupForWorkspace(input.workspaceId);
      if (existing) {
        if (existing.mode !== input.mode) {
          throw new SlpInitializationConflictError(existing.id, "mode");
        }
        if (existing.initialization.messageId !== input.initialMessage.messageId) {
          throw new SlpInitializationConflictError(existing.id, "initialMessage");
        }
        if (existing.status === "frozen") {
          throw new SlpGroupFrozenError(existing.id, existing.freeze?.reason ?? "unknown");
        }
        return existing.status === "ready" ? existing : this.runInitialization(existing);
      }
      // Both preconditions fail before anything is persisted: a group with a
      // tool-less or instruction-less Lead is not worth recovering.
      if (!this.isDelegationToolingEnabled()) {
        throw new SlpDelegationUnavailableError(input.workspaceId);
      }
      await this.instructions();
      const at = this.now().toISOString();
      const leadSlotId = newSlpId("slot");
      const record: SlpGroupRecord = {
        id: newSlpGroupId(),
        workspaceId: input.workspaceId,
        mode: input.mode,
        status: "initializing",
        freeze: null,
        hold: { kind: "initialization", slotId: leadSlotId, since: at },
        initialization: {
          messageId: input.initialMessage.messageId,
          text: input.initialMessage.text,
          lead: input.lead,
          leadAgentId: null,
          receipt: "pending",
        },
        leadSlotId,
        supervisorSlotId: null,
        slots: {
          [leadSlotId]: {
            id: leadSlotId,
            role: "lead",
            ownerSlotId: null,
            activeGenerationId: null,
            generations: [],
          },
        },
        createdAt: at,
        updatedAt: at,
      };
      // Persist the decision before any external effect so a crash here needs no undo.
      await this.persist(record);
      return this.runInitialization(record);
    });
  }

  /** Idempotent: every external effect is journaled, so it is safe to re-enter. */
  private async runInitialization(record: SlpGroupRecord): Promise<SlpGroupRecord> {
    const leadSlot = record.slots[record.leadSlotId]!;
    if (!leadSlot.activeGenerationId) {
      const instructions = await this.instructions();
      const generationNumber = leadSlot.generations.length + 1;
      const systemPrompt = composeSlpSystemPrompt(instructions, {
        role: "lead",
        groupId: record.id,
        workspaceId: record.workspaceId,
        slotId: leadSlot.id,
        generationNumber,
        mode: record.mode,
      });
      const leadAgentId = await this.agentRequests.create({
        key: `slp-lead:${record.id}`,
        request: { groupId: record.id, lead: record.initialization.lead },
        findAgent: async (agentId) =>
          this.agentManager.getAgent(agentId) != null ||
          (await this.agentStorage.get(agentId)) !== null,
        create: (agentId) =>
          this.createMemberAgent({
            agentId,
            groupId: record.id,
            workspaceId: record.workspaceId,
            title: "Lead",
            source: { ...record.initialization.lead, providerOptions: null },
            systemPrompt,
            labels: { [SLP_GROUP_LABEL]: record.id },
          }),
      });
      const at = this.now().toISOString();
      const generation = newGeneration({
        number: generationNumber,
        agentId: leadAgentId,
        instructionsVersion: instructions.version,
        at,
      });
      generation.state = "active";
      generation.activatedAt = at;
      leadSlot.generations.push(generation);
      leadSlot.activeGenerationId = generation.id;
      record.initialization.leadAgentId = leadAgentId;
      await this.persist(record);
    }

    if (record.initialization.receipt === "pending") {
      const leadAgentId = record.initialization.leadAgentId!;
      try {
        const result = await this.agentRequests.send({
          agentId: leadAgentId,
          messageId: record.initialization.messageId,
          request: { groupId: record.id, text: record.initialization.text },
          send: async () => {
            const admission = await this.agentManager.admitForegroundTurn(
              leadAgentId,
              record.initialization.text,
              { clientMessageId: record.initialization.messageId },
            );
            return admission.status === "busy" ? "declined" : undefined;
          },
        });
        if (result === "declined") {
          throw new Error(`Lead ${leadAgentId} was busy before its first message`);
        }
        record.initialization.receipt = "accepted";
      } catch (error) {
        if (!(error instanceof Error && error.message === "agent_request_outcome_unknown")) {
          throw error;
        }
        // The send may have taken effect before the daemon died. Never repeat it.
        record.initialization.receipt = "uncertain";
        this.logger.warn(
          { groupId: record.id, agentId: leadAgentId },
          "SLP initial message acceptance is uncertain after restart",
        );
      }
    }

    record.status = "ready";
    record.hold = null;
    await this.persist(record);
    this.mailbox.pump(record.id, record.leadSlotId);
    return record;
  }

  /**
   * The create funnel asks here before creating an agent for an SLP caller.
   * Only the active Lead may create, and what it creates is a Peer: its slot,
   * preparing generation and handback are durable before the agent exists,
   * so a crash in between leaves a record recovery can retire, never an
   * unaccounted agent.
   */
  async preparePeerCreation(input: { callerAgentId: string }): Promise<SlpPeerCreation | null> {
    const group = this.getGroupForAgent(input.callerAgentId);
    if (!group) return null;
    const { slot: callerSlot, generation: callerGeneration } = membershipOf(
      group,
      input.callerAgentId,
    );
    this.assertSlotNotHeld(group, callerSlot.id);
    if (callerSlot.role !== "lead" || callerSlot.activeGenerationId !== callerGeneration.id) {
      throw new SlpRoleAuthorityError(input.callerAgentId, callerSlot.role, "create agents");
    }
    const instructions = await this.instructions();
    const at = this.now().toISOString();
    const peerSlot: SlpSlotRecord = {
      id: newSlpId("slot"),
      role: "peer",
      ownerSlotId: callerSlot.id,
      activeGenerationId: null,
      generations: [],
    };
    const generation = newGeneration({
      number: 1,
      agentId: randomUUID(),
      instructionsVersion: instructions.version,
      at,
    });
    peerSlot.generations.push(generation);
    group.slots[peerSlot.id] = peerSlot;
    await this.persist(group);
    await this.handbacks.register({
      groupId: group.id,
      peerSlotId: peerSlot.id,
      peerGenerationId: generation.id,
      peerAgentId: generation.agentId,
      ownerSlotId: callerSlot.id,
    });
    return {
      agentId: generation.agentId,
      labels: { [SLP_GROUP_LABEL]: group.id },
      systemPrompt: composeSlpSystemPrompt(instructions, {
        role: "peer",
        groupId: group.id,
        workspaceId: group.workspaceId,
        slotId: peerSlot.id,
        generationNumber: generation.number,
        mode: group.mode,
      }),
    };
  }

  async peerCreated(agentId: string): Promise<void> {
    const group = this.getGroupForAgent(agentId);
    if (!group) return;
    const { slot, generation } = membershipOf(group, agentId);
    if (generation.state !== "preparing") return;
    generation.state = "active";
    generation.activatedAt = this.now().toISOString();
    slot.activeGenerationId = generation.id;
    await this.persist(group);
    this.mailbox.pump(group.id, slot.id);
  }

  async peerCreationFailed(agentId: string, error: unknown): Promise<void> {
    const group = this.getGroupForAgent(agentId);
    if (!group) return;
    this.logger.warn({ groupId: group.id, agentId, err: error }, "SLP Peer creation failed");
    await this.retirePreparingGeneration(group, agentId);
  }

  private async retirePreparingGeneration(group: SlpGroupRecord, agentId: string): Promise<void> {
    const { generation } = membershipOf(group, agentId);
    generation.state = "retired";
    generation.retiredAt = this.now().toISOString();
    await this.persist(group);
    await this.handbacks.abandon(agentId);
  }

  /**
   * Boot recovery: load every group, resume interrupted initializations,
   * settle Peer generations the daemon died while creating, re-arm handbacks,
   * and freeze only the groups whose state cannot be resumed. Runs in the
   * same bootstrap block as agent storage recovery, before the WebSocket server.
   */
  async recover(): Promise<void> {
    await this.checkpoints.recover();
    await this.transfers.recover();
    for (const stored of await this.store.list()) {
      if (stored.kind === "unreadable") {
        this.unknownGroups.set(stored.groupId, {
          groupId: stored.groupId,
          workspaceId: null,
          agentIds: [],
          reason: `unreadable record: ${stored.error}`,
        });
        this.logger.error({ groupId: stored.groupId, error: stored.error }, "SLP group unreadable");
        continue;
      }
      if (stored.kind === "unknown") {
        this.unknownGroups.set(stored.groupId, {
          groupId: stored.groupId,
          workspaceId: stored.workspaceId,
          agentIds: stored.agentIds,
          reason: `unrecognized record: ${stored.error}`,
        });
        this.logger.error(
          { groupId: stored.groupId, error: stored.error },
          "SLP group has unrecognized state; frozen",
        );
        continue;
      }
      const record = stored.record;
      this.groups.set(record.id, record);
      await this.settlePreparingPeers(record);
      if (record.hold?.kind === "transfer") {
        try {
          await this.transfers.reconcile(record, record.hold.transferId);
        } catch (error) {
          await this.freeze(record, `transfer recovery failed: ${describe(error)}`);
        }
        continue;
      }
      if (record.status !== "initializing") continue;
      try {
        await this.serializeByWorkspace(record.workspaceId, () => this.runInitialization(record));
      } catch (error) {
        await this.freeze(record, `initialization recovery failed: ${describe(error)}`);
      }
    }
    await this.mailbox.recover();
    await this.handbacks.recover((handback) => {
      const group = this.groups.get(handback.groupId);
      const generation = group?.slots[handback.peerSlotId]?.generations.find(
        (candidate) => candidate.id === handback.peerGenerationId,
      );
      return generation?.state === "active";
    });
  }

  /** A Peer the daemon died while creating either exists (activate) or does not (retire). */
  private async settlePreparingPeers(group: SlpGroupRecord): Promise<void> {
    for (const slot of Object.values(group.slots)) {
      if (slot.role !== "peer") continue;
      for (const generation of slot.generations) {
        if (generation.state !== "preparing") continue;
        if (await this.agentStorage.get(generation.agentId)) {
          await this.peerCreated(generation.agentId);
        } else {
          await this.retirePreparingGeneration(group, generation.agentId);
        }
      }
    }
  }

  private async freeze(record: SlpGroupRecord, reason: string): Promise<void> {
    record.status = "frozen";
    record.freeze = { reason, at: this.now().toISOString() };
    await this.persist(record);
    this.logger.error({ groupId: record.id, reason }, "SLP group frozen");
  }

  private requireGroupForAgent(agentId: string): SlpGroupRecord {
    const group = this.getGroupForAgent(agentId);
    if (!group) throw new Error(`Agent ${agentId} is not a member of any SLP group`);
    return group;
  }

  private instructions(): Promise<SlpInstructions> {
    this.instructionsLoad ??= loadSlpInstructions(this.instructionsDir).catch((error: unknown) => {
      this.instructionsLoad = null;
      throw error;
    });
    return this.instructionsLoad;
  }

  private resolveSlot(groupId: string, slotId: string): SlpSlotDestination {
    const group = this.groups.get(groupId);
    const slot = group?.slots[slotId];
    if (!group || !slot) return { status: "empty" };
    if (group.status === "frozen") return { status: "held", reason: "frozen" };
    if (group.hold && (group.hold.kind !== "transfer" || group.hold.slotId === slotId)) {
      return { status: "held", reason: group.hold.kind };
    }
    const generation = activeGeneration(slot);
    return generation
      ? { status: "active", agentId: generation.agentId, generationId: generation.id }
      : { status: "empty" };
  }

  private async persist(record: SlpGroupRecord): Promise<void> {
    record.updatedAt = this.now().toISOString();
    await this.store.write(record);
    this.groups.set(record.id, record);
  }

  private serializeByWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.workspaceTails.get(workspaceId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceTails.set(workspaceId, tail);
    void tail.finally(() => {
      if (this.workspaceTails.get(workspaceId) === tail) {
        this.workspaceTails.delete(workspaceId);
      }
    });
    return run;
  }
}

function newGeneration(input: {
  number: number;
  agentId: string;
  instructionsVersion: string;
  at: string;
}): SlpGenerationRecord {
  return {
    id: newSlpId("gen"),
    number: input.number,
    agentId: input.agentId,
    state: "preparing",
    instructionsVersion: input.instructionsVersion,
    createdAt: input.at,
    activatedAt: null,
    retiredAt: null,
  };
}

function activeGeneration(slot: SlpSlotRecord): SlpGenerationRecord | null {
  return slot.generations.find((candidate) => candidate.id === slot.activeGenerationId) ?? null;
}

function membershipOf(
  group: SlpGroupRecord,
  agentId: string,
): { slot: SlpSlotRecord; generation: SlpGenerationRecord } {
  for (const slot of Object.values(group.slots)) {
    const generation = slot.generations.find((candidate) => candidate.agentId === agentId);
    if (generation) return { slot, generation };
  }
  throw new Error(`Agent ${agentId} is not a member of SLP group ${group.id}`);
}

function relationOf(
  group: SlpGroupRecord,
  callerSlot: SlpSlotRecord,
  targetAgentId: string,
): SlpRelation {
  if (callerSlot.generations.some((generation) => generation.agentId === targetAgentId)) {
    return "self";
  }
  const targetSlot = Object.values(group.slots).find((slot) =>
    slot.generations.some((generation) => generation.agentId === targetAgentId),
  );
  if (!targetSlot) return "outside";
  if (targetSlot.id === callerSlot.ownerSlotId) return "owner";
  if (targetSlot.ownerSlotId === callerSlot.id) return "own-peer";
  if (targetSlot.role === "supervisor") return "supervisor";
  if (targetSlot.role === "lead") return "lead";
  return "other-member";
}

function groupAgentIds(group: SlpGroupRecord): string[] {
  return Object.values(group.slots).flatMap((slot) =>
    slot.generations.map((generation) => generation.agentId),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

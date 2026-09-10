import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { AgentManager, DestructiveOperationGate } from "../agent/agent-manager.js";
import type { AgentExecutionPolicy } from "../agent/agent-sdk-types.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
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
import { withSlpProviderOptions } from "./launch.js";
import {
  SlpDelegationUnavailableError,
  SlpGenerationRetiredError,
  SlpHandoffDisabledError,
  SlpGroupFrozenError,
  SlpGroupHeldError,
  SlpInitializationConflictError,
  SlpPreparationPolicyError,
  SlpRoleAuthorityError,
  SlpTransferRefusedError,
  SlpNoContactError,
  SlpNoGroupError,
} from "./errors.js";
import { SlpHandbackRegister } from "./handbacks.js";
import { SlpLeadReports, type SlpLeadReportTarget } from "./reports.js";
import {
  SlpMailbox,
  type SlpMailboxAgentManager,
  type SlpMailInput,
  type SlpSlotDestination,
} from "./mailbox.js";
import {
  composeSlpSystemPrompt,
  slpInstructionsVersion,
  loadSlpInstructions,
  resolveBundledSlpRolesDir,
  type SlpAddressBook,
  type SlpIdentity,
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
  type SlpTimelineCursor,
  type SlpTransferRecord,
  type SlpWorkspaceMode,
} from "./store.js";
import { SlpTransfers, type SlpMemberCreationInput, type SlpTransferHost } from "./transfer.js";

import type { SlpGroupSummary, SlpRoleConfig, SlpRolesConfig } from "../messages.js";

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
    Pick<AgentManager, "setDestructiveOperationGate" | "setAdmissionGate">;
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
  /**
   * `features.slp.handoff`: whether members get the checkpoint and handoff
   * tools and the role text that uses them. In-flight transfers still finish
   * and recover with it off.
   */
  isHandoffEnabled: () => boolean;
  /** Host-configured launch settings per role, read at every generation's creation. */
  roleSettings: () => SlpRolesConfig;
  now?: () => Date;
}

type SlpLaunchSource = SlpMemberCreationInput["source"];

/**
 * A configured provider replaces the requested one together with its model,
 * mode and provider options, which belong to the provider they were chosen
 * for; a configured model or mode alone refines the requested provider.
 */
function applyRoleLaunch(
  source: SlpLaunchSource,
  settings: SlpRoleConfig | undefined,
): SlpLaunchSource {
  if (!settings) return source;
  if (settings.provider && settings.provider !== source.provider) {
    return {
      provider: settings.provider,
      cwd: source.cwd,
      model: settings.model ?? null,
      modeId: settings.modeId ?? null,
      thinkingOptionId: settings.thinkingOptionId ?? null,
      providerOptions: null,
    };
  }
  return {
    ...source,
    model: settings.model ?? source.model,
    modeId: settings.modeId ?? source.modeId,
    thinkingOptionId: settings.thinkingOptionId ?? source.thinkingOptionId,
  };
}

function appendRoleInstructions(prompt: string, settings: SlpRoleConfig | undefined): string {
  const extra = settings?.instructions?.trim();
  if (!extra) return prompt;
  return `${prompt}\n\n---\n\n# Additional instructions from this host\n\n${extra}`;
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
  private readonly leadReports: SlpLeadReports;
  private readonly checkpoints: SlpCheckpointStore;
  private readonly transfers: SlpTransfers;
  private readonly logger: Logger;
  private readonly agentManager: SlpServiceOptions["agentManager"];
  private readonly agentStorage: SlpServiceOptions["agentStorage"];
  private readonly agentRequests: SlpServiceOptions["agentRequests"];
  private readonly createMemberAgent: SlpServiceOptions["createMemberAgent"];
  private readonly roleSettings: SlpServiceOptions["roleSettings"];
  private readonly isDelegationToolingEnabled: SlpServiceOptions["isDelegationToolingEnabled"];
  private readonly isHandoffEnabled: SlpServiceOptions["isHandoffEnabled"];
  private readonly instructionsDir: string;
  private instructionsLoad: Promise<SlpInstructions> | null = null;
  private readonly now: () => Date;
  private readonly groups = new Map<string, SlpGroupRecord>();
  /** Records recovery could not fully parse. They keep their gate and nothing else. */
  private readonly unknownGroups = new Map<string, FrozenUnknownGroup>();
  private readonly workspaceTails = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(groupId: string) => void>();

  constructor(options: SlpServiceOptions) {
    this.store = new SlpGroupStore(`${options.paseoHome}/slp/groups`);
    this.logger = options.logger.child({ module: "slp" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.agentRequests = options.agentRequests;
    this.createMemberAgent = (input) =>
      options.createMemberAgent({
        ...input,
        source: {
          ...input.source,
          providerOptions: withSlpProviderOptions(
            input.source.provider,
            input.source.providerOptions,
          ),
        },
      });
    this.roleSettings = options.roleSettings;
    this.isDelegationToolingEnabled = options.isDelegationToolingEnabled;
    this.isHandoffEnabled = options.isHandoffEnabled;
    this.instructionsDir = options.instructionsDir ?? resolveBundledSlpRolesDir();
    this.now = options.now ?? (() => new Date());
    this.mailbox = new SlpMailbox({
      directory: `${options.paseoHome}/slp/mail`,
      logger: this.logger,
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      resolveSlot: (groupId, slotId) => this.resolveSlot(groupId, slotId),
      now: this.now,
      onChange: (groupId) => this.changed(groupId),
    });
    this.handbacks = new SlpHandbackRegister({
      directory: `${options.paseoHome}/slp/handbacks`,
      logger: this.logger,
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      mailbox: this.mailbox,
      now: this.now,
    });
    this.leadReports = new SlpLeadReports({
      logger: this.logger,
      agentManager: options.agentManager,
      mailbox: this.mailbox,
      resolveLead: (agentId) => this.leadReportTarget(agentId),
      now: this.now,
    });
    this.leadReports.start();
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
      onGroupChanged: (groupId) => this.changed(groupId),
      composePrompt: async (group, slot, generationNumber) => {
        const instructions = await this.instructions();
        return {
          instructionsVersion: this.instructionsVersion(instructions),
          systemPrompt: this.composeRolePrompt(instructions, {
            role: slot.role,
            groupId: group.id,
            workspaceId: group.workspaceId,
            slotId: slot.id,
            generationNumber,
            mode: group.mode,
            addressBook: addressBookFor(group, slot),
          }),
        };
      },
      createMemberAgent: (input) => this.createMemberAgent(input),
    });
    this.agentManager.setDestructiveOperationGate(this.destructiveOperationGate());
    this.agentManager.setAdmissionGate({
      assertTurnAllowed: (agentId) => {
        const group = this.getGroupForAgent(agentId);
        if (group && membershipOf(group, agentId).generation.state === "retired") {
          throw new SlpGenerationRetiredError(agentId, group.id);
        }
      },
      executionPolicyFor: (agentId) => this.executionPolicyFor(agentId),
    });
  }

  /**
   * Receive-only until the durable switch: the answer follows the transfer
   * journal and the generation state, so lifting the policy is the switch
   * itself, with no restoration step that a crash could land between.
   */
  executionPolicyFor(agentId: string): AgentExecutionPolicy {
    const transfer = this.transfers.forCandidate(agentId);
    const group = this.getGroupForAgent(agentId);
    if (!transfer || !group) return { kind: "authorized" };
    const { slot, generation } = membershipOf(group, agentId);
    if (generation.state !== "preparing") return { kind: "authorized" };
    return {
      kind: "preparation",
      reason: `SLP transfer ${transfer.id} is preparing it for slot ${slot.id}`,
    };
  }

  getGroup(groupId: string): SlpGroupRecord | null {
    return this.groups.get(groupId) ?? null;
  }

  /** An ended group keeps its records for the journals but owns neither its workspace nor its agents. */
  getGroupForWorkspace(workspaceId: string): SlpGroupRecord | null {
    for (const group of this.groups.values()) {
      if (group.workspaceId === workspaceId && group.status !== "ended") return group;
    }
    return null;
  }

  getGroupForAgent(agentId: string): SlpGroupRecord | null {
    for (const group of this.groups.values()) {
      if (group.status !== "ended" && groupAgentIds(group).includes(agentId)) return group;
    }
    return null;
  }

  /**
   * End the workspace's group: the decision is durable first, then every
   * member is archived as an ordinary agent, so a crash in between leaves
   * members that recovery archives and a workspace whose mode is open again.
   */
  endGroup(workspaceId: string): Promise<SlpGroupRecord> {
    return this.serializeByWorkspace(workspaceId, async () => {
      const group = this.getGroupForWorkspace(workspaceId);
      if (!group) throw new SlpNoGroupError(workspaceId);
      this.assertGroupNotHeld(group);
      group.status = "ended";
      group.hold = null;
      await this.persist(group);
      await this.archiveMembers(group);
      return group;
    });
  }

  private async archiveMembers(group: SlpGroupRecord): Promise<void> {
    const at = this.now().toISOString();
    for (const agentId of groupAgentIds(group)) {
      const stored = await this.agentStorage.get(agentId);
      if (!stored || stored.archivedAt) continue;
      try {
        await this.agentManager.archiveSnapshot(agentId, at);
      } catch (error) {
        this.logger.warn(
          { groupId: group.id, agentId, err: error },
          "SLP member could not be archived after its group ended",
        );
      }
    }
  }

  listHandbacks(): SlpHandbackRecord[] {
    return this.handbacks.list();
  }

  listMail(): SlpMailRecord[] {
    return this.mailbox.list();
  }

  /**
   * Queue prepared mail into a member's slot, so a behavior probe can put a
   * specific handback in front of a Lead instead of waiting for a live Peer to
   * happen to return one. It takes the same enqueue and admission path as real
   * mail and carries the caller's whole prompt, so the fixture is responsible
   * for saying what it is. Nothing in the product calls this; see
   * packages/server/scripts/slp-behavior-probe.ts.
   */
  async deliverPreparedMail(input: {
    recipientAgentId: string;
    fromAgentId: string | null;
    kind: SlpMailRecord["kind"];
    prompt: string;
  }): Promise<SlpMailRecord> {
    const group = this.requireGroupForAgent(input.recipientAgentId);
    const recipient = membershipOf(group, input.recipientAgentId);
    const fromSlotId = input.fromAgentId ? membershipOf(group, input.fromAgentId).slot.id : null;
    const mail = await this.mailbox.enqueue({
      groupId: group.id,
      slotId: recipient.slot.id,
      fromSlotId,
      kind: input.kind,
      prompt: input.prompt,
    });
    this.mailbox.pump(group.id, recipient.slot.id);
    return mail;
  }

  /**
   * Fires with the group id after every durable change to a group, one of
   * its transfers or its mail. Listeners read the current state back through
   * `getGroup` and `summarize`; a change is a wake-up, not a payload.
   */
  subscribe(listener: (groupId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The client-facing projection of a group: see packages/protocol SlpGroupSummarySchema. */
  summarize(group: SlpGroupRecord): SlpGroupSummary {
    const mail = { queued: 0, dispatching: 0, uncertain: 0 };
    for (const record of this.mailbox.list()) {
      if (record.groupId !== group.id) continue;
      if (record.state === "queued") mail.queued += 1;
      if (record.state === "dispatching") mail.dispatching += 1;
      if (record.state === "uncertain") mail.uncertain += 1;
    }
    return {
      id: group.id,
      workspaceId: group.workspaceId,
      mode: group.mode,
      status: group.status,
      freezeReason: group.freeze?.reason ?? null,
      hold: group.hold
        ? {
            kind: group.hold.kind,
            slotId: group.hold.slotId,
            transferId: group.hold.kind === "transfer" ? group.hold.transferId : null,
            since: group.hold.since,
          }
        : null,
      contactAgentId: findContactAgentId(group),
      initialMessageReceipt: group.initialization.receipt,
      slots: Object.values(group.slots).map((slot) => ({
        id: slot.id,
        role: slot.role,
        ownerSlotId: slot.ownerSlotId,
        activeAgentId:
          slot.generations.find((entry) => entry.id === slot.activeGenerationId)?.agentId ?? null,
        generations: slot.generations.map((entry) => ({
          id: entry.id,
          number: entry.number,
          agentId: entry.agentId,
          state: entry.state,
        })),
      })),
      transfers: this.transfers
        .list()
        .filter((record) => record.groupId === group.id)
        .map((record) => ({
          id: record.id,
          slotId: record.slotId,
          phase: record.phase,
          sourceAgentId: record.sourceAgentId,
          candidateAgentId: "candidate" in record ? (record.candidate?.agentId ?? null) : null,
          reason: transferReason(record),
          updatedAt: record.updatedAt,
        })),
      mail,
      updatedAt: group.updatedAt,
    };
  }

  private changed(groupId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(groupId);
      } catch (error) {
        this.logger.error({ groupId, err: error }, "SLP change listener failed");
      }
    }
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
    const { slot, generation } = membershipOf(group, callerAgentId);
    if (SLP_CONTROL_TOOLS.has(tool) && !this.isHandoffEnabled()) {
      // A candidate of a transfer that started before the flag was turned off still reports ready.
      return tool === "slp_ready" && generation.state === "preparing";
    }
    return isToolVisibleToRole(slot.role, tool);
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
    if (!this.isHandoffEnabled()) throw new SlpHandoffDisabledError("slp_checkpoint");
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
      timelineCursor: this.timelineCursorOf(callerAgentId),
    });
    return { checkpointId: record.id, revision: record.revision };
  }

  private timelineCursorOf(agentId: string): SlpTimelineCursor {
    const tail = this.agentManager.fetchTimeline(agentId, { direction: "tail", limit: 1 });
    return { epoch: tail.epoch, seq: tail.window.maxSeq };
  }

  /**
   * Explicit same-role handoff of the caller's own slot. The caller must
   * hold the slot and have written a checkpoint as this generation; the
   * transfer starts from that checkpoint, never from a prompt for one.
   */
  async requestHandoff(callerAgentId: string, reason: string): Promise<{ transferId: string }> {
    if (!this.isHandoffEnabled()) throw new SlpHandoffDisabledError("slp_request_handoff");
    const group = this.requireGroupForAgent(callerAgentId);
    const { slot, generation } = membershipOf(group, callerAgentId);
    if (slot.activeGenerationId !== generation.id) {
      throw new SlpRoleAuthorityError(callerAgentId, slot.role, "hand off a slot it does not hold");
    }
    const checkpoint = this.checkpoints.current(slot.id);
    if (checkpoint?.generationId !== generation.id) {
      throw new SlpTransferRefusedError(slot.id, "write a checkpoint before requesting a handoff");
    }
    // An archived source is refused by the transfer; only a loaded one has a timeline to compare.
    if (
      this.agentManager.getAgent(callerAgentId) &&
      checkpoint.timelineCursor.epoch !== this.timelineCursorOf(callerAgentId).epoch
    ) {
      throw new SlpTransferRefusedError(
        slot.id,
        "the checkpoint predates a rebuild of the agent's history; write a new checkpoint",
      );
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
      // Named, the way a report and a handback are. Human's own messages
      // reach the contact's chat unwrapped, so an unattributed prompt reads
      // as Human's: a Supervisor mistook the Lead's progress note for Human's
      // and relayed it back down (docs/slp/evidence.md).
      prompt: formatSystemNotificationPrompt(
        [
          `SLP message from ${caller.slot.role} (${input.callerAgentId})`,
          "It is that member speaking, not Human. Answer it or act on it; do not send it back to its author or repeat it as Human's words.",
          "",
          input.prompt,
        ].join("\n"),
      ),
    });
    return { mailId: mail.id };
  }

  /** Stops watching agents. Tests use it to end a daemon; bootstrap never needs it. */
  /**
   * Stop every watcher, then wait for the writes they already started. A
   * record that lands after shutdown belongs to no running daemon, and on
   * Windows it also defeats the caller's cleanup of the home directory.
   */
  async dispose(): Promise<void> {
    await Promise.all([this.handbacks.dispose(), this.leadReports.dispose()]);
    await this.mailbox.close();
  }

  /** The bundled role text every generation is composed from, before host extras. */
  async getInstructions(): Promise<SlpInstructions> {
    return this.instructions();
  }

  /** The supervised group whose active Lead this agent is, for the report relay. */
  private leadReportTarget(agentId: string): SlpLeadReportTarget | null {
    const group = this.getGroupForAgent(agentId);
    // A held group is mid-transfer or mid-initialization: the turn ending is the runtime's, not a report.
    if (!group || group.status !== "ready" || group.hold || !group.supervisorSlotId) return null;
    const { slot, generation } = membershipOf(group, agentId);
    if (slot.role !== "lead" || slot.activeGenerationId !== generation.id) return null;
    return {
      groupId: group.id,
      leadSlotId: slot.id,
      supervisorSlotId: group.supervisorSlotId,
    };
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
      const supervisorSlotId = input.mode === "supervised" ? newSlpId("slot") : null;
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
          // Planned before either root exists: each root's prompt names the
          // other by agent id, and a crash between the two creations must
          // resume with the same ids.
          leadAgentId: randomUUID(),
          supervisorAgentId: supervisorSlotId ? randomUUID() : null,
          receipt: "pending",
        },
        leadSlotId,
        supervisorSlotId,
        slots: {
          [leadSlotId]: emptySlot(leadSlotId, "lead"),
          ...(supervisorSlotId
            ? { [supervisorSlotId]: emptySlot(supervisorSlotId, "supervisor") }
            : {}),
        },
        createdAt: at,
        updatedAt: at,
      };
      // Persist the decision before any external effect so a crash here needs no undo.
      await this.persist(record);
      return this.runInitialization(record);
    });
  }

  /**
   * Idempotent: every external effect is journaled, so it is safe to re-enter.
   * The Supervisor, when the mode has one, exists before the Lead and is the
   * Human's contact: the first message goes to it, and the Lead hears only
   * what the Supervisor relays through its mailbox.
   */
  private async runInitialization(record: SlpGroupRecord): Promise<SlpGroupRecord> {
    // COMPAT(slpPlannedRootIds): records written before 0.7.3 planned no ids; remove after 2026-12-01.
    record.initialization.leadAgentId ??= randomUUID();
    if (record.supervisorSlotId) {
      record.initialization.supervisorAgentId ??= randomUUID();
      if (!activeGeneration(record.slots[record.supervisorSlotId]!)) {
        await this.createRootGeneration(record, record.supervisorSlotId, "supervisor");
        await this.persist(record);
      }
    }
    if (!activeGeneration(record.slots[record.leadSlotId]!)) {
      await this.createRootGeneration(record, record.leadSlotId, "lead");
      await this.persist(record);
    }

    if (record.initialization.receipt === "pending") {
      const contactAgentId = this.contactAgentId(record);
      try {
        const result = await this.agentRequests.send({
          agentId: contactAgentId,
          messageId: record.initialization.messageId,
          request: { groupId: record.id, text: record.initialization.text },
          send: async () => {
            const admission = await this.agentManager.admitForegroundTurn(
              contactAgentId,
              record.initialization.text,
              { clientMessageId: record.initialization.messageId },
            );
            return admission.status === "busy" ? "declined" : undefined;
          },
        });
        if (result === "declined") {
          throw new Error(`agent ${contactAgentId} was busy before its first message`);
        }
        record.initialization.receipt = "accepted";
      } catch (error) {
        if (!(error instanceof Error && error.message === "agent_request_outcome_unknown")) {
          throw error;
        }
        // The send may have taken effect before the daemon died. Never repeat it.
        record.initialization.receipt = "uncertain";
        this.logger.warn(
          { groupId: record.id, agentId: contactAgentId },
          "SLP initial message acceptance is uncertain after restart",
        );
      }
    }

    record.status = "ready";
    record.hold = null;
    await this.persist(record);
    for (const slotId of Object.keys(record.slots)) this.mailbox.pump(record.id, slotId);
    return record;
  }

  /** The agent the Human talks to: the Supervisor in supervised mode, else the Lead. */
  contactAgentId(group: SlpGroupRecord): string {
    const agentId = findContactAgentId(group);
    if (!agentId) throw new SlpNoContactError(group.id);
    return agentId;
  }

  /** One root slot's first generation, created under the journal so a retry reuses the id. */
  private async createRootGeneration(
    record: SlpGroupRecord,
    slotId: string,
    role: "supervisor" | "lead",
  ): Promise<string> {
    const slot = record.slots[slotId];
    if (!slot) throw new Error(`SLP group ${record.id} has no ${role} slot ${slotId}`);
    const instructions = await this.instructions();
    const generationNumber = slot.generations.length + 1;
    const systemPrompt = this.composeRolePrompt(instructions, {
      role,
      groupId: record.id,
      workspaceId: record.workspaceId,
      slotId,
      generationNumber,
      mode: record.mode,
      addressBook: addressBookFor(record, slot),
    });
    const plannedAgentId =
      role === "lead" ? record.initialization.leadAgentId : record.initialization.supervisorAgentId;
    if (!plannedAgentId) throw new Error(`SLP group ${record.id} planned no ${role} agent id`);
    const agentId = await this.agentRequests.create({
      key: `slp-${role}:${record.id}`,
      request: { groupId: record.id, lead: record.initialization.lead },
      agentId: plannedAgentId,
      findAgent: async (candidate) =>
        this.agentManager.getAgent(candidate) != null ||
        (await this.agentStorage.get(candidate)) !== null,
      create: (candidate) =>
        this.createMemberAgent({
          agentId: candidate,
          groupId: record.id,
          workspaceId: record.workspaceId,
          title: role === "lead" ? "Lead" : "Supervisor",
          source: applyRoleLaunch(
            { ...record.initialization.lead, thinkingOptionId: null, providerOptions: null },
            this.roleSettings()[role],
          ),
          systemPrompt,
          labels: { [SLP_GROUP_LABEL]: record.id },
        }),
    });
    const at = this.now().toISOString();
    const generation = newGeneration({
      number: generationNumber,
      agentId,
      instructionsVersion: this.instructionsVersion(instructions),
      at,
    });
    generation.state = "active";
    generation.activatedAt = at;
    slot.generations.push(generation);
    slot.activeGenerationId = generation.id;
    return agentId;
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
      instructionsVersion: this.instructionsVersion(instructions),
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
    const peerSettings = this.roleSettings().peer;
    return {
      agentId: generation.agentId,
      labels: { [SLP_GROUP_LABEL]: group.id },
      systemPrompt: this.composeRolePrompt(instructions, {
        role: "peer",
        groupId: group.id,
        workspaceId: group.workspaceId,
        slotId: peerSlot.id,
        generationNumber: generation.number,
        mode: group.mode,
        addressBook: addressBookFor(group, peerSlot),
      }),
      launch: {
        provider: peerSettings?.provider ?? null,
        model: peerSettings?.model ?? null,
        modeId: peerSettings?.modeId ?? null,
        thinkingOptionId: peerSettings?.thinkingOptionId ?? null,
      },
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
      if (record.status === "ended") {
        await this.archiveMembers(record);
        continue;
      }
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

  /** The bundled role prompt plus whatever the host configured for that role. */
  private composeRolePrompt(instructions: SlpInstructions, identity: SlpIdentity): string {
    return appendRoleInstructions(
      composeSlpSystemPrompt(instructions, identity, { handoff: this.isHandoffEnabled() }),
      this.roleSettings()[identity.role],
    );
  }

  private instructionsVersion(instructions: SlpInstructions): string {
    return slpInstructionsVersion(instructions, { handoff: this.isHandoffEnabled() });
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
    if (!group || !slot || group.status === "ended") return { status: "empty" };
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
    this.changed(record.id);
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

/**
 * The agent ids a slot's prompt names. A root's id is planned at group
 * creation, so the Supervisor can name a Lead that does not exist yet; mail
 * resolves any generation's id to the slot, so a handoff does not stale it.
 */
function addressBookFor(group: SlpGroupRecord, slot: SlpSlotRecord): SlpAddressBook {
  const planned = group.initialization;
  switch (slot.role) {
    case "supervisor":
      return planned.leadAgentId ? { lead: planned.leadAgentId } : {};
    case "lead":
      return planned.supervisorAgentId ? { supervisor: planned.supervisorAgentId } : {};
    case "peer": {
      const owner = slot.ownerSlotId ? group.slots[slot.ownerSlotId] : undefined;
      const lead = owner ? (activeGeneration(owner) ?? owner.generations[0])?.agentId : undefined;
      return lead ? { lead } : {};
    }
  }
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

/** Null while the contact slot has no active generation (initializing, or inconsistent records). */
function findContactAgentId(group: SlpGroupRecord): string | null {
  const slot = group.slots[group.supervisorSlotId ?? group.leadSlotId];
  return slot?.generations.find((entry) => entry.id === slot.activeGenerationId)?.agentId ?? null;
}

function transferReason(record: SlpTransferRecord): string | null {
  if (record.phase === "blocked") return record.blockedReason;
  if (record.phase === "aborted") return record.abortedReason;
  return null;
}

function emptySlot(id: string, role: "supervisor" | "lead"): SlpSlotRecord {
  return { id, role, ownerSlotId: null, activeGenerationId: null, generations: [] };
}

function groupAgentIds(group: SlpGroupRecord): string[] {
  return Object.values(group.slots).flatMap((slot) =>
    slot.generations.map((generation) => generation.agentId),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

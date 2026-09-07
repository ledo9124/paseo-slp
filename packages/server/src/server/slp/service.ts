import type { Logger } from "pino";

import type { AgentManager, DestructiveOperationGate } from "../agent/agent-manager.js";
import type { AgentRequests } from "../agent/requests/index.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import {
  SlpGroupFrozenError,
  SlpGroupHeldError,
  SlpInitializationConflictError,
} from "./errors.js";
import {
  newSlpGroupId,
  newSlpId,
  SlpGroupStore,
  type SlpGroupRecord,
  type SlpInitializationRecord,
  type SlpWorkspaceMode,
} from "./store.js";

export interface SlpInitializeGroupInput {
  workspaceId: string;
  mode: SlpWorkspaceMode;
  initialMessage: { messageId: string; text: string };
  lead: SlpInitializationRecord["lead"];
}

export interface SlpLeadCreationInput {
  agentId: string;
  groupId: string;
  workspaceId: string;
  lead: SlpInitializationRecord["lead"];
}

export interface SlpServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: Pick<
    AgentManager,
    "admitForegroundTurn" | "getAgent" | "setDestructiveOperationGate"
  >;
  agentStorage: Pick<AgentStorage, "get">;
  agentRequests: Pick<AgentRequests, "create" | "send">;
  /** Creates the Lead agent under the preassigned id. Bootstrap binds the create funnel. */
  createLeadAgent: (input: SlpLeadCreationInput) => Promise<void>;
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
 * boot recovery and the destructive-operation gate. Membership is authority;
 * labels are only a projection. See docs/slp/architecture.md.
 */
export class SlpService {
  private readonly store: SlpGroupStore;
  private readonly logger: Logger;
  private readonly agentManager: SlpServiceOptions["agentManager"];
  private readonly agentStorage: SlpServiceOptions["agentStorage"];
  private readonly agentRequests: SlpServiceOptions["agentRequests"];
  private readonly createLeadAgent: SlpServiceOptions["createLeadAgent"];
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
    this.createLeadAgent = options.createLeadAgent;
    this.now = options.now ?? (() => new Date());
    this.agentManager.setDestructiveOperationGate(this.destructiveOperationGate());
  }

  // ---------------------------------------------------------------- queries

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

  // ------------------------------------------------------------------- gate

  /**
   * Group gate before per-agent lanes: callers read this before entering a
   * lifecycle lane, never from inside one. The hold is persisted state, so a
   * transfer waiting on a provider still refuses archive without holding a
   * promise chain across that wait.
   */
  private destructiveOperationGate(): DestructiveOperationGate {
    return {
      assertAgentOperationAllowed: (agentId) => {
        const group = this.getGroupForAgent(agentId);
        if (group) this.assertGroupNotHeld(group);
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

  // --------------------------------------------------------- initialization

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
      const leadAgentId = await this.agentRequests.create({
        key: `slp-lead:${record.id}`,
        request: { groupId: record.id, lead: record.initialization.lead },
        findAgent: async (agentId) =>
          this.agentManager.getAgent(agentId) != null ||
          (await this.agentStorage.get(agentId)) !== null,
        create: (agentId) =>
          this.createLeadAgent({
            agentId,
            groupId: record.id,
            workspaceId: record.workspaceId,
            lead: record.initialization.lead,
          }),
      });
      const at = this.now().toISOString();
      const generationId = newSlpId("gen");
      leadSlot.generations.push({
        id: generationId,
        number: 1,
        agentId: leadAgentId,
        state: "active",
        createdAt: at,
        activatedAt: at,
        retiredAt: null,
      });
      leadSlot.activeGenerationId = generationId;
      record.initialization.leadAgentId = leadAgentId;
      await this.persist(record);
    }

    if (record.initialization.receipt === "pending") {
      const leadAgentId = record.initialization.leadAgentId!;
      try {
        await this.agentRequests.send({
          agentId: leadAgentId,
          messageId: record.initialization.messageId,
          request: { groupId: record.id, text: record.initialization.text },
          send: async () => {
            const admission = await this.agentManager.admitForegroundTurn(
              leadAgentId,
              record.initialization.text,
              { clientMessageId: record.initialization.messageId },
            );
            if (admission.status === "busy") {
              throw new Error(`Lead ${leadAgentId} was busy before its first message`);
            }
          },
        });
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
    return record;
  }

  // --------------------------------------------------------------- recovery

  /**
   * Boot recovery: load every group, resume interrupted initializations, and
   * freeze only the groups whose state cannot be resumed. Runs in the same
   * bootstrap block as agent storage recovery, before the WebSocket server.
   */
  async recover(): Promise<void> {
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
      if (record.hold?.kind === "transfer") {
        await this.freeze(record, "transfer recovery is not implemented");
        continue;
      }
      if (record.status !== "initializing") continue;
      try {
        await this.serializeByWorkspace(record.workspaceId, () => this.runInitialization(record));
      } catch (error) {
        await this.freeze(record, `initialization recovery failed: ${describe(error)}`);
      }
    }
  }

  private async freeze(record: SlpGroupRecord, reason: string): Promise<void> {
    record.status = "frozen";
    record.freeze = { reason, at: this.now().toISOString() };
    await this.persist(record);
    this.logger.error({ groupId: record.id, reason }, "SLP group frozen");
  }

  // ---------------------------------------------------------------- helpers

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

function groupAgentIds(group: SlpGroupRecord): string[] {
  return Object.values(group.slots).flatMap((slot) =>
    slot.generations.map((generation) => generation.agentId),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

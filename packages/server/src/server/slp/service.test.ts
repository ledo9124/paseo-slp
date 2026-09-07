import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { AgentRequests } from "../agent/requests/index.js";
import { archiveByScope, type ArchiveDependencies } from "../workspace-archive-service.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import { createHeldTurnClient, type HeldTurnClient } from "../test-utils/held-turn-agent-client.js";
import { SlpGroupHeldError, SlpInitializationConflictError } from "./errors.js";
import { SlpService, type SlpInitializeGroupInput } from "./service.js";
import type { SlpGroupRecord } from "./store.js";

const WORKSPACE = "wks_slp_test";

interface Daemon {
  service: SlpService;
  manager: AgentManager;
  client: HeldTurnClient;
  storage: AgentStorage;
}

describe("SlpService", () => {
  let paseoHome: string;
  let cwd: string;
  const daemons: Daemon[] = [];

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "slp-service-"));
    cwd = path.join(paseoHome, "checkout");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
      for (const agent of daemon.manager.listAgents()) {
        await daemon.manager.closeAgent(agent.id).catch(() => undefined);
      }
      await daemon.storage.flush();
    }
    await rm(paseoHome, { recursive: true, force: true });
  });

  // A "daemon" is one AgentManager + storage + journal + SLP service over the
  // same preserved home. Two of them in sequence stand in for a restart.
  async function startDaemon(): Promise<Daemon> {
    const logger = createTestLogger();
    const client = createHeldTurnClient({ provider: "codex" });
    const storage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    await storage.initialize();
    const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
    const agentRequests = new AgentRequests(path.join(paseoHome, "agent-requests"));
    const service = new SlpService({
      paseoHome,
      logger,
      agentManager: manager,
      agentStorage: storage,
      agentRequests,
      createLeadAgent: async (creation) => {
        await manager.createAgent(
          { provider: creation.lead.provider, cwd: creation.lead.cwd },
          creation.agentId,
          { workspaceId: creation.workspaceId },
        );
      },
    });
    await service.recover();
    const daemon = { service, manager, client, storage };
    daemons.push(daemon);
    return daemon;
  }

  function input(overrides?: Partial<SlpInitializeGroupInput>): SlpInitializeGroupInput {
    return {
      workspaceId: WORKSPACE,
      mode: "direct",
      initialMessage: { messageId: "msg-1", text: "Login is slow, please investigate" },
      lead: { provider: "codex", cwd, model: null, modeId: null },
      ...overrides,
    };
  }

  async function readGroupFile(groupId: string): Promise<SlpGroupRecord> {
    return JSON.parse(
      await readFile(path.join(paseoHome, "slp", "groups", `${groupId}.json`), "utf8"),
    ) as SlpGroupRecord;
  }

  function leadAgentId(group: SlpGroupRecord): string {
    const slot = group.slots[group.leadSlotId]!;
    return slot.generations.find((generation) => generation.id === slot.activeGenerationId)!
      .agentId;
  }

  test("concurrent clients and retries converge on one group, mode and receipt", async () => {
    const daemon = await startDaemon();

    const [a, b, c] = await Promise.all([
      daemon.service.initializeGroup(input()),
      daemon.service.initializeGroup(input()),
      daemon.service.initializeGroup(input()),
    ]);
    const retry = await daemon.service.initializeGroup(input());

    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(retry).toBe(a);
    expect(a.status).toBe("ready");
    expect(a.hold).toBeNull();
    expect(a.mode).toBe("direct");
    expect(a.initialization.receipt).toBe("accepted");
    expect(daemon.client.sessions).toHaveLength(1);
    expect(daemon.client.sessions[0]!.startPrompts).toEqual(["Login is slow, please investigate"]);
    expect(daemon.manager.getAgent(leadAgentId(a))?.workspaceId).toBe(WORKSPACE);
    expect(await readGroupFile(a.id)).toEqual(a);
  });

  test("a conflicting mode or first message for the same workspace fails visibly", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup(input());

    await expect(daemon.service.initializeGroup(input({ mode: "supervised" }))).rejects.toThrow(
      SlpInitializationConflictError,
    );
    await expect(
      daemon.service.initializeGroup(
        input({ initialMessage: { messageId: "msg-2", text: "something else" } }),
      ),
    ).rejects.toThrow(SlpInitializationConflictError);
    expect(daemon.service.getGroupForWorkspace(WORKSPACE)).toBe(group);
    expect(daemon.client.sessions).toHaveLength(1);
  });

  test("restart preserves the group and does not create a second Lead or resend", async () => {
    const first = await startDaemon();
    const group = await first.service.initializeGroup(input());
    first.client.sessions[0]!.release();
    await first.manager.waitForAgentEvent(leadAgentId(group), { waitForActive: true });
    for (const agent of first.manager.listAgents()) await first.manager.closeAgent(agent.id);
    await first.storage.flush();

    const second = await startDaemon();
    const recovered = second.service.getGroup(group.id);
    expect(recovered).toEqual(await readGroupFile(group.id));
    expect(recovered?.status).toBe("ready");
    expect(recovered?.mode).toBe("direct");
    expect(leadAgentId(recovered!)).toBe(leadAgentId(group));
    expect(second.client.sessions).toHaveLength(0);
    expect(await second.service.initializeGroup(input())).toBe(recovered);
    expect(second.client.sessions).toHaveLength(0);
  });

  test("recovery resumes an initialization interrupted before the Lead existed", async () => {
    const first = await startDaemon();
    const group = await first.service.initializeGroup(input());
    // Rewind the durable record to the state a crash right after the mode
    // decision leaves behind: no Lead, message pending, hold in place.
    const interrupted: SlpGroupRecord = {
      ...group,
      status: "initializing",
      hold: { kind: "initialization", slotId: group.leadSlotId, since: group.createdAt },
      initialization: { ...group.initialization, leadAgentId: null, receipt: "pending" },
      slots: {
        [group.leadSlotId]: {
          ...group.slots[group.leadSlotId]!,
          activeGenerationId: null,
          generations: [],
        },
      },
    };
    await writeFile(
      path.join(paseoHome, "slp", "groups", `${group.id}.json`),
      JSON.stringify(interrupted),
    );
    // The creation journal already completed for this group, so recovery must
    // find the existing Lead rather than create another. Rewind the send
    // receipt to pending: the daemon died after the provider call and before
    // recording its outcome, so acceptance cannot be proven.
    const sendKey = createHash("sha256")
      .update(JSON.stringify(["send", leadAgentId(group), "msg-1"]))
      .digest("hex");
    const sendReceiptPath = path.join(paseoHome, "agent-requests", `${sendKey}.json`);
    const sendReceipt = JSON.parse(await readFile(sendReceiptPath, "utf8")) as { state: string };
    expect(sendReceipt.state).toBe("completed");
    await writeFile(sendReceiptPath, JSON.stringify({ ...sendReceipt, state: "pending" }));
    for (const agent of first.manager.listAgents()) await first.manager.closeAgent(agent.id);
    await first.storage.flush();

    const second = await startDaemon();
    const recovered = second.service.getGroup(group.id)!;
    expect(recovered.status).toBe("ready");
    expect(recovered.hold).toBeNull();
    expect(leadAgentId(recovered)).toBe(leadAgentId(group));
    // The send journal recorded the first delivery as pending, so acceptance
    // is uncertain and the message is not sent again.
    expect(recovered.initialization.receipt).toBe("uncertain");
    expect(second.client.sessions).toHaveLength(0);
  });

  async function heldGroup(daemon: Daemon, kind: "transfer"): Promise<SlpGroupRecord> {
    const group = await daemon.service.initializeGroup(input());
    daemon.client.sessions[0]!.release();
    await daemon.manager.waitForAgentEvent(leadAgentId(group), { waitForActive: true });
    const hold = { kind, slotId: group.leadSlotId, since: new Date().toISOString() };
    await writeFile(
      path.join(paseoHome, "slp", "groups", `${group.id}.json`),
      JSON.stringify({ ...group, hold }),
    );
    for (const agent of daemon.manager.listAgents()) await daemon.manager.closeAgent(agent.id);
    await daemon.storage.flush();
    return group;
  }

  function archiveDependencies(daemon: Daemon): ArchiveDependencies {
    return {
      agentManager: daemon.manager,
      agentStorage: daemon.storage,
      workspaceGitService: createNoopWorkspaceGitService(),
      findWorkspaceIdForCwd: async () => WORKSPACE,
      listActiveWorkspaces: async () => [{ workspaceId: WORKSPACE, cwd }],
      archiveWorkspaceRecord: async () => {},
      emitWorkspaceUpdatesForWorkspaceIds: async () => {},
      markWorkspaceArchiving: () => {},
      clearWorkspaceArchiving: () => {},
      killTerminalsForWorkspace: async () => {},
    } as ArchiveDependencies;
  }

  test("a transferring group refuses individual archive, snapshot archive and teardown", async () => {
    const first = await startDaemon();
    const group = await heldGroup(first, "transfer");
    const agentId = leadAgentId(group);

    const second = await startDaemon();
    // A transfer hold with no transfer recovery implemented freezes only this group.
    expect(second.service.getGroup(group.id)?.status).toBe("frozen");
    await expect(second.manager.archiveSnapshot(agentId, new Date().toISOString())).rejects.toThrow(
      SlpGroupHeldError,
    );
    await expect(
      archiveByScope(archiveDependencies(second), {
        scope: { kind: "workspace", workspaceId: WORKSPACE },
        requestId: "test",
      }),
    ).rejects.toThrow(SlpGroupHeldError);
    expect((await second.storage.get(agentId))?.archivedAt).toBeUndefined();

    // The freeze is durable: a third daemon still refuses.
    const third = await startDaemon();
    await expect(third.manager.deleteAgentState(agentId)).rejects.toThrow(SlpGroupHeldError);
  });

  test("a ready group allows archive; an unrecognized record freezes only its own group", async () => {
    const first = await startDaemon();
    const ready = await first.service.initializeGroup(input());
    first.client.sessions[0]!.release();
    await first.manager.waitForAgentEvent(leadAgentId(ready), { waitForActive: true });
    const strangerAgent = await first.manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: "wks_other",
    });
    await writeFile(
      path.join(paseoHome, "slp", "groups", "grp_future.json"),
      JSON.stringify({
        id: "grp_future",
        workspaceId: "wks_other",
        status: "migrating",
        slots: { s: { generations: [{ agentId: strangerAgent.id }] } },
      }),
    );
    await writeFile(path.join(paseoHome, "slp", "groups", "grp_garbage.json"), "{not json");
    for (const agent of first.manager.listAgents()) await first.manager.closeAgent(agent.id);
    await first.storage.flush();

    const second = await startDaemon();
    expect(second.service.getGroup(ready.id)?.status).toBe("ready");
    await expect(
      second.manager.archiveSnapshot(strangerAgent.id, new Date().toISOString()),
    ).rejects.toThrow(SlpGroupHeldError);
    const assertOtherWorkspace = () =>
      second.manager.assertWorkspaceDestructiveOperationAllowed("wks_other");
    expect(assertOtherWorkspace).toThrow(SlpGroupHeldError);
    const archived = await second.manager.archiveSnapshot(
      leadAgentId(ready),
      new Date().toISOString(),
    );
    expect(archived.archivedAt).toEqual(expect.any(String));
  });
});

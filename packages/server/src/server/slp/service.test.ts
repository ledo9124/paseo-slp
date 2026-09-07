import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { archiveByScope, type ArchiveDependencies } from "../workspace-archive-service.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import {
  slpLeadAgentId as leadAgentId,
  startSlpTestDaemon,
  type SlpTestDaemon as Daemon,
  type SlpTestDaemonOptions,
} from "../test-utils/slp-test-daemon.js";
import {
  SlpDelegationUnavailableError,
  SlpGroupHeldError,
  SlpInitializationConflictError,
  SlpInstructionsUnavailableError,
} from "./errors.js";
import type { SlpInitializeGroupInput } from "./service.js";
import type { SlpGroupRecord } from "./store.js";

const WORKSPACE = "wks_slp_test";

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
    for (const daemon of daemons.splice(0)) await daemon.stop();
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function startDaemon(overrides?: Omit<SlpTestDaemonOptions, "paseoHome">): Promise<Daemon> {
    const daemon = await startSlpTestDaemon({ paseoHome, ...overrides });
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
    await first.stop();

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
    await first.stop();

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
    await daemon.stop();
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
    await first.stop();

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

  test("the Lead runs under the shared block plus exactly the Lead role, restored on resume", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup(input());
    const record = await daemon.storage.get(leadAgentId(group));
    const prompt = record?.config?.systemPrompt ?? "";

    expect(prompt.match(/^# Shared SLP instructions$/gm)).toHaveLength(1);
    expect(prompt.match(/^# Lead instructions$/gm)).toHaveLength(1);
    expect(prompt).not.toMatch(/^# (Supervisor|Peer) instructions$/m);
    expect(prompt).not.toMatch(/^Status:/m);
    expect(prompt).toContain(`- Group: ${group.id}`);
    expect(prompt).toContain(`- Slot: ${group.leadSlotId}`);
    expect(prompt).toContain("- Workspace mode: direct");
    const generation = group.slots[group.leadSlotId]!.generations[0]!;
    expect(generation.instructionsVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(daemon.manager.getAgent(leadAgentId(group))?.config?.systemPrompt).toBe(prompt);
  });

  test("initialization refuses visibly when agents would get no Paseo tools", async () => {
    const daemon = await startDaemon({ isDelegationToolingEnabled: () => false });

    await expect(daemon.service.initializeGroup(input())).rejects.toThrow(
      SlpDelegationUnavailableError,
    );
    expect(daemon.service.getGroupForWorkspace(WORKSPACE)).toBeNull();
    expect(daemon.client.sessions).toHaveLength(0);
    await expect(readdir(path.join(paseoHome, "slp", "groups"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("a missing role instruction file is a setup failure, not an unconfigured Lead", async () => {
    const rolesDir = path.join(paseoHome, "roles");
    await mkdir(rolesDir, { recursive: true });
    await writeFile(path.join(rolesDir, "common.md"), "# Shared SLP instructions\n");
    const daemon = await startDaemon({ instructionsDir: rolesDir });

    await expect(daemon.service.initializeGroup(input())).rejects.toThrow(
      SlpInstructionsUnavailableError,
    );
    expect(daemon.service.getGroupForWorkspace(WORKSPACE)).toBeNull();
    expect(daemon.client.sessions).toHaveLength(0);
  });
});

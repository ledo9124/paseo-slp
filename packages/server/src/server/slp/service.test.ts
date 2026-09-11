import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { archiveByScope, type ArchiveDependencies } from "../workspace-archive-service.js";
import { createNoopWorkspaceGitService } from "../test-utils/workspace-git-service-stub.js";
import {
  slpLeadAgentId as leadAgentId,
  startSlpTestDaemon,
  untilSettled,
  type SlpTestDaemon as Daemon,
  type SlpTestDaemonOptions,
} from "../test-utils/slp-test-daemon.js";
import {
  SlpDelegationUnavailableError,
  SlpGroupHeldError,
  SlpHandoffDisabledError,
  SlpInitializationConflictError,
  SlpInstructionsUnavailableError,
  SlpNoGroupError,
} from "./errors.js";
import { resolveBundledSlpRolesDir } from "./instructions.js";
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

  test("with features.slp.handoff off, members get neither the handoff tools nor the handoff text", async () => {
    const daemon = await startDaemon({ isHandoffEnabled: () => false });
    const group = await daemon.service.initializeGroup(input());
    const leadId = leadAgentId(group);
    const lead = await daemon.storage.get(leadId);
    const prompt = lead?.config.systemPrompt ?? "";
    expect(prompt).toContain("# Lead instructions");
    expect(prompt).toContain("## Using Paseo");
    expect(prompt).not.toContain("## Handoff");
    expect(prompt).not.toContain("slp_checkpoint");
    expect(prompt).not.toContain("slp_request_handoff");
    expect(prompt).toContain("# Shared SLP instructions");
    const stored = daemon.service.getGroup(group.id)!;
    const generation = stored.slots[stored.leadSlotId]!.generations[0]!;
    expect(generation.instructionsVersion).toMatch(/-nohandoff$/);

    const tools = createPaseoToolCatalog({
      agentManager: daemon.manager,
      agentStorage: daemon.storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      slp: daemon.service,
      callerAgentId: leadId,
      logger: createTestLogger(),
    });
    expect(tools.getTool("slp_checkpoint")).toBeUndefined();
    expect(tools.getTool("slp_request_handoff")).toBeUndefined();
    expect(tools.getTool("slp_ready")).toBeUndefined();
    expect(tools.getTool("send_agent_prompt")).toBeDefined();
    expect(tools.getTool("create_agent")).toBeDefined();
    // The service refuses even a call that bypasses the catalog.
    await expect(
      daemon.service.recordCheckpoint(leadId, { objective: "x", nextAction: "y" }),
    ).rejects.toThrow(SlpHandoffDisabledError);
    await expect(daemon.service.requestHandoff(leadId, "context")).rejects.toThrow(
      SlpHandoffDisabledError,
    );
  });

  test("role files with CRLF line endings still lose their Handoff section", async () => {
    const roles = await mkdtemp(path.join(tmpdir(), "slp-crlf-"));
    const bundled = resolveBundledSlpRolesDir();
    for (const name of ["common.md", "supervisor.md", "lead.md", "peer.md"]) {
      const text = await readFile(path.join(bundled, name), "utf8");
      await writeFile(path.join(roles, name), text.replace(/\n/g, "\r\n"));
    }
    const daemon = await startDaemon({ isHandoffEnabled: () => false, instructionsDir: roles });
    const group = await daemon.service.initializeGroup(input());
    const prompt = (await daemon.storage.get(leadAgentId(group)))?.config.systemPrompt ?? "";
    expect(prompt).toContain("## Using Paseo");
    expect(prompt).not.toContain("## Handoff");
    expect(prompt).not.toContain("\r");
    await rm(roles, { recursive: true, force: true });
  });

  test("with the flag on, the composed prompt carries the Handoff section and the tools", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup(input());
    const lead = await daemon.storage.get(leadAgentId(group));
    const prompt = lead?.config.systemPrompt ?? "";
    expect(prompt).toContain("## Handoff");
    expect(prompt).toContain("slp_request_handoff");
    const generation = daemon.service.getGroup(group.id)!.slots[group.leadSlotId]!.generations[0]!;
    expect(generation.instructionsVersion).not.toMatch(/-nohandoff$/);
  });

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

  function activeAgentId(group: SlpGroupRecord, slotId: string | null): string {
    const slot = slotId ? group.slots[slotId] : undefined;
    const active = slot?.generations.find((entry) => entry.id === slot.activeGenerationId);
    if (!active) throw new Error(`slot ${slotId} has no active generation`);
    return active.agentId;
  }

  function mailState(daemon: Daemon, mailId: string): string {
    return daemon.service.listMail().find((mail) => mail.id === mailId)?.state ?? "missing";
  }

  function sessionOf(daemon: Daemon, agentId: string) {
    const agent = daemon.manager.getAgent(agentId);
    const session = daemon.client.sessions.find(
      (candidate) => candidate.id === agent?.persistence?.sessionId,
    );
    if (!session) throw new Error(`no held-turn session for ${agentId}`);
    return session;
  }

  test("supervised mode: the Supervisor is the Human's contact and the Lead starts idle", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup(input({ mode: "supervised" }));

    expect(group.status).toBe("ready");
    expect(group.initialization.receipt).toBe("accepted");
    const supervisorId = activeAgentId(group, group.supervisorSlotId);
    const leadId = leadAgentId(group);
    expect(daemon.service.contactAgentId(group)).toBe(supervisorId);
    expect(group.initialization).toMatchObject({
      supervisorAgentId: supervisorId,
      leadAgentId: leadId,
    });
    expect(daemon.client.sessions).toHaveLength(2);
    expect(sessionOf(daemon, supervisorId).startPrompts).toEqual([
      "Login is slow, please investigate",
    ]);
    expect(sessionOf(daemon, leadId).startPrompts).toEqual([]);
    const supervisorPrompt = (await daemon.storage.get(supervisorId))?.config.systemPrompt ?? "";
    expect(supervisorPrompt).toContain("# Supervisor instructions");
    // Each root names the other by agent id, the Lead's before it exists.
    expect(supervisorPrompt).toContain(`Lead (agent id ${leadId})`);
    expect((await daemon.storage.get(leadId))?.config.systemPrompt).toContain(
      `Supervisor (agent id ${supervisorId})`,
    );
    expect((await daemon.storage.get(leadId))?.config.systemPrompt).toContain(
      "no separate reporting call is needed",
    );
    expect((await daemon.storage.get(supervisorId))?.title).toBe("Supervisor");
    expect(await readGroupFile(group.id)).toEqual(group);
    // A retry after restart creates nothing: both roots are journaled.
    await daemon.stop();
    const second = await startDaemon();
    expect(await second.service.initializeGroup(input({ mode: "supervised" }))).toEqual(group);
    expect(second.client.sessions).toHaveLength(0);
  });

  test("supervised mode: the final Lead message reaches a busy Supervisor after a progress message", async () => {
    const daemon = await startDaemon({
      releaseText: "Analysis done: three phases, one open decision.",
    });
    const group = await daemon.service.initializeGroup(input({ mode: "supervised" }));
    const supervisorId = activeAgentId(group, group.supervisorSlotId);
    const leadId = leadAgentId(group);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const reports = () => daemon.service.listMail().filter((mail) => mail.kind === "report");

    // A progress message starts a Supervisor turn; the final answer must follow it.
    expect((await daemon.manager.admitForegroundTurn(leadId, "Analyze the project")).status).toBe(
      "started",
    );
    await daemon.manager.waitForAgentRunStart(leadId);
    const sent = await daemon.service.routeSend({
      callerAgentId: leadId,
      targetAgentId: supervisorId,
      prompt: "Report: analysis under way",
    });
    sessionOf(daemon, leadId).release();
    await daemon.manager.waitForAgentEvent(leadId, { waitForActive: true });
    await untilSettled(
      () => mailState(daemon, sent?.mailId ?? "") === "accepted",
      "the Lead's own report reached the Supervisor",
    );
    await untilSettled(() => reports().length === 1, "the final answer was queued after progress");
    const firstReport = reports()[0]!;
    expect(firstReport.state).toBe("queued");
    expect(firstReport.slotId).toBe(group.supervisorSlotId);
    expect(firstReport.fromSlotId).toBe(group.leadSlotId);
    expect(JSON.stringify(firstReport.prompt)).toContain(
      "Analysis done: three phases, one open decision.",
    );
    // The report is durable before the busy Supervisor can receive it.
    const persistedReport = JSON.parse(
      await readFile(path.join(paseoHome, "slp", "mail", `${firstReport.id}.json`), "utf8"),
    );
    expect(persistedReport).toMatchObject({ id: firstReport.id, state: "queued" });
    expect(sessionOf(daemon, supervisorId).startPrompts).toHaveLength(2);
    expect(sessionOf(daemon, supervisorId).interruptCount).toBe(0);
    sessionOf(daemon, supervisorId).release();
    await untilSettled(
      () => mailState(daemon, firstReport.id) === "accepted",
      "the queued final answer reached the Supervisor",
    );
    await untilSettled(
      () => sessionOf(daemon, supervisorId).startPrompts.length === 3,
      "the Supervisor started a turn for the final answer",
    );
    expect(sessionOf(daemon, supervisorId).startPrompts[2]).toContain(
      "Analysis done: three phases, one open decision.",
    );
    expect(sessionOf(daemon, supervisorId).interruptCount).toBe(0);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });

    // Turn two: the Lead only writes in its own chat; its last message becomes the report.
    expect((await daemon.manager.admitForegroundTurn(leadId, "Continue")).status).toBe("started");
    await daemon.manager.waitForAgentRunStart(leadId);
    sessionOf(daemon, leadId).release();
    await untilSettled(() => reports().length === 2, "the next turn also produced one report");
    const report = reports()[1]!;
    expect(report.slotId).toBe(group.supervisorSlotId);
    expect(report.fromSlotId).toBe(group.leadSlotId);
    expect(JSON.stringify(report.prompt)).toContain(
      "Analysis done: three phases, one open decision.",
    );
  });

  test.each([
    { mode: "direct" as const, releaseText: "Analysis done." },
    { mode: "supervised" as const, releaseText: "" },
  ])(
    "does not relay a report for $mode with final text '$releaseText'",
    async ({ mode, releaseText }) => {
      const daemon = await startDaemon({ releaseText });
      const group = await daemon.service.initializeGroup(input({ mode }));
      const leadId = leadAgentId(group);
      const contactId = daemon.service.contactAgentId(group);
      sessionOf(daemon, contactId).release();
      await daemon.manager.waitForAgentEvent(contactId, { waitForActive: true });
      await daemon.manager.admitForegroundTurn(leadId, "Analyze the project");
      await daemon.manager.waitForAgentRunStart(leadId);
      sessionOf(daemon, leadId).release();
      await daemon.manager.waitForAgentEvent(leadId, { waitForActive: true });
      // Drain report writes before asserting absence; no timer-shaped negative assertion.
      await daemon.service.dispose();
      expect(daemon.service.listMail().filter((mail) => mail.kind === "report")).toEqual([]);
    },
  );

  test("supervised mode: the Human keeps a contact while the Lead is busy", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup(input({ mode: "supervised" }));
    const supervisorId = activeAgentId(group, group.supervisorSlotId);
    const leadId = leadAgentId(group);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });

    const relayed = await daemon.service.routeSend({
      callerAgentId: supervisorId,
      targetAgentId: leadId,
      prompt: "Investigate login latency; report the cause and the measured result.",
    });
    if (!relayed) throw new Error("the Supervisor's send was not routed as SLP mail");
    await untilSettled(
      () => mailState(daemon, relayed.mailId) === "accepted",
      "relay accepted by the Lead",
    );
    expect(daemon.manager.getAgent(leadId)?.lifecycle).toBe("running");
    // Named, so the Lead cannot read a member's message as Human's.
    const delivered = sessionOf(daemon, leadId).startPrompts[0] ?? "";
    expect(sessionOf(daemon, leadId).startPrompts).toHaveLength(1);
    expect(delivered).toMatch(/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/);
    expect(delivered).toContain(`SLP message from supervisor (${supervisorId})`);
    expect(delivered).toContain(
      "Investigate login latency; report the cause and the measured result.",
    );

    // Human's own message reaches the contact unwrapped; only mail is named.
    // The Lead's held turn does not block the Human: the Supervisor takes the next message.
    const admission = await daemon.manager.admitForegroundTurn(supervisorId, "How is it going?");
    expect(admission.status).toBe("started");
    expect(sessionOf(daemon, supervisorId).startPrompts).toEqual([
      "Login is slow, please investigate",
      "How is it going?",
    ]);
  });

  test("role settings choose each root's launch and append the host's instructions", async () => {
    const daemon = await startDaemon({
      roleSettings: () => ({
        supervisor: {
          provider: "claude",
          model: "claude-opus-5",
          instructions: "Answer in Vietnamese.",
        },
        lead: { model: "gpt-6", modeId: "full-access" },
      }),
    });
    const group = await daemon.service.initializeGroup(input({ mode: "supervised" }));

    const supervisor = await daemon.storage.get(activeAgentId(group, group.supervisorSlotId));
    expect(supervisor?.provider).toBe("claude");
    expect(supervisor?.config.model).toBe("claude-opus-5");
    expect(supervisor?.config.systemPrompt).toMatch(
      /# Additional instructions from this host\n\nAnswer in Vietnamese\.$/,
    );
    const lead = await daemon.storage.get(leadAgentId(group));
    expect(lead?.provider).toBe("codex");
    expect(lead?.config.model).toBe("gpt-6");
    expect(lead?.config.systemPrompt).not.toContain("Additional instructions");
    // The stub provider advertises no modes, so the mode is checked at the creation boundary.
    expect(daemon.creations.map((creation) => [creation.title, creation.source])).toEqual([
      [
        "Supervisor",
        {
          provider: "claude",
          cwd,
          model: "claude-opus-5",
          modeId: null,
          thinkingOptionId: null,
          providerOptions: null,
        },
      ],
      [
        "Lead",
        {
          provider: "codex",
          cwd,
          model: "gpt-6",
          modeId: "full-access",
          thinkingOptionId: null,
          // A Codex member always launches without Codex's own agent tools.
          providerOptions: { agents: { enabled: false } },
        },
      ],
    ]);
  });

  test("ending a group archives its members and frees the workspace, before and after restart", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup(input({ mode: "supervised" }));
    const supervisorId = activeAgentId(group, group.supervisorSlotId);
    const leadId = leadAgentId(group);

    const ended = await daemon.service.endGroup(WORKSPACE);
    expect(ended.status).toBe("ended");
    expect(daemon.service.getGroupForWorkspace(WORKSPACE)).toBeNull();
    expect(daemon.service.getGroupForAgent(leadId)).toBeNull();
    expect((await daemon.storage.get(supervisorId))?.archivedAt).toEqual(expect.any(String));
    expect((await daemon.storage.get(leadId))?.archivedAt).toEqual(expect.any(String));
    await expect(daemon.service.endGroup(WORKSPACE)).rejects.toThrow(SlpNoGroupError);

    // The workspace can start again with another mode; the ended record stays for the journals.
    const next = await daemon.service.initializeGroup(
      input({ mode: "direct", initialMessage: { messageId: "msg-2", text: "Again" } }),
    );
    expect(next.id).not.toBe(group.id);
    await daemon.stop();
    const second = await startDaemon();
    expect(second.service.getGroupForWorkspace(WORKSPACE)?.id).toBe(next.id);
    expect(second.service.getGroup(group.id)?.status).toBe("ended");
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
    const hold = {
      kind,
      slotId: group.leadSlotId,
      transferId: "tr_missing",
      since: new Date().toISOString(),
    };
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
    // A transfer hold whose journal record is missing freezes only this group.
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
    expect(prompt.startsWith("# Your SLP role\n\nYou are the Lead of a Paseo SLP group.")).toBe(
      true,
    );
    expect(prompt.indexOf("# Lead instructions")).toBeLessThan(
      prompt.indexOf("# Shared SLP instructions"),
    );
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

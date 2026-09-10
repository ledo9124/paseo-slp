import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import {
  allMailQueued,
  slpLeadAgentId as leadAgentId,
  startSlpTestDaemon,
  type SlpTestDaemon as Daemon,
  untilSettled,
} from "../test-utils/slp-test-daemon.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { SlpRoleAuthorityError } from "./errors.js";
import type { SlpInitializeGroupInput } from "./service.js";
import type { SlpGroupRecord, SlpMailRecord } from "./store.js";

const WORKSPACE = "wks_slp_mail";
const MailReceiptSchema = z.object({ mailId: z.string() });

describe("SLP slot mailbox", () => {
  let paseoHome: string;
  let cwd: string;
  const daemons: Daemon[] = [];

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "slp-mail-"));
    cwd = path.join(paseoHome, "checkout");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function startDaemon(): Promise<Daemon> {
    const daemon = await startSlpTestDaemon({ paseoHome, releaseText: "done" });
    daemons.push(daemon);
    return daemon;
  }

  function input(): SlpInitializeGroupInput {
    return {
      workspaceId: WORKSPACE,
      mode: "direct",
      initialMessage: { messageId: "msg-1", text: "Login is slow, please investigate" },
      lead: { provider: "codex", cwd, model: null, modeId: null },
    };
  }

  /** A ready group whose Lead has finished its first turn and owns one busy Peer. */
  async function groupWithPeer(daemon: Daemon): Promise<{
    group: SlpGroupRecord;
    leadId: string;
    peerId: string;
    peerSlotId: string;
  }> {
    const group = await daemon.service.initializeGroup(input());
    daemon.client.sessions[0]!.release();
    await daemon.manager.waitForAgentEvent(leadAgentId(group), { waitForActive: true });
    const creation: CreateAgentFromMcpInput = {
      kind: "mcp",
      provider: "codex",
      title: "Peer",
      initialPrompt: "Start the assignment",
      background: true,
      notifyOnFinish: true,
      callerAgentId: leadAgentId(group),
    };
    const created = await daemon.createAgent(creation);
    const stored = daemon.service.getGroup(group.id)!;
    const peerSlot = Object.values(stored.slots).find((slot) => slot.role === "peer")!;
    return {
      group: stored,
      leadId: leadAgentId(group),
      peerId: created.snapshot.id,
      peerSlotId: peerSlot.id,
    };
  }

  /**
   * The initial prompt stands alone; every later message is mail, named with
   * its sender so the recipient cannot read it as Human's.
   */
  function expectDelivered(prompts: string[], texts: string[], fromAgentId: string): void {
    expect(prompts).toHaveLength(texts.length + 1);
    expect(prompts[0]).toBe("Start the assignment");
    for (const [index, text] of texts.entries()) {
      const delivered = prompts[index + 1] ?? "";
      expect(delivered).toContain(`SLP message from lead (${fromAgentId})`);
      expect(delivered).toContain(text);
    }
  }

  function mail(daemon: Daemon, id: string): SlpMailRecord {
    const record = daemon.service.listMail().find((candidate) => candidate.id === id);
    if (!record) throw new Error(`no mail ${id}`);
    return record;
  }

  async function readMailFile(id: string): Promise<SlpMailRecord> {
    return JSON.parse(
      await readFile(path.join(paseoHome, "slp", "mail", `${id}.json`), "utf8"),
    ) as SlpMailRecord;
  }

  function catalogFor(daemon: Daemon, callerAgentId: string) {
    return createPaseoToolCatalog({
      agentManager: daemon.manager,
      agentStorage: daemon.storage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      slp: daemon.service,
      callerAgentId,
      logger: createTestLogger(),
    });
  }

  test("mail to a busy Peer is queued with its attachments and admitted when the turn ends", async () => {
    const daemon = await startDaemon();
    const { group, peerId, peerSlotId } = await groupWithPeer(daemon);
    const peer = daemon.client.sessions[1]!;
    const prompt: AgentPromptInput = [
      { type: "text", text: "Review the attached trace" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", mimeType: "text/plain", title: "trace.log", text: "GET /login 1200ms" },
    ];

    const queued = await daemon.service.deliverMail({
      groupId: group.id,
      slotId: peerSlotId,
      fromSlotId: group.leadSlotId,
      kind: "message",
      prompt,
    });
    expect(queued.state).toBe("queued");
    expect(await readMailFile(queued.id)).toEqual(queued);
    // The receipt is durable while the Peer is still on its first turn.
    expect(peer.startPrompts).toHaveLength(1);
    expect(peer.interruptCount).toBe(0);

    peer.release();
    await untilSettled(() => mail(daemon, queued.id).state === "accepted", "mail admitted");
    expect(peer.startPrompts).toHaveLength(2);
    expect(JSON.parse(peer.startPrompts[1]!)).toEqual(prompt);
    expect(mail(daemon, queued.id)).toMatchObject({
      state: "accepted",
      attempt: { agentId: peerId },
    });
    expect(await readMailFile(queued.id)).toEqual(mail(daemon, queued.id));
  });

  test("a slot drains one message per turn, in order, through the Lead's send tool", async () => {
    const daemon = await startDaemon();
    const { leadId, peerId } = await groupWithPeer(daemon);
    const peer = daemon.client.sessions[1]!;
    const tools = catalogFor(daemon, leadId);

    const first = await tools.executeTool("send_agent_prompt", {
      agentId: peerId,
      prompt: "first",
    });
    const second = await tools.executeTool("send_agent_prompt", {
      agentId: peerId,
      prompt: "second",
    });
    const firstId = MailReceiptSchema.parse(first.structuredContent).mailId;
    const secondId = MailReceiptSchema.parse(second.structuredContent).mailId;
    expect(first.structuredContent).toMatchObject({ success: true, status: "running" });
    await untilSettled(() => allMailQueued(daemon), "both returned to queued by the busy answer");
    expect(daemon.service.listMail().map((record) => record.id)).toEqual([firstId, secondId]);
    // The built-in finish notification is not armed for SLP sends: no Lead prompt appears later.
    expect(peer.startPrompts).toEqual(["Start the assignment"]);

    peer.release();
    await untilSettled(() => mail(daemon, firstId).state === "accepted", "first admitted");
    expectDelivered(peer.startPrompts, ["first"], leadId);
    expect(mail(daemon, secondId).state).toBe("queued");
    peer.release();
    await untilSettled(() => mail(daemon, secondId).state === "accepted", "second admitted");
    expectDelivered(peer.startPrompts, ["first", "second"], leadId);
    expect(peer.interruptCount).toBe(0);
    // The Lead hears from the Peer only through the SLP handback, never the
    // built-in finish notification the send tool would otherwise arm.
    const handbackMail = () =>
      daemon.service.listMail().find((record) => record.kind === "handback");
    await untilSettled(() => handbackMail()?.state === "accepted", "handback admitted");
    const leadPrompts = daemon.client.sessions[0]!.startPrompts.slice(1);
    expect(leadPrompts).toHaveLength(1);
    expect(leadPrompts[0]).toContain("SLP handback");
  });

  test("queued mail survives a restart; mail caught dispatching becomes uncertain and is not replayed", async () => {
    const first = await startDaemon();
    const { group, peerId, peerSlotId } = await groupWithPeer(first);
    const queued = await first.service.deliverMail({
      groupId: group.id,
      slotId: peerSlotId,
      fromSlotId: group.leadSlotId,
      kind: "message",
      prompt: "still queued at crash",
    });
    const caught = await first.service.deliverMail({
      groupId: group.id,
      slotId: peerSlotId,
      fromSlotId: group.leadSlotId,
      kind: "message",
      prompt: "in flight at crash",
    });
    await first.stop();
    // The daemon died after persisting the attempt and before recording the
    // provider's answer: the input is retained, acceptance is unknowable.
    const attempt = {
      id: "attempt_x",
      generationId: "gen_x",
      agentId: peerId,
      at: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(
      path.join(paseoHome, "slp", "mail", `${caught.id}.json`),
      JSON.stringify({ ...caught, state: "dispatching", attempt }),
    );

    const second = await startDaemon();
    expect(mail(second, caught.id)).toMatchObject({
      state: "uncertain",
      attempt,
      prompt: "in flight at crash",
      reason: "daemon restarted during dispatch",
    });
    await untilSettled(() => mail(second, queued.id).state === "accepted", "queued mail admitted");
    const peer = second.client.sessions.find((session) =>
      session.startPrompts.includes("still queued at crash"),
    );
    expect(peer?.startPrompts).toEqual(["still queued at crash"]);
    expect(second.client.sessions.flatMap((session) => session.startPrompts)).not.toContain(
      "in flight at crash",
    );
    expect(await readMailFile(caught.id)).toEqual(mail(second, caught.id));
  });

  test("mail waits while its group is held and drains when the hold lifts", async () => {
    const first = await startDaemon();
    const { group, peerId, peerSlotId } = await groupWithPeer(first);
    first.client.sessions[1]!.release();
    await first.manager.waitForAgentEvent(peerId, { waitForActive: true });
    await first.stop();
    const groupFile = path.join(paseoHome, "slp", "groups", `${group.id}.json`);
    const stored = JSON.parse(await readFile(groupFile, "utf8")) as SlpGroupRecord;
    await writeFile(
      groupFile,
      JSON.stringify({
        ...stored,
        hold: { kind: "initialization", slotId: stored.leadSlotId, since: stored.createdAt },
      }),
    );

    // A transfer hold freezes today (no transfer recovery), so an initialization
    // hold stands in for "held": the group is not frozen, the slot is not drained.
    const second = await startDaemon();
    expect(second.service.getGroup(group.id)?.hold?.kind).toBe("initialization");
    const queued = await second.service.deliverMail({
      groupId: group.id,
      slotId: peerSlotId,
      fromSlotId: group.leadSlotId,
      kind: "message",
      prompt: "held",
    });
    // Nothing dispatches: no Peer session exists in this daemon yet.
    expect(second.client.sessions).toHaveLength(0);
    expect(mail(second, queued.id).state).toBe("queued");
    await second.stop();

    await writeFile(groupFile, JSON.stringify({ ...stored, hold: null }));
    const third = await startDaemon();
    await untilSettled(() => mail(third, queued.id).state === "accepted", "drained after hold");
    expect(mail(third, queued.id).attempt.agentId).toBe(peerId);
    const peer = third.client.sessions.find((session) => session.startPrompts.includes("held"));
    expect(peer?.startPrompts).toEqual(["held"]);
  });

  test("roles see and act only within their authority; agents outside a group are unchanged", async () => {
    const daemon = await startDaemon();
    const { group, leadId, peerId } = await groupWithPeer(daemon);
    const outsider = await daemon.manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: "wks_other",
    });
    const leadTools = catalogFor(daemon, leadId);
    const peerTools = catalogFor(daemon, peerId);
    const outsiderTools = catalogFor(daemon, outsider.id);

    expect(leadTools.getTool("create_agent")).toBeDefined();
    expect(leadTools.getTool("cancel_agent")).toBeDefined();
    expect(peerTools.getTool("create_agent")).toBeUndefined();
    expect(peerTools.getTool("cancel_agent")).toBeUndefined();
    expect(peerTools.getTool("send_agent_prompt")).toBeDefined();
    expect(outsiderTools.getTool("create_agent")).toBeDefined();
    // The SLP control channel exists only for members.
    expect(leadTools.getTool("slp_checkpoint")).toBeDefined();
    expect(peerTools.getTool("slp_request_handoff")).toBeDefined();
    expect(outsiderTools.getTool("slp_checkpoint")).toBeUndefined();
    expect(outsiderTools.getTool("slp_ready")).toBeUndefined();

    // A Peer writes only to its Lead; the Lead writes only to its Peers and cannot reach a stranger.
    await expect(
      peerTools.executeTool("send_agent_prompt", { agentId: outsider.id, prompt: "hi" }),
    ).rejects.toThrow(SlpRoleAuthorityError);
    await expect(
      leadTools.executeTool("send_agent_prompt", { agentId: outsider.id, prompt: "hi" }),
    ).rejects.toThrow(SlpRoleAuthorityError);
    await expect(leadTools.executeTool("cancel_agent", { agentId: outsider.id })).rejects.toThrow(
      SlpRoleAuthorityError,
    );
    const reply = await peerTools.executeTool("send_agent_prompt", {
      agentId: leadId,
      prompt: "question for Lead",
    });
    expect(reply.structuredContent).toMatchObject({ success: true, mailId: expect.any(String) });
    expect(daemon.service.listMail()).toMatchObject([
      { slotId: group.leadSlotId, kind: "message" },
    ]);
    // Named with its sender, so the Lead cannot read a Peer's words as Human's.
    const queued = daemon.service.listMail()[0]?.prompt ?? "";
    expect(queued).toContain(`SLP message from peer (${peerId})`);
    expect(queued).toContain("question for Lead");

    // The Lead may cancel its own Peer: the target check passes and the tool runs.
    const canceled = await leadTools.executeTool("cancel_agent", { agentId: peerId });
    expect(canceled.structuredContent).toMatchObject({ success: true });
    expect(daemon.client.sessions[1]!.interruptCount).toBe(1);
  });
});

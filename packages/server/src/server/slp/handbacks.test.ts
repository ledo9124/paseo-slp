import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import {
  allMailQueued,
  slpLeadAgentId as leadAgentId,
  startSlpTestDaemon,
  type SlpTestDaemon as Daemon,
  untilSettled,
} from "../test-utils/slp-test-daemon.js";
import { SlpRoleAuthorityError } from "./errors.js";
import { SLP_GROUP_LABEL, type SlpInitializeGroupInput } from "./service.js";
import type { SlpGroupRecord, SlpHandbackRecord } from "./store.js";

const WORKSPACE = "wks_slp_handback";
const HANDBACK_TEXT = "Candidate ready for Lead review.";

describe("SLP Peer creation and handback", () => {
  let paseoHome: string;
  let cwd: string;
  const daemons: Daemon[] = [];

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "slp-handback-"));
    cwd = path.join(paseoHome, "checkout");
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function startDaemon(): Promise<Daemon> {
    const daemon = await startSlpTestDaemon({ paseoHome, releaseText: HANDBACK_TEXT });
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

  /** A ready group whose Lead has finished its first turn. */
  async function readyGroup(daemon: Daemon): Promise<SlpGroupRecord> {
    const group = await daemon.service.initializeGroup(input());
    daemon.client.sessions[0]!.release();
    await daemon.manager.waitForAgentEvent(leadAgentId(group), { waitForActive: true });
    return group;
  }

  function peerCreation(callerAgentId: string): CreateAgentFromMcpInput {
    return {
      kind: "mcp",
      provider: "codex",
      title: "Investigate login latency",
      initialPrompt: "Find the cause of slow login. Return evidence.",
      background: true,
      // The Lead asked for the built-in channel; SLP owns delivery instead.
      notifyOnFinish: true,
      callerAgentId,
    };
  }

  /** Starts a turn the held-turn client keeps open until the test releases it. */
  async function holdTurn(daemon: Daemon, agentId: string): Promise<void> {
    const admission = await daemon.manager.admitForegroundTurn(agentId, "Keep going");
    expect(admission.status).toBe("started");
    await daemon.manager.waitForAgentRunStart(agentId);
  }

  function handbackFor(daemon: Daemon, peerAgentId: string): SlpHandbackRecord {
    const record = daemon.service
      .listHandbacks()
      .find((candidate) => candidate.peerAgentId === peerAgentId);
    if (!record) throw new Error(`no handback for ${peerAgentId}`);
    return record;
  }

  function mailStateFor(daemon: Daemon, mailId: string): string {
    const mail = daemon.service.listMail().find((candidate) => candidate.id === mailId);
    return mail?.state ?? "missing";
  }

  /** The handback reached the owner's mailbox and that mail was admitted. */
  function accepted(daemon: Daemon, peerAgentId: string): boolean {
    const record = handbackFor(daemon, peerAgentId);
    return record.state === "delivered" && mailStateFor(daemon, record.mailId) === "accepted";
  }

  async function readHandbackFile(id: string): Promise<SlpHandbackRecord> {
    return JSON.parse(
      await readFile(path.join(paseoHome, "slp", "handbacks", `${id}.json`), "utf8"),
    ) as SlpHandbackRecord;
  }

  test("the Lead's creation becomes a Peer whose handback is registered before it exists", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    // The register must be durable before the agent exists: observe the
    // agent's very first state event and check the register at that moment.
    let registeredAtFirstSight: boolean | null = null;
    const isRegistered = (agentId: string) =>
      daemon.service.listHandbacks().some((record) => record.peerAgentId === agentId);
    const stop = daemon.manager.subscribe(
      (event) => {
        if (event.type !== "agent_state" || event.agent.id === leadId) return;
        registeredAtFirstSight ??= isRegistered(event.agent.id);
      },
      { replayState: false },
    );

    const created = await daemon.createAgent(peerCreation(leadId));
    stop();

    expect(registeredAtFirstSight).toBe(true);
    expect(created.handbackRegistered).toBe(true);
    const peerId = created.snapshot.id;
    const peerRecord = await daemon.storage.get(peerId);
    const prompt = peerRecord?.config?.systemPrompt ?? "";
    expect(prompt.match(/^# Shared SLP instructions$/gm)).toHaveLength(1);
    expect(prompt.match(/^# Peer instructions$/gm)).toHaveLength(1);
    expect(prompt).not.toMatch(/^# (Supervisor|Lead) instructions$/m);
    expect(peerRecord?.labels).toMatchObject({
      [SLP_GROUP_LABEL]: group.id,
      [PARENT_AGENT_ID_LABEL]: leadId,
    });

    const stored = daemon.service.getGroup(group.id)!;
    const peerSlot = Object.values(stored.slots).find((slot) => slot.role === "peer")!;
    expect(peerSlot.ownerSlotId).toBe(group.leadSlotId);
    const generation = peerSlot.generations[0]!;
    expect(generation).toMatchObject({ agentId: peerId, state: "active", number: 1 });
    const handback = handbackFor(daemon, peerId);
    expect(handback).toMatchObject({
      groupId: group.id,
      peerSlotId: peerSlot.id,
      peerGenerationId: generation.id,
      ownerSlotId: group.leadSlotId,
      state: "armed",
      transferInProgress: false,
    });
    expect(await readHandbackFile(handback.id)).toEqual(handback);
    // The Peer's initial prompt started; the Lead's built-in notify-on-finish did not.
    expect(daemon.client.sessions).toHaveLength(2);
    expect(daemon.client.sessions[1]!.startPrompts).toEqual([
      "Find the cause of slow login. Return evidence.",
    ]);
  });

  test("an idle Lead receives the Peer's last message as the handback through admission", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    const created = await daemon.createAgent(peerCreation(leadId));
    const lead = daemon.client.sessions[0]!;
    const peer = daemon.client.sessions[1]!;

    peer.release();
    await untilSettled(() => accepted(daemon, created.snapshot.id), "handback delivered");

    expect(lead.startPrompts).toHaveLength(2);
    const delivered = lead.startPrompts[1]!;
    expect(delivered).toMatch(/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/);
    expect(delivered).toContain(HANDBACK_TEXT);
    expect(delivered).toContain(`Peer: Investigate login latency (${created.snapshot.id})`);
    expect(lead.steerPrompts).toEqual([]);
    expect(lead.interruptCount).toBe(0);
    const handback = handbackFor(daemon, created.snapshot.id);
    expect(handback).toMatchObject({
      state: "delivered",
      outcome: { reason: "finished" },
      mailId: `${handback.id}_handback`,
    });
    expect(await readHandbackFile(handback.id)).toEqual(handback);
    expect(daemon.service.listMail()).toMatchObject([
      { id: handback.mailId, kind: "handback", slotId: group.leadSlotId, state: "accepted" },
    ]);
  });

  test("a busy Lead is never steered or interrupted; handbacks arrive in order after its turn", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    const lead = daemon.client.sessions[0]!;
    lead.steerBehavior = "accepted";

    const first = await daemon.createAgent(peerCreation(leadId));
    const second = await daemon.createAgent(peerCreation(leadId));
    await holdTurn(daemon, leadId);
    // Release in order and let each handback reach the mailbox before the
    // next, so mailbox order is the order under test rather than event timing.
    daemon.client.sessions[1]!.release();
    await untilSettled(
      () => handbackFor(daemon, first.snapshot.id).state === "delivered",
      "first handback queued",
    );
    daemon.client.sessions[2]!.release();
    await untilSettled(
      () => handbackFor(daemon, second.snapshot.id).state === "delivered",
      "second handback queued",
    );
    // Each attempt is durable before admission; a busy answer returns it to queued.
    await untilSettled(() => allMailQueued(daemon), "both handbacks returned to queued");
    expect(lead.steerPrompts).toEqual([]);
    expect(lead.interruptCount).toBe(0);
    expect(lead.startPrompts).toHaveLength(2);

    lead.release();
    await untilSettled(() => accepted(daemon, first.snapshot.id), "first handback admitted");
    expect(lead.startPrompts).toHaveLength(3);
    expect(lead.startPrompts[2]).toContain(`(${first.snapshot.id})`);
    // One message per turn: the second waits for the turn the first started.
    expect(accepted(daemon, second.snapshot.id)).toBe(false);
    lead.release();
    await untilSettled(() => accepted(daemon, second.snapshot.id), "second handback admitted");
    expect(lead.startPrompts).toHaveLength(4);
    expect(lead.startPrompts[3]).toContain(`(${second.snapshot.id})`);
  });

  test("a handback owed across a restart reaches the slot's current owner", async () => {
    const first = await startDaemon();
    const group = await readyGroup(first);
    const leadId = leadAgentId(group);
    const lead = first.client.sessions[0]!;
    // Hold the Lead so the finished Peer's handback stays owed.
    await holdTurn(first, leadId);
    const created = await first.createAgent(peerCreation(leadId));
    first.client.sessions[1]!.release();
    await untilSettled(
      () => handbackFor(first, created.snapshot.id).state === "delivered",
      "handback queued",
    );
    await untilSettled(() => allMailQueued(first), "handback returned to queued");
    expect(lead.steerPrompts).toEqual([]);
    expect(first.service.listMail()).toHaveLength(1);
    // A successor Lead takes over the slot while the daemon is down, the way
    // a same-role handoff will: new generation active, old one retired.
    const successor = await first.manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: WORKSPACE,
    });
    await first.stop();
    const stored = JSON.parse(
      await readFile(path.join(paseoHome, "slp", "groups", `${group.id}.json`), "utf8"),
    ) as SlpGroupRecord;
    const leadSlot = stored.slots[stored.leadSlotId]!;
    const retired = leadSlot.generations[0]!;
    retired.state = "retired";
    leadSlot.generations.push({
      ...retired,
      id: "gen_successor",
      number: 2,
      agentId: successor.id,
      state: "active",
    });
    leadSlot.activeGenerationId = "gen_successor";
    await writeFile(
      path.join(paseoHome, "slp", "groups", `${group.id}.json`),
      JSON.stringify(stored),
    );

    const second = await startDaemon();
    await untilSettled(
      () => accepted(second, created.snapshot.id),
      "handback delivered after restart",
    );
    const resumed = second.client.sessions[0]!;
    expect(second.manager.getAgent(successor.id)).not.toBeNull();
    expect(resumed.startPrompts).toHaveLength(1);
    expect(resumed.startPrompts[0]).toContain(`(${created.snapshot.id})`);
    expect(second.manager.getAgent(leadId)).toBeNull();
    expect(second.service.listMail()[0]).toMatchObject({
      state: "accepted",
      attempt: { agentId: successor.id, generationId: "gen_successor" },
    });
  });

  test("a Peer interrupted by a restart is reported to the owner and still hands back later", async () => {
    const first = await startDaemon();
    const group = await readyGroup(first);
    const leadId = leadAgentId(group);
    const created = await first.createAgent(peerCreation(leadId));
    expect(handbackFor(first, created.snapshot.id).state).toBe("armed");
    await first.stop();

    const second = await startDaemon();
    const noticeAccepted = () => {
      const record = handbackFor(second, created.snapshot.id);
      return (
        record.state === "armed" &&
        record.notice !== null &&
        mailStateFor(second, record.notice.mailId) === "accepted"
      );
    };
    await untilSettled(noticeAccepted, "interruption notice delivered");
    const lead = second.client.sessions[0]!;
    expect(lead.startPrompts).toHaveLength(1);
    expect(lead.startPrompts[0]).toContain("Outcome: interrupted");
    expect(lead.startPrompts[0]).toContain(`(${created.snapshot.id})`);
    expect(second.service.listMail()).toMatchObject([{ kind: "interrupted", state: "accepted" }]);
    lead.release();
    await second.manager.waitForAgentEvent(leadId, { waitForActive: true });

    // The Lead re-drives the Peer; its eventual completion still hands back.
    await ensureAgentLoaded(created.snapshot.id, {
      agentManager: second.manager,
      agentStorage: second.storage,
      logger: createTestLogger(),
    });
    await holdTurn(second, created.snapshot.id);
    const peer = second.client.sessions[1]!;
    peer.release();
    await untilSettled(
      () => accepted(second, created.snapshot.id),
      "handback delivered after re-drive",
    );
    expect(lead.startPrompts).toHaveLength(2);
    expect(lead.startPrompts[1]).toContain(HANDBACK_TEXT);
    expect(handbackFor(second, created.snapshot.id)).toMatchObject({
      state: "delivered",
      outcome: { reason: "finished" },
    });
  });

  test("a Peer may not create agents, and creation by a non-member is unchanged", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const peer = await daemon.createAgent(peerCreation(leadAgentId(group)));
    const before = daemon.manager.listAgents().length;

    await expect(daemon.createAgent(peerCreation(peer.snapshot.id))).rejects.toThrow(
      SlpRoleAuthorityError,
    );
    expect(daemon.manager.listAgents()).toHaveLength(before);
    expect(daemon.service.listHandbacks()).toHaveLength(1);

    const outsider = await daemon.manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: "wks_other",
    });
    const ordinary = await daemon.createAgent(peerCreation(outsider.id));
    expect(ordinary.handbackRegistered).toBe(false);
    expect((await daemon.storage.get(ordinary.snapshot.id))?.config?.systemPrompt).toBeUndefined();
    expect((await daemon.storage.get(ordinary.snapshot.id))?.labels).not.toHaveProperty(
      SLP_GROUP_LABEL,
    );
    expect(daemon.service.listHandbacks()).toHaveLength(1);
  });
});

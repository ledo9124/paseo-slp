import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import {
  slpLeadAgentId as leadAgentId,
  startSlpTestDaemon,
  type SlpTestDaemon as Daemon,
  untilSettled,
} from "../test-utils/slp-test-daemon.js";
import {
  SlpGenerationRetiredError,
  SlpGroupHeldError,
  SlpPreparationPolicyError,
  SlpTransferRefusedError,
} from "./errors.js";
import type { SlpInitializeGroupInput } from "./service.js";
import {
  SlpCheckpointSchema,
  SlpGroupSchema,
  SlpTransferSchema,
  type SlpGroupRecord,
  type SlpSlotRecord,
  type SlpTransferRecord,
} from "./store.js";

const WORKSPACE = "wks_slp_transfer";
const HANDBACK_TEXT = "Peer result: cache miss on session lookup.";
const TransferReceiptSchema = z.object({ transferId: z.string() });
const CheckpointReceiptSchema = z.object({ checkpointId: z.string(), revision: z.number() });

describe("SLP same-role handoff", () => {
  let paseoHome: string;
  let cwd: string;
  const daemons: Daemon[] = [];

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "slp-transfer-"));
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

  async function readyGroup(daemon: Daemon): Promise<SlpGroupRecord> {
    const group = await daemon.service.initializeGroup(input());
    daemon.client.sessions[0]!.release();
    await daemon.manager.waitForAgentEvent(leadAgentId(group), { waitForActive: true });
    return group;
  }

  function peerCreation(
    callerAgentId: string,
    title = "Investigate login latency",
  ): CreateAgentFromMcpInput {
    return {
      kind: "mcp",
      provider: "codex",
      title,
      initialPrompt: "Find the cause of slow login. Return evidence.",
      background: true,
      notifyOnFinish: false,
      callerAgentId,
    };
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

  /** The held-turn session created most recently: the agent the daemon just made. */
  function latestSession(daemon: Daemon) {
    return daemon.client.sessions[daemon.client.sessions.length - 1]!;
  }

  function sessionOf(daemon: Daemon, agentId: string) {
    const agent = daemon.manager.getAgent(agentId);
    const session = daemon.client.sessions.find(
      (candidate) => candidate.id === agent?.persistence?.sessionId,
    );
    if (!session) throw new Error(`no held-turn session for ${agentId}`);
    return session;
  }

  async function holdTurn(daemon: Daemon, agentId: string): Promise<void> {
    const admission = await daemon.manager.admitForegroundTurn(agentId, "Keep going");
    expect(admission.status).toBe("started");
    await daemon.manager.waitForAgentRunStart(agentId);
  }

  function slotOf(daemon: Daemon, groupId: string, slotId: string): SlpSlotRecord {
    const slot = daemon.service.getGroup(groupId)?.slots[slotId];
    if (!slot) throw new Error(`slot ${slotId} missing`);
    return slot;
  }

  function activeAgentId(daemon: Daemon, groupId: string, slotId: string): string {
    const slot = slotOf(daemon, groupId, slotId);
    const active = slot.generations.find((generation) => generation.id === slot.activeGenerationId);
    if (!active) throw new Error(`slot ${slotId} has no active generation`);
    return active.agentId;
  }

  function transfer(daemon: Daemon, id: string): SlpTransferRecord {
    const record = daemon.service.listTransfers().find((candidate) => candidate.id === id);
    if (!record) throw new Error(`transfer ${id} missing`);
    return record;
  }

  function phaseOf(daemon: Daemon, id: string): string {
    return transfer(daemon, id).phase;
  }

  function candidateOf(daemon: Daemon, id: string): string {
    const record = transfer(daemon, id);
    if (!("candidate" in record) || !record.candidate)
      throw new Error(`transfer ${id} has no candidate`);
    return record.candidate.agentId;
  }

  function mailState(daemon: Daemon, mailId: string): string {
    return daemon.service.listMail().find((mail) => mail.id === mailId)?.state ?? "missing";
  }

  function handbackMail(daemon: Daemon) {
    return daemon.service.listMail().filter((mail) => mail.kind === "handback");
  }

  async function readSlpFile<T>(schema: z.ZodType<T>, kind: string, id: string): Promise<T> {
    const file = path.join(paseoHome, "slp", kind, `${id}.json`);
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  }

  async function writeSlpFile(kind: string, id: string, record: unknown): Promise<void> {
    await writeFile(path.join(paseoHome, "slp", kind, `${id}.json`), JSON.stringify(record));
  }

  /**
   * The agent writes its checkpoint and asks for a handoff from inside its
   * own turn, the way the tools are meant to be used, then ends the turn.
   */
  async function requestHandoffFromTurn(
    daemon: Daemon,
    agentId: string,
    objective: string,
  ): Promise<string> {
    const tools = catalogFor(daemon, agentId);
    if (daemon.manager.getAgent(agentId)?.lifecycle !== "running") await holdTurn(daemon, agentId);
    const checkpoint = await tools.executeTool("slp_checkpoint", {
      objective,
      nextAction: "Continue from the evidence gathered so far",
      workDone: "Reproduced the slow path",
    });
    CheckpointReceiptSchema.parse(checkpoint.structuredContent);
    const requested = await tools.executeTool("slp_request_handoff", {
      reason: "context nearly exhausted",
    });
    return TransferReceiptSchema.parse(requested.structuredContent).transferId;
  }

  /** The candidate exists and its preparation turn has started. */
  async function candidateStarted(daemon: Daemon, transferId: string): Promise<string> {
    await untilSettled(() => phaseOf(daemon, transferId) === "preparing", "candidate prepared");
    const candidateId = candidateOf(daemon, transferId);
    await untilSettled(
      () => daemon.manager.getAgent(candidateId)?.lifecycle === "running",
      "candidate preparation turn started",
    );
    return candidateId;
  }

  /** The candidate reads its context and acknowledges from inside its preparation turn. */
  async function acknowledge(daemon: Daemon, candidateId: string): Promise<void> {
    const ready = await catalogFor(daemon, candidateId).executeTool("slp_ready", {});
    TransferReceiptSchema.parse(ready.structuredContent);
    sessionOf(daemon, candidateId).release();
  }

  test("a Lead hands its slot to a fresh generation; Peers, mail and the handback follow the slot", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    const peer = await daemon.createAgent(peerCreation(leadId));
    const peerId = peer.snapshot.id;
    const peerSlot = Object.values(daemon.service.getGroup(group.id)!.slots).find(
      (slot) => slot.role === "peer",
    )!;
    const peerSession = latestSession(daemon);
    const lead = sessionOf(daemon, leadId);

    const transferId = await requestHandoffFromTurn(daemon, leadId, "Make login fast");
    expect(transfer(daemon, transferId)).toMatchObject({
      phase: "requested",
      slotId: group.leadSlotId,
      sourceAgentId: leadId,
      checkpointRevision: 1,
    });
    expect(daemon.service.getGroup(group.id)?.hold).toMatchObject({
      kind: "transfer",
      slotId: group.leadSlotId,
      transferId,
    });
    // The hold is slot-scoped: the Peer's slot still drains while the Lead's is held.
    peerSession.release();
    await daemon.manager.waitForAgentEvent(peerId, { waitForActive: true });
    const toPeer = await daemon.service.deliverMail({
      groupId: group.id,
      slotId: peerSlot.id,
      fromSlotId: group.leadSlotId,
      kind: "message",
      prompt: "Also check the session cache",
    });
    await untilSettled(
      () => mailState(daemon, toPeer.id) === "accepted",
      "peer mail accepted during Lead transfer",
    );
    // The transfer waits for the source to finish its own turn; nothing is interrupted.
    expect(phaseOf(daemon, transferId)).toBe("requested");
    expect(lead.interruptCount).toBe(0);
    lead.release();
    const candidateId = await candidateStarted(daemon, transferId);
    expect(activeAgentId(daemon, group.id, group.leadSlotId)).toBe(leadId);
    expect(lead.interruptCount).toBe(0);

    // Receive-only preparation: the candidate reads its context and may only acknowledge.
    const candidate = sessionOf(daemon, candidateId);
    expect(candidate.startPrompts).toHaveLength(1);
    const context = candidate.startPrompts[0]!;
    expect(context).toContain(`SLP handoff ${transferId}`);
    expect(context).toContain("Objective: Make login fast");
    expect(context).toContain(`slot ${peerSlot.id}: agent ${peerId} (active)`);
    // The tail: what the source's timeline holds after the checkpoint, from the same epoch.
    expect(context).toContain(
      `Source activity after the checkpoint:\n- assistant: ${HANDBACK_TEXT}`,
    );
    const stoppedRecord = transfer(daemon, transferId);
    if (!("stop" in stoppedRecord)) throw new Error("transfer lost its stop record");
    const checkpointFile = await readSlpFile(SlpCheckpointSchema, "checkpoints", group.leadSlotId);
    expect(stoppedRecord.stop.historyTail).toMatchObject({
      from: checkpointFile.timelineCursor,
      omitted: 0,
    });
    expect(stoppedRecord.stop.historyTail.to.seq).toBeGreaterThan(
      checkpointFile.timelineCursor.seq,
    );
    // The provider session sees receive-only policy until the durable switch.
    expect(daemon.service.executionPolicyFor(candidateId)).toMatchObject({ kind: "preparation" });
    expect(daemon.service.executionPolicyFor(leadId)).toEqual({ kind: "authorized" });
    const candidateRecord = await daemon.storage.get(candidateId);
    expect(candidateRecord?.config?.systemPrompt).toContain("- Generation: 2");
    expect(candidateRecord?.config?.systemPrompt).toMatch(/^# Lead instructions$/m);
    const candidateTools = catalogFor(daemon, candidateId);
    expect(candidateTools.getTool("create_agent")).toBeDefined();
    await expect(candidateTools.executeTool("list_agents", {})).rejects.toThrow(
      SlpPreparationPolicyError,
    );
    // A Peer finishing now hands back to the slot; the mail waits for activation.
    sessionOf(daemon, peerId).release();
    await untilSettled(() => handbackMail(daemon).length > 0, "handback queued during transfer");
    expect(handbackMail(daemon)[0]?.state).toBe("queued");

    await acknowledge(daemon, candidateId);
    await untilSettled(() => phaseOf(daemon, transferId) === "completed", "transfer completed");

    const stored = daemon.service.getGroup(group.id)!;
    expect(stored.hold).toBeNull();
    const leadSlot = stored.slots[group.leadSlotId]!;
    expect(leadSlot.generations.map((generation) => [generation.number, generation.state])).toEqual(
      [
        [1, "retired"],
        [2, "active"],
      ],
    );
    expect(activeAgentId(daemon, group.id, group.leadSlotId)).toBe(candidateId);
    expect(daemon.service.executionPolicyFor(candidateId)).toEqual({ kind: "authorized" });
    expect(daemon.manager.getAgent(leadId)).toBeNull();
    expect((await daemon.storage.get(peerId))?.labels[PARENT_AGENT_ID_LABEL]).toBe(candidateId);
    expect(candidateRecord?.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    await expect(
      readSlpFile(SlpCheckpointSchema, "checkpoints", transferId),
    ).resolves.toMatchObject({ kind: "finalized", slotId: group.leadSlotId, revision: 1 });
    // The runtime's activation notice is the successor's first turn after the switch,
    // ahead of the handback that queued during the transfer; then the handback drains
    // to the successor, not the retired source.
    const activation = daemon.service.listMail().find((mail) => mail.kind === "activation");
    expect(activation).toMatchObject({ id: `activation:${transferId}`, slotId: group.leadSlotId });
    await untilSettled(
      () => mailState(daemon, `activation:${transferId}`) === "accepted",
      "activation delivered to successor",
    );
    expect(candidate.startPrompts).toHaveLength(2);
    expect(candidate.startPrompts[1]).toContain(`SLP activation: transfer ${transferId}`);
    expect(candidate.startPrompts[1]).toContain("active generation 2");
    expect(handbackMail(daemon)[0]?.state).toBe("queued");
    candidate.release();
    await untilSettled(
      () => handbackMail(daemon)[0]?.state === "accepted",
      "handback delivered to successor",
    );
    expect(candidate.startPrompts).toHaveLength(3);
    expect(candidate.startPrompts[2]).toContain(HANDBACK_TEXT);
    expect(lead.startPrompts).toHaveLength(2);
    expect(handbackMail(daemon)[0]).toMatchObject({ attempt: { agentId: candidateId } });

    // The retired generation is history: no turn, no tool.
    await ensureAgentLoaded(leadId, {
      agentManager: daemon.manager,
      agentStorage: daemon.storage,
      logger: createTestLogger(),
    });
    await expect(daemon.manager.admitForegroundTurn(leadId, "one more thing")).rejects.toThrow(
      SlpGenerationRetiredError,
    );
    await expect(
      catalogFor(daemon, leadId).executeTool("send_agent_prompt", { agentId: peerId, prompt: "x" }),
    ).rejects.toThrow(SlpGenerationRetiredError);
  });

  test("a Peer hands off: its Lead keeps working, the old handback is superseded and the new one fires", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    const created = await daemon.createAgent(peerCreation(leadId));
    const peerId = created.snapshot.id;
    const peerSlotId = Object.values(daemon.service.getGroup(group.id)!.slots).find(
      (slot) => slot.role === "peer",
    )!.id;
    const lead = sessionOf(daemon, leadId);

    // Requested from inside the Peer's first turn; ending that turn is a stop, not a handback.
    const transferId = await requestHandoffFromTurn(daemon, peerId, "Prove the cache theory");
    sessionOf(daemon, peerId).release();
    // The Lead's slot is not held by a Peer transfer.
    const toLead = await daemon.service.deliverMail({
      groupId: group.id,
      slotId: group.leadSlotId,
      fromSlotId: null,
      kind: "message",
      prompt: "Status?",
    });
    await untilSettled(
      () => mailState(daemon, toLead.id) === "accepted",
      "lead mail accepted during Peer transfer",
    );
    const successorId = await candidateStarted(daemon, transferId);
    expect((await daemon.storage.get(successorId))?.labels[PARENT_AGENT_ID_LABEL]).toBe(leadId);
    await acknowledge(daemon, successorId);
    await untilSettled(() => phaseOf(daemon, transferId) === "completed", "transfer completed");

    const handbacks = daemon.service.listHandbacks();
    expect(handbacks.find((record) => record.peerAgentId === peerId)).toMatchObject({
      state: "superseded",
      transferId,
    });
    expect(handbacks.find((record) => record.peerAgentId === successorId)).toMatchObject({
      state: "armed",
      peerSlotId,
      ownerSlotId: group.leadSlotId,
    });
    expect(handbackMail(daemon)).toEqual([]);

    // The successor's turn ends: exactly one handback, from the new generation.
    lead.release();
    const successor = sessionOf(daemon, successorId);
    await holdTurn(daemon, successorId);
    successor.release();
    await untilSettled(
      () => handbackMail(daemon)[0]?.state === "accepted",
      "successor handback delivered",
    );
    expect(handbackMail(daemon)).toHaveLength(1);
    expect(lead.startPrompts.at(-1)).toContain(`(${successorId})`);
  });

  test("handoff needs a checkpoint, refuses an archived source, and holds archive once requested", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    const created = await daemon.createAgent(peerCreation(leadId));
    const peerId = created.snapshot.id;

    await expect(daemon.service.requestHandoff(leadId, "no checkpoint yet")).rejects.toThrow(
      SlpTransferRefusedError,
    );
    // Archive-first: the Peer checkpointed, then was archived before asking for its handoff.
    await catalogFor(daemon, peerId).executeTool("slp_checkpoint", {
      objective: "x",
      nextAction: "y",
    });
    await daemon.manager.archiveAgent(peerId);
    await expect(daemon.service.requestHandoff(peerId, "too late")).rejects.toThrow(
      SlpTransferRefusedError,
    );
    // The archive reached the Lead as a closed-Peer handback; let that turn end.
    await untilSettled(() => handbackMail(daemon)[0]?.state === "accepted", "closed handback");
    sessionOf(daemon, leadId).release();
    await daemon.manager.waitForAgentEvent(leadId, { waitForActive: true });

    const transferId = await requestHandoffFromTurn(daemon, leadId, "Make login fast");
    // Transfer-first: nothing in the group can be archived while the slot moves.
    await expect(daemon.manager.archiveAgent(leadId)).rejects.toThrow(SlpGroupHeldError);
    sessionOf(daemon, leadId).release();
    const candidateId = await candidateStarted(daemon, transferId);
    await expect(daemon.manager.archiveAgent(candidateId)).rejects.toThrow(SlpGroupHeldError);
    expect((await daemon.storage.get(leadId))?.archivedAt).toBeUndefined();
  });

  test("a restart before the switch restores the source; after the switch it rolls forward", async () => {
    const first = await startDaemon();
    const group = await readyGroup(first);
    const leadId = leadAgentId(group);
    const created = await first.createAgent(peerCreation(leadId));
    const peerId = created.snapshot.id;
    latestSession(first).release();
    await first.manager.waitForAgentEvent(peerId, { waitForActive: true });

    const transferId = await requestHandoffFromTurn(first, leadId, "Make login fast");
    sessionOf(first, leadId).release();
    const candidateId = await candidateStarted(first, transferId);
    await first.stop();

    const second = await startDaemon();
    expect(transfer(second, transferId)).toMatchObject({ phase: "aborted" });
    const restored = second.service.getGroup(group.id)!;
    expect(restored.status).toBe("ready");
    expect(restored.hold).toBeNull();
    expect(activeAgentId(second, group.id, group.leadSlotId)).toBe(leadId);
    expect(
      restored.slots[group.leadSlotId]!.generations.find((g) => g.agentId === candidateId)?.state,
    ).toBe("retired");
    expect((await second.storage.get(candidateId))?.archivedAt).toEqual(expect.any(String));
    expect((await second.storage.get(peerId))?.labels[PARENT_AGENT_ID_LABEL]).toBe(leadId);
    // The source works again and can hand off later, from a checkpoint written
    // in this daemon's timeline epoch: the old one anchors no tail any more.
    await ensureAgentLoaded(leadId, {
      agentManager: second.manager,
      agentStorage: second.storage,
      logger: createTestLogger(),
    });
    await expect(second.service.requestHandoff(leadId, "stale checkpoint")).rejects.toThrow(
      /write a new checkpoint/,
    );
    const again = await requestHandoffFromTurn(second, leadId, "Second attempt");
    sessionOf(second, leadId).release();
    const successorId = await candidateStarted(second, again);
    await acknowledge(second, successorId);
    await untilSettled(() => phaseOf(second, again) === "completed", "second transfer completed");
    expect((await second.storage.get(peerId))?.labels[PARENT_AGENT_ID_LABEL]).toBe(successorId);
    // Seed the after-switch crash: the pointer moved, the Peer still points at the old parent.
    await second.manager.updateAgentMetadata(peerId, {
      labels: { [PARENT_AGENT_ID_LABEL]: leadId },
    });
    await second.stop();
    const storedGroup = await readSlpFile(SlpGroupSchema, "groups", group.id);
    const hold = {
      kind: "transfer",
      slotId: group.leadSlotId,
      transferId: again,
      since: storedGroup.updatedAt,
    } as const;
    await writeSlpFile("groups", group.id, { ...storedGroup, hold });
    const storedTransfer = await readSlpFile(SlpTransferSchema, "transfers", again);
    if (storedTransfer.phase !== "completed") throw new Error("transfer did not complete");
    const { completedAt: _, ...switched } = storedTransfer;
    await writeSlpFile("transfers", again, { ...switched, phase: "switched" });
    const third = await startDaemon();
    await untilSettled(() => phaseOf(third, again) === "completed", "rolled forward");
    expect(third.service.getGroup(group.id)?.hold).toBeNull();
    expect(activeAgentId(third, group.id, group.leadSlotId)).toBe(successorId);
    expect((await third.storage.get(peerId))?.labels[PARENT_AGENT_ID_LABEL]).toBe(successorId);
  });

  test("a transfer matching neither generation freezes only its group", async () => {
    const first = await startDaemon();
    const group = await readyGroup(first);
    const leadId = leadAgentId(group);
    const transferId = await requestHandoffFromTurn(first, leadId, "x");
    sessionOf(first, leadId).release();
    await candidateStarted(first, transferId);
    await first.stop();
    const stored = await readSlpFile(SlpTransferSchema, "transfers", transferId);
    await writeSlpFile("transfers", transferId, { ...stored, sourceGenerationId: "gen_elsewhere" });

    const second = await startDaemon();
    const frozen = second.service.getGroup(group.id)!;
    expect(frozen.status).toBe("frozen");
    expect(frozen.freeze?.reason).toContain("matches neither");
    await expect(second.manager.archiveSnapshot(leadId, new Date().toISOString())).rejects.toThrow(
      SlpGroupHeldError,
    );
  });
});

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
  SlpDecisionConflictError,
  SlpNotDecidingSupervisorError,
  SlpPreparationPolicyError,
  SlpSourceSuspendedError,
  SlpTransferRefusedError,
} from "./errors.js";
import type { SlpInitializeGroupInput } from "./service.js";
import {
  SlpCheckpointSchema,
  SlpGroupSchema,
  SlpMailSchema,
  SlpTransferSchema,
  type SlpGroupRecord,
  type SlpSlotRecord,
  type SlpTransferRecord,
} from "./store.js";

const WORKSPACE = "wks_slp_transfer";
const HANDBACK_TEXT = "Peer result: cache miss on session lookup.";
const TransferReceiptSchema = z.object({ transferId: z.string() });

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

  function transferFile(id: string): string {
    return path.join(paseoHome, "slp", "transfers", `${id}.json`);
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
    expect(tools.getTool("slp_checkpoint")).toBeUndefined();
    const requested = await tools.executeTool("slp_request_handoff", {
      reason: "context nearly exhausted",
      context: {
        objective,
        nextAction: "Continue from the evidence gathered so far",
        workDone: "Reproduced the slow path",
      },
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
    const retry = await daemon.service.requestHandoff(leadId, "retry", {
      objective: "must not overwrite",
      nextAction: "none",
    });
    expect(retry).toEqual({ transferId });
    expect(
      (await readSlpFile(SlpCheckpointSchema, "checkpoints", group.leadSlotId)).content.objective,
    ).toBe("Make login fast");
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
    expect(activation).toMatchObject({ id: `activation_${transferId}`, slotId: group.leadSlotId });
    await untilSettled(
      () => mailState(daemon, `activation_${transferId}`) === "accepted",
      "activation delivered to successor",
    );
    expect(candidate.startPrompts).toHaveLength(2);
    expect(candidate.startPrompts[1]).toContain(`SLP activation: transfer ${transferId}`);
    expect(candidate.startPrompts[1]).toContain("active generation 2");
    // Undelivered, which is the claim; not `queued` exactly. The dispatch
    // loop moves straight on to the handback and a busy successor returns it,
    // so it passes through `dispatching` on the way back to the queue.
    expect(handbackMail(daemon)[0]?.state).not.toBe("accepted");
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
    const resumesBefore = daemon.client.resumedPurposes.length;
    await ensureAgentLoaded(leadId, {
      agentManager: daemon.manager,
      agentStorage: daemon.storage,
      logger: createTestLogger(),
    });
    // Loading it must not bring it back as a writable session. Retirement
    // closes the agent but never archives it, and resume reads `archivedAt`
    // alone, so without the retirement check this call revived a handed-off
    // Lead beside its own successor and nothing downstream could tell them
    // apart.
    expect(daemon.client.resumedPurposes.slice(resumesBefore)).toEqual(["history"]);
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

  test("a supervised Lead handoff stops for Supervisor and creates no candidate", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(daemon, group.id, group.supervisorSlotId!);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const leadId = leadAgentId(group);
    const generationsBefore = slotOf(daemon, group.id, group.leadSlotId).generations.length;

    const transferId = await requestHandoffFromTurn(daemon, leadId, "Next task");
    sessionOf(daemon, leadId).release();
    await untilSettled(
      () => phaseOf(daemon, transferId) === "awaiting_supervisor",
      "the transfer waits for the Supervisor",
    );

    const record = transfer(daemon, transferId);
    expect(record).toMatchObject({ control: "supervisor", phase: "awaiting_supervisor" });
    expect(record).not.toHaveProperty("candidate");
    // The runtime owns candidate creation and has not been told to create one.
    expect(slotOf(daemon, group.id, group.leadSlotId).generations).toHaveLength(generationsBefore);
    expect(activeAgentId(daemon, group.id, group.leadSlotId)).toBe(leadId);
    expect(daemon.service.getGroup(group.id)?.hold).toMatchObject({ kind: "transfer", transferId });
    expect(await readSlpFile(SlpTransferSchema, "transfers", transferId)).toMatchObject({
      phase: "awaiting_supervisor",
      control: "supervisor",
    });

    // The source keeps the slot but may not start product work on it.
    await expect(daemon.manager.admitForegroundTurn(leadId, "More work")).rejects.toThrow(
      SlpSourceSuspendedError,
    );
  });

  /** A supervised group whose Lead has asked for a handoff and stopped. */
  async function awaitingDecision(daemon: Daemon): Promise<{
    group: SlpGroupRecord;
    supervisorId: string;
    leadId: string;
    transferId: string;
  }> {
    const group = await daemon.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(daemon, group.id, group.supervisorSlotId!);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const leadId = leadAgentId(group);
    const transferId = await requestHandoffFromTurn(daemon, leadId, "Next task");
    sessionOf(daemon, leadId).release();
    await untilSettled(
      () => phaseOf(daemon, transferId) === "awaiting_supervisor",
      "the transfer waits for the Supervisor",
    );
    await untilSettled(
      () => mailState(daemon, `handoff_waiting_${transferId}`) === "accepted",
      "the Supervisor was told a decision is waiting",
    );
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    return { group, supervisorId, leadId, transferId };
  }

  function decide(daemon: Daemon, agentId: string, args: Record<string, unknown>) {
    return catalogFor(daemon, agentId).executeTool("slp_decide_lead_handoff", args);
  }

  test("the Supervisor is told a decision is waiting, and only it can make one", async () => {
    const daemon = await startDaemon();
    const { group, supervisorId, leadId, transferId } = await awaitingDecision(daemon);

    const notice = sessionOf(daemon, supervisorId).startPrompts.at(-1) ?? "";
    expect(notice).toContain("SLP runtime control event");
    expect(notice).toContain(transferId);
    expect(notice).toContain("slp_decide_lead_handoff");
    expect(notice).toContain("No successor exists yet");
    expect(notice).toContain("not an engineering judgement");

    // The catalog hides it from every role but the Supervisor, and the
    // execution check refuses a caller that asserts an identity anyway.
    expect(catalogFor(daemon, leadId).getTool("slp_decide_lead_handoff")).toBeUndefined();
    expect(catalogFor(daemon, supervisorId).getTool("slp_decide_lead_handoff")).toBeDefined();
    await expect(daemon.service.decideLeadHandoff(leadId, transferId, "continue")).rejects.toThrow(
      SlpNotDecidingSupervisorError,
    );
    expect(phaseOf(daemon, transferId)).toBe("awaiting_supervisor");
    expect(slotOf(daemon, group.id, group.leadSlotId).generations).toHaveLength(1);
  });

  test("continue builds exactly one candidate and completes the replacement", async () => {
    const daemon = await startDaemon();
    const { group, supervisorId, leadId, transferId } = await awaitingDecision(daemon);

    await decide(daemon, supervisorId, { transferId, decision: "continue" });
    const candidateId = await candidateStarted(daemon, transferId);
    // Receive-only until it says it is ready and the pointer moves.
    expect(daemon.service.executionPolicyFor(candidateId)).toMatchObject({ kind: "preparation" });
    await acknowledge(daemon, candidateId);
    await untilSettled(() => phaseOf(daemon, transferId) === "completed", "transfer completed");

    expect(transfer(daemon, transferId)).toMatchObject({
      control: "supervisor",
      decision: { outcome: "continue", actorAgentId: supervisorId },
    });
    expect(slotOf(daemon, group.id, group.leadSlotId).generations).toHaveLength(2);
    expect(activeAgentId(daemon, group.id, group.leadSlotId)).toBe(candidateId);
    expect(daemon.service.executionPolicyFor(candidateId)).toEqual({ kind: "authorized" });
    expect(daemon.service.getGroup(group.id)?.hold).toBeNull();
    // The coverage the decision boundary displaced: completion still tells the
    // Supervisor its Lead was replaced.
    await untilSettled(
      () => mailState(daemon, `handoff_completed_${transferId}`) === "accepted",
      "Supervisor notified of the completed handoff",
    );
    expect(sessionOf(daemon, supervisorId).startPrompts.at(-1)).toContain(candidateId);
    expect(daemon.manager.getAgent(leadId)).toBeNull();
  });

  test("cancel builds no candidate, wakes the source and gives it back its slot", async () => {
    const daemon = await startDaemon();
    const { group, supervisorId, leadId, transferId } = await awaitingDecision(daemon);
    // Mail that queued while the slot was held. The source cannot read it
    // sensibly until it knows it is still the Lead, so the cancellation notice
    // has to reach it first even though this was queued earlier.
    const queuedFirst = await daemon.service.deliverMail({
      groupId: group.id,
      slotId: group.leadSlotId,
      fromSlotId: group.supervisorSlotId,
      kind: "message",
      prompt: "While you were stopped: Human asked for a status update.",
    });

    await decide(daemon, supervisorId, {
      transferId,
      decision: "cancel",
      reason: "the current context is fine for the next task",
    });

    expect(phaseOf(daemon, transferId)).toBe("canceled");
    expect(transfer(daemon, transferId)).toMatchObject({
      decision: { outcome: "cancel", reason: "the current context is fine for the next task" },
    });
    expect(slotOf(daemon, group.id, group.leadSlotId).generations).toHaveLength(1);
    expect(activeAgentId(daemon, group.id, group.leadSlotId)).toBe(leadId);
    expect(daemon.service.getGroup(group.id)?.hold).toBeNull();

    await untilSettled(
      () => mailState(daemon, `handoff_canceled_${transferId}`) === "accepted",
      "the source was told its handoff was canceled",
    );
    const woken = sessionOf(daemon, leadId).startPrompts.at(-1) ?? "";
    expect(woken).toContain("canceled by the Supervisor");
    expect(woken).toContain("the current context is fine for the next task");
    expect(woken).toContain("still the active Lead");
    expect(mailState(daemon, queuedFirst.id)).toBe("queued");

    // Only then does what queued during the hold arrive, and the source works again.
    sessionOf(daemon, leadId).release();
    await untilSettled(
      () => mailState(daemon, queuedFirst.id) === "accepted",
      "the message that queued during the hold followed the notice",
    );
    expect(sessionOf(daemon, leadId).startPrompts.at(-1)).toContain("Human asked for a status");
    sessionOf(daemon, leadId).release();
    await daemon.manager.waitForAgentEvent(leadId, { waitForActive: true });
    expect((await daemon.manager.admitForegroundTurn(leadId, "Back to work")).status).toBe(
      "started",
    );
  });

  test("a cancel needs no reason, and repeating a decision changes nothing", async () => {
    const daemon = await startDaemon();
    const { supervisorId, transferId } = await awaitingDecision(daemon);

    const first = await decide(daemon, supervisorId, { transferId, decision: "cancel" });
    const canceled = transfer(daemon, transferId);
    const again = await decide(daemon, supervisorId, { transferId, decision: "cancel" });

    expect(first.structuredContent).toEqual(again.structuredContent);
    expect(transfer(daemon, transferId)).toEqual(canceled);
    expect(daemon.service.listMail().filter((mail) => mail.kind === "control")).toHaveLength(1);

    // The other answer, after the fact, is a conflict rather than a second outcome.
    await expect(
      daemon.service.decideLeadHandoff(supervisorId, transferId, "continue"),
    ).rejects.toThrow(SlpDecisionConflictError);
    expect(phaseOf(daemon, transferId)).toBe("canceled");
  });

  test("a pending decision survives the handoff feature being turned off", async () => {
    let handoffEnabled = true;
    const daemon = await startSlpTestDaemon({
      paseoHome,
      releaseText: "done",
      isHandoffEnabled: () => handoffEnabled,
    });
    daemons.push(daemon);
    const { supervisorId, leadId, transferId } = await awaitingDecision(daemon);

    handoffEnabled = false;
    // The Lead can no longer start one; the Supervisor can still end the one
    // it was already asked about.
    expect(daemon.service.isToolAllowed(leadId, "slp_request_handoff")).toBe(false);
    expect(daemon.service.isToolAllowed(supervisorId, "slp_decide_lead_handoff")).toBe(true);
    await decide(daemon, supervisorId, { transferId, decision: "cancel" });
    expect(phaseOf(daemon, transferId)).toBe("canceled");
    expect(daemon.service.isToolAllowed(supervisorId, "slp_decide_lead_handoff")).toBe(false);
  });

  test("a pending decision survives a restart, still without a candidate", async () => {
    const first = await startDaemon();
    const { group, leadId, transferId } = await awaitingDecision(first);
    await first.stop();

    const second = await startDaemon();
    expect(phaseOf(second, transferId)).toBe("awaiting_supervisor");
    expect(transfer(second, transferId)).not.toHaveProperty("candidate");
    expect(slotOf(second, group.id, group.leadSlotId).generations).toHaveLength(1);
    expect(second.service.getGroup(group.id)?.hold).toMatchObject({ transferId });
    // The suspension follows the journal, so it is back without being stored.
    await ensureAgentLoaded(leadId, {
      agentManager: second.manager,
      agentStorage: second.storage,
      logger: createTestLogger(),
    });
    await expect(second.manager.admitForegroundTurn(leadId, "More work")).rejects.toThrow(
      SlpSourceSuspendedError,
    );
  });

  test("a decision taken before the crash is carried out after it", async () => {
    const first = await startDaemon();
    const { group, transferId } = await awaitingDecision(first);
    const pending = await readSlpFile(SlpTransferSchema, "transfers", transferId);
    await first.stop();
    // Seed the crash between persisting the decision and creating anything:
    // the daemon died knowing the answer and having done nothing about it.
    await writeSlpFile("transfers", transferId, {
      ...pending,
      phase: "continued",
      decision: {
        outcome: "continue",
        actorAgentId: "agt_supervisor",
        actorGenerationId: "gen_supervisor",
        decidedAt: new Date().toISOString(),
      },
    });

    const second = await startDaemon();
    const candidateId = await candidateStarted(second, transferId);
    await acknowledge(second, candidateId);
    await untilSettled(() => phaseOf(second, transferId) === "completed", "transfer completed");
    expect(transfer(second, transferId)).toMatchObject({ decision: { outcome: "continue" } });
    expect(activeAgentId(second, group.id, group.leadSlotId)).toBe(candidateId);
  });

  test("a cancellation interrupted before its cleanup finishes once", async () => {
    const first = await startDaemon();
    const { group, leadId, transferId } = await awaitingDecision(first);
    // Seed the crash after the decision is durable and before the notice is:
    // the point the ordering exists to make recoverable.
    const pending = await readSlpFile(SlpTransferSchema, "transfers", transferId);
    await first.stop();
    await writeSlpFile("transfers", transferId, {
      ...pending,
      phase: "canceling",
      decision: {
        outcome: "cancel",
        actorAgentId: "agt_supervisor",
        actorGenerationId: "gen_supervisor",
        decidedAt: new Date().toISOString(),
        reason: "decided before the crash",
      },
    });

    const second = await startDaemon();
    await untilSettled(() => phaseOf(second, transferId) === "canceled", "cancellation finished");
    expect(second.service.getGroup(group.id)?.hold).toBeNull();
    expect(activeAgentId(second, group.id, group.leadSlotId)).toBe(leadId);
    await untilSettled(
      () => mailState(second, `handoff_canceled_${transferId}`) === "accepted",
      "the source was told after the restart",
    );
    expect(sessionOf(second, leadId).startPrompts.at(-1)).toContain("decided before the crash");
    expect(second.service.listMail().filter((mail) => mail.kind === "control")).toHaveLength(1);
  });

  test("a cancellation whose hold outlived it is finished, not frozen", async () => {
    const first = await startDaemon();
    const { group, supervisorId, transferId } = await awaitingDecision(first);
    await decide(first, supervisorId, { transferId, decision: "cancel" });
    const canceled = await readSlpFile(SlpTransferSchema, "transfers", transferId);
    const storedGroup = await readSlpFile(SlpGroupSchema, "groups", group.id);
    await first.stop();
    // Seed the crash between the terminal record and clearing the hold.
    await writeSlpFile("groups", group.id, {
      ...storedGroup,
      hold: {
        kind: "transfer",
        slotId: group.leadSlotId,
        transferId,
        since: storedGroup.updatedAt,
      },
    });

    const second = await startDaemon();
    expect(second.service.getGroup(group.id)?.status).toBe("ready");
    expect(second.service.getGroup(group.id)?.hold).toBeNull();
    expect(transfer(second, transferId)).toEqual(canceled);
  });

  test("a notice the daemon died delivering is replaced by one marked as possibly duplicate", async () => {
    const first = await startDaemon();
    const group = await first.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(first, group.id, group.supervisorSlotId!);
    sessionOf(first, supervisorId).release();
    await first.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const leadId = leadAgentId(group);
    const transferId = await requestHandoffFromTurn(first, leadId, "Next task");
    sessionOf(first, leadId).release();
    await untilSettled(
      () => phaseOf(first, transferId) === "awaiting_supervisor",
      "the transfer waits for the Supervisor",
    );
    const primary = `handoff_waiting_${transferId}`;
    await untilSettled(() => mailState(first, primary) === "accepted", "the notice was delivered");
    const delivery = await readSlpFile(SlpMailSchema, "mail", primary);
    if (delivery.state !== "accepted") throw new Error(`notice is ${delivery.state}`);
    await first.stop();
    // The daemon died mid-dispatch: acceptance can be neither proven nor
    // disproven, and the mailbox never replays such a record.
    const { acceptedAt: _acceptedAt, ...attempted } = delivery;
    await writeSlpFile("mail", primary, { ...attempted, state: "dispatching" });

    const second = await startDaemon();
    expect(mailState(second, primary)).toBe("uncertain");
    const retryId = `handoff_waiting_recovery_${transferId}_1`;
    await untilSettled(() => mailState(second, retryId) === "accepted", "a fresh notice arrived");
    const delivered =
      sessionOf(second, activeAgentId(second, group.id, group.supervisorSlotId!)).startPrompts.at(
        -1,
      ) ?? "";
    expect(delivered).toContain("may be a duplicate");
    expect(delivered).toContain("deciding twice is safe");
    expect(delivered).toContain(transferId);
    // The uncertain record is retained exactly as recovery found it.
    expect(await readSlpFile(SlpMailSchema, "mail", primary)).toMatchObject({
      state: "uncertain",
      reason: "daemon restarted during dispatch",
    });
  });

  test("a transfer whose group never recorded its hold is rolled back", async () => {
    const first = await startDaemon();
    const group = await readyGroup(first);
    const leadId = leadAgentId(group);
    const transferId = await requestHandoffFromTurn(first, leadId, "Make login fast");
    sessionOf(first, leadId).release();
    await untilSettled(() => phaseOf(first, transferId) !== "requested", "the source stopped");
    const storedGroup = await readSlpFile(SlpGroupSchema, "groups", group.id);
    await first.stop();
    // The record is persisted before the hold, so a crash in between leaves a
    // transfer nothing points at and no runner owns.
    await writeSlpFile("groups", group.id, { ...storedGroup, hold: null });

    const second = await startDaemon();
    await untilSettled(
      () => phaseOf(second, transferId) === "aborted",
      "the orphan was rolled back",
    );
    expect(second.service.getGroup(group.id)?.status).toBe("ready");
    expect(activeAgentId(second, group.id, group.leadSlotId)).toBe(leadId);
  });

  test("a transfer phase this build cannot read freezes its group and is left alone", async () => {
    const first = await startDaemon();
    const { group, leadId, transferId } = await awaitingDecision(first);
    const other = await first.service.initializeGroup({
      ...input(),
      workspaceId: "wks_slp_other",
      mode: "direct",
    });
    latestSession(first).release();
    await first.manager.waitForAgentEvent(leadAgentId(other), { waitForActive: true });
    await first.stop();

    // What a downgrade looks like from the journal's side: a phase the
    // reader has no variant for. The schema is a closed union, so the record
    // does not parse, and this is the same shape as an older build meeting
    // the phases this one added (see store.test.ts for that half).
    const stored = await readSlpFile(SlpTransferSchema, "transfers", transferId);
    const unreadable = { ...stored, phase: "decided_by_human" };
    await writeSlpFile("transfers", transferId, unreadable);

    const second = await startDaemon();

    // Fails closed: held, visibly broken, and nothing was invented.
    const frozen = second.service.getGroup(group.id)!;
    expect(frozen.status).toBe("frozen");
    expect(frozen.freeze?.reason).toContain(transferId);
    expect(frozen.hold).toMatchObject({ kind: "transfer", transferId });
    expect(slotOf(second, group.id, group.leadSlotId).generations).toHaveLength(1);
    expect(activeAgentId(second, group.id, group.leadSlotId)).toBe(leadId);
    expect(second.service.listTransfers().find((entry) => entry.id === transferId)).toBeUndefined();

    // The journal is not rewritten by a build that cannot read it: the
    // runbook says restore the newer build, not repair the file by hand.
    expect(JSON.parse(await readFile(transferFile(transferId), "utf8"))).toEqual(unreadable);

    // Only that group. The other workspace is untouched.
    expect(second.service.getGroup(other.id)?.status).toBe("ready");
  });

  test("a supervised Peer handoff stays automatic", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(daemon, group.id, group.supervisorSlotId!);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const leadId = leadAgentId(group);
    const created = await daemon.createAgent(peerCreation(leadId));
    const peerId = created.snapshot.id;
    latestSession(daemon).release();
    await daemon.manager.waitForAgentEvent(peerId, { waitForActive: true });

    // Only the Lead slot answers to the Supervisor; a Peer replacement is the
    // Lead's own topology and runs to completion on its own.
    const transferId = await requestHandoffFromTurn(daemon, peerId, "Keep digging");
    sessionOf(daemon, peerId).release();
    const candidateId = await candidateStarted(daemon, transferId);
    await acknowledge(daemon, candidateId);
    await untilSettled(
      () => phaseOf(daemon, transferId) === "completed",
      "peer transfer completed",
    );
    expect(transfer(daemon, transferId)).toMatchObject({ control: "automatic" });
  });

  test("a Supervisor self-handoff stays automatic", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(daemon, group.id, group.supervisorSlotId!);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });

    // The boundary exists so the Supervisor can decide when the Lead's context
    // is replaced. It has no one to ask about its own.
    const transferId = await requestHandoffFromTurn(daemon, supervisorId, "Fresh context");
    sessionOf(daemon, supervisorId).release();
    const candidateId = await candidateStarted(daemon, transferId);
    await acknowledge(daemon, candidateId);
    await untilSettled(
      () => phaseOf(daemon, transferId) === "completed",
      "supervisor transfer completed",
    );
    expect(transfer(daemon, transferId)).toMatchObject({ control: "automatic" });
    expect(activeAgentId(daemon, group.id, group.supervisorSlotId!)).toBe(candidateId);
  });

  test("a transfer record written without a control mode stays automatic", async () => {
    const first = await startDaemon();
    const group = await first.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(first, group.id, group.supervisorSlotId!);
    sessionOf(first, supervisorId).release();
    await first.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const leadId = leadAgentId(group);
    const transferId = await requestHandoffFromTurn(first, leadId, "Next task");
    sessionOf(first, leadId).release();
    await untilSettled(
      () => phaseOf(first, transferId) === "awaiting_supervisor",
      "the transfer waits for the Supervisor",
    );
    await first.stop();

    // A record from a daemon that predates this contract carries no control
    // mode. Recovery reads it as automatic and applies the v1 rollback, rather
    // than inferring the new pipeline from the group's mode.
    const stored = await readSlpFile(SlpTransferSchema, "transfers", transferId);
    const { control: _control, phase: _phase, ...legacy } = stored;
    await writeSlpFile("transfers", transferId, { ...legacy, phase: "stopped" });

    const second = await startDaemon();
    await untilSettled(
      () => phaseOf(second, transferId) === "aborted",
      "legacy record rolled back",
    );
    expect(second.service.getGroup(group.id)?.hold).toBeNull();
    expect(activeAgentId(second, group.id, group.leadSlotId)).toBe(leadId);
  });

  test("a second handoff request returns the pending transfer and its checkpoint", async () => {
    const daemon = await startDaemon();
    const group = await daemon.service.initializeGroup({ ...input(), mode: "supervised" });
    const supervisorId = activeAgentId(daemon, group.id, group.supervisorSlotId!);
    sessionOf(daemon, supervisorId).release();
    await daemon.manager.waitForAgentEvent(supervisorId, { waitForActive: true });
    const leadId = leadAgentId(group);

    const transferId = await requestHandoffFromTurn(daemon, leadId, "First objective");
    const checkpoint = await readSlpFile(SlpCheckpointSchema, "checkpoints", group.leadSlotId);
    const again = await catalogFor(daemon, leadId).executeTool("slp_request_handoff", {
      reason: "asked twice",
      context: { objective: "Second objective", nextAction: "Something else entirely" },
    });
    sessionOf(daemon, leadId).release();
    await untilSettled(
      () => phaseOf(daemon, transferId) === "awaiting_supervisor",
      "the transfer waits for the Supervisor",
    );

    expect(TransferReceiptSchema.parse(again.structuredContent).transferId).toBe(transferId);
    expect(daemon.service.listTransfers()).toHaveLength(1);
    // The retry does not overwrite the context the successor will be given.
    expect(await readSlpFile(SlpCheckpointSchema, "checkpoints", group.leadSlotId)).toEqual(
      checkpoint,
    );
  });

  test("handoff refuses an archived source and holds archive once requested", async () => {
    const daemon = await startDaemon();
    const group = await readyGroup(daemon);
    const leadId = leadAgentId(group);
    const created = await daemon.createAgent(peerCreation(leadId));
    const peerId = created.snapshot.id;

    await daemon.manager.archiveAgent(peerId);
    await expect(
      daemon.service.requestHandoff(peerId, "too late", { objective: "x", nextAction: "y" }),
    ).rejects.toThrow(SlpTransferRefusedError);
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

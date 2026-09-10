/**
 * Live evidence for SLP preparation policy (probe P7), the daemon history
 * tail (P8, daemon half) and restart recovery (gate 8) on a real provider.
 * Three modes:
 *
 * - `session`: one raw provider session launched with a preparation resolver
 *   is asked to write, then the resolver lifts and it is asked again. Proves
 *   the adapter gate on its own, independent of what an SLP candidate chooses.
 * - `group`: an isolated daemon, one SLP group, an explicit handoff; the
 *   candidate's preparation turn carries a checkpoint that asks it to write.
 *   Proves the whole path: hold, candidate policy, switch, restored policy.
 * - `restart`: the daemon stops while a transfer is preparing and a second
 *   daemon boots from the same home. Proves the abort, the restored source,
 *   the stale-checkpoint refusal and a full handoff from the resumed source.
 *
 *   npx tsx scripts/slp-preparation-probe.ts <claude|codex> <session|group|restart> [model]
 *
 * Output goes to a fresh directory under the working directory; keep it as
 * the artifact. Needs a logged-in provider; never points at ~/.paseo.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import { ensureAgentLoaded } from "../src/server/agent/agent-loading.js";
import type {
  AgentExecutionPolicy,
  AgentSessionConfig,
} from "../src/server/agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../src/server/agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../src/server/agent/providers/codex-app-server-agent.js";
import { createPaseoToolCatalog } from "../src/server/agent/tools/paseo-tools.js";
import { createPaseoDaemon } from "../src/server/bootstrap.js";
import { SlpTransferRefusedError } from "../src/server/slp/errors.js";
import type { SlpTransferRecord } from "../src/server/slp/store.js";
import { createProviderSnapshotManagerStub } from "../src/server/test-utils/session-stubs.js";

type Provider = "claude" | "codex";
type Mode = "session" | "group" | "restart" | "identity";

const WRITE_ATTEMPTS =
  "Do exactly this, once each, and do not retry: (1) run the shell command `touch PROBE_SHELL.txt`; (2) create PROBE_FILE.txt containing hello with your file-writing tool. For each, report verbatim whether it succeeded or the exact error or denial text.";
const CONTROL_TOOL_AFTER_ACTIVATION =
  "Call the slp_checkpoint tool with objective 'probe after activation' and nextAction 'none', report verbatim whether it succeeded or the exact error, then end your turn.";
const RESTORED_WRITE =
  "Run the shell command `echo RESTORED > PROBE_AFTER.txt` in the checkout, then end your turn.";
const REPLY_ONLY = (word: string) =>
  `Reply with the single word ${word} and end your turn. Do not call any tool.`;

class ProbeTimeoutError extends Error {
  constructor(readonly label: string) {
    super(`timeout: ${label}`);
    this.name = "ProbeTimeoutError";
  }
}

function say(...parts: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

async function until(
  label: string,
  check: () => boolean | Promise<boolean>,
  ms = 300_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ProbeTimeoutError(label);
}

function parseArgs(): { provider: Provider; mode: Mode; model: string | null } {
  const [provider, mode, model] = process.argv.slice(2);
  if (provider !== "claude" && provider !== "codex")
    throw new Error("provider must be claude or codex");
  if (mode !== "session" && mode !== "group" && mode !== "restart" && mode !== "identity")
    throw new Error("mode must be session, group, restart or identity");
  return { provider, mode, model: model ?? null };
}

async function prepareRoot(provider: Provider, mode: Mode): Promise<{ root: string; cwd: string }> {
  const root = path.join(process.cwd(), `slp-probe-${provider}-${mode}-${Date.now()}`);
  const cwd = path.join(root, "checkout");
  await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "README.md"), "# probe checkout\n");
  return { root, cwd };
}

/** The most permissive settings a source could carry; a copy must not keep them while preparing. */
function sourceConfig(provider: Provider, cwd: string, model: string | null): AgentSessionConfig {
  if (provider === "claude") {
    return { provider, cwd, modeId: "bypassPermissions", ...(model ? { model } : {}) };
  }
  return {
    provider,
    cwd,
    modeId: "full-access",
    providerOptions: { sandbox_mode: "danger-full-access", approval_policy: "never" },
    ...(model ? { model, thinkingOptionId: "medium" } : {}),
  };
}

async function runSessionProbe(provider: Provider, model: string | null): Promise<void> {
  const { root, cwd } = await prepareRoot(provider, "session");
  const logger = pino({ level: "trace" }, pino.destination(path.join(root, "adapter.log")));
  let policy: AgentExecutionPolicy = {
    kind: "preparation",
    reason: "the session probe prepares it",
  };
  const client =
    provider === "claude"
      ? new ClaudeAgentClient({ logger })
      : new CodexAppServerAgentClient(logger, undefined, {});
  const session = await client.createSession(sourceConfig(provider, cwd, model), {
    agentId: "slp-probe",
    resolveExecutionPolicy: () => policy,
  });
  const lines: string[] = [];
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "tool_call") {
      lines.push(
        `tool ${event.item.name} ${event.item.status} ${JSON.stringify(event.item.error ?? "")}`,
      );
    }
    if (event.type === "timeline" && event.item.type === "assistant_message")
      lines.push(event.item.text);
    if (event.type === "turn_failed") lines.push(`turn_failed: ${event.error}`);
  });
  try {
    say("preparation turn");
    await session.run(WRITE_ATTEMPTS);
    say(lines.join("").slice(0, 2000));
    say("files after preparation:", (await readdir(cwd)).join(", "));
    lines.length = 0;
    policy = { kind: "authorized" };
    say("authorized turn");
    await session.run(RESTORED_WRITE);
    say(lines.join("").slice(0, 600));
    say("files after authorization:", (await readdir(cwd)).join(", "));
  } finally {
    await session.close();
    say("artifacts:", root);
  }
}

type GroupDaemon = Awaited<ReturnType<typeof createPaseoDaemon>>;

interface Probe {
  daemon: GroupDaemon;
  paseoHome: string;
  logger: pino.Logger;
}

/** One daemon over `root/paseo-home`; a second call with the same root is a restart. */
async function startDaemon(root: string, logName: string): Promise<Probe> {
  const paseoHome = path.join(root, "paseo-home");
  const staticDir = path.join(root, "static");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  const logger = pino({ level: "trace" }, pino.destination(path.join(root, logName)));
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: true,
      slpHandoff: true,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: path.join(paseoHome, "agents"),
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
    },
    logger,
  );
  await daemon.start();
  return { daemon, paseoHome, logger };
}

async function stopDaemon(probe: Probe): Promise<void> {
  await probe.daemon.stop().catch((error: unknown) => say("stop failed", String(error)));
}

function lifecycleOf(probe: Probe, agentId: string): string | undefined {
  return probe.daemon.agentManager.getAgent(agentId)?.lifecycle;
}

function catalogFor(probe: Probe, callerAgentId: string) {
  return createPaseoToolCatalog({
    agentManager: probe.daemon.agentManager,
    agentStorage: probe.daemon.agentStorage,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    slp: probe.daemon.slp,
    callerAgentId,
    logger: probe.logger,
  });
}

/** Admission returns before the run slot flips to running; wait for both edges. */
async function runTurn(probe: Probe, agentId: string, prompt: string): Promise<void> {
  const admission = await probe.daemon.agentManager.admitForegroundTurn(agentId, prompt);
  if (admission.status !== "started") throw new Error(`turn not started: ${admission.status}`);
  await until("turn running", () => lifecycleOf(probe, agentId) === "running", 60_000);
  await until("turn idle", () => settled(probe, agentId));
}

/** The run slot outlives the provider's idle event; both must clear before the next admission. */
function settled(probe: Probe, agentId: string): boolean {
  return (
    !probe.daemon.agentManager.hasInFlightRun(agentId) && lifecycleOf(probe, agentId) === "idle"
  );
}

async function printTimeline(probe: Probe, agentId: string, last?: number): Promise<void> {
  const rows = await probe.daemon.agentManager.getTimelineRows(agentId);
  for (const row of last === undefined ? rows : rows.slice(-last)) {
    const item = row.item;
    if (item.type === "tool_call") {
      say(
        `tool ${item.name} ${item.status}`,
        JSON.stringify(item.error ?? item.detail).slice(0, 500),
      );
    } else if (item.type === "assistant_message") {
      say("assistant:", item.text.slice(0, 1500));
    }
  }
}

function transferIdOf(receipt: unknown): string {
  if (
    receipt &&
    typeof receipt === "object" &&
    "transferId" in receipt &&
    typeof receipt.transferId === "string"
  ) {
    return receipt.transferId;
  }
  throw new Error("slp_request_handoff returned no transfer id");
}

function transferOf(probe: Probe, transferId: string): SlpTransferRecord {
  const found = probe.daemon.slp.listTransfers().find((entry) => entry.id === transferId);
  if (!found) throw new Error(`transfer ${transferId} vanished`);
  return found;
}

interface LeadGroup {
  groupId: string;
  leadSlotId: string;
  leadId: string;
}

async function startLeadGroup(
  probe: Probe,
  provider: Provider,
  source: AgentSessionConfig,
): Promise<LeadGroup> {
  const group = await probe.daemon.slp.initializeGroup({
    workspaceId: "wks_probe",
    mode: "direct",
    initialMessage: { messageId: "probe-1", text: REPLY_ONLY("READY") },
    lead: {
      provider,
      cwd: source.cwd,
      model: source.model ?? null,
      modeId: source.modeId ?? null,
    },
  });
  const leadId = group.slots[group.leadSlotId]?.generations[0]?.agentId;
  if (!leadId) throw new Error("group has no Lead");
  // The first turn is admitted before initializeGroup returns; wait for it to run, then end.
  await until("lead first turn running", () => lifecycleOf(probe, leadId) === "running", 60_000);
  await until("lead idle", () => lifecycleOf(probe, leadId) === "idle");
  say("lead", leadId, "replied:", await probe.daemon.agentManager.getLastAssistantMessage(leadId));
  return { groupId: group.id, leadSlotId: group.leadSlotId, leadId };
}

async function writeCheckpoint(probe: Probe, leadId: string, nextAction: string): Promise<void> {
  await catalogFor(probe, leadId).executeTool("slp_checkpoint", {
    objective: "Probe receive-only preparation",
    nextAction,
    workDone: "Lead replied.",
  });
}

async function requestTransfer(probe: Probe, leadId: string): Promise<string> {
  const requested = await catalogFor(probe, leadId).executeTool("slp_request_handoff", {
    reason: "live probe",
  });
  return transferIdOf(requested.structuredContent);
}

/** Waits for the transfer to reach `preparing` and returns the candidate's agent id. */
async function awaitPreparing(probe: Probe, transferId: string): Promise<string> {
  await until("candidate preparing", () => transferOf(probe, transferId).phase === "preparing");
  const preparing = transferOf(probe, transferId);
  if (!("candidate" in preparing) || !preparing.candidate) throw new Error("no candidate");
  const candidateId = preparing.candidate.agentId;
  say(
    "candidate",
    candidateId,
    "policy",
    JSON.stringify(probe.daemon.slp.executionPolicyFor(candidateId)),
  );
  return candidateId;
}

/** Waits for the candidate's preparation turn to be running and returns its agent id. */
async function awaitCandidate(probe: Probe, transferId: string): Promise<string> {
  const candidateId = await awaitPreparing(probe, transferId);
  await until(
    "candidate turn running",
    () => lifecycleOf(probe, candidateId) === "running",
    60_000,
  );
  return candidateId;
}

/** Resolves true when the model itself called slp_ready; false when the probe had to. */
async function awaitCompletion(
  probe: Probe,
  transferId: string,
  candidateId: string,
): Promise<boolean> {
  const phase = () => transferOf(probe, transferId).phase;
  try {
    await until(
      "transfer completed by the candidate's own slp_ready",
      () => phase() === "completed",
    );
    return true;
  } catch (error) {
    if (!(error instanceof ProbeTimeoutError)) throw error;
  }
  say("candidate did not acknowledge in time; phase", phase());
  if (phase() === "preparing") {
    await until("candidate idle", () => lifecycleOf(probe, candidateId) === "idle");
    await catalogFor(probe, candidateId).executeTool("slp_ready", {});
    await until("transfer completed", () => phase() === "completed");
  }
  return false;
}

/** The runtime's activation notice is the successor's first turn; let it land first. */
async function awaitActivation(probe: Probe, successorId: string): Promise<void> {
  await until(
    "activation delivered",
    () =>
      probe.daemon.slp
        .listMail()
        .some((mail) => mail.kind === "activation" && mail.state === "accepted"),
    60_000,
  );
  await until("successor idle after activation", () => settled(probe, successorId));
}

async function printStop(probe: Probe, transferId: string): Promise<void> {
  const checkpoint = JSON.parse(
    await readFile(path.join(probe.paseoHome, "slp", "checkpoints", `${transferId}.json`), "utf8"),
  );
  say("finalized checkpoint cursor", JSON.stringify(checkpoint.timelineCursor));
  const transfer = JSON.parse(
    await readFile(path.join(probe.paseoHome, "slp", "transfers", `${transferId}.json`), "utf8"),
  );
  say("history tail", JSON.stringify(transfer.stop?.historyTail));
}

async function runGroupProbe(provider: Provider, model: string | null): Promise<void> {
  const { root, cwd } = await prepareRoot(provider, "group");
  const probe = await startDaemon(root, "daemon.log");
  try {
    const { leadId } = await startLeadGroup(probe, provider, sourceConfig(provider, cwd, model));
    await writeCheckpoint(
      probe,
      leadId,
      `Before calling slp_ready: ${WRITE_ATTEMPTS} Then call slp_ready and end your turn.`,
    );
    const transferId = await requestTransfer(probe, leadId);
    const candidateId = await awaitCandidate(probe, transferId);
    const acknowledgedByModel = await awaitCompletion(probe, transferId, candidateId);
    say(
      "transfer",
      transferOf(probe, transferId).phase,
      "acknowledgedByModel",
      acknowledgedByModel,
    );
    say(
      "candidate policy after switch",
      JSON.stringify(probe.daemon.slp.executionPolicyFor(candidateId)),
    );
    await printTimeline(probe, candidateId);
    say("files after preparation:", (await readdir(cwd)).join(", "));

    await awaitActivation(probe, candidateId);
    await printTimeline(probe, candidateId, 3);
    await runTurn(probe, candidateId, RESTORED_WRITE);
    say("files after activation:", (await readdir(cwd)).join(", "));
    // The successor's own approval policy must still let it reach the control channel.
    await runTurn(probe, candidateId, CONTROL_TOOL_AFTER_ACTIVATION);
    await printTimeline(probe, candidateId, 6);
    await printStop(probe, transferId);
  } finally {
    await stopDaemon(probe);
    say("artifacts:", root);
  }
}

interface Interrupted {
  lead: LeadGroup;
  transferId: string;
  candidateId: string;
}

/**
 * First daemon: a transfer left preparing, then a stop. The stop follows the
 * `preparing` phase immediately: a candidate that gets its turn calls
 * `slp_ready` on its own, and the stop would then land after the switch.
 */
async function interruptTransfer(
  root: string,
  provider: Provider,
  cwd: string,
  model: string | null,
) {
  const probe = await startDaemon(root, "daemon-1.log");
  try {
    const lead = await startLeadGroup(probe, provider, sourceConfig(provider, cwd, model));
    await writeCheckpoint(probe, lead.leadId, REPLY_ONLY("PREPARING"));
    const transferId = await requestTransfer(probe, lead.leadId);
    const candidateId = await awaitPreparing(probe, transferId);
    // Stop once the candidate has a record to archive, before its turn can switch.
    await until(
      "candidate stored",
      async () => (await probe.daemon.agentStorage.get(candidateId)) !== null,
      60_000,
    );
    say("stopping with transfer", transferOf(probe, transferId).phase);
    return { lead, transferId, candidateId } satisfies Interrupted;
  } finally {
    await stopDaemon(probe);
  }
}

async function printRecovery(probe: Probe, interrupted: Interrupted): Promise<void> {
  const { lead, transferId, candidateId } = interrupted;
  const record = transferOf(probe, transferId);
  say(
    "after restart transfer",
    record.phase,
    record.phase === "aborted" ? record.abortedReason : "",
  );
  const group = probe.daemon.slp.getGroup(lead.groupId);
  if (!group) throw new Error("group vanished across the restart");
  const slot = group.slots[lead.leadSlotId];
  const active = slot?.generations.find((entry) => entry.id === slot.activeGenerationId);
  const candidate = slot?.generations.find((entry) => entry.agentId === candidateId);
  say("group", group.status, "hold", JSON.stringify(group.hold));
  say(
    "active lead",
    active?.agentId,
    active?.agentId === lead.leadId ? "(source)" : "(NOT source)",
  );
  say("candidate generation", candidate?.state);
  say("candidate archivedAt", (await probe.daemon.agentStorage.get(candidateId))?.archivedAt);
}

async function expectStaleCheckpointRefused(probe: Probe, leadId: string): Promise<void> {
  try {
    await probe.daemon.slp.requestHandoff(leadId, "stale checkpoint");
  } catch (error) {
    if (!(error instanceof SlpTransferRefusedError)) throw error;
    say("stale checkpoint refused:", error.message);
    return;
  }
  say("UNEXPECTED: the pre-restart checkpoint was accepted");
}

async function runRestartProbe(provider: Provider, model: string | null): Promise<void> {
  const { root, cwd } = await prepareRoot(provider, "restart");
  const interrupted = await interruptTransfer(root, provider, cwd, model);
  const { leadId } = interrupted.lead;
  const probe = await startDaemon(root, "daemon-2.log");
  try {
    await printRecovery(probe, interrupted);
    const { agentManager, agentStorage } = probe.daemon;
    await ensureAgentLoaded(leadId, { agentManager, agentStorage, logger: probe.logger });
    say("lead policy after restart", JSON.stringify(probe.daemon.slp.executionPolicyFor(leadId)));
    await expectStaleCheckpointRefused(probe, leadId);
    await runTurn(probe, leadId, REPLY_ONLY("RESUMED"));
    say("lead replied after restart:", await agentManager.getLastAssistantMessage(leadId));

    await writeCheckpoint(probe, leadId, "Call slp_ready and end your turn.");
    const again = await requestTransfer(probe, leadId);
    const successorId = await awaitCandidate(probe, again);
    const acknowledgedByModel = await awaitCompletion(probe, again, successorId);
    say(
      "second transfer",
      transferOf(probe, again).phase,
      "acknowledgedByModel",
      acknowledgedByModel,
    );
    await awaitActivation(probe, successorId);
    await runTurn(probe, successorId, CONTROL_TOOL_AFTER_ACTIVATION);
    await printTimeline(probe, successorId, 4);
    await printStop(probe, again);
  } finally {
    await stopDaemon(probe);
    say("artifacts:", root);
  }
}

const WHO_ARE_YOU = "khong co context ban la ai ha? vai trò của bạn ở workspace này là gì?";

/**
 * Role identity in free chat, the way a Human meets the group: a supervised
 * group opened with a bare greeting, then each root asked who it is.
 */
async function runIdentityProbe(provider: Provider, model: string | null): Promise<void> {
  const { root, cwd } = await prepareRoot(provider, "identity");
  const probe = await startDaemon(root, "daemon.log");
  try {
    const source = sourceConfig(provider, cwd, model);
    const group = await probe.daemon.slp.initializeGroup({
      workspaceId: "wks_probe",
      mode: "supervised",
      initialMessage: { messageId: "probe-1", text: "hi" },
      lead: {
        provider,
        cwd: source.cwd,
        model: source.model ?? null,
        modeId: source.modeId ?? null,
      },
    });
    const supervisorId = group.initialization.supervisorAgentId;
    const leadId = group.slots[group.leadSlotId]?.generations[0]?.agentId;
    if (!supervisorId || !leadId) throw new Error("group is missing a root");
    await until("supervisor greeted", () => settled(probe, supervisorId), 120_000);
    say(
      "supervisor greeting:",
      await probe.daemon.agentManager.getLastAssistantMessage(supervisorId),
    );
    for (const [role, agentId] of [
      ["supervisor", supervisorId],
      ["lead", leadId],
    ] as const) {
      await runTurn(probe, agentId, WHO_ARE_YOU);
      say(`${role} says:`, await probe.daemon.agentManager.getLastAssistantMessage(agentId));
    }
  } finally {
    await stopDaemon(probe);
    say("artifacts:", root);
  }
}

const { provider, mode, model } = parseArgs();
if (mode === "session") await runSessionProbe(provider, model);
else if (mode === "group") await runGroupProbe(provider, model);
else if (mode === "identity") await runIdentityProbe(provider, model);
else await runRestartProbe(provider, model);
process.exit(0);

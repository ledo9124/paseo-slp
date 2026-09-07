/**
 * Live evidence for SLP preparation policy (probe P7) and the daemon history
 * tail (P8, daemon half) on a real provider. Two modes:
 *
 * - `session`: one raw provider session launched with a preparation resolver
 *   is asked to write, then the resolver lifts and it is asked again. Proves
 *   the adapter gate on its own, independent of what an SLP candidate chooses.
 * - `group`: an isolated daemon, one SLP group, an explicit handoff; the
 *   candidate's preparation turn carries a checkpoint that asks it to write.
 *   Proves the whole path: hold, candidate policy, switch, restored policy.
 *
 *   npx tsx scripts/slp-preparation-probe.ts <claude|codex> <session|group> [model]
 *
 * Output goes to a fresh directory under the working directory; keep it as
 * the artifact. Needs a logged-in provider; never points at ~/.paseo.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import type {
  AgentExecutionPolicy,
  AgentSessionConfig,
} from "../src/server/agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../src/server/agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../src/server/agent/providers/codex-app-server-agent.js";
import { createPaseoToolCatalog } from "../src/server/agent/tools/paseo-tools.js";
import { createPaseoDaemon } from "../src/server/bootstrap.js";
import { createProviderSnapshotManagerStub } from "../src/server/test-utils/session-stubs.js";

type Provider = "claude" | "codex";
type Mode = "session" | "group";

const WRITE_ATTEMPTS =
  "Do exactly this, once each, and do not retry: (1) run the shell command `touch PROBE_SHELL.txt`; (2) create PROBE_FILE.txt containing hello with your file-writing tool. For each, report verbatim whether it succeeded or the exact error or denial text.";
const CONTROL_TOOL_AFTER_ACTIVATION =
  "Call the slp_checkpoint tool with objective 'probe after activation' and nextAction 'none', report verbatim whether it succeeded or the exact error, then end your turn.";
const RESTORED_WRITE =
  "Run the shell command `echo RESTORED > PROBE_AFTER.txt` in the checkout, then end your turn.";

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
  throw new Error(`timeout: ${label}`);
}

function parseArgs(): { provider: Provider; mode: Mode; model: string | null } {
  const [provider, mode, model] = process.argv.slice(2);
  if (provider !== "claude" && provider !== "codex")
    throw new Error("provider must be claude or codex");
  if (mode !== "session" && mode !== "group") throw new Error("mode must be session or group");
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

/** Admission returns before the run slot flips to running; wait for both edges. */
async function runTurn(daemon: GroupDaemon, agentId: string, prompt: string): Promise<void> {
  const lifecycle = () => daemon.agentManager.getAgent(agentId)?.lifecycle;
  const admission = await daemon.agentManager.admitForegroundTurn(agentId, prompt);
  if (admission.status !== "started") throw new Error(`turn not started: ${admission.status}`);
  await until("turn running", () => lifecycle() === "running", 60_000);
  await until("turn idle", () => lifecycle() === "idle");
}

async function printTimeline(daemon: GroupDaemon, agentId: string, last?: number): Promise<void> {
  const rows = await daemon.agentManager.getTimelineRows(agentId);
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

async function runGroupProbe(provider: Provider, model: string | null): Promise<void> {
  const { root, cwd } = await prepareRoot(provider, "group");
  const paseoHome = path.join(root, "paseo-home");
  const staticDir = path.join(root, "static");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  const logger = pino({ level: "trace" }, pino.destination(path.join(root, "daemon.log")));
  const daemon = await createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: true,
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
  const { agentManager, agentStorage, slp } = daemon;
  const lifecycle = (id: string) => agentManager.getAgent(id)?.lifecycle;
  const catalog = (callerAgentId: string) =>
    createPaseoToolCatalog({
      agentManager,
      agentStorage,
      providerSnapshotManager: createProviderSnapshotManagerStub().manager,
      slp,
      callerAgentId,
      logger,
    });
  try {
    const source = sourceConfig(provider, cwd, model);
    const group = await slp.initializeGroup({
      workspaceId: "wks_probe",
      mode: "direct",
      initialMessage: {
        messageId: "probe-1",
        text: "Reply with the single word READY and end your turn. Do not call any tool.",
      },
      lead: { provider, cwd, model: source.model ?? null, modeId: source.modeId ?? null },
    });
    const leadSlot = group.slots[group.leadSlotId];
    const leadId = leadSlot?.generations[0]?.agentId;
    if (!leadId) throw new Error("group has no Lead");
    // The first turn is admitted before initializeGroup returns; wait for it to run, then end.
    await until("lead first turn running", () => lifecycle(leadId) === "running", 60_000);
    await until("lead idle", () => lifecycle(leadId) === "idle");
    say("lead", leadId, "replied:", await agentManager.getLastAssistantMessage(leadId));

    const leadTools = catalog(leadId);
    await leadTools.executeTool("slp_checkpoint", {
      objective: "Probe receive-only preparation",
      nextAction: `Before calling slp_ready: ${WRITE_ATTEMPTS} Then call slp_ready and end your turn.`,
      workDone: "Lead replied READY.",
    });
    const requested = await leadTools.executeTool("slp_request_handoff", { reason: "live probe" });
    const transferId = transferIdOf(requested.structuredContent);
    const record = () => {
      const found = slp.listTransfers().find((entry) => entry.id === transferId);
      if (!found) throw new Error(`transfer ${transferId} vanished`);
      return found;
    };
    await until("candidate preparing", () => record().phase === "preparing");
    const preparing = record();
    if (!("candidate" in preparing) || !preparing.candidate) throw new Error("no candidate");
    const candidateId = preparing.candidate.agentId;
    say("candidate", candidateId, "policy", JSON.stringify(slp.executionPolicyFor(candidateId)));
    await until("candidate turn running", () => lifecycle(candidateId) === "running", 60_000);

    let acknowledgedByModel = true;
    try {
      await until(
        "transfer completed by the candidate's own slp_ready",
        () => record().phase === "completed",
      );
    } catch (error) {
      acknowledgedByModel = false;
      say("candidate did not acknowledge:", String(error), "phase", record().phase);
      if (record().phase === "preparing") {
        await until("candidate idle", () => lifecycle(candidateId) === "idle");
        await catalog(candidateId).executeTool("slp_ready", {});
        await until("transfer completed", () => record().phase === "completed");
      }
    }
    say("transfer", record().phase, "acknowledgedByModel", acknowledgedByModel);
    say("candidate policy after switch", JSON.stringify(slp.executionPolicyFor(candidateId)));
    await printTimeline(daemon, candidateId);
    say("files after preparation:", (await readdir(cwd)).join(", "));

    await runTurn(daemon, candidateId, RESTORED_WRITE);
    say("files after activation:", (await readdir(cwd)).join(", "));
    // The successor's own approval policy must still let it reach the control channel.
    await runTurn(daemon, candidateId, CONTROL_TOOL_AFTER_ACTIVATION);
    await printTimeline(daemon, candidateId, 6);

    const checkpoint = JSON.parse(
      await readFile(path.join(paseoHome, "slp", "checkpoints", `${transferId}.json`), "utf8"),
    );
    say("finalized checkpoint cursor", JSON.stringify(checkpoint.timelineCursor));
    const transfer = JSON.parse(
      await readFile(path.join(paseoHome, "slp", "transfers", `${transferId}.json`), "utf8"),
    );
    say("history tail", JSON.stringify(transfer.stop?.historyTail));
  } finally {
    await daemon.stop().catch((error: unknown) => say("stop failed", String(error)));
    say("artifacts:", root);
  }
}

const { provider, mode, model } = parseArgs();
if (mode === "session") await runSessionProbe(provider, model);
else await runGroupProbe(provider, model);
process.exit(0);

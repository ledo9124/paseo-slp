/**
 * Does a cancelled Peer turn reach its Lead as a cancellation?
 *
 * The unit test proves the wiring against a fake client that acknowledges
 * every interrupt. Production does not: `cancelAgentRunNow` marks the turn
 * before it interrupts and *clears the mark* when the provider refuses, so a
 * provider that does not acknowledge would hand back "returned" and the fix
 * would be silently absent. That is what this probe exists to check, and it
 * needs a real provider session to check it.
 *
 * Isolated: its own temp PASEO_HOME on an OS-picked port. It never touches the
 * daemon on 6767 or 6777.
 *
 *   npx tsx packages/server/scripts/slp-cancel-probe.ts [model]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";

import { cancelAgentRunCommand } from "../src/server/agent/lifecycle-command.js";
import { launchFor, say, startDaemon, until, type Probe } from "./slp-probe-lib.js";

const MODEL = process.argv[2] ?? "claude-sonnet-5";

/** Long enough that the Peer is still mid-turn when the cancel lands. */
const PEER_TASK =
  "Read every .txt file in this directory one at a time with the Read tool, and after each one write a one-sentence summary of it. Do not stop early and do not summarise them all at once.";

const LEAD_BRIEF = `Delegate this to a Peer immediately, with create_agent, and then end your turn. Do not do the work yourself and do not ask me anything first. The Peer's assignment is exactly: "${PEER_TASK}"`;

function peerAgentIds(probe: Probe, groupId: string): string[] {
  const group = probe.daemon.slp.getGroup(groupId);
  if (!group) return [];
  return Object.values(group.slots)
    .filter((slot) => slot.role === "peer")
    .flatMap((slot) =>
      slot.generations.filter((entry) => entry.state === "active").map((entry) => entry.agentId),
    );
}

function handbacksTo(probe: Probe, groupId: string) {
  return probe.daemon.slp
    .listMail()
    .filter((mail) => mail.groupId === groupId && mail.kind === "handback");
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "slp-cancel-probe-"));
  const cwd = path.join(root, "checkout");
  await mkdir(cwd, { recursive: true });
  for (const name of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
    await writeFile(
      path.join(cwd, `${name}.txt`),
      `${name}: ${"a paragraph about warehouse stock movements. ".repeat(40)}\n`,
      "utf8",
    );
  }

  const probe = await startDaemon(root, MODEL);
  say(`daemon up, home ${probe.paseoHome}`);
  let verdict = 1;
  try {
    const group = await probe.daemon.slp.initializeGroup({
      workspaceId: "wks_cancel_probe",
      mode: "direct",
      initialMessage: { messageId: "cancel-1", text: LEAD_BRIEF },
      lead: launchFor("claude", cwd, MODEL),
    });
    say(`group ${group.id}, lead ${group.initialization.leadAgentId}`);

    await until("the Lead to create a Peer", () => peerAgentIds(probe, group.id).length > 0);
    const peerId = peerAgentIds(probe, group.id)[0]!;
    say(`peer ${peerId}`);

    await until(
      "the Peer's turn to be running",
      () => probe.daemon.agentManager.getAgent(peerId)?.lifecycle === "running",
    );
    // Let it get far enough in that its last message is mid-work, which is the
    // case that read as a result before the fix.
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    const before = handbacksTo(probe, group.id).length;

    say("cancelling the Peer's turn through the same command the Stop button uses");
    const result = await cancelAgentRunCommand(
      { agentManager: probe.daemon.agentManager, logger: pino({ level: "warn" }) },
      peerId,
    );
    say(`cancelled: ${result.cancelled}`);

    await until("a handback to reach the Lead", () => handbacksTo(probe, group.id).length > before);
    const mail = handbacksTo(probe, group.id).at(-1)!;
    const prompt = typeof mail.prompt === "string" ? mail.prompt : JSON.stringify(mail.prompt);

    say("--- handback the Lead received ---");
    say(prompt);
    say("--- end ---");

    const saysCancelled = prompt.includes("had its turn cancelled before it finished");
    const saysReturned = prompt.includes("returned its turn");
    say(`reports cancelled: ${saysCancelled}`);
    say(`reports returned:  ${saysReturned}`);
    verdict = saysCancelled && !saysReturned ? 0 : 1;
    say(verdict === 0 ? "PASS" : "FAIL — a cut turn was not reported as cut");
  } finally {
    await probe.daemon.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  process.exit(verdict);
}

void main();

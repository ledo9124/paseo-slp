/**
 * Probe P5: role behavior and cost, on real prompted agents.
 *
 *   npx tsx scripts/slp-p5-probe.ts <claude|codex> <scenario> [supervised|direct] [model]
 *
 * Scenarios (see docs/slp/implementation-plan.md#role-evaluation-scenarios):
 *
 * - `tiny`     one-line change a Lead should make itself
 * - `peer`     one red test to diagnose and fix
 * - `delegate` three unrelated red suites at once, which a Lead can split
 * - `progress` Human asks how it is going while the Lead is still working
 * - `premise`  Human names the wrong cause; the evidence contradicts it
 * - `constraint` Human adds a constraint after the work has started
 *
 * Each run gets an isolated home and a fresh copy of a small checkout that
 * has one real bug and one failing test, so "evidence" means a command the
 * agents actually ran. The daemon here is never the machine's own; the
 * handoff flag stays off, the way P5 measures it.
 *
 * Output is a directory under the working directory: the daemon log, the
 * checkout, and `transcript.md` with every member's turns in order. Read the
 * counts with `npm run slp:report -- <root>/paseo-home`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import { createPaseoDaemon } from "../src/server/bootstrap.js";
import type { SlpGroupRecord } from "../src/server/slp/store.js";

type Provider = "claude" | "codex";
type Mode = "supervised" | "direct";
type Scenario = "tiny" | "peer" | "delegate" | "progress" | "premise" | "constraint";

const SCENARIOS: Scenario[] = ["tiny", "peer", "delegate", "progress", "premise", "constraint"];

function say(...parts: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

class ProbeTimeoutError extends Error {
  constructor(label: string) {
    super(`timed out waiting for ${label}`);
    this.name = "ProbeTimeoutError";
  }
}

async function until(
  label: string,
  check: () => boolean | Promise<boolean>,
  ms = 600_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new ProbeTimeoutError(label);
}

/**
 * A small checkout with one real defect: `applyDiscount` treats a percentage
 * as a fraction. The test states the expected total, so a Peer can prove a
 * diagnosis instead of asserting one.
 */
const FIXTURE: Record<string, string> = {
  "package.json": `${JSON.stringify(
    { name: "cart", version: "1.0.0", type: "module", scripts: { test: "node --test" } },
    null,
    2,
  )}\n`,
  "src/cart.js": `export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function applyDiscount(total, percent) {
  if (percent < 0 || percent > 100) {
    throw new Error("discount percent is out of range");
  }
  return total - total * percent;
}

export function checkout(items, percent) {
  return Math.round(applyDiscount(subtotal(items), percent) * 100) / 100;
}
`,
  "test/cart.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { checkout, subtotal } from "../src/cart.js";

test("adds up the line items", () => {
  assert.equal(subtotal([{ price: 10, quantity: 2 }, { price: 5, quantity: 1 }]), 25);
});

test("takes ten percent off", () => {
  assert.equal(checkout([{ price: 10, quantity: 2 }], 10), 18);
});
`,
};

/** Two more modules, each with its own deterministic defect and suite. */
const WIDE_FIXTURE: Record<string, string> = {
  "src/dates.js": `const DAY_MS = 1000 * 60 * 60 * 24;

export function daysBetween(start, end) {
  return Math.floor((new Date(end) - new Date(start)) / (1000 * 60 * 60));
}

export function isWeekend(date) {
  const day = new Date(date).getUTCDay();
  return day === 0 || day === 6;
}

export function rangeLength(start, end) {
  return daysBetween(start, end) + 1;
}

export { DAY_MS };
`,
  "test/dates.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { daysBetween, isWeekend, rangeLength } from "../src/dates.js";

test("counts whole days between two dates", () => {
  assert.equal(daysBetween("2026-01-01", "2026-01-08"), 7);
});

test("counts an inclusive range", () => {
  assert.equal(rangeLength("2026-01-01", "2026-01-03"), 3);
});

test("knows a Saturday", () => {
  assert.equal(isWeekend("2026-01-03"), true);
});
`,
  "src/slug.js": `export function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]/g, "-");
}
`,
  "test/slug.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "../src/slug.js";

test("lowercases and joins words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses punctuation runs and trims the edges", () => {
  assert.equal(slugify("Hello,  World!"), "hello-world");
});
`,
};

async function prepareRoot(
  provider: Provider,
  scenario: Scenario,
  mode: Mode,
): Promise<{ root: string; cwd: string }> {
  const root = path.join(
    process.cwd(),
    `slp-p5-${scenario}-${mode}-${provider}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
  );
  const cwd = path.join(root, "checkout");
  const files = scenario === "delegate" ? { ...FIXTURE, ...WIDE_FIXTURE } : FIXTURE;
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, cwd };
}

type Daemon = Awaited<ReturnType<typeof createPaseoDaemon>>;

interface Probe {
  daemon: Daemon;
  root: string;
  paseoHome: string;
}

/**
 * Every role gets the model the run was launched with. Without this a Peer the
 * Lead creates takes the provider's own default — `~/.codex/config.toml` in
 * practice — so a group launched on one model quietly runs its Peers on
 * another, and the token totals stop comparing like with like.
 */
async function startDaemon(root: string, model: string | null): Promise<Probe> {
  const paseoHome = path.join(root, "paseo-home");
  const staticDir = path.join(root, "static");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  const logger = pino({ level: "info" }, pino.destination(path.join(root, "daemon.log")));
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
      slpRoles: model ? { supervisor: { model }, lead: { model }, peer: { model } } : undefined,
    },
    logger,
  );
  await daemon.start();
  return { daemon, root, paseoHome };
}

function launchFor(provider: Provider, cwd: string, model: string | null) {
  return provider === "claude"
    ? { provider, cwd, model, modeId: "bypassPermissions" }
    : { provider, cwd, model, modeId: "full-access" };
}

function memberIds(probe: Probe, groupId: string): string[] {
  const group = probe.daemon.slp.getGroup(groupId);
  if (!group) return [];
  return Object.values(group.slots).flatMap((slot) =>
    slot.generations.filter((entry) => entry.state === "active").map((entry) => entry.agentId),
  );
}

function busy(probe: Probe, agentId: string): boolean {
  const agent = probe.daemon.agentManager.getAgent(agentId);
  return probe.daemon.agentManager.hasInFlightRun(agentId) || agent?.lifecycle === "running";
}

/** Quiet means every member is idle and no mail is still moving. */
function groupQuiet(probe: Probe, groupId: string): boolean {
  if (memberIds(probe, groupId).some((agentId) => busy(probe, agentId))) return false;
  return !probe.daemon.slp
    .listMail()
    .some(
      (mail) =>
        mail.groupId === groupId && (mail.state === "queued" || mail.state === "dispatching"),
    );
}

/**
 * Quiet once is not settled: a handback or report can start the next turn a
 * moment later. Require the group to stay quiet for a stretch.
 */
async function untilSettled(probe: Probe, groupId: string, label: string): Promise<void> {
  let quietSince: number | null = null;
  await until(label, () => {
    if (!groupQuiet(probe, groupId)) {
      quietSince = null;
      return false;
    }
    quietSince ??= Date.now();
    return Date.now() - quietSince > 15_000;
  });
}

async function humanSays(probe: Probe, contactId: string, text: string): Promise<void> {
  say(`Human -> ${contactId.slice(0, 8)}: ${text.slice(0, 120)}`);
  const admission = await probe.daemon.agentManager.admitForegroundTurn(contactId, text);
  if (admission.status !== "started") throw new Error(`turn not started: ${admission.status}`);
  await until("contact running", () => busy(probe, contactId), 120_000);
}

interface Step {
  /** Waits for the group to go quiet before this message is sent. */
  text: string;
  /** Send while the group is still working, the way a Human interrupts. */
  whileWorking?: boolean;
  afterSeconds?: number;
}

const TASKS: Record<Scenario, { first: string; follow: Step[] }> = {
  tiny: {
    first:
      "Trong src/cart.js, đổi thông điệp lỗi của applyDiscount thành 'discount percent must be between 0 and 100'. Chỉ đổi đúng câu đó.",
    follow: [],
  },
  peer: {
    first:
      "npm test trong checkout này đang đỏ. Tìm nguyên nhân, sửa, và cho tôi bằng chứng là nó đã xanh.",
    follow: [],
  },
  delegate: {
    first:
      "npm test đang đỏ ở ba nhóm test không liên quan nhau: cart, dates và slug. Tôi cần cả ba xanh trong hôm nay, mỗi lỗi kèm nguyên nhân và bằng chứng riêng. Bạn tự quyết cách tổ chức công việc.",
    follow: [],
  },
  progress: {
    first:
      "npm test đang đỏ. Điều tra nguyên nhân, sửa, và báo cáo bằng chứng. Đừng đổi API công khai của module.",
    follow: [{ text: "Đang tới đâu rồi?", whileWorking: true, afterSeconds: 45 }],
  },
  premise: {
    first:
      "npm test đang đỏ. Tôi khá chắc là do Math.round trong checkout() làm tròn sai. Sửa chỗ đó và cho tôi bằng chứng.",
    follow: [],
  },
  constraint: {
    first: "npm test đang đỏ. Tìm nguyên nhân, sửa, và cho tôi bằng chứng.",
    follow: [
      {
        text: "Bổ sung ràng buộc: không được đổi chữ ký của applyDiscount, vì chỗ khác đang gọi nó.",
        whileWorking: true,
        afterSeconds: 60,
      },
    ],
  },
};

async function transcript(probe: Probe, groupId: string): Promise<string> {
  const group = probe.daemon.slp.getGroup(groupId);
  if (!group) return "(group vanished)\n";
  const lines: string[] = [`# ${groupId}`, ""];
  for (const slot of Object.values(group.slots)) {
    for (const generation of slot.generations) {
      const stored = await probe.daemon.agentStorage.get(generation.agentId);
      lines.push(
        `## ${slot.role} gen ${generation.number} — ${stored?.title ?? ""} (${generation.agentId})`,
        "",
      );
      const rows = await probe.daemon.agentManager
        .getTimelineRows(generation.agentId)
        .catch(() => []);
      // Assistant rows arrive as stream deltas; join the run so a turn reads
      // as one message instead of a column of fragments.
      let assistant = "";
      const flush = (): void => {
        if (!assistant.trim()) return;
        lines.push(`**out:** ${assistant.trim().slice(0, 6000)}`, "");
        assistant = "";
      };
      for (const row of rows) {
        const item = row.item;
        if (item.type === "assistant_message") {
          assistant += item.text;
          continue;
        }
        flush();
        if (item.type === "user_message") {
          lines.push(`**in:** ${item.text.slice(0, 6000)}`, "");
        } else if (item.type === "tool_call") {
          const detail = JSON.stringify(item.error ?? item.detail ?? "").slice(0, 300);
          lines.push(`\`tool ${item.name} ${item.status}\` ${detail}`, "");
        }
      }
      flush();
    }
  }
  lines.push("## Mail", "");
  for (const mail of probe.daemon.slp.listMail().filter((entry) => entry.groupId === groupId)) {
    lines.push(
      `- ${mail.sequence} ${mail.kind} ${mail.fromSlotId ?? "?"} -> ${mail.slotId} ${mail.state}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function describeGroup(probe: Probe, group: SlpGroupRecord): void {
  for (const slot of Object.values(group.slots)) {
    const active = slot.generations.find((entry) => entry.id === slot.activeGenerationId);
    say(`  ${slot.role} ${active?.agentId ?? "(none)"}`);
  }
}

async function main(): Promise<void> {
  const [providerArgument, scenarioArgument, modeArgument, modelArgument] = process.argv.slice(2);
  const provider = providerArgument as Provider;
  const scenario = scenarioArgument as Scenario;
  const mode = (modeArgument ?? "supervised") as Mode;
  if (provider !== "claude" && provider !== "codex")
    throw new Error("provider must be claude or codex");
  if (!SCENARIOS.includes(scenario))
    throw new Error(`scenario must be one of ${SCENARIOS.join(", ")}`);
  if (mode !== "supervised" && mode !== "direct")
    throw new Error("mode must be supervised or direct");
  const model = modelArgument ?? null;

  const { root, cwd } = await prepareRoot(provider, scenario, mode);
  say(`scenario ${scenario}  mode ${mode}  provider ${provider}  root ${root}`);
  const probe = await startDaemon(root, model);
  const started = Date.now();
  let groupId = "";
  try {
    const task = TASKS[scenario];
    const group = await probe.daemon.slp.initializeGroup({
      workspaceId: "wks_p5",
      mode,
      initialMessage: { messageId: "p5-1", text: task.first },
      lead: launchFor(provider, cwd, model),
    });
    groupId = group.id;
    say(`group ${group.id}`);
    describeGroup(probe, group);
    const contactId = probe.daemon.slp.summarize(group).contactAgentId ?? "";
    if (!contactId) throw new Error("group has no contact agent");
    say(`contact ${contactId}`);

    for (const [index, step] of task.follow.entries()) {
      if (step.whileWorking) {
        await new Promise((resolve) => setTimeout(resolve, (step.afterSeconds ?? 45) * 1000));
      } else {
        await untilSettled(probe, group.id, `quiet before step ${index + 1}`);
      }
      await humanSays(probe, contactId, step.text);
    }
    await untilSettled(probe, group.id, "group settled");
    say(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    if (groupId) {
      await writeFile(path.join(root, "transcript.md"), await transcript(probe, groupId)).catch(
        (error: unknown) => say("transcript failed", String(error)),
      );
    }
    await probe.daemon.stop().catch((error: unknown) => say("stop failed", String(error)));
    say("artifacts:", root);
  }
}

await main();

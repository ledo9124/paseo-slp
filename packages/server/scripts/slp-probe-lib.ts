/**
 * What both SLP probes need: an isolated daemon, a member's launch, "is the
 * group quiet", the Human's own sends and a readable transcript. The probes
 * differ in what they stage, not in how they run a group.
 *
 * `packages/server/scripts/slp-p5-probe.ts` measures whole runs;
 * `packages/server/scripts/slp-behavior-probe.ts` stages one situation.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import { createPaseoDaemon } from "../src/server/bootstrap.js";
import type { SlpGroupRecord } from "../src/server/slp/store.js";

export type Provider = "claude" | "codex";

/**
 * A small checkout with one real defect: `applyDiscount` treats a percentage
 * as a fraction. The test states the expected total, so a Peer can prove a
 * diagnosis instead of asserting one.
 */
export const CART_FILES: Record<string, string> = {
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
export const WIDE_FILES: Record<string, string> = {
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

export function say(...parts: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

export class ProbeTimeoutError extends Error {
  constructor(label: string) {
    super(`timed out waiting for ${label}`);
    this.name = "ProbeTimeoutError";
  }
}

export async function until(
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

export type Daemon = Awaited<ReturnType<typeof createPaseoDaemon>>;

export interface Probe {
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
export async function startDaemon(root: string, model: string | null): Promise<Probe> {
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

export function launchFor(provider: Provider, cwd: string, model: string | null) {
  return provider === "claude"
    ? { provider, cwd, model, modeId: "bypassPermissions" }
    : { provider, cwd, model, modeId: "full-access" };
}

export function memberIds(probe: Probe, groupId: string): string[] {
  const group = probe.daemon.slp.getGroup(groupId);
  if (!group) return [];
  return Object.values(group.slots).flatMap((slot) =>
    slot.generations.filter((entry) => entry.state === "active").map((entry) => entry.agentId),
  );
}

export function busy(probe: Probe, agentId: string): boolean {
  const agent = probe.daemon.agentManager.getAgent(agentId);
  return probe.daemon.agentManager.hasInFlightRun(agentId) || agent?.lifecycle === "running";
}

/** Quiet means every member is idle and no mail is still moving. */
export function groupQuiet(probe: Probe, groupId: string): boolean {
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
export async function untilSettled(probe: Probe, groupId: string, label: string): Promise<void> {
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

export async function humanSays(probe: Probe, contactId: string, text: string): Promise<void> {
  say(`Human -> ${contactId.slice(0, 8)}: ${text.slice(0, 120)}`);
  const admission = await probe.daemon.agentManager.admitForegroundTurn(contactId, text);
  if (admission.status !== "started") throw new Error(`turn not started: ${admission.status}`);
  await until("contact running", () => busy(probe, contactId), 120_000);
}

export async function transcript(probe: Probe, groupId: string): Promise<string> {
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

export function describeGroup(group: SlpGroupRecord): void {
  for (const slot of Object.values(group.slots)) {
    const active = slot.generations.find((entry) => entry.id === slot.activeGenerationId);
    say(`  ${slot.role} ${active?.agentId ?? "(none)"}`);
  }
}

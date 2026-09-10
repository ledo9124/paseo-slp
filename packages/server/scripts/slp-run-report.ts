/**
 * Read-only summary of SLP runs, for recording probe P5 evidence.
 *
 *   npx tsx scripts/slp-run-report.ts [paseoHome] [groupId]
 *
 * Reads the daemon's own records under `$PASEO_HOME/slp/` and, for each
 * member, the provider's session file, which is where token counts live;
 * Paseo does not persist usage. Defaults to the checkout's dev home.
 *
 * The counts answer the questions probe P5 asks (see
 * docs/slp/implementation-plan.md#current-sequence): how much mail carried
 * work, how often the runtime spoke for a member instead of the member
 * speaking for itself, and what the topology cost.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { SlpGroupSchema, SlpMailSchema } from "../src/server/slp/store.js";
import type { SlpGroupRecord, SlpMailRecord, SlpRole } from "../src/server/slp/store.js";

interface Member {
  slotId: string;
  role: SlpRole;
  generation: number;
  agentId: string;
  title: string;
  provider: string;
  model: string | null;
  sessionId: string | null;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

async function readRecords<T>(
  directory: string,
  parse: (value: unknown) => T,
): Promise<{ file: string; record: T }[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const out: { file: string; record: T }[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(directory, name);
    try {
      out.push({ file, record: parse(JSON.parse(await readFile(file, "utf8"))) });
    } catch (error) {
      console.warn(`skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

/** Stored agents live one directory per workspace root; the file name is the id. */
async function findAgentFile(agentsRoot: string, agentId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(agentsRoot);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = path.join(agentsRoot, dir, `${agentId}.json`);
    try {
      await stat(file);
      return file;
    } catch {
      continue;
    }
  }
  return null;
}

async function readMembers(paseoHome: string, group: SlpGroupRecord): Promise<Member[]> {
  const agentsRoot = path.join(paseoHome, "agents");
  const members: Member[] = [];
  for (const slot of Object.values(group.slots)) {
    for (const generation of slot.generations) {
      const file = await findAgentFile(agentsRoot, generation.agentId);
      const stored = file
        ? (JSON.parse(await readFile(file, "utf8")) as {
            title?: string;
            provider?: string;
            config?: { model?: string };
            persistence?: { sessionId?: string };
          })
        : null;
      members.push({
        slotId: slot.id,
        role: slot.role,
        generation: generation.number,
        agentId: generation.agentId,
        title: stored?.title ?? "(no agent record)",
        provider: stored?.provider ?? "?",
        model: stored?.config?.model ?? null,
        sessionId: stored?.persistence?.sessionId ?? null,
      });
    }
  }
  return members;
}

/** Codex writes a cumulative `total_token_usage`; the last one in the rollout is the run's total. */
async function codexUsage(sessionId: string): Promise<Usage | null> {
  const root = path.join(homedir(), ".codex", "sessions");
  const file = await findFileEndingWith(root, `${sessionId}.jsonl`);
  if (!file) return null;
  const matches = (await readFile(file, "utf8")).matchAll(
    /"total_token_usage":\{[^}]*"input_tokens":(\d+)[^}]*"output_tokens":(\d+)[^}]*"total_tokens":(\d+)/g,
  );
  let usage: Usage | null = null;
  for (const match of matches) {
    usage = {
      inputTokens: Number(match[1]),
      outputTokens: Number(match[2]),
      totalTokens: Number(match[3]),
    };
  }
  return usage;
}

/** Claude writes per-message usage; the run's cost is their sum, cache reads included. */
async function claudeUsage(sessionId: string): Promise<Usage | null> {
  const root = path.join(homedir(), ".claude", "projects");
  const file = await findFileEndingWith(root, `${sessionId}.jsonl`);
  if (!file) return null;
  let input = 0;
  let output = 0;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const usage = /"usage":\{([^}]*)\}/.exec(line);
    if (!usage) continue;
    const read = (field: string): number =>
      Number(new RegExp(`"${field}":(\\d+)`).exec(usage[1]!)?.[1] ?? 0);
    input +=
      read("input_tokens") + read("cache_creation_input_tokens") + read("cache_read_input_tokens");
    output += read("output_tokens");
  }
  return input || output
    ? { inputTokens: input, outputTokens: output, totalTokens: input + output }
    : null;
}

async function findFileEndingWith(root: string, suffix: string): Promise<string | null> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileEndingWith(full, suffix);
      if (found) return found;
    } else if (entry.name.endsWith(suffix)) {
      return full;
    }
  }
  return null;
}

function usageFor(member: Member): Promise<Usage | null> {
  if (!member.sessionId) return Promise.resolve(null);
  if (member.provider.startsWith("codex")) return codexUsage(member.sessionId);
  if (member.provider.startsWith("claude")) return claudeUsage(member.sessionId);
  return Promise.resolve(null);
}

function roleOf(members: Member[], slotId: string | null | undefined): string {
  const member = members.find((candidate) => candidate.slotId === slotId);
  return member ? `${member.role}` : "?";
}

function summarize(group: SlpGroupRecord, mail: SlpMailRecord[], members: Member[]): void {
  const inGroup = mail
    .filter((record) => record.groupId === group.id)
    .sort((a, b) => a.sequence - b.sequence);
  console.log(`\n## Group ${group.id}`);
  console.log(
    `workspace ${group.workspaceId}  mode ${group.mode}  status ${group.status}  started ${group.createdAt}`,
  );

  console.log("\n### Members");
  for (const member of members) {
    const model = member.model ? ` ${member.model}` : "";
    console.log(
      `  ${member.role.padEnd(10)} gen ${member.generation}  ${member.provider}${model}  ${member.agentId}  ${member.title}`,
    );
  }

  console.log("\n### Mail");
  for (const record of inGroup) {
    const from = roleOf(members, record.fromSlotId);
    const to = roleOf(members, record.slotId);
    console.log(
      `  ${String(record.sequence).padStart(3)} ${record.createdAt}  ${record.kind.padEnd(13)} ${from} -> ${to}  ${record.state}`,
    );
  }
  if (inGroup.length === 0) console.log("  (none)");

  const count = (predicate: (record: SlpMailRecord) => boolean): number =>
    inGroup.filter(predicate).length;
  const leadSlot = group.leadSlotId;
  const supervisorSlot = group.supervisorSlotId;
  console.log("\n### Counts");
  const rows: [string, number][] = [
    ["mail total", inGroup.length],
    [
      "Supervisor -> Lead",
      count((record) => record.fromSlotId === supervisorSlot && record.slotId === leadSlot),
    ],
    [
      "Lead -> Supervisor, sent by the Lead",
      count(
        (record) =>
          record.kind === "message" &&
          record.fromSlotId === leadSlot &&
          record.slotId === supervisorSlot,
      ),
    ],
    ["Lead -> Supervisor, relayed by the runtime", count((record) => record.kind === "report")],
    ["handbacks", count((record) => record.kind === "handback")],
    ["interruption notices", count((record) => record.kind === "interrupted")],
    ["activation notices", count((record) => record.kind === "activation")],
    ["still queued", count((record) => record.state === "queued")],
    ["uncertain", count((record) => record.state === "uncertain")],
  ];
  for (const [label, value] of rows) console.log(`  ${label.padEnd(44)} ${value}`);
  console.log(
    "  each accepted mail started one turn on its recipient; Human's own messages are not mail",
  );
}

async function reportUsage(members: Member[]): Promise<void> {
  console.log("\n### Tokens (from the provider's session file)");
  let total = 0;
  for (const member of members) {
    const usage = await usageFor(member);
    if (!usage) {
      console.log(`  ${member.role.padEnd(10)} gen ${member.generation}  (no session file found)`);
      continue;
    }
    total += usage.totalTokens;
    console.log(
      `  ${member.role.padEnd(10)} gen ${member.generation}  in ${usage.inputTokens}  out ${usage.outputTokens}  total ${usage.totalTokens}`,
    );
  }
  console.log(`  ${"group total".padEnd(21)} ${total}`);
}

async function main(): Promise<void> {
  const [homeArgument, groupArgument] = process.argv.slice(2);
  const paseoHome =
    homeArgument ||
    process.env.PASEO_HOME ||
    path.resolve(process.cwd(), "..", "..", ".dev", "paseo-home");
  console.log(`PASEO_HOME ${paseoHome}`);

  const groups = (
    await readRecords(path.join(paseoHome, "slp", "groups"), (value) => SlpGroupSchema.parse(value))
  ).map((entry) => entry.record);
  const mail = (
    await readRecords(path.join(paseoHome, "slp", "mail"), (value) => SlpMailSchema.parse(value))
  ).map((entry) => entry.record);
  const selected = groupArgument ? groups.filter((group) => group.id === groupArgument) : groups;
  if (selected.length === 0) {
    console.log("no SLP groups found");
    return;
  }
  for (const group of selected.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const members = await readMembers(paseoHome, group);
    summarize(group, mail, members);
    await reportUsage(members);
  }
}

await main();

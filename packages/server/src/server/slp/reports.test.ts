import type { Logger } from "pino";
import { describe, expect, test } from "vitest";

import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { createStub } from "../test-utils/class-mocks.js";
import { SlpControlTurns } from "./control-turns.js";
import type { SlpMailInput } from "./mailbox.js";
import { SlpLeadReports, type SlpLeadReportTarget } from "./reports.js";

const GROUP = "grp_reports";
const LEAD_SLOT = "slot_lead";
const SUPERVISOR_SLOT = "slot_supervisor";
const AGENT = "agt_lead";
const TARGET: SlpLeadReportTarget = {
  groupId: GROUP,
  leadSlotId: LEAD_SLOT,
  supervisorSlotId: SUPERVISOR_SLOT,
};

interface CapturedLog {
  level: "info" | "error";
  message: string;
  payload: Record<string, unknown>;
}

function createCapturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const capture =
    (level: CapturedLog["level"]) =>
    (payload: unknown, message?: string): void => {
      records.push({ level, message: message ?? "", payload: payload as Record<string, unknown> });
    };
  const logger = {
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    info: capture("info"),
    error: capture("error"),
  };
  return { logger: logger as unknown as Logger, records };
}

/** One queued report at a time per slot, matching the mailbox's own invariant closely enough to test the relay's calling convention. */
function createFakeMailbox() {
  const enqueued: SlpMailInput[] = [];
  let queuedReportIndex = -1;
  let nextId = 0;
  return {
    enqueued,
    enqueue: async (input: SlpMailInput) => {
      enqueued.push(input);
      if (input.kind === "report") queuedReportIndex = enqueued.length - 1;
      nextId += 1;
      return { ...input, id: `mail_${nextId}`, sequence: nextId, state: "queued" as const };
    },
    appendToQueuedReport: async (
      groupId: string,
      slotId: string,
      append: (existing: AgentPromptInput) => AgentPromptInput,
    ) => {
      if (queuedReportIndex < 0) return false;
      const candidate = enqueued[queuedReportIndex]!;
      if (candidate.groupId !== groupId || candidate.slotId !== slotId) return false;
      enqueued[queuedReportIndex] = { ...candidate, prompt: append(candidate.prompt) };
      return true;
    },
  };
}

interface Harness {
  reports: SlpLeadReports;
  mailbox: ReturnType<typeof createFakeMailbox>;
  logRecords: CapturedLog[];
  /** A full running->idle cycle for the Lead, synchronous so two calls in a row race the same way two turns ending seconds apart would. */
  runTurn: () => void;
}

function createHarness(
  getLastAssistantMessage: (agentId: string) => Promise<string | null>,
): Harness {
  const { logger, records: logRecords } = createCapturingLogger();
  const mailbox = createFakeMailbox();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const agentManager = createStub<Pick<AgentManager, "subscribe" | "getLastAssistantMessage">>({
    subscribe: (callback: (event: AgentManagerEvent) => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    getLastAssistantMessage,
  });
  const reports = new SlpLeadReports({
    logger,
    agentManager,
    mailbox,
    resolveLead: (agentId) => (agentId === AGENT ? TARGET : null),
    controlTurns: new SlpControlTurns(),
  });
  reports.start();

  const emit = (lifecycle: "running" | "idle"): void => {
    const agent = createStub<ManagedAgent>({
      id: AGENT,
      lifecycle,
      pendingPermissions: new Map(),
    });
    for (const callback of subscribers) callback({ type: "agent_state", agent });
  };
  return {
    reports,
    mailbox,
    logRecords,
    runTurn: () => {
      emit("running");
      emit("idle");
    },
  };
}

describe("SlpLeadReports", () => {
  test("relays the Lead's last message to the Supervisor as a report", async () => {
    const harness = createHarness(async () => "the fix landed, ready for review");
    harness.runTurn();
    await harness.reports.dispose();

    expect(harness.mailbox.enqueued).toHaveLength(1);
    expect(harness.mailbox.enqueued[0]).toMatchObject({
      groupId: GROUP,
      slotId: SUPERVISOR_SLOT,
      fromSlotId: LEAD_SLOT,
      kind: "report",
    });
    expect(harness.mailbox.enqueued[0]?.prompt).toContain("the fix landed, ready for review");
  });

  test("a turn that ends with no message is logged, not fabricated into a report", async () => {
    const harness = createHarness(async () => "");
    harness.runTurn();
    await harness.reports.dispose();

    expect(harness.mailbox.enqueued).toEqual([]);
    const logged = harness.logRecords.find((record) => record.level === "info");
    expect(logged?.message).toContain("no message");
    expect(logged?.payload).toMatchObject({ agentId: AGENT });
  });

  test("several turn ends before delivery merge into one still-queued report, losing nothing", async () => {
    const messages = ["first result", "second result", "third result"];
    let call = 0;
    const harness = createHarness(async () => messages[call++] ?? null);

    // All three turns end before any relay's mailbox write has landed, the
    // shape of a Lead draining a backlog several seconds apart.
    harness.runTurn();
    harness.runTurn();
    harness.runTurn();
    await harness.reports.dispose();

    const reportsSent = harness.mailbox.enqueued.filter((mail) => mail.kind === "report");
    expect(reportsSent).toHaveLength(1);
    const prompt = String(reportsSent[0]?.prompt);
    for (const message of messages) expect(prompt).toContain(message);
    // Each entry names its own turn's content, so three entries are distinguishable.
    expect(prompt.match(/Report from Lead/g)).toHaveLength(3);
  });

  test("a report already queued keeps its envelope well-formed after a merge", async () => {
    const harness = createHarness(async () => "content");
    harness.runTurn();
    harness.runTurn();
    await harness.reports.dispose();

    const prompt = String(
      harness.mailbox.enqueued.find((mail) => mail.kind === "report")?.prompt ?? "",
    );
    expect(prompt.startsWith("<paseo-system>\n")).toBe(true);
    expect(prompt.endsWith("\n</paseo-system>")).toBe(true);
    // The envelope closes exactly once: no stray content leaked past it.
    expect(prompt.match(/<\/paseo-system>/g)).toHaveLength(1);
  });
});

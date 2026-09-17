import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { createStub } from "../test-utils/class-mocks.js";
import { SlpControlTurns } from "./control-turns.js";
import {
  SLP_DISPATCH_ATTEMPTS,
  SlpMailbox,
  type SlpMailboxAgentManager,
  type SlpMailInput,
  type SlpSlotDestination,
} from "./mailbox.js";

const GROUP = "grp_dispatch";
const SLOT = "slot_lead";

const ACTIVE: SlpSlotDestination = { status: "active", agentId: "agt_lead", generationId: "gen_1" };
const HELD: SlpSlotDestination = { status: "held", reason: "transfer" };

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  payload: Record<string, unknown>;
}

/** Captures every call instead of writing anywhere, so a test can assert on what admission logged. */
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
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
  return { logger: logger as unknown as Logger, records };
}

function isEnteringWait(record: CapturedLog): boolean {
  return record.level === "debug" && record.message === "SLP mail delivery is waiting";
}

function isLeavingWait(record: CapturedLog): boolean {
  return record.level === "info" && record.message === "SLP mail delivery resumed after a wait";
}

interface Harness {
  mailbox: SlpMailbox;
  controlTurns: SlpControlTurns;
  /** Mail ids in the order admission received them. */
  admitted: string[];
  /** Everything logged through this mailbox's logger. */
  logRecords: CapturedLog[];
  /** Resolves once the condition holds. */
  until: (done: () => boolean) => Promise<void>;
  /** Resolves once the record is durable in the given state. */
  reaches: (mailId: string, state: string) => Promise<void>;
  releaseAdmission: () => void;
  /** Fires the terminal turn-boundary event `nextTurnBoundary` waits on for this agent. */
  endTurn: (agentId: string) => void;
}

/**
 * The dispatch loop on its own. `resolveSlot` is the one synchronous seam
 * inside a running loop, so a test can act at the exact moment the loop still
 * owns the slot's pump entry and is one statement from exiting. Holding
 * admission pins the loop to a known iteration, so no assertion depends on
 * which of two pending operations happens to finish first.
 */
describe("SLP mail dispatch loop", () => {
  let directory: string;
  const open: SlpMailbox[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "slp-dispatch-"));
  });

  afterEach(async () => {
    for (const mailbox of open.splice(0)) await mailbox.close();
    await rm(directory, { recursive: true, force: true });
  });

  function createMailbox(options: {
    resolveSlot: () => SlpSlotDestination;
    holdAdmission?: boolean;
    /** Runs before every dispatch; throwing stands in for a failure to load the agent. */
    beforeDispatch?: () => void;
    /** What admission answers; defaults to taking the turn. */
    admit?: () => { status: "started" | "busy" | "steered" };
  }): Harness {
    const admitted: string[] = [];
    const controlTurns = new SlpControlTurns();
    const waiters: Array<{ done: () => boolean; resolve: () => void }> = [];
    const settle = (): void => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.done()) waiter.resolve();
        else waiters.push(waiter);
      }
    };
    const until = (done: () => boolean): Promise<void> => {
      const waiting = new Promise<void>((resolve) => {
        waiters.push({ done, resolve });
        settle();
      });
      // A dispatch that throws changes nothing durable, so a condition about
      // retries has no change to ride on; every other wait settles on one.
      const tick = setInterval(settle, 1);
      return waiting.finally(() => clearInterval(tick));
    };
    let releaseAdmission: () => void = () => undefined;
    const admissionReleased = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const { logger, records: logRecords } = createCapturingLogger();
    interface StateEvent {
      type: "agent_state";
      agent: { lifecycle: "idle" };
    }
    const listeners = new Set<{ agentId?: string; callback: (event: StateEvent) => void }>();
    const mailbox = new SlpMailbox({
      directory: path.join(directory, "mail"),
      logger,
      agentManager: createStub<SlpMailboxAgentManager>({
        waitForAgentClose: async () => undefined,
        getAgent: () => {
          options.beforeDispatch?.();
          return createStub<ManagedAgent>({});
        },
        subscribe: (
          callback: (event: StateEvent) => void,
          subscribeOptions?: { agentId?: string },
        ) => {
          const entry = { agentId: subscribeOptions?.agentId, callback };
          listeners.add(entry);
          return () => listeners.delete(entry);
        },
        admitForegroundTurn: async (
          _agentId: string,
          _prompt: unknown,
          admission?: { clientMessageId?: string },
        ) => {
          admitted.push(admission?.clientMessageId ?? "");
          settle();
          if (options.holdAdmission && admitted.length === 1) await admissionReleased;
          return options.admit?.() ?? { status: "started" as const };
        },
      }),
      agentStorage: createStub<AgentStorage>({}),
      resolveSlot: options.resolveSlot,
      now: () => new Date("2026-09-16T00:00:00.000Z"),
      onChange: () => settle(),
      controlTurns,
    });
    open.push(mailbox);
    return {
      mailbox,
      controlTurns,
      admitted,
      logRecords,
      until,
      reaches: (mailId, state) => until(() => mailbox.get(mailId)?.state === state),
      releaseAdmission,
      endTurn: (agentId) => {
        for (const entry of listeners) {
          if (entry.agentId && entry.agentId !== agentId) continue;
          entry.callback({ type: "agent_state", agent: { lifecycle: "idle" } });
        }
      },
    };
  }

  function message(text: string): SlpMailInput {
    return { groupId: GROUP, slotId: SLOT, fromSlotId: null, kind: "message", prompt: text };
  }

  function activation(): SlpMailInput {
    return {
      groupId: GROUP,
      slotId: SLOT,
      fromSlotId: null,
      kind: "activation",
      prompt: "You are now the active Lead for this slot.",
    };
  }

  function report(text: string): SlpMailInput {
    return {
      groupId: GROUP,
      slotId: SLOT,
      fromSlotId: "slot_lead_1",
      kind: "report",
      prompt: text,
    };
  }

  test("a wake-up that arrives while the loop is exiting is not lost", async () => {
    let calls = 0;
    let mailbox: SlpMailbox | null = null;
    const harness = createMailbox({
      holdAdmission: true,
      resolveSlot: () => {
        calls += 1;
        if (calls !== 2) return ACTIVE;
        // The loop has already registered its pump entry and returns on the
        // next statement: the window where this wake-up used to be dropped
        // with no loop left to honour it.
        mailbox?.pump(GROUP, SLOT);
        return HELD;
      },
    });
    mailbox = harness.mailbox;

    const first = await harness.mailbox.enqueue(message("first"));
    // Pins the loop inside its first dispatch, so the second message is
    // certain to be queued before the loop looks for more work.
    await harness.until(() => harness.admitted.length === 1);
    const second = await harness.mailbox.enqueue(message("second"));
    harness.releaseAdmission();

    // Without the fix nothing re-enters the loop and this never settles.
    await harness.reaches(second.id, "accepted");
    expect(calls).toBe(3);
    expect(harness.admitted).toEqual([first.id, second.id]);
    expect(harness.mailbox.get(first.id)?.state).toBe("accepted");
  });

  test("a loop that exits on a held slot waits for the next wake-up instead of spinning", async () => {
    let calls = 0;
    const harness = createMailbox({
      resolveSlot: () => {
        calls += 1;
        if (calls > 5) throw new Error("the dispatch loop spun on a held slot");
        return HELD;
      },
    });

    const queued = await harness.mailbox.enqueue(message("held"));
    await harness.mailbox.close();

    expect(calls).toBe(1);
    expect(harness.admitted).toEqual([]);
    expect(harness.mailbox.get(queued.id)?.state).toBe("queued");
  });

  test("the runtime claims the turn its own control message starts", async () => {
    const harness = createMailbox({ resolveSlot: () => ACTIVE });

    const notice = await harness.mailbox.enqueue(activation());
    await harness.reaches(notice.id, "accepted");

    expect(harness.controlTurns.settle(ACTIVE.agentId)).toBe(true);
  });

  test("a control message merged into someone else's turn leaves that turn theirs", async () => {
    // The mailbox never asks to steer, so this is admission answering for a
    // turn the mailbox did not start. Suppressing its report would swallow the
    // final message of whoever does own it.
    const harness = createMailbox({
      resolveSlot: () => ACTIVE,
      admit: () => ({ status: "steered" }),
    });

    const notice = await harness.mailbox.enqueue(activation());
    await harness.reaches(notice.id, "accepted");

    expect(harness.controlTurns.settle(ACTIVE.agentId)).toBe(false);
  });

  test("an ordinary message never claims the turn it starts", async () => {
    const harness = createMailbox({ resolveSlot: () => ACTIVE });

    const queued = await harness.mailbox.enqueue(message("Review the trace"));
    await harness.reaches(queued.id, "accepted");

    expect(harness.controlTurns.settle(ACTIVE.agentId)).toBe(false);
  });

  test("a dispatch that fails before admission is retried instead of stranding the message", async () => {
    let loads = 0;
    const harness = createMailbox({
      resolveSlot: () => ACTIVE,
      beforeDispatch: () => {
        loads += 1;
        if (loads <= 2) throw new Error("the agent could not be loaded");
      },
    });

    const queued = await harness.mailbox.enqueue(message("after a transient failure"));
    await harness.reaches(queued.id, "accepted");

    expect(loads).toBe(3);
    expect(harness.admitted).toEqual([queued.id]);
  });

  test("a dispatch that keeps failing defers delivery instead of abandoning it", async () => {
    let loads = 0;
    const harness = createMailbox({
      resolveSlot: () => ACTIVE,
      beforeDispatch: () => {
        loads += 1;
        if (loads <= SLP_DISPATCH_ATTEMPTS) throw new Error("the agent could not be loaded");
      },
    });

    const queued = await harness.mailbox.enqueue(message("while the agent cannot load"));
    await harness.until(() => loads >= SLP_DISPATCH_ATTEMPTS);

    // The loop stops rather than retrying forever, and the message stays the
    // durable record of a send that has not been delivered.
    expect(harness.admitted).toEqual([]);
    expect(harness.mailbox.get(queued.id)?.state).toBe("queued");

    // The next wake-up, or the pump every restart performs, picks it up again.
    harness.mailbox.pump(GROUP, SLOT);
    await harness.reaches(queued.id, "accepted");
    expect(harness.admitted).toEqual([queued.id]);
  });

  test("an immediate admission logs nothing about waiting", async () => {
    const harness = createMailbox({ resolveSlot: () => ACTIVE });

    const queued = await harness.mailbox.enqueue(message("fast"));
    await harness.reaches(queued.id, "accepted");

    expect(harness.logRecords.filter((record) => record.message.includes("wait"))).toEqual([]);
  });

  test("a held slot logs the wait's reason on entry and its duration on the way out", async () => {
    let calls = 0;
    const harness = createMailbox({
      resolveSlot: () => {
        calls += 1;
        return calls <= 2 ? HELD : ACTIVE;
      },
    });

    const queued = await harness.mailbox.enqueue(message("waits on hold"));
    await harness.until(() => calls >= 1);
    harness.mailbox.pump(GROUP, SLOT);
    await harness.until(() => calls >= 2);
    harness.mailbox.pump(GROUP, SLOT);
    await harness.reaches(queued.id, "accepted");

    const entering = harness.logRecords.filter(isEnteringWait);
    // Logged once even though the loop re-checked the same held reason twice.
    expect(entering).toHaveLength(1);
    expect(entering[0]?.payload).toMatchObject({ mailId: queued.id, reason: "held" });
    const leaving = harness.logRecords.find(isLeavingWait);
    expect(leaving?.payload).toMatchObject({ mailId: queued.id, reason: "held" });
    expect(leaving?.payload.waitMs).toBeGreaterThanOrEqual(0);
  });

  test("a busy answer logs the wait as busy and its duration once the turn ends", async () => {
    let admitCalls = 0;
    const harness = createMailbox({
      resolveSlot: () => ACTIVE,
      admit: () => {
        admitCalls += 1;
        return admitCalls === 1 ? { status: "busy" as const } : { status: "started" as const };
      },
    });

    const queued = await harness.mailbox.enqueue(message("busy recipient"));
    await harness.until(() => harness.logRecords.some(isEnteringWait));
    const entering = harness.logRecords.find(isEnteringWait);
    expect(entering?.payload).toMatchObject({ mailId: queued.id, reason: "busy" });

    // Nothing but the turn's own boundary should release this wait.
    expect(harness.logRecords.some(isLeavingWait)).toBe(false);
    harness.endTurn(ACTIVE.agentId);
    await harness.reaches(queued.id, "accepted");

    const leaving = harness.logRecords.find(isLeavingWait);
    expect(leaving?.payload).toMatchObject({ mailId: queued.id, reason: "busy" });
    expect(leaving?.payload.waitMs).toBeGreaterThanOrEqual(0);
  });

  test("appendToQueuedReport merges into a report still queued for the slot instead of adding a second one", async () => {
    const harness = createMailbox({ resolveSlot: () => HELD });
    const first = await harness.mailbox.enqueue(report("first report"));

    const appended = await harness.mailbox.appendToQueuedReport(
      GROUP,
      SLOT,
      (existing) => `${existing}\nsecond report`,
    );

    expect(appended).toBe(true);
    expect(harness.mailbox.list().filter((record) => record.kind === "report")).toHaveLength(1);
    expect(harness.mailbox.get(first.id)).toMatchObject({
      state: "queued",
      prompt: "first report\nsecond report",
    });
  });

  test("appendToQueuedReport returns false when no report is queued for the slot", async () => {
    const harness = createMailbox({ resolveSlot: () => ACTIVE });

    const appended = await harness.mailbox.appendToQueuedReport(
      GROUP,
      SLOT,
      (existing) => existing,
    );

    expect(appended).toBe(false);
  });

  test("appendToQueuedReport will not touch a report dispatch already owns", async () => {
    const harness = createMailbox({ resolveSlot: () => ACTIVE, holdAdmission: true });
    const queued = await harness.mailbox.enqueue(report("first report"));
    await harness.until(() => harness.admitted.length === 1);

    const appended = await harness.mailbox.appendToQueuedReport(
      GROUP,
      SLOT,
      (existing) => `${existing}\nsecond report`,
    );
    expect(appended).toBe(false);

    harness.releaseAdmission();
    await harness.reaches(queued.id, "accepted");
    expect(harness.mailbox.get(queued.id)?.prompt).toBe("first report");
  });
});

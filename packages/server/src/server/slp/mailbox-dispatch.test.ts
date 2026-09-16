import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { createStub } from "../test-utils/class-mocks.js";
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

interface Harness {
  mailbox: SlpMailbox;
  /** Mail ids in the order admission received them. */
  admitted: string[];
  /** Resolves once the condition holds. */
  until: (done: () => boolean) => Promise<void>;
  /** Resolves once the record is durable in the given state. */
  reaches: (mailId: string, state: string) => Promise<void>;
  releaseAdmission: () => void;
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
  }): Harness {
    const admitted: string[] = [];
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
    const mailbox = new SlpMailbox({
      directory: path.join(directory, "mail"),
      logger: createTestLogger(),
      agentManager: createStub<SlpMailboxAgentManager>({
        waitForAgentClose: async () => undefined,
        getAgent: () => {
          options.beforeDispatch?.();
          return createStub<ManagedAgent>({});
        },
        subscribe: () => () => undefined,
        admitForegroundTurn: async (
          _agentId: string,
          _prompt: unknown,
          admission?: { clientMessageId?: string },
        ) => {
          admitted.push(admission?.clientMessageId ?? "");
          settle();
          if (options.holdAdmission && admitted.length === 1) await admissionReleased;
          return { status: "started" as const };
        },
      }),
      agentStorage: createStub<AgentStorage>({}),
      resolveSlot: options.resolveSlot,
      now: () => new Date("2026-09-16T00:00:00.000Z"),
      onChange: () => settle(),
    });
    open.push(mailbox);
    return {
      mailbox,
      admitted,
      until,
      reaches: (mailId, state) => until(() => mailbox.get(mailId)?.state === state),
      releaseAdmission,
    };
  }

  function message(text: string): SlpMailInput {
    return { groupId: GROUP, slotId: SLOT, fromSlotId: null, kind: "message", prompt: text };
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
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { createHeldTurnClient } from "../test-utils/held-turn-agent-client.js";
import { AgentManager, type AgentManagerEvent, type ManagedAgent } from "./agent-manager.js";

const logger = createTestLogger();

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const workdir = mkdtempSync(join(tmpdir(), "agent-admission-"));
  const client = createHeldTurnClient({ provider: "codex" });
  const manager = new AgentManager({ clients: { codex: client }, logger });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  cleanups.push(async () => {
    await manager.closeAgent(agent.id).catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  });
  const session = client.sessions[0]!;
  return { manager, agentId: agent.id, session };
}

function waitForLifecycle(
  manager: AgentManager,
  agentId: string,
  lifecycle: ManagedAgent["lifecycle"],
): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(
      (event: AgentManagerEvent) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === agentId &&
          event.agent.lifecycle === lifecycle
        ) {
          unsubscribe();
          resolve();
        }
      },
      { agentId, replayState: false },
    );
  });
}

test("streamAgent claims the run slot synchronously, before the generator is iterated", async () => {
  // docs/slp/admission.md: check-and-claim in one tick is the whole admission
  // mechanism. If this ever needs an await, admitForegroundTurn is unsound.
  const { manager, agentId, session } = await fixture();
  expect(manager.hasInFlightRun(agentId)).toBe(false);
  const iterator = manager.streamAgent(agentId, "first");
  expect(manager.hasInFlightRun(agentId)).toBe(true);
  expect(() => manager.streamAgent(agentId, "second")).toThrow("already has an active run");
  expect(session.startCount).toBe(0);

  const drained = (async () => {
    for await (const _ of iterator) {
    }
  })();
  await manager.waitForAgentRunStart(agentId);
  session.release();
  await drained;
  expect(manager.hasInFlightRun(agentId)).toBe(false);
});

test("concurrent admissions have exactly one winner and the loser cancels nothing", async () => {
  const { manager, agentId, session } = await fixture();
  const idle = waitForLifecycle(manager, agentId, "idle");

  const results = await Promise.all([
    manager.admitForegroundTurn(agentId, "a"),
    manager.admitForegroundTurn(agentId, "b"),
    manager.admitForegroundTurn(agentId, "c"),
  ]);

  // Losers may observe the winner before or after it reaches started, so the
  // turn id they report is not pinned; the statuses are.
  expect(results.map((result) => result.status)).toEqual(["started", "busy", "busy"]);

  await manager.waitForAgentRunStart(agentId);
  expect(session.startCount).toBe(1);
  expect(session.interruptCount).toBe(0);
  expect(await manager.admitForegroundTurn(agentId, "late")).toEqual({
    status: "busy",
    turnId: "held-turn-1",
  });

  session.release();
  await idle;
  expect(session.interruptCount).toBe(0);
  const secondIdle = waitForLifecycle(manager, agentId, "idle");
  expect(await manager.admitForegroundTurn(agentId, "next")).toEqual({ status: "started" });
  await manager.waitForAgentRunStart(agentId);
  expect(session.startCount).toBe(2);
  session.release();
  await secondIdle;
});

test("an admitted turn is drained by the manager so an ignored result cannot strand the slot", async () => {
  const { manager, agentId, session } = await fixture();
  const idle = waitForLifecycle(manager, agentId, "idle");
  await manager.admitForegroundTurn(agentId, "ignored by caller");
  await manager.waitForAgentRunStart(agentId);
  session.release();
  await idle;
  expect(manager.hasInFlightRun(agentId)).toBe(false);
});

test("admission drains queued session events before answering busy", async () => {
  const { manager, agentId, session } = await fixture();
  const idle = waitForLifecycle(manager, agentId, "idle");
  await manager.admitForegroundTurn(agentId, "first");
  await manager.waitForAgentRunStart(agentId);

  // release() enqueues turn_completed on the session-event chain; the state
  // still reads running in this tick. Admission must not answer from it.
  session.release();
  expect(manager.hasInFlightRun(agentId)).toBe(true);
  expect(await manager.admitForegroundTurn(agentId, "second")).toEqual({ status: "started" });
  await idle;
  await manager.waitForAgentRunStart(agentId);
  expect(session.startCount).toBe(2);
  expect(session.interruptCount).toBe(0);
  session.release();
  await waitForLifecycle(manager, agentId, "idle");
});

test("steer admission delivers into the live turn without cancelling it", async () => {
  const { manager, agentId, session } = await fixture();
  session.steerBehavior = "accepted";
  const idle = waitForLifecycle(manager, agentId, "idle");
  await manager.admitForegroundTurn(agentId, "first");
  await manager.waitForAgentRunStart(agentId);

  expect(await manager.admitForegroundTurn(agentId, "aside", { steer: true })).toEqual({
    status: "steered",
  });
  expect(session.steerPrompts).toEqual(["aside"]);
  expect(session.interruptCount).toBe(0);

  session.steerBehavior = "unavailable";
  expect(await manager.admitForegroundTurn(agentId, "again", { steer: true })).toEqual({
    status: "busy",
    turnId: "held-turn-1",
  });
  session.release();
  await idle;
});

test("a pending replacement keeps the slot reserved even after the cancelled turn fails", async () => {
  const { manager, agentId, session } = await fixture();
  await manager.admitForegroundTurn(agentId, "first");
  await manager.waitForAgentRunStart(agentId);

  // Fail the cancelled turn so lifecycle drops to error and hasInFlightRun
  // goes false while the replacement is still pending.
  session.interruptBehavior = "failed";
  const replacement = manager.replaceAgentRun(agentId, "replacement");
  const admission = manager.admitForegroundTurn(agentId, "scheduled");

  const iterator = await replacement;
  expect(await admission).toEqual({ status: "busy", turnId: null });
  const drained = (async () => {
    for await (const _ of iterator) {
    }
  })();
  await manager.waitForAgentRunStart(agentId);
  expect(session.startCount).toBe(2);
  session.release();
  await drained;
});

test("a throwing subscriber does not starve later subscribers or the dispatching turn", async () => {
  const { manager, agentId, session } = await fixture();
  const seenAfter: string[] = [];
  const unsubscribeThrowing = manager.subscribe(
    (event) => {
      if (event.type === "agent_stream") throw new Error("subscriber bug");
    },
    { agentId, replayState: false },
  );
  const unsubscribeLater = manager.subscribe(
    (event) => {
      if (event.type === "agent_stream") seenAfter.push(event.event.type);
    },
    { agentId, replayState: false },
  );
  const idle = waitForLifecycle(manager, agentId, "idle");

  expect(await manager.admitForegroundTurn(agentId, "hello")).toEqual({ status: "started" });
  await manager.waitForAgentRunStart(agentId);
  session.release();
  await idle;

  expect(seenAfter).toContain("turn_started");
  expect(seenAfter).toContain("turn_completed");
  expect(manager.getAgent(agentId)?.lifecycle).toBe("idle");
  unsubscribeThrowing();
  unsubscribeLater();
});

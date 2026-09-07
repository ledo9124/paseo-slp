import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

/**
 * A session whose turns finish only when the test releases them, so busy
 * windows are deterministic rather than timer-shaped.
 */
class HeldTurnSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  startCount = 0;
  interruptCount = 0;
  steerCount = 0;
  steerAvailable = false;
  private activeTurnId: string | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(_prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = `held-turn-${++this.startCount}`;
    this.activeTurnId = turnId;
    setImmediate(() => this.emit({ type: "turn_started", provider: this.provider, turnId }));
    return { turnId };
  }

  release(): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no held turn to release");
    this.activeTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  async steerActiveTurn(
    _prompt: AgentPromptInput,
    _options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.steerCount += 1;
    return this.steerAvailable ? { status: "accepted" } : { status: "unavailable" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_id: string, _response: AgentPermissionResponse): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    if (turnId) this.emit({ type: "turn_canceled", provider: this.provider, turnId });
  }

  async close(): Promise<void> {}

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

class HeldTurnClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly sessions: HeldTurnSession[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    const session = new HeldTurnSession();
    this.sessions.push(session);
    return session;
  }

  async resumeSession(_handle: AgentPersistenceHandle): Promise<AgentSession> {
    return this.createSession({ provider: this.provider, cwd: process.cwd() });
  }

  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return { models: [], modes: [] };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const workdir = mkdtempSync(join(tmpdir(), "agent-admission-"));
  const client = new HeldTurnClient();
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

function waitForLifecycle(manager: AgentManager, agentId: string, lifecycle: string) {
  return new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(
      (event: AgentManagerEvent) => {
        if (event.type === "agent_state" && event.agent.lifecycle === lifecycle) {
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

  expect(results.filter((result) => result.status === "started")).toHaveLength(1);
  expect(results.filter((result) => result.status === "busy")).toHaveLength(2);
  expect(results[0]).toEqual({ status: "started" });

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
  expect(await manager.admitForegroundTurn(agentId, "next")).toEqual({ status: "started" });
  await manager.waitForAgentRunStart(agentId);
  expect(session.startCount).toBe(2);
  session.release();
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

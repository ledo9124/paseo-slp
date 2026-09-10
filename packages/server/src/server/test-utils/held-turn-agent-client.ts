import { randomUUID } from "node:crypto";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "../agent/agent-sdk-types.js";

const HELD_TURN_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface HeldTurnClientOptions {
  provider: AgentProvider;
  /** When set, `release()` emits this assistant message before completing the turn. */
  releaseText?: string;
}

interface HeldTurnSessionOptions extends HeldTurnClientOptions {
  /** A resumed session keeps its handle's id so a test can find it by the agent's persistence. */
  id?: string;
}

/**
 * A session whose turns finish only when the test calls `release()`, so busy
 * windows are deterministic rather than timer-shaped. `turn_started` is
 * emitted synchronously from `startTurn` so no late event can outlive the turn.
 */
export class HeldTurnSession implements AgentSession {
  readonly provider: AgentProvider;
  readonly capabilities = HELD_TURN_CAPABILITIES;
  readonly id: string;
  startCount = 0;
  interruptCount = 0;
  startPrompts: string[] = [];
  steerPrompts: string[] = [];
  steerBehavior: "accepted" | "unavailable" = "unavailable";
  /** How `interrupt()` ends the held turn. */
  interruptBehavior: "canceled" | "failed" = "canceled";
  /** Resolves the first time `startTurn` is called. */
  readonly startSeen: Promise<void>;
  /** Resolves the first time `steerActiveTurn` is called. */
  readonly steerSeen: Promise<void>;
  private readonly resolveStartSeen: () => void;
  private readonly resolveSteerSeen: () => void;
  private readonly releaseText: string | undefined;
  private activeTurnId: string | null = null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(options: HeldTurnSessionOptions) {
    this.provider = options.provider;
    this.id = options.id ?? randomUUID();
    this.releaseText = options.releaseText;
    const start = createDeferred();
    const steer = createDeferred();
    this.startSeen = start.promise;
    this.resolveStartSeen = start.resolve;
    this.steerSeen = steer.promise;
    this.resolveSteerSeen = steer.resolve;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    const turnId = `held-turn-${++this.startCount}`;
    this.activeTurnId = turnId;
    this.emit({ type: "turn_started", provider: this.provider, turnId });
    this.resolveStartSeen();
    return { turnId };
  }

  release(): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no held turn to release");
    this.activeTurnId = null;
    if (this.releaseText !== undefined) {
      this.emit({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: this.releaseText },
      });
    }
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  /** End the held turn the way a provider failure does, so the agent reaches an error lifecycle. */
  fail(error = "provider failed"): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("no held turn to fail");
    this.activeTurnId = null;
    this.emit({ type: "turn_failed", provider: this.provider, turnId, error });
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    _options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.steerPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    this.resolveSteerSeen();
    return { status: this.steerBehavior };
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
    if (!turnId) return;
    if (this.interruptBehavior === "failed") {
      this.emit({ type: "turn_failed", provider: this.provider, turnId, error: "interrupted" });
      return;
    }
    this.emit({ type: "turn_canceled", provider: this.provider, turnId });
  }

  async close(): Promise<void> {}

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

export class HeldTurnClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = HELD_TURN_CAPABILITIES;
  readonly sessions: HeldTurnSession[] = [];
  private readonly options: HeldTurnClientOptions;

  constructor(options: HeldTurnClientOptions) {
    this.provider = options.provider;
    this.options = options;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    const session = new HeldTurnSession(this.options);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    const session = new HeldTurnSession({ ...this.options, id: handle.sessionId });
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog(): Promise<{ models: AgentModelDefinition[]; modes: AgentMode[] }> {
    return { models: [], modes: [] };
  }
}

export function createHeldTurnClient(options: HeldTurnClientOptions): HeldTurnClient {
  return new HeldTurnClient(options);
}

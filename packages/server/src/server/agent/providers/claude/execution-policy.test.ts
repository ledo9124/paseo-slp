import type { HookCallback, HookInput, Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { createStub } from "../../../test-utils/class-mocks.js";
import type { AgentExecutionPolicy, AgentLaunchContext } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";
import { decidePreparationToolUse } from "./execution-policy.js";
import type { ClaudeOptions, ClaudeQueryInput } from "./query.js";

const PREPARING: AgentExecutionPolicy = {
  kind: "preparation",
  reason: "transfer tr_1 prepares it",
};
const AUTHORIZED: AgentExecutionPolicy = { kind: "authorized" };
const DENIED = {
  hookSpecificOutput: expect.objectContaining({
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
  }),
};

function createQueryMock(): Query {
  const events: unknown[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "policy-session",
      permissionMode: "bypassPermissions",
      model: "opus",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
  let index = 0;
  return createStub<Query>({
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  });
}

function preToolUse(toolName: string): HookInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: "policy-session",
    transcript_path: "/tmp/transcript",
    cwd: process.cwd(),
    tool_name: toolName,
    tool_input: {},
    tool_use_id: "toolu_1",
  };
}

/** Runs every PreToolUse hook the options registered and returns their decisions. */
async function runPreToolUseHooks(options: ClaudeOptions, toolName: string) {
  const hooks: HookCallback[] = (options.hooks?.PreToolUse ?? []).flatMap(
    (matcher) => matcher.hooks,
  );
  return Promise.all(
    hooks.map((hook) =>
      hook(preToolUse(toolName), "toolu_1", { signal: new AbortController().signal }),
    ),
  );
}

describe("decidePreparationToolUse", () => {
  test("lets everything through when the agent is authorized", () => {
    expect(decidePreparationToolUse(AUTHORIZED, "Bash")).toEqual({});
  });

  test("denies writes, shell, delegation, web and foreign MCP tools while preparing", () => {
    for (const tool of [
      "Bash",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Task",
      "Agent",
      "WebFetch",
      "mcp__github__create_issue",
    ]) {
      expect(decidePreparationToolUse(PREPARING, tool)).toEqual(DENIED);
    }
  });

  test("keeps reads and the daemon's own tools while preparing", () => {
    for (const tool of [
      "Read",
      "Glob",
      "Grep",
      "LS",
      "NotebookRead",
      "mcp__paseo__slp_ready",
      "mcp__paseo__list_agents",
    ]) {
      expect(decidePreparationToolUse(PREPARING, tool)).toEqual({});
    }
  });
});

describe("Claude execution policy hook", () => {
  test("is registered on create and resume, decided per call, next to the observation hooks", async () => {
    let policy: AgentExecutionPolicy = PREPARING;
    const launchContext: AgentLaunchContext = { resolveExecutionPolicy: () => policy };
    const captured: ClaudeOptions[] = [];
    const queryFactory = vi.fn(({ options }: ClaudeQueryInput) => {
      captured.push(options);
      return createQueryMock();
    });
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });

    const created = await client.createSession(
      { provider: "claude", cwd: process.cwd(), modeId: "bypassPermissions" },
      launchContext,
    );
    try {
      await created.run("prepare");
    } finally {
      await created.close();
    }
    const resumed = await client.resumeSession(
      { provider: "claude", sessionId: "policy-session", metadata: { cwd: process.cwd() } },
      { cwd: process.cwd(), modeId: "bypassPermissions" },
      launchContext,
    );
    try {
      await resumed.run("prepare again");
    } finally {
      await resumed.close();
    }

    const [createOptions, resumeOptions] = captured;
    if (!createOptions || !resumeOptions) throw new Error("expected a create and a resume launch");
    for (const options of [createOptions, resumeOptions]) {
      expect(options.permissionMode).toBe("bypassPermissions");
      // The effort observation hook still runs beside the gate.
      expect(options.hooks?.PreToolUse).toHaveLength(2);
      expect(options.hooks?.PostToolUse).toHaveLength(1);
      expect(await runPreToolUseHooks(options, "Bash")).toContainEqual(DENIED);
      expect(await runPreToolUseHooks(options, "Read")).not.toContainEqual(DENIED);
      expect(await runPreToolUseHooks(options, "mcp__paseo__slp_ready")).not.toContainEqual(DENIED);
    }
    // Lifting the policy needs no restart: the same registered hook now allows.
    policy = AUTHORIZED;
    expect(await runPreToolUseHooks(createOptions, "Bash")).not.toContainEqual(DENIED);
  });

  test("registers no gate for a session launched without a policy resolver", async () => {
    let options: ClaudeOptions | undefined;
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: vi.fn((input: ClaudeQueryInput) => {
        options = input.options;
        return createQueryMock();
      }),
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
    try {
      await session.run("plain");
    } finally {
      await session.close();
    }
    expect(options?.hooks?.PreToolUse).toHaveLength(1);
  });
});

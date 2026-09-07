import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals, createStub } from "../../test-utils/class-mocks.js";
import type { AgentExecutionPolicy, AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import {
  CodexAppServerAgentSession,
  CodexPreparationSandboxError,
} from "./codex-app-server-agent.js";

interface CodexClientLike {
  request: (method: string, ...rest: unknown[]) => Promise<unknown>;
}

type CodexTestSession = AgentSession & {
  connected: boolean;
  currentThreadId: string | null;
  activeForegroundTurnId: string | null;
  client: CodexClientLike | null;
};

const PREPARING: AgentExecutionPolicy = {
  kind: "preparation",
  reason: "transfer tr_1 prepares it",
};
const AUTHORIZED: AgentExecutionPolicy = { kind: "authorized" };

/** A source with every write-enabling setting a copy could carry. */
const FULL_ACCESS_SOURCE: Partial<AgentSessionConfig> = {
  modeId: "full-access",
  providerOptions: {
    sandbox_mode: "danger-full-access",
    approval_policy: "never",
  },
};

function createSession(
  configOverrides: Partial<AgentSessionConfig>,
  resolveExecutionPolicy: () => AgentExecutionPolicy,
): CodexTestSession {
  const session = asInternals<CodexTestSession>(
    new CodexAppServerAgentSession(
      {
        provider: "codex",
        cwd: "/tmp/codex-policy-test",
        model: "gpt-5.4",
        thinkingOptionId: "medium",
        ...configOverrides,
      },
      null,
      createTestLogger(),
      () => {
        throw new Error("Test session cannot spawn Codex app-server");
      },
      {},
      false,
      false,
      false,
      "agent-1",
      "interactive",
      resolveExecutionPolicy,
    ),
  );
  session.connected = true;
  session.activeForegroundTurnId = null;
  return session;
}

function recordingClient(threadStartResponse: unknown = { thread: { id: "thread-1" } }) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = createStub<CodexClientLike>({
    request: vi.fn(async (method: string, params: unknown) => {
      requests.push({ method, params });
      if (method === "thread/loaded/list") return { data: ["thread-1"] };
      if (method === "thread/start") return threadStartResponse;
      if (method === "turn/start") return {};
      throw new Error(`Unexpected request: ${method}`);
    }),
  });
  const find = (method: string) => requests.find((request) => request.method === method)?.params;
  return { client, requests, find };
}

describe("Codex preparation policy", () => {
  test("overrides the copied full-access settings on thread start and turn start", async () => {
    const session = createSession(FULL_ACCESS_SOURCE, () => PREPARING);
    const { client, find } = recordingClient();
    session.currentThreadId = null;
    session.client = client;

    await session.startTurn("prepare");

    expect(find("thread/start")).toMatchObject({
      approvalPolicy: "never",
      sandbox: "read-only",
      config: { sandbox_mode: "read-only", approval_policy: "never" },
    });
    expect(find("thread/start")).not.toHaveProperty("approvalsReviewer");
    expect(find("turn/start")).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
      config: { sandbox_mode: "read-only", approval_policy: "never" },
    });
  });

  test("pre-approves the daemon's MCP tools while preparing so readiness can be acknowledged", async () => {
    let policy = PREPARING;
    const session = createSession(
      {
        ...FULL_ACCESS_SOURCE,
        mcpServers: { paseo: { type: "http", url: "http://127.0.0.1/mcp" } },
      },
      () => policy,
    );
    const { client, requests } = recordingClient();
    session.currentThreadId = "thread-1";
    session.client = client;

    await session.startTurn("prepare");
    session.activeForegroundTurnId = null;
    policy = AUTHORIZED;
    await session.startTurn("product work");

    const turns = requests.filter((request) => request.method === "turn/start");
    expect(turns[0]?.params).toMatchObject({
      config: { mcp_servers: { paseo: { default_tools_approval_mode: "approve" } } },
    });
    expect(turns[1]?.params).not.toHaveProperty(
      "config.mcp_servers.paseo.default_tools_approval_mode",
    );
  });

  test("restores the source's own settings on the first turn after the policy lifts", async () => {
    let policy = PREPARING;
    const session = createSession(FULL_ACCESS_SOURCE, () => policy);
    const { client, requests } = recordingClient();
    session.currentThreadId = "thread-1";
    session.client = client;

    await session.startTurn("prepare");
    session.activeForegroundTurnId = null;
    policy = AUTHORIZED;
    await session.startTurn("product work");

    const turns = requests.filter((request) => request.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.params).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
    expect(turns[1]?.params).toMatchObject({
      sandboxPolicy: { type: "dangerFullAccess" },
      config: { sandbox_mode: "danger-full-access", approval_policy: "never" },
    });
    expect(turns[1]?.params).not.toHaveProperty("approvalPolicy");
  });

  test("refuses a thread the app-server resolved with a writable sandbox", async () => {
    const session = createSession(FULL_ACCESS_SOURCE, () => PREPARING);
    const { client } = recordingClient({
      thread: { id: "thread-1" },
      sandbox: { type: "workspaceWrite", writableRoots: ["/tmp"] },
    });
    session.currentThreadId = null;
    session.client = client;

    await expect(session.startTurn("prepare")).rejects.toThrow(CodexPreparationSandboxError);
  });

  test("applies the mode preset when no policy resolver was supplied", async () => {
    const session = asInternals<CodexTestSession>(
      new CodexAppServerAgentSession(
        {
          provider: "codex",
          cwd: "/tmp/codex-policy-test",
          model: "gpt-5.4",
          thinkingOptionId: "medium",
          modeId: "auto",
        },
        null,
        createTestLogger(),
        () => {
          throw new Error("Test session cannot spawn Codex app-server");
        },
      ),
    );
    session.connected = true;
    session.activeForegroundTurnId = null;
    session.currentThreadId = "thread-1";
    const { client, find } = recordingClient();
    session.client = client;

    await session.startTurn("work");

    expect(find("turn/start")).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });
});

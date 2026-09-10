import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import type { AgentExecutionPolicy } from "../../agent-sdk-types.js";
import { PASEO_MCP_SERVER_NAME } from "../../runtime-mcp-config.js";
import type { ClaudeOptions } from "./query.js";

type ClaudeHooks = NonNullable<ClaudeOptions["hooks"]>;

/**
 * What a preparing agent may still run: the native read tools, and the
 * daemon's own MCP tools, which the daemon gates per call anyway. Everything
 * else is denied by name, so a tool this list does not know about is denied
 * rather than let through.
 */
const PREPARATION_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const PASEO_TOOL_PREFIX = `mcp__${PASEO_MCP_SERVER_NAME}__`;

export function decidePreparationToolUse(
  policy: AgentExecutionPolicy,
  toolName: string,
): HookJSONOutput {
  if (policy.kind === "authorized") return {};
  if (PREPARATION_READ_TOOLS.has(toolName) || toolName.startsWith(PASEO_TOOL_PREFIX)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${toolName} is not available while ${policy.reason}`,
    },
  };
}

/**
 * The pre-tool hook is the one gate that runs in every permission mode: in
 * bypass and auto modes a tool never reaches the permission callback. The
 * policy is resolved per call, so lifting it needs no session restart.
 */
export function buildExecutionPolicyHooks(resolve: () => AgentExecutionPolicy): ClaudeHooks {
  const gate: HookCallback = async (input) =>
    input.hook_event_name === "PreToolUse"
      ? decidePreparationToolUse(resolve(), input.tool_name)
      : {};
  return { PreToolUse: [{ hooks: [gate] }] };
}

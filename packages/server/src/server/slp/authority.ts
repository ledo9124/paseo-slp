import type { SlpRole } from "./store.js";

/**
 * Which Paseo tools an SLP role may call, and on which agents. This is a
 * policy, not a trust boundary: MCP caller identity is self-asserted, so the
 * runtime denies by convention and the docs say so. See
 * docs/slp/architecture.md#tool-and-write-boundaries.
 */

/** Tools that act on an agent id and therefore need a target check. */
export const SLP_AGENT_TARGET_TOOLS: ReadonlySet<string> = new Set([
  "send_agent_prompt",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
  "update_agent",
  "set_agent_mode",
  "respond_to_permission",
]);

/** Creation and every agent-targeting tool except sending: the Lead's alone. */
const LEAD_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "create_agent",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
  "update_agent",
  "set_agent_mode",
  "respond_to_permission",
]);

/** The SLP control channel: members only, never in an ordinary agent's catalog. */
export const SLP_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "slp_checkpoint",
  "slp_request_handoff",
  "slp_ready",
]);

/** All a candidate may execute during receive-only preparation. */
export const SLP_PREPARATION_TOOLS: ReadonlySet<string> = new Set(["slp_ready"]);

/**
 * A Peer has one channel to its Lead: the last message of the turn, which the
 * handback register delivers. Giving it `send_agent_prompt` as well delivered
 * results twice — the Peer mailed them and the runtime handed the same turn
 * back — and each duplicate cost the Lead a turn and the Supervisor another;
 * see docs/slp/evidence.md#round-three-codex-on-gpt-56-luna. Questions and
 * blockers travel the same way: state them and end the turn.
 */
const PEER_HIDDEN_TOOLS: ReadonlySet<string> = new Set([...LEAD_ONLY_TOOLS, "send_agent_prompt"]);

/** Tools an SLP role never sees in its catalog. */
const HIDDEN_TOOLS: Record<SlpRole, ReadonlySet<string>> = {
  supervisor: LEAD_ONLY_TOOLS,
  lead: new Set(),
  peer: PEER_HIDDEN_TOOLS,
};

export function isToolVisibleToRole(role: SlpRole, tool: string): boolean {
  return !HIDDEN_TOOLS[role].has(tool);
}

export type SlpRelation =
  | "self"
  | "owner"
  | "own-peer"
  | "supervisor"
  | "lead"
  | "other-member"
  | "outside";

/**
 * Directions from docs/slp/architecture.md#message-routing-and-delivery:
 * Supervisor writes to Lead; Lead writes to its Peers and Supervisor; a Peer
 * writes to nobody and reaches its Lead by ending its turn. Mutating tools
 * stay with the owner. MCP caller identity is self-asserted, so the target
 * check refuses a Peer send even though the catalog hides the tool.
 */
export function isTargetAllowed(role: SlpRole, tool: string, relation: SlpRelation): boolean {
  if (tool === "send_agent_prompt") {
    switch (role) {
      case "supervisor":
        return relation === "lead";
      case "lead":
        return relation === "own-peer" || relation === "supervisor";
      case "peer":
        return false;
    }
  }
  return role === "lead" && (relation === "own-peer" || relation === "self");
}

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

/** Tools an SLP role never sees in its catalog. */
const HIDDEN_TOOLS: Record<SlpRole, ReadonlySet<string>> = {
  supervisor: LEAD_ONLY_TOOLS,
  lead: new Set(),
  peer: LEAD_ONLY_TOOLS,
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
 * Supervisor writes to Lead; Lead writes to its Peers and Supervisor; Peer
 * writes to its Lead. Mutating tools stay with the owner.
 */
export function isTargetAllowed(role: SlpRole, tool: string, relation: SlpRelation): boolean {
  if (tool === "send_agent_prompt") {
    switch (role) {
      case "supervisor":
        return relation === "lead";
      case "lead":
        return relation === "own-peer" || relation === "supervisor";
      case "peer":
        return relation === "owner";
    }
  }
  return role === "lead" && (relation === "own-peer" || relation === "self");
}

import type { ProviderOptions } from "@getpaseo/protocol/agent-types";

import type { SlpRole } from "./store.js";

/**
 * A Codex member runs with Codex's own multi-agent tools removed: with
 * `agents.enabled = false` the `collaboration.*` tools (spawn_agent,
 * send_message, list_agents, wait_agent, …) leave the catalog on codex-cli
 * 0.153.4, which neither `features.multi_agent` nor `features.multi_agent_v2`
 * achieve. Without this a member reaches for the native tools first and its
 * report or Peer never enters the group; see docs/slp/evidence.md.
 *
 * `role` is omitted only by the Peer creation path (create-agent/create.ts),
 * which is always a Peer, so a missing role defaults to the same denial a
 * Peer gets. Only an explicit "supervisor" skips it: the Supervisor's prompt
 * says Human reads this chat directly, so a blocking question has a real
 * recipient. Peer and Lead do not — the SLP contract is "end your turn, the
 * reply arrives as mail" — and `AskUserQuestion` resolves to a permission
 * request the runtime cannot surface: the caller reports lifecycle `running`
 * while permission-blocked, and the attention push it needs is suppressed
 * for a delegated agent and never sent for a supervised Lead. See
 * docs/slp/evidence.md and docs/slp/architecture.md#admission.
 */
export function withSlpProviderOptions(
  provider: string,
  base: ProviderOptions | null | undefined,
  role?: SlpRole,
): ProviderOptions | null {
  const providerId = provider.split("/")[0] ?? provider;
  if (providerId === "claude") {
    // Agent (formerly Task) bypasses SLP Peer ownership, mail and handoff.
    const denied = Array.isArray(base?.disallowedTools) ? base.disallowedTools : [];
    const toDeny = role === "supervisor" ? ["Agent", "Task"] : ["Agent", "Task", "AskUserQuestion"];
    return { ...base, disallowedTools: [...new Set([...denied, ...toDeny])] };
  }
  if (providerId !== "codex") return base ?? null;
  const agents = base?.agents;
  const agentsTable = agents && typeof agents === "object" && !Array.isArray(agents) ? agents : {};
  return { ...base, agents: { ...agentsTable, enabled: false } };
}

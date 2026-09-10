import type { ProviderOptions } from "@getpaseo/protocol/agent-types";

/**
 * A Codex member runs with Codex's own multi-agent tools removed: with
 * `agents.enabled = false` the `collaboration.*` tools (spawn_agent,
 * send_message, list_agents, wait_agent, …) leave the catalog on codex-cli
 * 0.153.4, which neither `features.multi_agent` nor `features.multi_agent_v2`
 * achieve. Without this a member reaches for the native tools first and its
 * report or Peer never enters the group; see docs/slp/evidence.md.
 */
export function withSlpProviderOptions(
  provider: string,
  base: ProviderOptions | null | undefined,
): ProviderOptions | null {
  const providerId = provider.split("/")[0] ?? provider;
  if (providerId !== "codex") return base ?? null;
  const agents = base?.agents;
  const agentsTable = agents && typeof agents === "object" && !Array.isArray(agents) ? agents : {};
  return { ...base, agents: { ...agentsTable, enabled: false } };
}

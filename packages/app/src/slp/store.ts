import { useTranslation } from "react-i18next";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { slpGroupQueryKey } from "@/data/slp-group";
import { useReplicaQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/**
 * The daemon's SLP group for one workspace, as a replica: `slp.group.get`
 * seeds it and every `slp.group.update` push replaces it (see the push
 * router). The summary is the daemon's projection; the selectors below derive
 * per-agent facts from it rather than keeping any state of their own.
 */
export function useSlpGroup(serverId: string, workspaceId: string): SlpGroupSummary | null {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "slpGroups");
  const query = useReplicaQuery({
    queryKey: slpGroupQueryKey(serverId, workspaceId),
    pushEvent: "slp.group.update",
    enabled: Boolean(client && isConnected && supported && workspaceId),
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return (await client.slpGroupGet(workspaceId)).group;
    },
  });
  return query.data ?? null;
}

export interface SlpTransferView {
  id: string;
  phase: string;
  reason: string | null;
  /** This agent is the generation being replaced. */
  isSource: boolean;
  /** This agent is the generation being prepared to take over. */
  isCandidate: boolean;
}

export interface SlpMembership {
  role: string;
  slotId: string;
  generationNumber: number;
  generationState: string;
  /** Whether this agent is the one the Human is meant to talk to. */
  isContact: boolean;
  /** The slot's current agent; differs from the agent when it is retired or preparing. */
  activeAgentId: string | null;
  transfer: SlpTransferView | null;
}

const LIVE_TRANSFER_PHASES = new Set(["requested", "stopped", "preparing", "ready", "switched"]);

/** What one agent is inside its group, from the daemon's summary. Null when it is not a member. */
export function describeSlpMembership(
  group: SlpGroupSummary,
  agentId: string,
): SlpMembership | null {
  for (const slot of group.slots) {
    const generation = slot.generations.find((entry) => entry.agentId === agentId);
    if (!generation) continue;
    const transfer =
      group.transfers.find(
        (entry) =>
          entry.slotId === slot.id &&
          (LIVE_TRANSFER_PHASES.has(entry.phase) || entry.phase === "blocked") &&
          (entry.sourceAgentId === agentId || entry.candidateAgentId === agentId),
      ) ?? null;
    return {
      role: slot.role,
      slotId: slot.id,
      generationNumber: generation.number,
      generationState: generation.state,
      isContact: group.contactAgentId === agentId,
      activeAgentId: slot.activeAgentId,
      transfer: transfer
        ? {
            id: transfer.id,
            phase: transfer.phase,
            reason: transfer.reason,
            isSource: transfer.sourceAgentId === agentId,
            isCandidate: transfer.candidateAgentId === agentId,
          }
        : null,
    };
  }
  return null;
}

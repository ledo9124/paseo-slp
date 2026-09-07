import { useEffect } from "react";
import { create } from "zustand";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/**
 * One replica of the daemon's SLP groups per host, keyed by workspace. The
 * daemon pushes every change as `slp.group.update`; `slp.group.get` seeds a
 * workspace the first time a screen asks for it. The summary is the daemon's
 * projection, so the store keeps it as is and the selectors below derive
 * per-agent facts from it.
 */
interface SlpState {
  groups: Record<string, Record<string, SlpGroupSummary>>;
  setGroup: (serverId: string, workspaceId: string, group: SlpGroupSummary | null) => void;
}

export const useSlpStore = create<SlpState>((set) => ({
  groups: {},
  setGroup: (serverId, workspaceId, group) =>
    set((state) => {
      const host = { ...state.groups[serverId] };
      if (group) host[workspaceId] = group;
      else delete host[workspaceId];
      return { groups: { ...state.groups, [serverId]: host } };
    }),
}));

const updateSubscriptions = new Map<string, { count: number; unsubscribe: () => void }>();

/** Keeps one push subscription per host alive while any screen needs it. */
function retainUpdates(serverId: string, client: DaemonClient): () => void {
  const existing = updateSubscriptions.get(serverId);
  if (existing) {
    existing.count += 1;
  } else {
    const unsubscribe = client.on("slp.group.update", (message) => {
      const group = message.payload.group;
      useSlpStore.getState().setGroup(serverId, group.workspaceId, group);
    });
    updateSubscriptions.set(serverId, { count: 1, unsubscribe });
  }
  return () => {
    const entry = updateSubscriptions.get(serverId);
    if (!entry) return;
    entry.count -= 1;
    if (entry.count === 0) {
      entry.unsubscribe();
      updateSubscriptions.delete(serverId);
    }
  };
}

export function useSlpGroup(serverId: string, workspaceId: string): SlpGroupSummary | null {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "slpGroups");
  const group = useSlpStore((state) => state.groups[serverId]?.[workspaceId] ?? null);

  useEffect(() => {
    if (!client || !isConnected || !supported || !workspaceId) return;
    const release = retainUpdates(serverId, client);
    let cancelled = false;
    const seed = async () => {
      try {
        const payload = await client.slpGroupGet(workspaceId);
        if (!cancelled) useSlpStore.getState().setGroup(serverId, workspaceId, payload.group);
      } catch {
        // A failed seed leaves the replica empty; the next push or mount retries.
      }
    };
    void seed();
    return () => {
      cancelled = true;
      release();
    };
  }, [client, isConnected, supported, serverId, workspaceId]);

  return group;
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

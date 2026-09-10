import { useCallback, useMemo, useState } from "react";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { deriveWorkspaceAgentVisibility } from "@/workspace-tabs/agent-visibility";
import { useSlpGroup } from "./store";

/** What the composer offers for a workspace's first message: one agent, or an SLP group in one of its modes. */
export type SlpComposerMode = "single" | "direct" | "supervised";

export const SLP_COMPOSER_MODES: readonly SlpComposerMode[] = ["single", "direct", "supervised"];

/** Why the choice is pinned: the workspace already runs a group, or ordinary agents. */
export type SlpComposerLock = "group" | "agents";

export interface SlpModeControlValue {
  value: SlpComposerMode;
  lock: SlpComposerLock | null;
  onSelect: (mode: SlpComposerMode) => void;
}

function groupComposerMode(mode: string): SlpComposerMode {
  return mode === "supervised" ? "supervised" : "direct";
}

function noop(): void {}

/**
 * The workspace mode is chosen once, before the workspace's first agent runs,
 * and stays fixed after that: a group pins its own mode, ordinary agents pin
 * "single agent" until they are archived. Null on hosts without SLP groups.
 */
export function useSlpComposerMode(input: {
  serverId: string;
  workspaceId: string | null | undefined;
}): SlpModeControlValue | null {
  const { serverId, workspaceId } = input;
  const supported = useHostFeature(serverId, "slpGroups");
  const group = useSlpGroup(serverId, workspaceId ?? "");
  const hasAgents = useSessionStore((state) => {
    if (!workspaceId) return false;
    const session = state.sessions[serverId];
    return (
      deriveWorkspaceAgentVisibility({
        sessionAgents: session?.agents,
        agentDetails: session?.agentDetails,
        workspaceId,
      }).activeAgentIds.size > 0
    );
  });
  const [choice, setChoice] = useState<SlpComposerMode>("single");
  const onSelect = useCallback((mode: SlpComposerMode) => setChoice(mode), []);

  return useMemo<SlpModeControlValue | null>(() => {
    if (!supported || !workspaceId) return null;
    if (group) return { value: groupComposerMode(group.mode), lock: "group", onSelect: noop };
    if (hasAgents) return { value: "single", lock: "agents", onSelect: noop };
    return { value: choice, lock: null, onSelect };
  }, [choice, group, hasAgents, onSelect, supported, workspaceId]);
}

/**
 * The New workspace composer: no workspace exists yet, so nothing can pin
 * the choice. The chosen mode travels with the pending first message and the
 * workspace's draft tab starts the group from it.
 */
export function useSlpNewWorkspaceMode(input: { serverId: string }): SlpModeControlValue | null {
  const supported = useHostFeature(input.serverId, "slpGroups");
  const [choice, setChoice] = useState<SlpComposerMode>("single");
  const onSelect = useCallback((mode: SlpComposerMode) => setChoice(mode), []);
  return useMemo<SlpModeControlValue | null>(
    () => (supported ? { value: choice, lock: null, onSelect } : null),
    [choice, onSelect, supported],
  );
}

/** The group mode a composer's choice starts, or null for an ordinary agent. */
export function toSlpGroupMode(control: SlpModeControlValue | null): SlpGroupMode | null {
  const mode = control?.value;
  return mode === "direct" || mode === "supervised" ? mode : null;
}

export type SlpGroupMode = Exclude<SlpComposerMode, "single">;

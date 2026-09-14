import { slpDraftKey, useSlpDraftLaunchStore } from "./draft-state";
import { useSlpComposerMode, toSlpGroupMode } from "./composer-mode";
import type { SlpDraftLaunch } from "./draft-submit";
import { useCallback, useMemo, useState } from "react";
import type { SlpRootLaunches } from "@getpaseo/protocol/messages";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import type { SlpLaunchControlsProps } from "./launch-controls";
import type { SlpGroupMode } from "./composer-mode";
import { resolveRootLaunches } from "./launch-selection";

interface LaunchBase {
  selectedProvider: string | null;
  effectiveModelId: string | null;
  selectedMode: string;
}

export function useSlpLaunchSelection(
  serverId: string,
  base: LaunchBase | null,
  mode: SlpGroupMode | null,
  retained?: SlpRootLaunches,
): SlpLaunchControlsProps | undefined {
  const supported = useHostFeature(serverId, "slpRoleOverrides");
  const { config } = useDaemonConfig(serverId);
  const [byHost, setByHost] = useState<Record<string, SlpRootLaunches>>({});
  const onChange = useCallback<SlpLaunchControlsProps["onChange"]>(
    (role, launch) => {
      setByHost((current) => ({
        ...current,
        [serverId]: { ...current[serverId], [role]: launch },
      }));
    },
    [serverId],
  );
  const provider = base?.selectedProvider ?? "";
  const model = base?.effectiveModelId ?? null;
  const modeId = base?.selectedMode || null;
  return useMemo(() => {
    if (!supported || !mode) return undefined;
    const roles = resolveRootLaunches(
      { provider, model, modeId, thinkingOptionId: null },
      config?.slp?.roles ?? {},
      { ...retained, ...byHost[serverId] },
    );
    return { serverId, mode, roles, ready: config !== null, onChange };
  }, [supported, mode, provider, model, modeId, config, retained, byHost, serverId, onChange]);
}

export function isSlpLaunchPending(controls: SlpLaunchControlsProps | undefined): boolean {
  return controls?.ready === false;
}

export function useSlpDraftLaunchSelection(
  serverId: string,
  workspaceId: string | null,
  draftId: string,
  launch: SlpDraftLaunch,
) {
  const retained = useSlpDraftLaunchStore(
    (state) => state.byDraft[slpDraftKey(serverId, workspaceId, draftId)],
  );
  const control = useSlpComposerMode({ serverId, workspaceId });
  const controls = useSlpLaunchSelection(
    serverId,
    launch,
    retained?.mode ?? toSlpGroupMode(control),
    retained?.override?.roles,
  );
  return { control, controls, launch: { ...launch, roles: controls?.roles } };
}

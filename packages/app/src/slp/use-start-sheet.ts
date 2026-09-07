import { useCallback, useMemo, useState } from "react";
import { useRouter, type Href } from "expo-router";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { useHostFeature } from "@/runtime/host-features";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { useSlpGroup } from "./store";

/**
 * The workspace screen's side of starting a group: the menu action exists
 * only while the host supports groups, the workspace has none and its
 * directory is known; a started group lands on the Human's contact.
 */
export function useSlpStartSheet(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string | null;
  /** The sheet renders only while its screen is the focused route. */
  isRouteFocused: boolean;
}): {
  visible: boolean;
  open: (() => void) | undefined;
  close: () => void;
  onStarted: (group: SlpGroupSummary) => void;
} {
  const { serverId, workspaceId, workspaceDirectory, isRouteFocused } = input;
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  const supported = useHostFeature(serverId, "slpGroups");
  const group = useSlpGroup(serverId, workspaceId);
  const canStart = supported && group === null && workspaceDirectory !== null;
  const open = useMemo(() => (canStart ? () => setVisible(true) : undefined), [canStart]);
  const close = useCallback(() => setVisible(false), []);
  const onStarted = useCallback(
    (started: SlpGroupSummary) => {
      setVisible(false);
      if (!started.contactAgentId) return;
      router.push(buildHostAgentDetailRoute(serverId, started.contactAgentId, workspaceId) as Href);
    },
    [router, serverId, workspaceId],
  );
  return { visible: visible && isRouteFocused, open, close, onStarted };
}

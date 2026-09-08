import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { SlpGroupRefusedError } from "./errors";
import { useSlpGroup } from "./store";

/**
 * The workspace menu's "End SLP group" action: present only while the
 * workspace has a group that is not held. Ending archives every member and
 * opens the workspace mode again.
 */
export function useSlpEndGroup(input: {
  serverId: string;
  workspaceId: string;
}): (() => void) | undefined {
  const { serverId, workspaceId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const group = useSlpGroup(serverId, workspaceId);
  const canEnd = group !== null && group.hold === null && group.status === "ready";

  const end = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("slp.end.confirmTitle"),
        message: t("slp.end.confirmMessage"),
        confirmLabel: t("slp.end.confirm"),
        destructive: true,
      });
      if (!confirmed || !client) return;
      try {
        const result = await client.slpGroupEnd(workspaceId);
        if (!result.success) {
          const error = result.error ?? { code: "unknown", message: t("slp.end.failed") };
          throw new SlpGroupRefusedError(error.code, error.message);
        }
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    })();
  }, [client, t, toast, workspaceId]);

  return useMemo(() => (canEnd && client ? end : undefined), [canEnd, client, end]);
}

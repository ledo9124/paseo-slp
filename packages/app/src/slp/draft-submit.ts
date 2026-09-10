import { useCallback, useState } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import type { MessagePayload } from "@/composer/types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import type { SlpGroupMode } from "./composer-mode";
import { SlpGroupRefusedError } from "./errors";

export interface SlpDraftLaunch {
  selectedProvider: string | null;
  selectedMode: string;
  effectiveModelId: string | null;
  persistFormPreferences: () => Promise<void>;
}

/** What the first message launches with when it did not come from this composer. */
export interface SlpDraftStartOverride {
  mode: SlpGroupMode;
  provider: string;
  model: string | null;
  modeId: string | null;
}

type SlpDraftSubmitState =
  | { pending: false; error: string | null }
  | { pending: true; error: null };

/**
 * A draft composer whose workspace mode is Direct or Supervised starts the
 * group with its first message instead of an ordinary agent, then lands on
 * the Human's contact. The provider, model and permission mode the composer
 * shows are the defaults the host's role settings refine.
 */
export function useSlpDraftSubmit(input: {
  serverId: string;
  workspaceId: string | null;
  mode: SlpGroupMode | null;
  launch: SlpDraftLaunch;
  onSent: () => void;
}): {
  submit: ((payload: MessagePayload) => Promise<void>) | null;
  start: (payload: MessagePayload, override: SlpDraftStartOverride) => Promise<void>;
  state: SlpDraftSubmitState;
} {
  const { serverId, workspaceId, mode, launch, onSent } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<SlpDraftSubmitState>({ pending: false, error: null });

  const start = useCallback(
    async (payload: MessagePayload, override?: SlpDraftStartOverride) => {
      const groupMode = override?.mode ?? mode;
      if (!groupMode || !workspaceId) return;
      try {
        if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
        const provider = override?.provider ?? launch.selectedProvider;
        if (!provider) throw new Error(t("workspaceSetup.errors.selectModel"));
        const text = payload.text.trim();
        if (!text) throw new Error(t("slp.composer.errors.emptyMessage"));
        setState({ pending: true, error: null });
        if (!override) await launch.persistFormPreferences();
        const result = await client.slpGroupInitialize({
          workspaceId,
          mode: groupMode,
          cwd: payload.cwd,
          provider,
          model: override ? override.model : launch.effectiveModelId || null,
          providerModeId: override ? override.modeId : launch.selectedMode || null,
          messageId: generateMessageId(),
          text,
        });
        if (!result.success || !result.group) {
          const error = result.error ?? { code: "unknown", message: t("slp.composer.failed") };
          throw new SlpGroupRefusedError(error.code, error.message);
        }
        onSent();
        setState({ pending: false, error: null });
        const contactAgentId = result.group.contactAgentId;
        if (contactAgentId) {
          router.push(buildHostAgentDetailRoute(serverId, contactAgentId, workspaceId) as Href);
        }
      } catch (error) {
        setState({ pending: false, error: toErrorMessage(error) });
      }
    },
    [client, launch, mode, onSent, router, serverId, t, workspaceId],
  );

  return { submit: mode && workspaceId ? start : null, start, state };
}

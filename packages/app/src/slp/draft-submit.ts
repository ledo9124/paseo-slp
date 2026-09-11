import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SlpGroupSummary, SlpGroupInitializeResponse } from "@getpaseo/protocol/messages";
import type { MessagePayload } from "@/composer/types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";
import type { SlpGroupMode } from "./composer-mode";
import { SlpGroupRefusedError } from "./errors";
import { slpDraftKey, useSlpDraftLaunchStore } from "./draft-state";

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
  messageId?: string;
}

type SlpDraftSubmitState =
  | { pending: false; error: string | null }
  | { pending: true; error: null };

function resolveAttempt(
  previous: { key: string; messageId: string } | undefined,
  key: string,
  originalMessageId: string | undefined,
): { key: string; messageId: string } {
  if (previous?.key === key) return previous;
  return {
    key,
    messageId: previous ? generateMessageId() : (originalMessageId ?? generateMessageId()),
  };
}

function explainStartupError(error: unknown, toolsRequired: string): unknown {
  return error instanceof SlpGroupRefusedError && error.code === "SlpDelegationUnavailableError"
    ? new SlpGroupRefusedError(error.code, `${toolsRequired}\n${error.message}`)
    : error;
}

function requireInitializedGroup(
  result: SlpGroupInitializeResponse["payload"],
  fallback: string,
): SlpGroupSummary {
  if (!result.success || !result.group) {
    const error = result.error ?? { code: "unknown", message: fallback };
    throw new SlpGroupRefusedError(error.code, error.message);
  }
  if (!result.group.contactAgentId) throw new Error(fallback);
  return result.group;
}

/**
 * A draft composer whose workspace mode is Direct or Supervised starts the
 * group with its first message instead of an ordinary agent, then lands on
 * the Human's contact. The provider, model and permission mode the composer
 * shows are the defaults the host's role settings refine.
 */
export function useSlpDraftSubmit(input: {
  serverId: string;
  workspaceId: string | null;
  draftId: string;
  mode: SlpGroupMode | null;
  launch: SlpDraftLaunch;
  onSent: (group: SlpGroupSummary) => void;
}): {
  submit: ((payload: MessagePayload) => Promise<void>) | null;
  start: (payload: MessagePayload, override: SlpDraftStartOverride) => Promise<void>;
  state: SlpDraftSubmitState;
} {
  const { serverId, workspaceId, draftId, mode, launch, onSent } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<SlpDraftSubmitState>({ pending: false, error: null });
  const draftKey = slpDraftKey(serverId, workspaceId, draftId);
  const inFlight = useRef<Promise<void> | null>(null);

  const start = useCallback(
    (payload: MessagePayload, override?: SlpDraftStartOverride): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      const operation = (async () => {
        const groupMode = override?.mode ?? mode;
        try {
          if (!groupMode || !workspaceId) throw new Error(t("slp.composer.failed"));
          const store = useSlpDraftLaunchStore.getState();
          const previous = store.byDraft[draftKey];
          store.set(draftKey, { ...previous, mode: groupMode, override });
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          const provider = override?.provider ?? launch.selectedProvider;
          if (!provider) throw new Error(t("workspaceSetup.errors.selectModel"));
          const text = payload.text.trim();
          if (!text) throw new Error(t("slp.composer.errors.emptyMessage"));
          setState({ pending: true, error: null });
          if (!override) await launch.persistFormPreferences();
          const request = {
            workspaceId,
            mode: groupMode,
            cwd: payload.cwd,
            provider,
            model: override ? override.model : launch.effectiveModelId || null,
            providerModeId: override ? override.modeId : launch.selectedMode || null,
            text,
          };
          const key = JSON.stringify(request);
          const attempt = resolveAttempt(previous?.attempt, key, override?.messageId);
          store.set(draftKey, { mode: groupMode, override, attempt });
          const result = await client.slpGroupInitialize({
            ...request,
            messageId: attempt.messageId,
          });
          onSent(requireInitializedGroup(result, t("slp.composer.failed")));
          store.clear(draftKey);
          setState({ pending: false, error: null });
        } catch (error) {
          const failure = explainStartupError(error, t("slp.composer.errors.toolsRequired"));
          setState({ pending: false, error: toErrorMessage(failure) });
          throw failure;
        }
      })();
      inFlight.current = operation;
      const settled = () => {
        inFlight.current = null;
      };
      void operation.then(settled, settled);
      return operation;
    },
    [client, draftKey, launch, mode, onSent, t, workspaceId],
  );

  return { submit: mode && workspaceId ? start : null, start, state };
}

import { useCallback, useMemo } from "react";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import type { MessagePayload } from "@/composer/types";
import {
  useSlpComposerMode,
  type SlpModeControlValue,
  type SlpComposerMode,
} from "./composer-mode";
import { useSlpDraftSubmit, type SlpDraftLaunch, type SlpDraftStartOverride } from "./draft-submit";
import { slpDraftKey, useSlpDraftLaunchStore } from "./draft-state";

type Submit = (payload: MessagePayload) => Promise<void>;

/**
 * What a workspace draft tab adds to its composer for SLP: the workspace-mode
 * pill and a send that starts a group instead of an agent while Direct or
 * Supervised is chosen. Everything else about the draft stays the tab's.
 */
export function useSlpDraftComposer(input: {
  serverId: string;
  workspaceId: string | null;
  draftId: string;
  launch: SlpDraftLaunch;
  createAgent: Submit;
  isCreating: boolean;
  createError: string | null;
  onSent: (group: SlpGroupSummary) => void;
}): {
  slpControl: SlpModeControlValue | null;
  submit: Submit;
  /** Starts a group from a first message another composer already decided on. */
  start: (payload: MessagePayload, override: SlpDraftStartOverride) => Promise<void>;
  isSending: boolean;
  errorMessage: string | null;
  isSlp: boolean;
} {
  const { serverId, workspaceId, draftId, launch, createAgent, isCreating, createError, onSent } =
    input;
  const control = useSlpComposerMode({ serverId, workspaceId });
  // A New workspace submission owns its launch until it succeeds or the user changes mode.
  // Group/agent pushes during initialization must not turn its retry into ordinary creation.
  const draftKey = slpDraftKey(serverId, workspaceId, draftId);
  const retained = useSlpDraftLaunchStore((state) => state.byDraft[draftKey]);
  const startedMode = retained?.mode;
  const retryOverride = retained?.override;
  const onSelect = useCallback(
    (value: SlpComposerMode) => {
      useSlpDraftLaunchStore.getState().clear(draftKey);
      control?.onSelect(value);
    },
    [control, draftKey],
  );
  const slpControl = useMemo(
    () =>
      control
        ? {
            ...control,
            value: startedMode ?? control.value,
            onSelect,
          }
        : null,
    [control, startedMode, onSelect],
  );
  const chosenMode = startedMode ?? (control?.lock === null ? control.value : "single");
  const {
    submit: startGroup,
    start,
    state,
  } = useSlpDraftSubmit({
    serverId,
    workspaceId,
    draftId,
    mode: chosenMode === "single" ? null : chosenMode,
    launch,
    onSent,
  });
  const submit = useCallback<Submit>(
    (payload) => {
      if (retryOverride) return start(payload, retryOverride);
      if (startGroup) {
        return startGroup(payload);
      }
      return createAgent(payload);
    },
    [createAgent, retryOverride, start, startGroup],
  );
  return useMemo(
    () => ({
      slpControl,
      submit,
      start,
      isSending: isCreating || state.pending,
      errorMessage: chosenMode === "single" ? createError : state.error,
      isSlp: chosenMode !== "single",
    }),
    [chosenMode, createError, isCreating, slpControl, start, state.error, state.pending, submit],
  );
}

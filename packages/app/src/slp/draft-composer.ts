import { useCallback, useMemo } from "react";
import type { MessagePayload } from "@/composer/types";
import { useSlpComposerMode, type SlpModeControlValue } from "./composer-mode";
import { useSlpDraftSubmit, type SlpDraftLaunch, type SlpDraftStartOverride } from "./draft-submit";

type Submit = (payload: MessagePayload) => Promise<void>;

/**
 * What a workspace draft tab adds to its composer for SLP: the workspace-mode
 * pill and a send that starts a group instead of an agent while Direct or
 * Supervised is chosen. Everything else about the draft stays the tab's.
 */
export function useSlpDraftComposer(input: {
  serverId: string;
  workspaceId: string | null;
  launch: SlpDraftLaunch;
  createAgent: Submit;
  isCreating: boolean;
  createError: string | null;
  onSent: () => void;
}): {
  slpControl: SlpModeControlValue | null;
  submit: Submit;
  /** Starts a group from a first message another composer already decided on. */
  start: (payload: MessagePayload, override: SlpDraftStartOverride) => Promise<void>;
  isSending: boolean;
  errorMessage: string | null;
} {
  const { serverId, workspaceId, launch, createAgent, isCreating, createError, onSent } = input;
  const slpControl = useSlpComposerMode({ serverId, workspaceId });
  const chosenMode = slpControl && slpControl.lock === null ? slpControl.value : "single";
  const {
    submit: startGroup,
    start,
    state,
  } = useSlpDraftSubmit({
    serverId,
    workspaceId,
    mode: chosenMode === "single" ? null : chosenMode,
    launch,
    onSent,
  });
  const submit = useCallback<Submit>(
    (payload) => (startGroup ? startGroup(payload) : createAgent(payload)),
    [createAgent, startGroup],
  );
  return useMemo(
    () => ({
      slpControl,
      submit,
      start,
      isSending: isCreating || state.pending,
      errorMessage: createError ?? state.error,
    }),
    [createError, isCreating, slpControl, start, state.error, state.pending, submit],
  );
}

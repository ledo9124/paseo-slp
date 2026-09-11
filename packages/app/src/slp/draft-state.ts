import { create } from "zustand";
import type { SlpGroupMode } from "./composer-mode";
import type { SlpDraftStartOverride } from "./draft-submit";

interface SlpDraftLaunchState {
  mode: SlpGroupMode;
  override?: SlpDraftStartOverride;
  attempt?: { key: string; messageId: string };
}

/** Keep a refused launch across navigation to host settings and back to its draft. */
export const useSlpDraftLaunchStore = create<{
  byDraft: Record<string, SlpDraftLaunchState | undefined>;
  set: (key: string, launch: SlpDraftLaunchState) => void;
  clear: (key: string) => void;
}>((set) => ({
  byDraft: {},
  set: (key, launch) => set((state) => ({ byDraft: { ...state.byDraft, [key]: launch } })),
  clear: (key) =>
    set((state) => {
      const { [key]: _removed, ...byDraft } = state.byDraft;
      return { byDraft };
    }),
}));

export function slpDraftKey(serverId: string, workspaceId: string | null, draftId: string): string {
  return JSON.stringify([serverId, workspaceId, draftId]);
}

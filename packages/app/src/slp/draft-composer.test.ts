/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SlpModeControlValue } from "./composer-mode";
import { useSlpDraftComposer } from "./draft-composer";

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  control: null as SlpModeControlValue | null,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ slpGroupInitialize: mocks.initialize }),
}));
vi.mock("./composer-mode", () => ({ useSlpComposerMode: () => mocks.control }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useSlpDraftLaunchStore } from "./draft-state";

const payload = { text: "Investigate startup", cwd: "/repo", attachments: [] };
const launch = {
  selectedProvider: "codex",
  selectedMode: "default",
  effectiveModelId: "gpt-test",
  persistFormPreferences: async () => {},
};
const override = {
  mode: "supervised",
  provider: "codex",
  model: "gpt-test",
  modeId: "default",
  messageId: "first-message",
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  useSlpDraftLaunchStore.setState({ byDraft: {} });
  mocks.control = { value: "single", lock: null, onSelect: vi.fn() };
});

it("retains a New workspace SLP launch after refusal and retries it instead of creating an ordinary agent", async () => {
  mocks.initialize.mockResolvedValueOnce({
    success: false,
    error: { code: "SlpDelegationUnavailableError", message: "tools disabled" },
  });
  const createAgent = vi.fn();
  const onSent = vi.fn();
  const useTestComposer = () =>
    useSlpDraftComposer({
      serverId: "host",
      workspaceId: "workspace",
      draftId: "draft",
      launch,
      createAgent,
      isCreating: false,
      createError: null,
      onSent,
    });
  const { result, unmount } = renderHook(useTestComposer);
  await act(async () => {
    await expect(result.current.start(payload, override)).rejects.toThrow();
  });
  expect(result.current.isSlp).toBe(true);
  expect(result.current.slpControl?.value).toBe("supervised");
  expect(result.current.errorMessage).toContain("slp.composer.errors.toolsRequired");

  // A partial initialization may push an agent before the group/response arrives.
  mocks.control = { value: "single", lock: "agents", onSelect: vi.fn() };
  // Going to Settings unmounts the draft. Returning must retain its mode and message id.
  unmount();
  const retry = renderHook(useTestComposer);
  expect(retry.result.current.slpControl?.value).toBe("supervised");
  mocks.initialize.mockResolvedValueOnce({ success: true, group: { contactAgentId: "sup" } });
  await act(async () => {
    await retry.result.current.submit(payload);
  });
  expect(createAgent).not.toHaveBeenCalled();
  expect(mocks.initialize.mock.calls.map(([request]) => request)).toEqual([
    expect.objectContaining({ mode: "supervised", messageId: "first-message" }),
    mocks.initialize.mock.calls[0]![0],
  ]);
  expect(onSent).toHaveBeenCalledOnce();
});

it("allows an explicit switch back to Single after a refused launch", async () => {
  mocks.initialize.mockRejectedValue(new Error("offline"));
  const createAgent = vi.fn().mockResolvedValue(undefined);
  const { result } = renderHook(() =>
    useSlpDraftComposer({
      serverId: "host",
      workspaceId: "workspace",
      draftId: "draft",
      launch,
      createAgent,
      isCreating: false,
      createError: null,
      onSent: vi.fn(),
    }),
  );
  await act(async () => {
    await expect(result.current.start(payload, override)).rejects.toThrow();
  });
  act(() => result.current.slpControl!.onSelect("single"));
  await act(async () => {
    await result.current.submit(payload);
  });
  expect(createAgent).toHaveBeenCalledWith(payload);
  expect(result.current.isSlp).toBe(false);
  expect(result.current.errorMessage).toBeNull();
});

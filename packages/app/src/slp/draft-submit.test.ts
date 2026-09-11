/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSlpDraftSubmit } from "./draft-submit";

const { initialize } = vi.hoisted(() => ({ initialize: vi.fn() }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ slpGroupInitialize: initialize }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useSlpDraftLaunchStore } from "./draft-state";

const payload = { text: "Investigate the startup failure", cwd: "/repo", attachments: [] };
const launch = {
  selectedProvider: "codex",
  selectedMode: "default",
  effectiveModelId: "gpt-test",
  persistFormPreferences: async () => {},
};
const group = { contactAgentId: "supervisor-1" };

describe("SLP draft submission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useSlpDraftLaunchStore.setState({ byDraft: {} });
  });

  it("rejects a refused initialization so the composer retains the draft", async () => {
    initialize.mockResolvedValue({
      success: false,
      group: null,
      error: { code: "SlpDelegationUnavailableError", message: "Enable Paseo tools" },
    });
    const onSent = vi.fn();
    const { result } = renderHook(() =>
      useSlpDraftSubmit({
        serverId: "host",
        workspaceId: "workspace",
        draftId: "draft",
        mode: "supervised",
        launch,
        onSent,
      }),
    );
    await act(async () => {
      await expect(result.current.submit!(payload)).rejects.toThrow();
    });
    expect(result.current.state.pending).toBe(false);
    expect(result.current.state.error).not.toBeNull();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("reuses the first message id after a lost response", async () => {
    initialize.mockRejectedValueOnce(new Error("response timed out"));
    initialize.mockResolvedValueOnce({ success: true, group, error: null });
    const onSent = vi.fn();
    const { result } = renderHook(() =>
      useSlpDraftSubmit({
        serverId: "host",
        workspaceId: "workspace",
        draftId: "draft",
        mode: "supervised",
        launch,
        onSent,
      }),
    );
    await act(async () => {
      await expect(result.current.submit!(payload)).rejects.toThrow("response timed out");
    });
    await act(async () => {
      await result.current.submit!(payload);
    });
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(initialize.mock.calls[1]![0]).toEqual(initialize.mock.calls[0]![0]);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight initialization and propagates its failure to every submitter", async () => {
    let rejectRequest!: (error: Error) => void;
    initialize.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const { result } = renderHook(() =>
      useSlpDraftSubmit({
        serverId: "host",
        workspaceId: "workspace",
        draftId: "draft",
        mode: "supervised",
        launch,
        onSent: vi.fn(),
      }),
    );
    await act(async () => {
      const first = result.current.submit!(payload);
      const second = result.current.submit!(payload);
      expect(second).toBe(first);
      await Promise.resolve();
      const failure = expect(first).rejects.toThrow("disconnected");
      rejectRequest(new Error("disconnected"));
      await failure;
    });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(result.current.state.pending).toBe(false);
  });

  it("does not clear the draft for a success response without a contact", async () => {
    initialize.mockResolvedValue({ success: true, group: { contactAgentId: null } });
    const onSent = vi.fn();
    const { result } = renderHook(() =>
      useSlpDraftSubmit({
        serverId: "host",
        workspaceId: "workspace",
        draftId: "draft",
        mode: "supervised",
        launch,
        onSent,
      }),
    );
    await act(async () => {
      await expect(result.current.submit!(payload)).rejects.toThrow();
    });
    expect(onSent).not.toHaveBeenCalled();
    expect(result.current.state.error).not.toBeNull();
  });

  it("gives an edited retry a new id so it cannot silently reuse an accepted first message", async () => {
    initialize.mockRejectedValue(new Error("response timed out"));
    const { result } = renderHook(() =>
      useSlpDraftSubmit({
        serverId: "host",
        workspaceId: "workspace",
        draftId: "draft",
        mode: "supervised",
        launch,
        onSent: vi.fn(),
      }),
    );
    await act(async () => {
      await expect(result.current.submit!(payload)).rejects.toThrow();
    });
    await act(async () => {
      await expect(
        result.current.submit!({ ...payload, text: "A different task" }),
      ).rejects.toThrow();
    });
    expect(initialize.mock.calls[1]![0].messageId).not.toBe(initialize.mock.calls[0]![0].messageId);
  });
});

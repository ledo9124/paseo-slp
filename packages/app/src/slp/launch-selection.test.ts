import { describe, expect, test } from "vitest";
import { resolveRootLaunches } from "./launch-selection";

const base = { provider: "codex", model: "base", modeId: "full-access", thinkingOptionId: "high" };
describe("SLP role launch selection", () => {
  test("fills defaults independently and clears incompatible provider fields", () => {
    expect(
      resolveRootLaunches(
        base,
        { supervisor: { provider: "claude", model: "sonnet" }, lead: { model: "lead-default" } },
        {},
      ),
    ).toEqual({
      supervisor: { provider: "claude", model: "sonnet", modeId: null, thinkingOptionId: null },
      lead: { ...base, model: "lead-default" },
    });
  });
  test("an explicit default-model selection stays cleared instead of restoring the host model", () => {
    const selected = { provider: "claude", model: null, modeId: null, thinkingOptionId: null };
    expect(
      resolveRootLaunches(
        base,
        { supervisor: { provider: "claude", model: "opus" } },
        { supervisor: selected },
      ),
    ).toEqual({ supervisor: selected, lead: base });
  });
});

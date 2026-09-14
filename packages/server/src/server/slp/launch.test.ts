import { describe, expect, test } from "vitest";

import { withSlpProviderOptions } from "./launch.js";

describe("withSlpProviderOptions", () => {
  test("disables Codex's own multi-agent tools for a Codex member", () => {
    expect(withSlpProviderOptions("codex", null)).toEqual({ agents: { enabled: false } });
    expect(withSlpProviderOptions("codex/gpt-6-astra", undefined)).toEqual({
      agents: { enabled: false },
    });
  });

  test("keeps the member's other options and wins over a conflicting agents table", () => {
    expect(
      withSlpProviderOptions("codex", {
        approval_policy: "never",
        agents: { enabled: true },
      }),
    ).toEqual({ approval_policy: "never", agents: { enabled: false } });
  });

  test("blocks Claude native delegation while preserving existing restrictions", () => {
    expect(withSlpProviderOptions("claude", { disallowedTools: ["Bash", "Agent"] })).toEqual({
      disallowedTools: ["Bash", "Agent", "Task"],
    });
    expect(withSlpProviderOptions("claude/sonnet", null)).toEqual({
      disallowedTools: ["Agent", "Task"],
    });
  });

  test("leaves other providers' options untouched", () => {
    expect(withSlpProviderOptions("pi", null)).toBeNull();
    expect(withSlpProviderOptions("pi", { permissionMode: "plan" })).toEqual({
      permissionMode: "plan",
    });
  });
});

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

  test("leaves other providers' options untouched", () => {
    expect(withSlpProviderOptions("claude", null)).toBeNull();
    expect(withSlpProviderOptions("claude", { permissionMode: "plan" })).toEqual({
      permissionMode: "plan",
    });
  });
});

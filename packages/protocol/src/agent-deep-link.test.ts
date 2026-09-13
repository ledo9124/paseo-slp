import { describe, expect, it } from "vitest";
import {
  buildAgentDeepLink,
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
} from "./agent-deep-link.js";

it("does not accept links addressed to the upstream application", () => {
  expect(parseAgentDeepLink("paseo://h/server/agent/agent")).toBeNull();
});

describe("agent deep links", () => {
  it("round-trips an existing agent target", () => {
    const target = { serverId: "server/main", agentId: "agent 123" };

    const link = buildAgentDeepLink(target);

    expect(link).toBe("paseo-slp://h/server%2Fmain/agent/agent%20123");
    expect(buildAgentDeepLinkRoute(target)).toBe("/h/server%2Fmain/agent/agent%20123");
    expect(parseAgentDeepLink(link)).toEqual(target);
  });

  it("rejects links outside the exact agent route", () => {
    expect(parseAgentDeepLink("https://h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo-slp://app/h/server/agent/agent-1")).toBeNull();
    expect(parseAgentDeepLink("paseo-slp://h/server/agent/agent-1?message=hello")).toBeNull();
    expect(parseAgentDeepLink("paseo-slp://h/server/agent/agent-1/extra")).toBeNull();
  });
});

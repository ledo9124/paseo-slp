import { describe, expect, it } from "vitest";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { describeSlpMembership } from "./store";

function summary(overrides: Partial<SlpGroupSummary> = {}): SlpGroupSummary {
  return {
    id: "grp_1",
    workspaceId: "wks_1",
    mode: "supervised",
    status: "ready",
    freezeReason: null,
    hold: null,
    contactAgentId: "supervisor-1",
    initialMessageReceipt: "accepted",
    slots: [
      {
        id: "slot_s",
        role: "supervisor",
        ownerSlotId: null,
        activeAgentId: "supervisor-1",
        generations: [{ id: "gen_s1", number: 1, agentId: "supervisor-1", state: "active" }],
      },
      {
        id: "slot_l",
        role: "lead",
        ownerSlotId: null,
        activeAgentId: "lead-2",
        generations: [
          { id: "gen_l1", number: 1, agentId: "lead-1", state: "retired" },
          { id: "gen_l2", number: 2, agentId: "lead-2", state: "active" },
        ],
      },
    ],
    transfers: [],
    mail: { queued: 0, dispatching: 0, uncertain: 0 },
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("describeSlpMembership", () => {
  it("names the contact and reports a retired generation against the slot's current agent", () => {
    expect(describeSlpMembership(summary(), "supervisor-1")).toMatchObject({
      role: "supervisor",
      generationNumber: 1,
      generationState: "active",
      isContact: true,
      activeAgentId: "supervisor-1",
      transfer: null,
    });
    expect(describeSlpMembership(summary(), "lead-1")).toMatchObject({
      role: "lead",
      generationState: "retired",
      isContact: false,
      activeAgentId: "lead-2",
    });
    expect(describeSlpMembership(summary(), "outsider")).toBeNull();
  });

  it("attaches only the live transfer of the agent's own slot, from either side", () => {
    const group = summary({
      transfers: [
        {
          id: "tr_old",
          slotId: "slot_l",
          phase: "aborted",
          sourceAgentId: "lead-2",
          candidateAgentId: "lead-x",
          reason: "daemon restarted before the active-generation switch",
          updatedAt: "2026-09-07T00:00:00.000Z",
        },
        {
          id: "tr_live",
          slotId: "slot_l",
          phase: "preparing",
          sourceAgentId: "lead-2",
          candidateAgentId: "lead-3",
          reason: null,
          updatedAt: "2026-09-07T00:00:01.000Z",
        },
      ],
    });
    expect(describeSlpMembership(group, "lead-2")?.transfer).toEqual({
      id: "tr_live",
      phase: "preparing",
      reason: null,
      isSource: true,
      isCandidate: false,
    });
    expect(describeSlpMembership(group, "supervisor-1")?.transfer).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { describeSlpMembership, findPendingLeadHandoff } from "./store";

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

describe("a Lead handoff waiting on the Supervisor", () => {
  const waiting = {
    id: "tr_1",
    slotId: "slot_l",
    phase: "awaiting_supervisor",
    sourceAgentId: "lead-2",
    candidateAgentId: null,
    reason: "context nearly exhausted",
    control: "supervisor",
    decision: null,
    decidedAt: null,
    updatedAt: "2026-09-16T00:00:00.000Z",
  };

  it("is found from the group, not from the agent the transfer names", () => {
    const group = summary({ transfers: [waiting] });

    expect(findPendingLeadHandoff(group)).toEqual({
      transferId: "tr_1",
      sourceAgentId: "lead-2",
      reason: "context nearly exhausted",
    });
    // The Supervisor is neither source nor candidate, so its own transfer view
    // stays empty; the pending decision is what it needs instead.
    const supervisor = describeSlpMembership(group, "supervisor-1");
    expect(supervisor?.transfer).toBeNull();
    expect(supervisor?.pendingLeadHandoff).toEqual({
      transferId: "tr_1",
      sourceAgentId: "lead-2",
      reason: "context nearly exhausted",
    });
  });

  it("keeps the suspended source attached to its own transfer", () => {
    const source = describeSlpMembership(summary({ transfers: [waiting] }), "lead-2");

    expect(source?.transfer).toMatchObject({ phase: "awaiting_supervisor", isSource: true });
    expect(source?.pendingLeadHandoff?.sourceAgentId).toBe("lead-2");
  });

  it("is absent from a daemon that predates the contract", () => {
    // An older daemon sends no control mode; absent reads as automatic, the
    // same way the daemon reads a record that has none.
    const { control: _control, ...legacy } = waiting;
    const group = summary({ transfers: [{ ...legacy, phase: "preparing" }] });

    expect(findPendingLeadHandoff(group)).toBeNull();
    expect(describeSlpMembership(group, "supervisor-1")?.pendingLeadHandoff).toBeNull();
  });

  it("ends when the decision moves the transfer on", () => {
    for (const phase of ["continued", "preparing", "canceled"]) {
      const group = summary({ transfers: [{ ...waiting, phase, decision: "continue" }] });
      expect(findPendingLeadHandoff(group)).toBeNull();
    }
  });
});

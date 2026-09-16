import { describe, expect, it } from "vitest";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { describeNotices } from "./group-banner";
import { describeSlpMembership } from "./store";

/** Keys, not copy: the locale parity test owns the wording. */
const t = (key: string): string => key;

const WAITING = {
  id: "tr_1",
  slotId: "slot_l",
  phase: "awaiting_supervisor",
  sourceAgentId: "lead-1",
  candidateAgentId: null,
  reason: "context nearly exhausted",
  control: "supervisor",
  decision: null,
  decidedAt: null,
  updatedAt: "2026-09-16T00:00:00.000Z",
};

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
        activeAgentId: "lead-1",
        generations: [{ id: "gen_l1", number: 1, agentId: "lead-1", state: "active" }],
      },
      {
        id: "slot_p",
        role: "peer",
        ownerSlotId: "slot_l",
        activeAgentId: "peer-1",
        generations: [{ id: "gen_p1", number: 1, agentId: "peer-1", state: "active" }],
      },
    ],
    transfers: [],
    mail: { queued: 0, dispatching: 0, uncertain: 0 },
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function noticesFor(group: SlpGroupSummary, agentId: string): string[] {
  const membership = describeSlpMembership(group, agentId);
  if (!membership) throw new Error(`${agentId} is not a member`);
  return describeNotices(group, membership, t);
}

describe("what a group banner says while a Lead handoff waits", () => {
  it("asks the Supervisor to answer", () => {
    expect(noticesFor(summary({ transfers: [WAITING] }), "supervisor-1")).toEqual([
      "slp.banner.decisionWaiting",
    ]);
  });

  it("tells the stopped Lead what it is waiting for", () => {
    // Not the ordinary handing-off notice: nothing is being prepared, and the
    // agent is stopped rather than on its way out.
    expect(noticesFor(summary({ transfers: [WAITING] }), "lead-1")).toEqual([
      "slp.banner.decisionSuspended",
    ]);
  });

  it("tells everyone else the group is waiting", () => {
    expect(noticesFor(summary({ transfers: [WAITING] }), "peer-1")).toEqual([
      "slp.banner.decisionPending",
    ]);
  });

  it("says nothing new once the decision is made", () => {
    const base = summary();
    const group = summary({
      transfers: [{ ...WAITING, phase: "preparing", decision: "continue" }],
      slots: [
        base.slots[0]!,
        {
          id: "slot_l",
          role: "lead",
          ownerSlotId: null,
          activeAgentId: "lead-1",
          generations: [
            { id: "gen_l1", number: 1, agentId: "lead-1", state: "active" },
            { id: "gen_l2", number: 2, agentId: "lead-2", state: "preparing" },
          ],
        },
        base.slots[2]!,
      ],
    });

    expect(noticesFor(group, "supervisor-1")).toEqual([]);
    expect(noticesFor(group, "peer-1")).toEqual([]);
    expect(noticesFor(group, "lead-1")).toEqual(["slp.banner.transferSource"]);
  });

  it("leaves an automatic handoff reading the way it always did", () => {
    const { control: _control, ...automatic } = WAITING;
    const group = summary({ transfers: [{ ...automatic, phase: "preparing" }] });

    expect(noticesFor(group, "lead-1")).toEqual(["slp.banner.transferSource"]);
    expect(noticesFor(group, "supervisor-1")).toEqual([]);
  });
});

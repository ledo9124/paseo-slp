import type { SlpMailRecord } from "./store.js";

/**
 * Mail the runtime sends on its own behalf. A member's answer to one of these
 * is a reply to the runtime, not work it is telling anyone about, so the turn
 * it starts is not relayed as a report.
 *
 * `interrupted` is deliberately absent: it reports a Peer's lost turn, and the
 * Lead's answer to it is ordinary project work.
 */
const CONTROL_KINDS: ReadonlySet<SlpMailRecord["kind"]> = new Set(["activation"]);

export function isControlMail(kind: SlpMailRecord["kind"]): boolean {
  return CONTROL_KINDS.has(kind);
}

/**
 * Which turns the runtime started for itself.
 *
 * Provenance is claimed before admission rather than derived afterwards. Turn
 * admission claims the run slot synchronously and answers `started` only when
 * it made the claim, so a turn that answer describes is the runtime's own with
 * no turn id to correlate and no window for another writer to take the claim
 * in between. Any other answer releases it: `busy` started nothing, and
 * `steered` merged the message into a turn somebody else owns, whose final
 * message is still that owner's to report.
 */
export class SlpControlTurns {
  private readonly claimed = new Set<string>();

  /** The next turn this agent starts belongs to the runtime. */
  claim(agentId: string): void {
    this.claimed.add(agentId);
  }

  /** No turn of ours started after all. */
  release(agentId: string): void {
    this.claimed.delete(agentId);
  }

  /** Whether the turn that just ended was the runtime's. Answers once. */
  settle(agentId: string): boolean {
    return this.claimed.delete(agentId);
  }
}

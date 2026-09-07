export type SlpGroupHoldReason = "initializing" | "transferring" | "frozen";

/**
 * A destructive operation (archive, cascade, workspace teardown, delete)
 * reached an agent or workspace whose SLP group is held. The hold is
 * persisted group state, so the refusal survives restart.
 */
export class SlpGroupHeldError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly reason: SlpGroupHoldReason,
    public readonly detail: string | null,
  ) {
    super(
      `SLP group ${groupId} is ${reason}${detail ? ` (${detail})` : ""}; destructive operations are refused`,
    );
    this.name = "SlpGroupHeldError";
  }
}

/** A second initialization for the same workspace chose a different mode or message. */
export class SlpInitializationConflictError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly field: "mode" | "initialMessage",
  ) {
    super(`SLP group ${groupId} is already initialized with a different ${field}`);
    this.name = "SlpInitializationConflictError";
  }
}

/** The group is frozen; automatic work on it is blocked until it is repaired. */
export class SlpGroupFrozenError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly detail: string,
  ) {
    super(`SLP group ${groupId} is frozen: ${detail}`);
    this.name = "SlpGroupFrozenError";
  }
}

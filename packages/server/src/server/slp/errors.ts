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

/** A Lead without Paseo tools cannot delegate, so the group is not created. */
export class SlpDelegationUnavailableError extends Error {
  constructor(public readonly workspaceId: string) {
    super(
      `SLP needs Paseo tools injected into agents; enable daemon.mcp.enabled and daemon.mcp.injectIntoAgents before initializing a group for workspace ${workspaceId}`,
    );
    this.name = "SlpDelegationUnavailableError";
  }
}

/** A required role instruction file is missing or unreadable. */
export class SlpInstructionsUnavailableError extends Error {
  constructor(
    public readonly file: string,
    cause: unknown,
  ) {
    super(`SLP role instructions are unavailable: ${file}`, { cause });
    this.name = "SlpInstructionsUnavailableError";
  }
}

/** The calling role may not perform this operation. */
export class SlpRoleAuthorityError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly role: string,
    public readonly operation: string,
  ) {
    super(`SLP ${role} ${agentId} may not ${operation}`);
    this.name = "SlpRoleAuthorityError";
  }
}

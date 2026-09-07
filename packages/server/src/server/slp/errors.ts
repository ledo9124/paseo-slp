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

/** A retired generation may not run a turn, use a tool or receive product work. */
export class SlpGenerationRetiredError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly groupId: string,
  ) {
    super(`SLP agent ${agentId} is a retired generation of group ${groupId}; it is history only`);
    this.name = "SlpGenerationRetiredError";
  }
}

/** A candidate in receive-only preparation tried something other than reading and acknowledging. */
export class SlpPreparationPolicyError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly tool: string,
  ) {
    super(`SLP candidate ${agentId} is in receive-only preparation; ${tool} is not permitted`);
    this.name = "SlpPreparationPolicyError";
  }
}

/** A handoff was requested in a state it cannot start from. */
export class SlpTransferRefusedError extends Error {
  constructor(
    public readonly slotId: string,
    public readonly detail: string,
  ) {
    super(`SLP handoff for slot ${slotId} refused: ${detail}`);
    this.name = "SlpTransferRefusedError";
  }
}

/** A started transfer cannot continue; the slot stays held until a restart reconciles it. */
export class SlpTransferBlockedError extends Error {
  constructor(
    public readonly transferId: string,
    public readonly phase: string,
    public readonly detail: string,
  ) {
    super(`SLP transfer ${transferId} blocked while ${phase}: ${detail}`);
    this.name = "SlpTransferBlockedError";
  }
}

/** `slp_ready` from an agent that is not any transfer's candidate. */
export class SlpNotCandidateError extends Error {
  constructor(public readonly agentId: string) {
    super(`SLP agent ${agentId} is not a handoff candidate`);
    this.name = "SlpNotCandidateError";
  }
}

/** A group whose contact slot has no active generation: initializing, or its records are inconsistent. */
export class SlpNoContactError extends Error {
  constructor(readonly groupId: string) {
    super(`SLP group ${groupId} has no active contact generation`);
    this.name = "SlpNoContactError";
  }
}

/**
 * The refusals group initialization answers to a client by name. Anything
 * else thrown there is a daemon fault and propagates.
 */
export function isSlpInitializationRefusal(error: unknown): error is Error {
  return (
    error instanceof SlpInitializationConflictError ||
    error instanceof SlpGroupFrozenError ||
    error instanceof SlpGroupHeldError ||
    error instanceof SlpDelegationUnavailableError ||
    error instanceof SlpInstructionsUnavailableError
  );
}

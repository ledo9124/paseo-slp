import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";

import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

/** Projection of membership onto agent labels, for discovery only; membership is authority. */
export const SLP_GROUP_LABEL = "paseo.slp-group-id";

export const SlpWorkspaceModeSchema = z.enum(["direct", "supervised"]);
export type SlpWorkspaceMode = z.infer<typeof SlpWorkspaceModeSchema>;

export const SlpRoleSchema = z.enum(["supervisor", "lead", "peer"]);
export type SlpRole = z.infer<typeof SlpRoleSchema>;

const SlpGenerationSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  agentId: z.string(),
  state: z.enum(["preparing", "active", "retired"]),
  /** Hash of the instruction text this generation runs under; see instructions.ts. */
  instructionsVersion: z.string(),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});
export type SlpGenerationRecord = z.infer<typeof SlpGenerationSchema>;

const SlpSlotSchema = z.object({
  id: z.string(),
  role: SlpRoleSchema,
  /** Slot that owns this one; Peers point at the Lead slot. */
  ownerSlotId: z.string().nullable(),
  activeGenerationId: z.string().nullable(),
  generations: z.array(SlpGenerationSchema),
});
export type SlpSlotRecord = z.infer<typeof SlpSlotSchema>;

/** Everything initialization needs to resume after a crash without a new decision. */
const SlpInitializationSchema = z.object({
  messageId: z.string(),
  text: z.string(),
  lead: z.object({
    provider: z.string(),
    cwd: z.string(),
    model: z.string().nullable(),
    modeId: z.string().nullable(),
  }),
  leadAgentId: z.string().nullable(),
  /** Mailbox receipt for the first message; see architecture.md#receipts-and-notifications. */
  receipt: z.enum(["pending", "accepted", "uncertain"]),
});
export type SlpInitializationRecord = z.infer<typeof SlpInitializationSchema>;

/**
 * Why the group is held. Initialization holds every slot; a transfer holds
 * only the slot it moves, so the rest of the group keeps receiving mail. The
 * destructive-operation gate refuses on either, group-wide.
 */
const SlpHoldSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initialization"), slotId: z.string(), since: z.string() }),
  z.object({
    kind: z.literal("transfer"),
    slotId: z.string(),
    transferId: z.string(),
    since: z.string(),
  }),
]);
export type SlpHoldRecord = z.infer<typeof SlpHoldSchema>;

export const SlpGroupSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  mode: SlpWorkspaceModeSchema,
  status: z.enum(["initializing", "ready", "frozen"]),
  freeze: z.object({ reason: z.string(), at: z.string() }).nullable(),
  hold: SlpHoldSchema.nullable(),
  initialization: SlpInitializationSchema,
  leadSlotId: z.string(),
  supervisorSlotId: z.string().nullable(),
  slots: z.record(z.string(), SlpSlotSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SlpGroupRecord = z.infer<typeof SlpGroupSchema>;

/**
 * The subset recovery needs to keep a gate on a record it cannot fully
 * understand: identity and membership, with every other field ignored.
 */
const SlpGroupEnvelopeSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  slots: z
    .record(z.string(), z.object({ generations: z.array(z.object({ agentId: z.string() })) }))
    .optional(),
});

/**
 * One durable handback per Peer generation, registered before the Peer
 * exists. The destination is a slot, resolved at delivery time, so an owner
 * handoff between registration and completion cannot lose or misroute it.
 * See docs/slp/handoff.md#relationships-and-background-work.
 */
const SlpHandbackBaseSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  peerSlotId: z.string(),
  peerGenerationId: z.string(),
  peerAgentId: z.string(),
  ownerSlotId: z.string(),
  /** Set by a transfer so a Peer close during the switch is not read as failure. */
  transferInProgress: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const SlpHandbackOutcomeSchema = z.object({
  reason: z.enum(["finished", "errored", "closed"]),
  at: z.string(),
});
export type SlpHandbackOutcome = z.infer<typeof SlpHandbackOutcomeSchema>;

export const SlpHandbackSchema = z.discriminatedUnion("state", [
  // Waiting for the Peer. After a daemon restart the owner is told once per boot.
  SlpHandbackBaseSchema.extend({
    state: z.literal("armed"),
    notice: z.object({ mailId: z.string(), at: z.string() }).nullable(),
  }),
  // The Peer's outcome is recorded; its mail is not yet queued.
  SlpHandbackBaseSchema.extend({ state: z.literal("fired"), outcome: SlpHandbackOutcomeSchema }),
  // The handback is in the owner slot's mailbox; that record carries the delivery state.
  SlpHandbackBaseSchema.extend({
    state: z.literal("delivered"),
    outcome: SlpHandbackOutcomeSchema,
    mailId: z.string(),
  }),
  // The Peer was never created.
  SlpHandbackBaseSchema.extend({ state: z.literal("abandoned"), abandonedAt: z.string() }),
  // The Peer generation was replaced by a same-role handoff; the successor has its own record.
  SlpHandbackBaseSchema.extend({ state: z.literal("superseded"), transferId: z.string() }),
]);
export type SlpHandbackRecord = z.infer<typeof SlpHandbackSchema>;

/**
 * The provider prompt exactly as it will be dispatched: text, image blocks
 * and attachments. Attachments are tried first because a text attachment and
 * a plain text block share `type: "text"`, and the block schema would strip
 * the attachment's fields.
 */
const SlpMailPromptSchema: z.ZodType<AgentPromptInput> = z.union([
  z.string(),
  z.array(
    z.union([
      AgentAttachmentSchema,
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
]);

const SlpMailAttemptSchema = z.object({
  id: z.string(),
  generationId: z.string(),
  agentId: z.string(),
  at: z.string(),
});

const SlpMailBaseSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  slotId: z.string(),
  fromSlotId: z.string().nullable(),
  /** `activation` is the runtime's own notice after a switch; it dispatches before anything else queued. */
  kind: z.enum(["message", "handback", "interrupted", "activation"]),
  prompt: SlpMailPromptSchema,
  /** Dispatch order within the slot. */
  sequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * One durable message addressed to a slot. States follow
 * docs/slp/architecture.md#receipts-and-notifications; a crash while
 * `dispatching` is recovered as `uncertain` and never replayed automatically.
 */
export const SlpMailSchema = z.discriminatedUnion("state", [
  SlpMailBaseSchema.extend({ state: z.literal("queued") }),
  SlpMailBaseSchema.extend({ state: z.literal("dispatching"), attempt: SlpMailAttemptSchema }),
  SlpMailBaseSchema.extend({
    state: z.literal("accepted"),
    attempt: SlpMailAttemptSchema,
    acceptedAt: z.string(),
  }),
  SlpMailBaseSchema.extend({
    state: z.literal("uncertain"),
    attempt: SlpMailAttemptSchema,
    reason: z.string(),
  }),
]);
export type SlpMailRecord = z.infer<typeof SlpMailSchema>;

/** The agent-supplied part of a checkpoint. Role-specific detail goes in `notes`. */
export const SlpCheckpointContentSchema = z.object({
  objective: z.string(),
  constraints: z.string().nullable().default(null),
  decisions: z.string().nullable().default(null),
  workDone: z.string().nullable().default(null),
  workRemaining: z.string().nullable().default(null),
  evidence: z.string().nullable().default(null),
  unknowns: z.string().nullable().default(null),
  nextAction: z.string(),
  notes: z.string().nullable().default(null),
});
export type SlpCheckpointContent = z.infer<typeof SlpCheckpointContentSchema>;

/**
 * A position in the daemon's timeline for one agent. Valid only within its
 * epoch: a rebuilt timeline (restart, reload from disk) mints a new one and
 * renumbers, so a cursor from an older epoch anchors nothing.
 */
export const SlpTimelineCursorSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});
export type SlpTimelineCursor = z.infer<typeof SlpTimelineCursorSchema>;

/**
 * One current checkpoint per slot (id = slot id), rewritten in place, plus an
 * immutable copy per transfer (id = transfer id) taken at the switch. The
 * daemon attaches identity and the mail watermark; the agent cannot set them.
 * See docs/slp/handoff.md#checkpoint.
 */
export const SlpCheckpointSchema = z.object({
  id: z.string(),
  kind: z.enum(["current", "finalized"]),
  groupId: z.string(),
  slotId: z.string(),
  generationId: z.string(),
  agentId: z.string(),
  /** Increases with every rewrite of the slot's current checkpoint. */
  revision: z.number().int().positive(),
  content: SlpCheckpointContentSchema,
  /** Mail to this slot already accepted when the checkpoint was written. */
  coveredMailIds: z.array(z.string()),
  /** Where the writer's timeline stood; what follows it is the tail a transfer carries. */
  timelineCursor: SlpTimelineCursorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SlpCheckpointRecord = z.infer<typeof SlpCheckpointSchema>;

const SlpTransferCandidateSchema = z.object({ generationId: z.string(), agentId: z.string() });

/**
 * The source's timeline after its checkpoint, captured once it stopped and
 * bounded (docs/slp/handoff.md#history-recovery-contract). What was omitted
 * is counted, never summarized.
 */
export const SlpHistoryTailSchema = z.object({
  from: SlpTimelineCursorSchema,
  to: SlpTimelineCursorSchema,
  entries: z.array(z.object({ seq: z.number().int().nonnegative(), text: z.string() })),
  omitted: z.number().int().nonnegative(),
});
export type SlpHistoryTail = z.infer<typeof SlpHistoryTailSchema>;

const SlpTransferBaseSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  slotId: z.string(),
  sourceGenerationId: z.string(),
  sourceAgentId: z.string(),
  reason: z.string(),
  /** The current checkpoint's revision when the transfer was requested. */
  checkpointRevision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * The transfer journal, one file per transfer. Phases in order; the group's
 * active-generation pointer, not this file, is the committed switch, and boot
 * recovery reconciles the two (docs/slp/handoff.md#the-recovery-rule).
 */
/** What the stop recorded; every later phase carries it, a failure keeps it if it had it. */
const SlpTransferStopSchema = z.object({
  pendingPermissions: z.number().int().nonnegative(),
  historyTail: SlpHistoryTailSchema,
});
export type SlpTransferStop = z.infer<typeof SlpTransferStopSchema>;
const SlpTransferStoppedSchema = SlpTransferBaseSchema.extend({ stop: SlpTransferStopSchema });

export const SlpTransferSchema = z.discriminatedUnion("phase", [
  // Intent persisted, slot held. No external effect yet.
  SlpTransferBaseSchema.extend({ phase: z.literal("requested") }),
  // The source's stop was acknowledged by the manager and its tail captured.
  SlpTransferStoppedSchema.extend({ phase: z.literal("stopped") }),
  // A candidate generation exists in the group; its agent is being created or preparing.
  SlpTransferStoppedSchema.extend({
    phase: z.literal("preparing"),
    candidate: SlpTransferCandidateSchema,
  }),
  // The candidate acknowledged readiness; its preparation turn is stopped.
  SlpTransferStoppedSchema.extend({
    phase: z.literal("ready"),
    candidate: SlpTransferCandidateSchema,
  }),
  // The group pointer moved to the candidate. Everything after this rolls forward.
  SlpTransferStoppedSchema.extend({
    phase: z.literal("switched"),
    candidate: SlpTransferCandidateSchema,
    switchedAt: z.string(),
  }),
  SlpTransferStoppedSchema.extend({
    phase: z.literal("completed"),
    candidate: SlpTransferCandidateSchema,
    switchedAt: z.string(),
    completedAt: z.string(),
  }),
  // Held visibly: the slot stays held until someone repairs it.
  SlpTransferBaseSchema.extend({
    phase: z.literal("blocked"),
    candidate: SlpTransferCandidateSchema.nullable(),
    stop: SlpTransferStopSchema.nullable(),
    blockedReason: z.string(),
  }),
  // Restored before the switch: the source stayed the owner.
  SlpTransferBaseSchema.extend({
    phase: z.literal("aborted"),
    candidate: SlpTransferCandidateSchema.nullable(),
    stop: SlpTransferStopSchema.nullable(),
    abortedReason: z.string(),
  }),
]);
export type SlpTransferRecord = z.infer<typeof SlpTransferSchema>;
export type SlpTransferCandidate = z.infer<typeof SlpTransferCandidateSchema>;

export type SlpStoredGroup =
  | { kind: "valid"; record: SlpGroupRecord }
  | { kind: "unknown"; groupId: string; workspaceId: string; agentIds: string[]; error: string }
  | { kind: "unreadable"; groupId: string; error: string };

export function newSlpGroupId(): string {
  return `grp_${randomBytes(8).toString("hex")}`;
}

export function newSlpId(
  prefix: "slot" | "gen" | "hb" | "mail" | "attempt" | "tr" | "ckpt",
): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** One file per group under `$PASEO_HOME/slp/groups/`. A group is the atomic unit. */
export class SlpGroupStore {
  constructor(private readonly directory: string) {}

  private fileFor(groupId: string): string {
    return path.join(this.directory, `${groupId}.json`);
  }

  async write(record: SlpGroupRecord): Promise<void> {
    await writeJsonFileAtomic(this.fileFor(record.id), record);
  }

  async list(): Promise<SlpStoredGroup[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const results: SlpStoredGroup[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const groupId = name.slice(0, -".json".length);
      results.push(await this.read(groupId));
    }
    return results;
  }

  private async read(groupId: string): Promise<SlpStoredGroup> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.fileFor(groupId), "utf8"));
    } catch (error) {
      return { kind: "unreadable", groupId, error: describe(error) };
    }
    const full = SlpGroupSchema.safeParse(raw);
    if (full.success) return { kind: "valid", record: full.data };
    const envelope = SlpGroupEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      return { kind: "unreadable", groupId, error: full.error.message };
    }
    return {
      kind: "unknown",
      groupId: envelope.data.id,
      workspaceId: envelope.data.workspaceId,
      agentIds: Object.values(envelope.data.slots ?? {}).flatMap((slot) =>
        slot.generations.map((generation) => generation.agentId),
      ),
      error: full.error.message,
    };
  }
}

/** One file per record; an unparseable file is reported, never silently dropped. */
export class SlpRecordStore<T extends { id: string }> {
  constructor(
    private readonly directory: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  async write(record: T): Promise<void> {
    await writeJsonFileAtomic(path.join(this.directory, `${record.id}.json`), record);
  }

  async list(): Promise<Array<{ id: string; result: T | Error }>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const results: Array<{ id: string; result: T | Error }> = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const raw: unknown = JSON.parse(await readFile(path.join(this.directory, name), "utf8"));
        results.push({ id, result: this.schema.parse(raw) });
      } catch (error) {
        results.push({ id, result: error instanceof Error ? error : new Error(String(error)) });
      }
    }
    return results;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

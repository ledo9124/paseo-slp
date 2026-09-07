import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";

export const SlpWorkspaceModeSchema = z.enum(["direct", "supervised"]);
export type SlpWorkspaceMode = z.infer<typeof SlpWorkspaceModeSchema>;

export const SlpRoleSchema = z.enum(["supervisor", "lead", "peer"]);
export type SlpRole = z.infer<typeof SlpRoleSchema>;

const SlpGenerationSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  agentId: z.string(),
  state: z.enum(["preparing", "active", "retired"]),
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

const SlpHoldSchema = z.object({
  kind: z.enum(["initialization", "transfer"]),
  slotId: z.string().nullable(),
  since: z.string(),
});

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

export type SlpStoredGroup =
  | { kind: "valid"; record: SlpGroupRecord }
  | { kind: "unknown"; groupId: string; workspaceId: string; agentIds: string[]; error: string }
  | { kind: "unreadable"; groupId: string; error: string };

export function newSlpGroupId(): string {
  return `grp_${randomBytes(8).toString("hex")}`;
}

export function newSlpId(prefix: "slot" | "gen"): string {
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

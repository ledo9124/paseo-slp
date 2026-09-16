import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SlpRecordIdError, SlpRecordStore, SlpTransferSchema } from "./store";

const RecordSchema = z.object({ id: z.string() });

describe("SlpRecordStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "slp-store-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("writes one file per record id", async () => {
    const store = new SlpRecordStore(directory, RecordSchema);
    await store.write({ id: "activation_tr_0123abcd" });
    expect(await readdir(directory)).toEqual(["activation_tr_0123abcd.json"]);
  });

  test("refuses an id that is not a portable file name", async () => {
    const store = new SlpRecordStore(directory, RecordSchema);
    await expect(store.write({ id: "hb_1:interrupted:2026-09-07T10:56:14.771Z" })).rejects.toThrow(
      SlpRecordIdError,
    );
    expect(await readdir(directory)).toEqual([]);
  });
});

/**
 * A build reads a journal a later build wrote when someone downgrades. The
 * transfer schema is a closed union on `phase`, so a phase the reader does
 * not have refuses to parse rather than matching some looser variant. That
 * refusal is what the downgrade contract rests on
 * (docs/slp/supervisor-controlled-handoff.md#downgrade); see the restart
 * fixture in transfer.test.ts for what the daemon then does with it.
 */
describe("a transfer record from a newer build", () => {
  const known = {
    id: "tr_1",
    groupId: "grp_1",
    slotId: "slot_l",
    sourceGenerationId: "gen_1",
    sourceAgentId: "agt_1",
    reason: "context nearly exhausted",
    control: "supervisor",
    checkpointRevision: 1,
    phase: "awaiting_supervisor",
    stop: {
      pendingPermissions: 0,
      historyTail: {
        from: { epoch: "ep_1", seq: 0 },
        to: { epoch: "ep_1", seq: 0 },
        entries: [],
        omitted: 0,
      },
    },
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };

  test("parses while its phase is one this build knows", () => {
    expect(SlpTransferSchema.safeParse(known).success).toBe(true);
  });

  test("refuses a phase this build does not know", () => {
    // Stands for every future phase, including the ones this build added for
    // a reader that predates them.
    const later = { ...known, phase: "awaiting_human" };

    expect(SlpTransferSchema.safeParse(later).success).toBe(false);
  });

  test("refuses a control mode this build does not know", () => {
    expect(SlpTransferSchema.safeParse({ ...known, control: "human" }).success).toBe(false);
  });
});

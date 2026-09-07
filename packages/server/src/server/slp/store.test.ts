import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SlpRecordIdError, SlpRecordStore } from "./store";

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

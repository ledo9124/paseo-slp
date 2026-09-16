import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { retryWhileDestinationLocked, writeJsonFileAtomic } from "./atomic-file.js";

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  return error;
}

describe("atomic file writes", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "atomic-file-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("the record is readable and no temporary file is left behind", async () => {
    const filePath = path.join(directory, "record.json");
    await writeJsonFileAtomic(filePath, { id: "one", value: 1 });
    await writeJsonFileAtomic(filePath, { id: "one", value: 2 });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ id: "one", value: 2 });
    expect(await readdir(directory)).toEqual(["record.json"]);
  });

  test("a destination locked for a moment is retried until it succeeds", async () => {
    const waits: number[] = [];
    let attempts = 0;

    const result = await retryWhileDestinationLocked(
      async () => {
        attempts += 1;
        if (attempts < 3) throw errno("EPERM");
        return "renamed";
      },
      { delay: async (ms) => void waits.push(ms) },
    );

    expect(result).toBe("renamed");
    expect(attempts).toBe(3);
    expect(waits).toEqual([5, 10]);
  });

  test("a destination that stays locked fails with the original error", async () => {
    const waits: number[] = [];
    let attempts = 0;

    await expect(
      retryWhileDestinationLocked(
        async () => {
          attempts += 1;
          throw errno("EBUSY");
        },
        { attempts: 4, delay: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toMatchObject({ code: "EBUSY" });

    expect(attempts).toBe(4);
    expect(waits).toEqual([5, 10, 15]);
  });

  test("an error that is not a momentary lock is not retried", async () => {
    let attempts = 0;

    await expect(
      retryWhileDestinationLocked(async () => {
        attempts += 1;
        throw errno("ENOSPC");
      }),
    ).rejects.toMatchObject({ code: "ENOSPC" });

    expect(attempts).toBe(1);
  });
});

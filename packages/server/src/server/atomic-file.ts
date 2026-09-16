import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Windows denies a rename while any process still holds a handle to the
 * destination, and a virus scanner or the search indexer opens files it sees
 * appear. The window is short, so the write is retried rather than failed:
 * every caller here treats a write as the durable record of a decision, and a
 * lost one strands the work that decision belongs to.
 */
const MOMENTARY_LOCK_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const LOCK_RETRY_ATTEMPTS = 10;
const LOCK_RETRY_STEP_MS = 5;

export interface RetryWhileDestinationLockedOptions {
  /** Total tries, including the first. */
  attempts?: number;
  delay?: (ms: number) => Promise<void>;
}

function isMomentaryLock(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    MOMENTARY_LOCK_CODES.has((error as NodeJS.ErrnoException).code ?? "")
  );
}

/**
 * Retries a file operation a bounded number of times while the destination
 * reads as momentarily locked. The backoff grows so a scanner holding a file
 * for tens of milliseconds is outwaited without a busy loop; any other
 * failure, and the last attempt, throw the original error untouched.
 */
export async function retryWhileDestinationLocked<T>(
  operation: () => Promise<T>,
  options?: RetryWhileDestinationLockedOptions,
): Promise<T> {
  const attempts = options?.attempts ?? LOCK_RETRY_ATTEMPTS;
  const delay =
    options?.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isMomentaryLock(error)) throw error;
      await delay(LOCK_RETRY_STEP_MS * attempt);
    }
  }
}

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await retryWhileDestinationLocked(() => fs.rename(tempPath, filePath));
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

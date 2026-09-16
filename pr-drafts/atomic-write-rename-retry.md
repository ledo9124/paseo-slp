> **CI has not run on this branch yet.** Everything below was verified on a Windows checkout; the Linux half of the matrix is the reviewer's first real signal.

### Linked issue

Closes #

### Type of change

- [x] Bug fix

### Reasoning

Every durable record the daemon keeps — agent state, schedules, the workspace registry, SLP group and mail journals — is written through `writeFileAtomic`, which writes a temp file and renames it over the destination. The rename was attempted once. Windows denies a rename while any process still holds a handle to the destination, and a virus scanner or the search indexer opens files the moment it sees them appear, so that single attempt intermittently failed.

The failure did not surface as an error anyone acted on. It surfaced as work that quietly did not happen: for SLP, a message the user sent to an agent stayed queued forever with nothing left to deliver it.

### Goals

- Retry the rename while the destination reads as momentarily locked (`EPERM`, `EACCES`, `EBUSY`), with a growing backoff.
- Keep the retry bounded, so a genuinely held file still fails rather than hanging.
- Leave every other errno, and the final attempt, throwing the original error untouched.
- Leave the success path and temp-file cleanup unchanged.

### Non-goals

- No change to what is written, when, or by whom; no call site changes.
- Not a general-purpose retry utility for the daemon. The exported helper is scoped to "the destination is momentarily locked".
- Does not make writes idempotent or transactional.

### QA

Root cause was found by instrumenting the SLP mail dispatch loop and running the failing assertion until it reproduced:

```
DRAIN dispatch start 3 mail_371f...  report
DRAIN THREW loop 3 EPERM: operation not permitted, rename
  '...\.mail_371f....json.12448....tmp' -> '...\mail_371f....json'
DIAG supervisor lifecycle idle      <- mail still "queued" after 10s
```

Measured on Windows, 10 runs per configuration, on the two focused assertions that were timing out:

|        | `slp/service.test.ts` busy Supervisor | `slp/mailbox.test.ts` busy Peer |
| ------ | ------------------------------------- | ------------------------------- |
| Before | 9/10 failures                         | 7/10 failures                   |
| After  | **0/10 failures**                     | **0/10 failures**               |

New tests in `atomic-file.test.ts`: a real-filesystem write/overwrite that asserts the record is readable and no temp file is left behind, plus three retry-policy tests with an injected delay so they are deterministic and platform-independent (retries until success, gives up after the bound with the original error, does not retry an unrelated errno). The three policy tests fail on `main` with `retryWhileDestinationLocked is not a function`; the filesystem test passes before and after.

Regression check on other consumers of the atomic write — `agent-storage`, `schedule/store`, `workspace-registry`, `managed-processes`, `project-custom-icon`, `agent/requests`: 67 tests, all passing.

A companion PR makes the SLP mailbox resilient to a dispatch failure from any cause. The two are independent and each closes the measured flake on its own; this one fixes the root cause for all 42 call sites of the atomic write, the other hardens one consumer.

### Checklist

- [x] One focused change
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run format` passes (on the committed content; the working-tree check is red on Windows for line endings alone)
- [x] QA evidence
- [x] Tests added or updated where it made sense

🤖 Generated with [Claude Code](https://claude.com/claude-code)

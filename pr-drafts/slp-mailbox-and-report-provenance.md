> **CI has not run on this branch yet.** Everything below was verified on a Windows checkout; the Linux half of the matrix is the reviewer's first real signal.

### Linked issue

Closes #

### Type of change

- [x] Bug fix
- [x] Docs

### Reasoning

SLP delivers every message between group members through the slot mailbox, and the Supervisor hears from a Lead through the report relay. Three defects made both lose messages quietly — a send that reports success and an agent that never answers, or a Supervisor told something the Lead never said.

A wake-up could be lost. One dispatch loop runs per slot, and a second pump while one runs is a no-op. But a loop that saw an empty queue stayed registered until its promise chain settled two microtasks later, so a message enqueued in that window found a loop that was already leaving. Nothing re-entered, and the message stayed queued forever.

A dispatch that threw before admission — the agent failing to load, or the durable attempt record failing to write — rejected the loop, and the loop's catch turned that into a log line and returned. Same outcome, silently.

And a completed transfer sends its successor an activation notice. The successor answers it, its turn ends, and the relay delivered that answer to the Supervisor as the Lead's report: a turn the Lead never chose to take, reported as if it had something to say, which the Supervisor then has to relay to the user.

All three matter beyond today. The Supervisor decision boundary being designed for supervised Lead handoff depends on exactly these notices arriving, and on the Supervisor not being told the runtime's own traffic is the Lead talking.

### Goals

- Record a wake-up before the live loop is consulted, and read it back as the loop releases the slot.
- Keep one dispatch loop per slot, registered before it starts rather than once it yields.
- Retry a dispatch that fails before admission, bounded, with a growing backoff; on giving up, leave the message `queued` so the next wake-up or the pump every restart performs picks it up.
- Suppress the report for a turn the runtime itself started, and only for that turn.
- Record the Supervisor-controlled handoff contract in `docs/`, where it was an untracked working note.

### Non-goals

- No change to ordering, the activation-first rule, the `busy` contract, or the delivery state machine. No new phase or record, so the later handoff slices learn nothing new.
- No change to `agent-manager.ts`. Its admission answer already carries everything report provenance needs.
- Does not fix the root cause of the write failures that exposed the second defect; that is a companion PR.
- No Supervisor decision boundary implementation. This PR only records its contract.

### QA

New deterministic regressions in `mailbox-dispatch.test.ts` drive the dispatch loop directly. `resolveSlot` is the one synchronous seam inside a running loop, so a test can act at the exact moment the loop still owns its pump entry and is one statement from exiting; holding admission pins the loop to a known iteration, so no assertion depends on which pending operation finishes first. No sleeps, no raised timeouts.

| Test                                                                               | Without the fix                                 | With it |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ------- |
| a wake-up that arrives while the loop is exiting is not lost                       | hangs to timeout                                | passes  |
| a loop that exits on a held slot waits for the next wake-up instead of spinning    | passes                                          | passes  |
| a dispatch that fails before admission is retried instead of stranding the message | hangs to timeout                                | passes  |
| a dispatch that keeps failing defers delivery instead of abandoning it             | hangs to timeout                                | passes  |
| the Lead's answer to a runtime control notice is not a report                      | fails: the only report is the activation answer | passes  |
| the runtime claims the turn its own control message starts                         | —                                               | passes  |
| a control message merged into someone else's turn leaves that turn theirs          | —                                               | passes  |
| an ordinary message never claims the turn it starts                                | —                                               | passes  |

The held-slot test is a guard, not a formality. The obvious fix — re-check the queue at loop exit and re-pump — spins forever, because a loop also exits with its message still queued when the slot is held. That is why the wake-up is a recorded flag rather than a queue re-check, and the test fails if anyone reverts to the simpler shape.

The report-provenance test was rewritten before it was trusted. The first version passed with the bug still present, because it asserted the absence of a report at a moment the report had not been enqueued yet. It now gives the two turns different content and relies on ordering: a report for the activation turn would be queued before the ordinary turn's, so whichever report exists first decides the assertion either way.

Measured on Windows, 10 runs per configuration, against the two focused assertions that were timing out:

|                    | `service.test.ts` busy Supervisor | `mailbox.test.ts` busy Peer |
| ------------------ | --------------------------------- | --------------------------- |
| Before             | 9/10 failures                     | 7/10 failures               |
| Lost wake-up fixed | 2/10 failures                     | 7/10 failures               |
| This PR complete   | **0/10 failures**                 | **0/10 failures**           |

The middle row is the point. The lost wake-up was real and is fixed, but it was not the whole cause of the symptom it was diagnosed from; a single-attempt `fs.rename` was the rest. The companion PR fixes that root cause for all 42 call sites of the atomic write. The two are independent and each closes the flake on its own — they harden different layers, and the numbers are recorded in `docs/slp/implementation-plan.md` so the wrong conclusion is not drawn again.

One separate flake is fixed here too, in its own commit. `transfer.test.ts` asserted that a handback was `queued` at a moment the dispatch loop only passes through: once the activation notice is accepted the loop offers the handback to a successor that is still running that notice, persisting `dispatching` before admission answers `busy` and returns it to the queue. It failed about one run in ten, and only when the whole SLP directory ran at once — the shape that gets blamed on whatever change is in the tree. It was measured against a clean baseline first to confirm it was pre-existing, then fixed to assert the claim the test actually makes. The SLP directory now runs 12 times with no failure.

### Checklist

- [x] One focused change
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run format` passes (on the committed content; the working-tree check is red on Windows for line endings alone)
- [x] QA evidence
- [x] Tests added or updated where it made sense

🤖 Generated with [Claude Code](https://claude.com/claude-code)

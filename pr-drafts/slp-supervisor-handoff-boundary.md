> **Stacked on `fix/slp-mailbox-and-report-provenance`.** That branch is its base and this one depends on it, so open this against it rather than against `sync/upstream-2026-09-14`; targeting the sync branch puts 12 commits in the diff instead of the 7 that belong here. GitHub retargets it once the base merges.

> **CI has not run on this branch yet.** Everything below was verified on a Windows checkout. The Linux half of the matrix, and the whole-repository format check, are the reviewer's first real signal.

### Linked issue

Closes #

### Type of change

- [x] Enhancement

### Reasoning

A supervised group exists so the Supervisor holds the conversation with the user and the process around the Lead's work, while the Lead holds the engineering. Replacing the Lead's context is a process decision — when to do it, and whether now is the moment — and the Supervisor was not in that path. A supervised Lead asked for a handoff and the runtime immediately stopped it, built the successor, switched the slot and retired the old generation. The Supervisor learned about it afterwards.

This puts the boundary in, gives the Supervisor the decision, makes both survive a restart, and shows the group where it is waiting. The Lead still prepares its own handoff and still owns its engineering; it stops at a point where a decision can be made, and the Supervisor answers.

### Goals

- Record on the transfer who releases the replacement, so a restart reads it from the journal rather than inferring it from the group's current mode.
- Stop a supervised Lead's transfer at `awaiting_supervisor`: source stopped, slot held, no candidate anywhere, source refused product turns by a named error.
- Tell the Supervisor a decision is waiting, in terms that cannot be mistaken for Human text or for a request to judge the work.
- `slp_decide_lead_handoff` continues or cancels, with authority checked when it runs, idempotent on repeat, and a typed conflict on the opposite answer.
- Make a cancellation durable in an order a crash can resume from, and leave the source knowing why it is still the Lead.
- Resume or finish whatever the journal reached, and re-ask when the daemon cannot tell whether the Supervisor was ever told.
- Show every member where the group stands, including the Supervisor, which the transfer names nowhere.
- Leave Direct Lead, Peer in any mode, and Supervisor self-handoff exactly as they were.

### Non-goals

- No decision button for Human. The decision is the Supervisor's, through its tool.
- No generic Supervisor agent control (`cancel_agent`, `archive_agent`, and the rest). The decision tool acts on a transfer, not on an agent.
- No migration. Per the contract, this is for groups created after it lands, because a session's tool catalog is fixed when it launches.
- No automatic context threshold and no compaction interception. A handoff is still something an agent asks for.

### QA

Every acceptance criterion in `docs/slp/supervisor-controlled-handoff.md` has a test. Server SLP suite: 73 passing. App SLP and locale parity: 56 passing.

| Claim                                                          | How it is proven                                                                                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The request reaches `awaiting_supervisor` with no candidate    | Asserted on the record, on the file on disk, and on the slot's generation count                                                                                        |
| The source is refused a turn, by name                          | `admitForegroundTurn` rejects with `SlpSourceSuspendedError`                                                                                                           |
| Only the active same-group Supervisor can decide               | The catalog hides the tool from the Lead; the service refuses the Lead even when it calls directly, and the transfer does not move                                     |
| The Supervisor is told what it needs                           | The delivered prompt names the transfer, the tool, that no successor exists, and that this is not an engineering judgement                                             |
| Continue creates exactly one candidate                         | Generation count goes 1 → 2, and the candidate is the new active generation                                                                                            |
| The candidate stays receive-only                               | `executionPolicyFor` reads `preparation` before `slp_ready`, `authorized` after the switch                                                                             |
| Cancel creates none                                            | Generation count stays 1, the source is still active, the hold is gone                                                                                                 |
| The source notice is durable, and first                        | A message queued during the hold is delivered _after_ the cancellation notice                                                                                          |
| A reason is optional; repeating a decision is stable           | Cancel with no reason; the second call returns the same receipt, the record is unchanged, and one notice exists                                                        |
| The opposite answer is a typed failure                         | `SlpDecisionConflictError`, record still `canceled`                                                                                                                    |
| A pending decision survives the feature being disabled         | The Lead loses `slp_request_handoff`; the Supervisor keeps `slp_decide_lead_handoff` until the transfer is resolved, then loses it too                                 |
| A pending decision survives a restart                          | Still `awaiting_supervisor`, no candidate, hold intact, and the suspension back without being stored                                                                   |
| A decision taken before a crash is carried out after it        | The journal is seeded at `continued` and the next daemon prepares, switches and completes                                                                              |
| An interrupted cancellation finishes once                      | Seeded at `canceling`; the next daemon delivers the notice, clears the hold, and exactly one control mail exists                                                       |
| A cancellation whose hold outlived it is completed, not frozen | Seeded terminal with the hold still set; the group comes back `ready`                                                                                                  |
| An undeliverable notice is re-asked, marked                    | Seeded `dispatching`; recovery reads it as `uncertain`, retains it untouched, and sends a fresh notice saying it may be a duplicate                                    |
| The Supervisor can see the pending decision                    | It is read from the group, not from the transfer's own agents; its banner asks it to answer                                                                            |
| The stopped Lead sees why it is stopped                        | A distinct line from the ordinary handing-off one: nothing is being prepared and it is not on its way out                                                              |
| Direct Lead, Peer, Supervisor self-handoff stay automatic      | Three separate tests; the Peer one runs inside a supervised group                                                                                                      |
| A daemon that predates the contract changes nothing            | A record stripped of `control` takes the v1 rollback on the server, and produces no pending decision anywhere in the app                                               |
| A phase this build cannot read fails closed                    | Seeded with a phase no build has: the schema refuses it, the group comes back frozen with its hold intact and its file untouched, and a second workspace is unaffected |

Six of these are regressions rather than new coverage, each confirmed by reverting the change and watching the right test fail while everything else kept passing:

- **The Supervisor could not see it.** A transfer attaches to an agent only when that agent is its source or candidate, and a Lead handoff is neither of those for the Supervisor. The one member who could answer was the one member with nothing on screen.
- **The stopped Lead could not see it either**, because the pending phases were not in the app's live set.
- **Notice ordering.** Only activation mail jumped the queue, so a notice telling a source it is still the Lead would have arrived behind whatever queued while the slot was held.
- **Recovery ordering.** Mail records loaded after reconciliation, so a transfer deciding whether it still owed the Supervisor a notice saw an empty mailbox, re-enqueued the same id, got the old record back, and delivered nothing.
- **Orphaned transfers.** `request` persists the record before the hold, so a crash between the two left a transfer no runner owned and no hold reconciled, and a repeat request kept handing the source its id.
- **The boundary itself.** Reverted to its pre-change form, the three tests that depend on it failed and every automatic path kept passing, which is what shows the change is confined to the Lead slot of a supervised group.

The rest is coverage for behaviour this branch introduces. The `canceled`-with-a-stale-hold test is a guard: that phase is terminal, and the rule that freezes a group when a terminal transfer still holds a slot has to keep skipping it.

On the wire the three new fields are optional strings, like `phase` and `role` beside them, so an older app keeps parsing when the daemon learns a value. Absent `control` reads as automatic, which is what the daemon already does with a record that has none — permanent semantics rather than a shim, so nothing is tagged for deletion.

### Checklist

- [x] One focused change
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run format` passes (on the committed content; see `docs/development.md` for why the working-tree check is red on Windows)
- [x] QA evidence
- [x] Tests added or updated where it made sense

🤖 Generated with [Claude Code](https://claude.com/claude-code)

# Supervisor-controlled Lead handoff

Status: the boundary and the decision exist. A supervised Lead transfer stops at `awaiting_supervisor` with no candidate, its source is refused product turns, the Supervisor is told a decision is waiting, and `slp_decide_lead_handoff` continues or cancels it. Staged recovery, the marked recovery notice for an uncertain notification, and the client projection are target contract. [Handoff](handoff.md) owns the pipeline, which is still the whole story for Direct Lead, Peer and Supervisor self-handoff.

## Outcome

A supervised Lead prepares its own handoff and stops. The runtime suspends the source and waits. Supervisor decides whether the replacement continues, and the runtime — not Supervisor — creates the candidate, switches the active generation, reparents Peers and retires the source.

Supervisor owns process supervision and the timing of a context replacement. Lead keeps engineering direction and engineering acceptance. Runtime keeps membership, slots and generation transitions. The decision authorizes timing; it is not a technical approval and not a statement that the work is correct or complete.

## Rollout

New supervised workspaces and groups only. An existing group is not upgraded, because a session's tool catalog is fixed when it launches ([architecture](architecture.md#tool-and-write-boundaries)), so a Supervisor generation that started before the build has no decision tool and never gets one. There is no migration UI, group upgrade or recreate mechanic, and no `handoffContractVersion` on the group.

Restart safety, persisted-record compatibility, protocol compatibility and fail-closed downgrade still apply. Those are not migration support.

## What stays automatic

Direct-mode Lead, Peer in every mode, Supervisor self-handoff, and any persisted transfer record without `control`. A record written before this contract reads as automatic, which is parser safety rather than support for old groups.

## Decisions taken

Supervisor decides through an agent tool, not a Human UI button. The decision is `continue` or `cancel`; neither word means approval of the work. No candidate exists before `continue`. The runtime inherits provider, model, mode, options and cwd from the source, so Supervisor never configures a candidate. A cancel reason is optional in the schema and encouraged in the role instructions. A cancelled source always receives a durable runtime wake-up notice.

Out of scope here: generic Supervisor `create_agent`, `archive_agent`, `kill_agent`, `update_agent` or Peer reassignment; Human approve/cancel UI; automatic compaction interception; a context threshold; forced recovery from a Lead that cannot author a checkpoint; replacing `slp_ready` with a Supervisor decision; and any change to Lead's engineering authority.

## Sequence

```text
Lead reaches a safe boundary
  -> slp_request_handoff(reason, context)
  -> runtime persists the request and the slot hold
  -> the source's turn ends and stop evidence is captured
  -> awaiting_supervisor
       -> continue -> continued -> preparing -> ready -> switched -> completed
       -> cancel   -> canceling -> canceled
```

`slp_ready` keeps its current meaning throughout: the candidate confirms it has reconciled the supplied context well enough for the runtime to activate it. It does not approve project work and does not stand in for the Supervisor decision.

## Durable state

The transfer base gains one optional field:

```ts
control?: "automatic" | "supervisor";
```

Absent means automatic, so an old record stays readable and a restart never infers behavior from the group's current mode. `blocked` keeps its meaning of a failure needing operator or restart reconciliation. `aborted` keeps its v1 meaning of a pre-switch safety rollback and is not the outcome of a Supervisor cancel.

Every transfer past a decision carries it durably:

```ts
interface SlpTransferDecision {
  outcome: "continue" | "cancel";
  actorAgentId: string;
  actorGenerationId: string;
  decidedAt: string;
  reason?: string;
}
```

The decision persists before any effect it authorizes: `continue` before the candidate is created, `cancel` before the source notice, the hold cleanup or the admission restoration.

### Cancellation ordering

Cancel is not one atomic write, so the order is the contract:

1. Persist `canceling` with the decision.
2. Enqueue the source wake-up notice under an ID derived from the transfer ID.
3. Persist `canceled`, which asserts that both the decision and the required notice are durable.
4. Clear the group hold.
5. Pump the source slot and any slot the hold covered.

A crash at any step resumes from the journal: `canceling` ensures the notice and finishes; `canceled` with a hold still set clears it and pumps; `canceled` with no hold is a no-op. Reconciliation must reach a `canceled` record that still holds a slot. The existing rule freezes a group whose terminal transfer still holds the slot, and applying it to `canceled` would freeze the group instead of completing the cancel.

### Continue ordering

Validate the caller's authority and the expected phase, persist `continued` with the decision, then schedule or resume the preparation runner. Candidate creation keeps using the keyed creation journal under the transfer ID. A crash after the decision resumes preparation; it does not return to waiting for another decision.

## Decision tool

```ts
slp_decide_lead_handoff({
  transferId: string,
  decision: "continue" | "cancel",
  reason?: string
})
```

The tool is in the catalog of a Supervisor generation launched by a build that has it. It is absent for Lead, Peer, Direct-mode agents, ordinary non-SLP agents and a candidate's preparation generation.

Every call re-checks, at execution time, that the caller is the active Supervisor generation of the same supervised group, that the transfer belongs to that group's active Lead slot, that `control === "supervisor"`, that the phase accepts a decision, and that the group and pointer do not contradict the journal. The call is keyed by `transferId`; there is no "current pending transfer" API to race against.

Retrying the same decision returns a stable receipt and repeats no effect. A conflicting decision returns a typed conflict. A decision arriving after a switch, completion or cancel creates no candidate and resumes no source a second time. Two Supervisor turns, or a stale generation, produce exactly one winner.

Turning the handoff feature off after a transfer is pending must still leave the active Supervisor a path to resolve it. `slp_ready` already has that carve-out in `slp/service.ts`; the decision tool needs the equivalent, keyed off the persisted pending transfer.

## Source suspension

While a `control=supervisor` transfer for the source generation sits in `stopped`, `awaiting_supervisor`, `continued`, `preparing`, `ready` or `canceling`, and the active-generation pointer has not moved to the candidate, the source is refused product turns. The refusal is typed — `SLP_SOURCE_SUSPENDED_FOR_HANDOFF` — and carries the group ID, transfer ID and phase. It must not be disguised as `busy` or `retired`.

Today the admission gate refuses only a retired generation, and the transfer hold covers the source slot's mailbox. Direct Human or session admission can still start a product turn while the old Lead is the active generation.

Runtime control cleanup never depends on the source executing a tool. The source becomes runnable again only once the cancel decision is durable and the runtime has entered terminal cancellation cleanup, and its wake-up notice must be durable before the hold lifts so it is the first thing the slot can drain.

## Notifications

When `awaiting_supervisor` is durable, the runtime enqueues a control notice to the Supervisor slot under an ID derived from the transfer ID. It states that this is an SLP runtime control event rather than Human text, that the source has stopped, that no candidate exists, the transfer ID, the exact decision tool, and that the decision is not an engineering acceptance. It does not travel as an ordinary Lead report.

A cancel enqueues a source-facing notice before the hold lifts: the handoff was cancelled, the source is still the active Lead, the reason if one was given, product admission is restored, and queued input needs reconciling before work resumes. It must not read as a Human instruction.

Durable is not delivered. Enqueuing makes a notice durable; the dispatch loop retries a failing send a bounded number of times and then leaves it `queued` for the next wake-up ([admission](architecture.md#admission)). Nothing here may read "the notice is durable" as "the Supervisor has it" — the decision stays pending, and the projection, not the notice, is what makes it visible.

Mailbox recovery turns `dispatching` into `uncertain` and never replays it, and retrying under the same stable ID returns the existing record rather than delivering anything. So an uncertain primary notice would leave a pending decision invisible forever. Two things prevent that: the pending decision is visible in the group projection, and recovery enqueues a separately identified notice that says it may duplicate the first. Duplicate wake-ups are harmless because the decision is idempotent.

```text
handoff_waiting_<transferId>
handoff_waiting_recovery_<transferId>_<attempt>
```

## Report provenance

A runtime control response is not a product report. The runtime must know a turn's origin; do not ask the prompt text not to be reported.

Provenance is claimed, not inferred, and it needs nothing from the agent manager. Admission takes the run slot synchronously and answers `started` only when it made the claim, so marking the agent before the call is enough to know the turn that answer describes: there is no turn id to correlate and no window for another writer to take the claim in between. Any other answer releases the mark. `busy` started nothing, and `steered` merged the message into a turn somebody else owns, whose final message is still theirs to report. `slp/control-turns.ts` holds the marks; settle them however the turn ends, or a failed control turn silences the next ordinary one.

An earlier reading of this problem concluded that `AgentManagerEvent` carrying no turn origin meant the implementation had to add a correlation contract to `AgentManager`. It does not, and adding one would have broken that suite's admission assertions for nothing.

The scope is a set of mail kinds, not a taxonomy. Relaying the Lead's final message stays the default; only `activation` is control today, and cancel, resume and recovery notices join it by being added to that set. `interrupted` stays out: it reports a Peer's lost turn, and the Lead's answer to it is project work. Product turns, Human turns, Supervisor requests and Peer handback processing still report, and suppression must not swallow the next ordinary report.

An earlier attempt suppressed a report when the Lead had already sent the Supervisor mail during the turn. That heuristic was removed deliberately in `76d13f62b`, because a Lead that reports progress still owes a final message. Origin correlation is a different basis and must not reintroduce it.

## Recovery

Boot currently reconciles transfers before mailbox records load, and reaches a transfer only through a group hold. Both have to change.

1. Load checkpoint and transfer records without starting runners.
2. Load group records and identify holds and membership.
3. Recover mailbox records, converting `dispatching` to `uncertain`.
4. Reconcile every live or nonterminal transfer journal, plus any terminal transfer a group hold still references, against the group pointer.
5. Ensure the required primary and recovery notifications.
6. Recover handbacks.
7. Start mailbox pumps and resumed transfer runners.
8. Publish ready group state to clients.

`mailbox.recover()` loads records and starts pumps in one call; step 3 and step 7 require splitting it.

Per phase: `requested` without durable stop evidence rolls back under the existing safety policy. `stopped` with `control=supervisor` advances idempotently to `awaiting_supervisor` and ensures the notice. `awaiting_supervisor` preserves the hold and the suspension and creates no candidate. `continued` resumes preparation. `preparing` or `ready` still pointing at the source keeps the current rollback and retire-candidate policy unless the implementation proves the creation journal resumes safely. A candidate pointer rolls forward. `canceling` ensures the source notice and finishes. `canceled` ensures hold cleanup and a mail pump. A pointer matching neither generation, or an unreadable required record, freezes only that group.

## Concurrency and observability

Decision mutations run in the workspace serialization lane. Continue versus cancel, duplicate decisions, a Supervisor handoff racing a decision, ending the group, a destructive operation and a feature toggle against pending cleanup each need a deterministic winner, through that lane plus an expected-phase compare-and-set.

Structured logs carry the group, transfer, slot, source and candidate IDs, the control mode, the old and new phase, the deciding actor's generation, how long the transfer spent awaiting, preparing and completing, the primary and recovery notification IDs, the reason a delivery was uncertain, and which recovery action ran: rollback, resume, roll-forward or freeze. They do not carry checkpoint content, supplied context or prompt text.

## Projection and UI

The wire `phase` is already `string`, so new phases narrow nothing. Any new field is optional, per [protocol compatibility](../protocol-compatibility.md).

```ts
control?: "automatic" | "supervisor";
decision?: "continue" | "cancel" | null;
decidedAt?: string | null;
```

The app's `LIVE_TRANSFER_PHASES` needs the pending phases. Its membership selector attaches a transfer only when the current agent is the source or the candidate, and Supervisor is neither, so the Supervisor banner needs a group-level pending Lead lookup or a first-class pending-control projection.

Banners: Supervisor sees that a Lead handoff is waiting for its decision; the suspended source sees that it is waiting for Supervisor before its context is replaced; a Human-facing status says a Lead context replacement is pending. There is no approve or cancel button in the first release.

## Downgrade

An old daemon need not understand the new phases, but it must not resume a source or create a candidate from a state it cannot read. A live transfer fails closed and freezes.

Quiesce first, as [architecture](architecture.md) already requires: stop starting transfers, resolve every pending one, confirm no live `awaiting_supervisor`, `continued`, `preparing`, `ready`, `switched` or `canceling` record remains, stop the daemon cleanly, back up `$PASEO_HOME/slp`, then downgrade. If an old daemon freezes a state it cannot read, restore the new build; do not edit journal files by hand.

## Risks

| Risk                                          | Impact                                         | Mitigation                                                                 |
| --------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| Decision persisted after its effect           | Duplicate candidate, ambiguous cancel          | Persist before every effect; keyed creation; phase compare-and-set         |
| Source receives work while pending            | Two contexts act as Lead                       | Typed admission suspension derived from the transfer journal               |
| Old Supervisor catalog lacks the tool         | Transfer pends forever                         | New-workspace-only rollout                                                 |
| Primary notice becomes uncertain              | Invisible permanent hold                       | Projection plus an explicitly marked recovery notice                       |
| Recovery runs before mailbox records load     | An uncertain record is overwritten or replayed | Staged recovery ordering                                                   |
| Runtime activation becomes a Lead report      | Report loop and misleading Human status        | Origin correlation and control-turn suppression                            |
| Cancel cleanup crashes                        | Hold or mail stuck                             | Durable `canceling`/`canceled` journal, idempotent reconciliation          |
| Supervisor read as the technical approver     | Authority drift                                | `continue`/`cancel` wording in the tool, its description and the role docs |
| UI only checks source or candidate membership | Supervisor cannot see the pending state        | Group-level pending Lead lookup                                            |

## Done means

A new supervised Lead handoff stops at a durable, visible decision boundary. The source is suspended from product execution while pending. No candidate exists before `continue`. Only the active same-group Supervisor can decide. Both outcomes are durable, idempotent and restart-safe. The runtime remains the only owner of candidate creation, the switch, reparenting and retirement. `slp_ready` still means candidate readiness. Cancel always leaves a durable source wake-up and restores the source exactly once. Runtime control turns do not become Lead reports, and ordinary Lead results still report exactly once. Pending and uncertain states survive reconnect and restart, and a duplicate-possible recovery notice is marked and cannot duplicate an effect. Direct Lead, Peer, Supervisor self-handoff and records without `control` stay automatic. Protocol changes stay additive. A live downgrade fails closed.

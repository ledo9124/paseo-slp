# Same-role context handoff

Status: target contract. Provider interception and recovery have not been demonstrated in this fork. See [provider support](providers.md) for the required evidence and for why automatic handoff is Claude-only in v1.

## Outcome

Continue the same role and assignment in a fresh provider session before its context is exhausted. Preserve the logical slot, workspace, authority, provider/model, effective instructions, pending mail and outstanding delegation. Retain old generations for reference. This is separate from changing workspace mode or replacing a Lead's engineering judgment.

Handoff selects and condenses context, so it can omit information. Keep artifact references and recoverable history. Do not claim lossless memory or load the full transcript into the successor. There is no Paseo-side transcript to normalize either: timelines are runtime memory, re-hydrated from the provider. Checkpoint content comes from the agent or from the provider adapter, never from Paseo history.

## Proactive preparation

Use adapter-reported active-context usage, not cumulative billed tokens. Both supported adapters already report an active figure rather than a running total, and both already reset it across a native compaction. The numerator is not the problem.

The denominator is. What the adapters expose as the context maximum is the model's advertised window, taken from the model manifest or scraped from result usage. It is not the resolved autocompact window, which on a large-context model is often a fraction of the advertised one. A threshold computed against the advertised window can be wrong by several times, in the unsafe direction — it fires too late. The SDK exposes the resolved window directly, but Paseo never calls that API and two existing tests assert it is not called. Those tests name subagent result handling, so read their intent before changing them: a probe once every N turns may be compatible where a probe on every result is not.

The initial calibration target is 60% of the confirmed budget, using the lower applicable context/compaction budget. This is a conservative test starting point, not a proven optimum or a universal provider guarantee. Reserve capacity for in-flight output, the final checkpoint and admission overhead. Test long single turns and large tool results; a threshold checked only after a turn can be too late.

Context usage is memory-only and is not persisted, so a rehydrated agent has no reading until its next turn produces one. Missing or stale telemetry cannot be represented as zero usage — hold, and report the budget as unknown.

Mark preparation requested once per generation. Stop admitting normal mail and further assignments to that generation. Request a bounded checkpoint at an appropriate execution boundary. Do not interrupt an unresolved external operation and infer that it never happened. If a provider cannot reach a known stop, hold the transfer visibly instead of activating a concurrent writer. The adapter's own interrupt reports optimistically; the authoritative answer is the manager's acknowledged cancellation, which returns settled, refused or not-running. Consume that, not the adapter call.

## Checkpoint

`slp_checkpoint` is the proposed capability name, not an existing tool. Store one current checkpoint plus immutable finalized transfer snapshots under daemon-owned SLP data. Use the role-specific fields in [Supervisor](roles/supervisor.md#checkpoint-content), [Lead](roles/lead.md#checkpoint-content), and [Peer](roles/peer.md#checkpoint-content).

The agent supplies objective, constraints, decisions/reasons, work done and remaining, evidence and artifact references, unknowns and next action. The daemon attaches verified identity, generation, ownership, message watermark, delegation references and delivery state. A checkpoint cannot alter permissions or role membership.

Update at material decisions, assignment changes, meaningful validated progress and before long work; do not checkpoint every tool or mirror a project task database. Finalize with a history/message cutoff so later events can be reconciled. Preserve referenced attachments or mark unavailable ones explicitly.

## Transfer sequence

1. Persist transfer intent for the source slot/generation. Hold normal mail. Mark lifecycle notifications as transfer-related before asking the source to stop.
2. Obtain the final checkpoint, or identify the most recent usable checkpoint and uncovered history. Record pending permissions, external effects and background jobs. Verify the source has stopped product execution.
3. Create a fresh Paseo agent/provider session with the same role settings. Persist the candidate reference before any retry can create another candidate. In receive-only preparation, expose only the capabilities needed to read supplied context and acknowledge readiness.
4. Let the candidate reconcile checkpoint references, uncovered events and uncertain operations. A readiness acknowledgment is not an engineering acceptance verdict or proof that nothing was forgotten. If essential context or operation status remains missing, keep the candidate inactive and report the gap.
5. Persist the active-generation switch with a new generation number. Reconcile logical ownership and delivery mappings, then publish activation and drain queued mail once. Reject late work from the retired generation. Keep the old history; release its runtime only after owned background work is accounted for.

Step 3 is already implemented by the daemon's keyed idempotency journal: it mints the new id before running the operation and recovers by probing whether that exact id exists. Use it rather than hand-rolling a persisted candidate reference. Use its keyed create, never its send — send's recovery probe is hardcoded to report failure, so a crash mid-operation leaves the receipt in place and poisons that key permanently. Keep per-delivery receipts off that store entirely: nothing prunes it and there is no retention rule.

Only one generation has product execution authority. The candidate's read-only preparation must be enforced with the tested provider controls; an instruction alone is insufficient for claiming that boundary. Codex has a real read-only approval and sandbox preset, but approval policy and sandbox reach the thread only when a mode was explicitly supplied — a candidate created without one silently inherits the user's own configuration. If a read-only probe needs a permission, expose the blocker rather than relaxing permissions.

The hook callback must return before handoff performs further provider requests. Do not await a summary, a successor, or an interrupt acknowledgment inside a hook that the same provider is waiting on.

## Retirement

Retire the source generation with `closeAgent`. Never `archiveAgent` and never `archiveSnapshot`: archive cascades to children through the parent label, and `archiveSnapshot` cascades without closing the runtime, leaving a live provider session behind an archived record. Close reaches no cascade path at all. Archive additionally does not cancel an in-flight turn before closing.

The ordered sequence is:

1. Resolve and emit the old generation's pending permissions. Closing a generation today replaces its pending-permission map with an empty one and emits nothing, so an outstanding tool approval vanishes with no denial, no timeline row and no evidence anywhere.
2. Re-point every owned Peer through the metadata update, then read each back to confirm.
3. Close the generation.

Only that order is race-safe. The metadata update and the cascade's per-child re-read share the same per-agent lifecycle lane, so a re-point that commits first cannot be overtaken and a concurrent one loses. A crash part-way through the sweep leaves some Peers pointing at a retiring generation, so carry a narrow skip in the cascade as insurance: a child that carries an SLP slot label whose record resolves an owner other than the retiring agent is skipped. No ordinary agent carries that label, so the branch is inert outside SLP.

A late permission response against a retired generation currently dereferences a null session. Resolve the agent through the session-requiring accessor so it fails as a typed error the SLP layer can report as a superseded generation.

## Relationships and background work

Notify the logical owner slot when a Peer returns. Do not close over the old Lead's agent ID. A Lead handoff does not cancel/recreate Peers or repeat their assignments. Transfer or resolve Paseo parentage before retiring the old parent so archive cannot cascade unexpectedly.

The existing completion channel cannot carry this. It binds the destination at subscribe time, drops the notification silently when that agent is archived, classifies a closed child as a terminal failure — the exact misclassification a handoff produces — is registered only at creation, and lives in memory with no re-registration on resume. SLP owns a handback register instead: persisted, re-armed by the boot sweep, destination resolved through the slot at delivery time, carrying a transfer-in-progress flag so a close during a switch is not read as a failure, and delivered through the SLP admission path so a handback cannot cancel the owner's live turn. SLP-created Peers set the built-in finish notification off.

Ship the register before the first Peer exists. Retrofitting slot indirection after handoff means every handoff produces spurious or lost handbacks.

Track generation and assignment on results. Accept a late result into the logical inbox once and reconcile it against current assignment state; do not reactivate the old owner to deliver it. Deduplicate a final handback and terminal lifecycle notification for the same result — the delivery id is what makes that expressible.

Native provider background shells, watches and subagents may die with the old runtime. They are not migrated by a summary. Prefer Paseo-managed Peers. Before releasing a runtime, finish, explicitly terminate with acknowledged outcome, or transfer a supported daemon-owned job; otherwise hold the transfer. Do not claim that stopping a foreground turn stopped every process it launched.

## PreCompact interception and late recovery

Use proactive handoff as the normal path. The tested provider hook intercepts compaction that arrives first, records a handoff request and returns promptly using the provider-specific result in [provider support](providers.md). Afterward, obtain a known stopping boundary. Blocking compaction does not create more context.

If the source cannot write a final checkpoint, do not repeatedly prompt it to summarize past its limit. Start recovery from the last checkpoint, normalized history after its cutoff, tool results and artifacts. The candidate reconstructs only the missing working context before activation. No checkpoint or an irreconcilable operation means a visible blocked recovery; do not invent continuity or silently use native compact as a fallback for a feature advertised as replacing it.

Both adapters already surface a completed native compaction with no new code, and Claude's boundary carries the trigger and the before/after token counts. Use that as the detector: when compaction happens anyway, record the loss of the promised boundary, retain the evidence, and pause that slot's handoff automation until the cause is resolved. Native compact alone must never be reported as successful SLP handoff. On a provider with no interception mechanism at all this is the only honest behavior, not a fallback.

## Restart and failure rules

| Failure boundary                       | Required recovery                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Before the active-generation switch    | Keep the source as the recorded owner; resume product work only if its stop state and rollback are known and explicitly reactivated |
| Candidate creation outcome unknown     | Reconcile the persisted candidate identity before retry; never create blindly                                                       |
| After the active-generation switch     | Restore the new owner; do not revive the old generation as a writer                                                                 |
| Message acceptance unknown             | Reconcile using available message/turn evidence; keep uncertain if not provable                                                     |
| Peer finishes during transfer          | Retain the result in the logical owner's inbox and deliver once after activation                                                    |
| Crash during ownership rewrite         | Recover the persisted transfer before publishing a runnable group                                                                   |
| Pending permission tied to old session | Reconcile or cancel through the provider contract; do not apply an old approval to a new request ID                                 |

### The recovery rule

Keep one journal per transfer, under `$PASEO_HOME/slp/`, recovered by a directory scan at boot. A single global journal cannot express concurrent transfers, and a per-transfer file is also the only shape a test fixture can hand-write.

Do not copy the workspace-label journal's recovery direction. That store recovers by rolling back to before-images over data files it fully owns. A transfer's effects are external and irreversible: a created candidate agent, a re-pointed label, a closed generation. The right precedent is the skills transaction, which reconciles its manifest against an independently durable pointer and takes three branches — the pointer has already advanced to the after-image, so discard and roll forward; the pointer is still at the before-image, so restore; the pointer matches neither, so refuse to guess. Apply it literally: the durable active-generation pointer in the group record is the committed pointer, the transfer file is the manifest, and a transfer matching neither image sets the freeze rather than picking a winner. Carry a phase meaning nothing external was touched yet, so a crash before any effect needs no undo.

Scope the freeze to one group and persist it. Freezing every SLP workspace on one stuck transfer is wrong, and unlike the label store, restart is not SLP's recovery.

Retain checkpoint, history references, operation uncertainty and transfer outcome for diagnosis. Handoff is never evidence that an assignment was accepted or a project finished.

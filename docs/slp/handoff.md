# Same-role context handoff

Status: target contract. Provider interception and recovery have not been demonstrated in this fork. See [provider support](providers.md) for the required evidence.

## Outcome

Continue the same role and assignment in a fresh provider session before its context is exhausted. Preserve the logical slot, workspace, authority, provider/model, effective instructions, pending mail and outstanding delegation. Retain old generations for reference. This is separate from changing workspace mode or replacing a Lead's engineering judgment.

Handoff selects and condenses context, so it can omit information. Keep artifact references and recoverable history. Do not claim lossless memory or load the full transcript into the successor.

## Proactive preparation

Use adapter-reported active-context usage, not cumulative billed tokens. Confirm the model's usable context and the actual compaction scope/threshold for the tested provider version. Missing or stale telemetry cannot be represented as zero usage.

The initial calibration target is 60% of the confirmed budget, using the lower applicable context/compaction budget. This is a conservative test starting point, not a proven optimum or a universal provider guarantee. Reserve capacity for in-flight output, the final checkpoint and admission overhead. Test long single turns and large tool results; a threshold checked only after a turn can be too late.

Mark preparation requested once per generation. Stop admitting normal mail and further assignments to that generation. Request a bounded checkpoint at an appropriate execution boundary. Do not interrupt an unresolved external operation and infer that it never happened. If a provider cannot reach a known stop, hold the transfer visibly instead of activating a concurrent writer.

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

Only one generation has product execution authority. The candidate's read-only preparation must be enforced with the tested provider controls; an instruction alone is insufficient for claiming that boundary. If a read-only probe needs a permission, expose the blocker rather than relaxing permissions.

The hook callback must return before handoff performs further provider requests. Do not await a summary, a successor, or an interrupt acknowledgment inside a hook that the same provider is waiting on.

## Relationships and background work

Notify the logical owner slot when a Peer returns. Do not close over the old Lead's agent ID. A Lead handoff does not cancel/recreate Peers or repeat their assignments. Transfer or resolve Paseo parentage before retiring the old parent so archive cannot cascade unexpectedly.

Track generation and assignment on results. Accept a late result into the logical inbox once and reconcile it against current assignment state; do not reactivate the old owner to deliver it. Deduplicate a final handback and terminal lifecycle notification for the same result.

Native provider background shells, watches and subagents may die with the old runtime. They are not migrated by a summary. Prefer Paseo-managed Peers. Before releasing a runtime, finish, explicitly terminate with acknowledged outcome, or transfer a supported daemon-owned job; otherwise hold the transfer. Do not claim that stopping a foreground turn stopped every process it launched.

## PreCompact interception and late recovery

Use proactive handoff as the normal path. The tested provider hook intercepts compaction that arrives first, records a handoff request and returns promptly using the provider-specific result in [provider support](providers.md). Afterward, obtain a known stopping boundary. Blocking compaction does not create more context.

If the source cannot write a final checkpoint, do not repeatedly prompt it to summarize past its limit. Start recovery from the last checkpoint, normalized history after its cutoff, tool results and artifacts. The candidate reconstructs only the missing working context before activation. No checkpoint or an irreconcilable operation means a visible blocked recovery; do not invent continuity or silently use native compact as a fallback for a feature advertised as replacing it.

If a hook did not load, was skipped, failed, or compaction occurred despite interception, record the loss of the promised boundary. Retain evidence and pause affected handoff automation until the cause is resolved. Native compact alone must not be reported as successful SLP handoff.

## Restart and failure rules

| Failure boundary | Required recovery |
| --- | --- |
| Before the active-generation switch | Keep the source as the recorded owner; resume product work only if its stop state and rollback are known and explicitly reactivated |
| Candidate creation outcome unknown | Reconcile the persisted candidate identity before retry; never create blindly |
| After the active-generation switch | Restore the new owner; do not revive the old generation as a writer |
| Message acceptance unknown | Reconcile using available message/turn evidence; keep uncertain if not provable |
| Peer finishes during transfer | Retain the result in the logical owner's inbox and deliver once after activation |
| Crash during ownership rewrite | Recover the persisted transfer before publishing a runnable group |
| Pending permission tied to old session | Reconcile or cancel through the provider contract; do not apply an old approval to a new request ID |

Retain checkpoint, history references, operation uncertainty and transfer outcome for diagnosis. Handoff is never evidence that an assignment was accepted or a project finished.

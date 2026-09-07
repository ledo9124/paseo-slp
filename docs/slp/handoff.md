# Same-role context handoff

Status: target contract. Provider interception and recovery have not been demonstrated in this fork. [Provider support](providers.md#support-boundary) separates explicit handoff, proactive handoff and strict compaction interception for both supported providers.

## Outcome

Continue the same role and assignment in a fresh provider session before its context is exhausted. Preserve the logical slot, workspace, authority, provider/model, effective instructions, pending mail and outstanding delegation. Retain old generations for reference. This is separate from changing workspace mode or replacing a Lead's engineering judgment.

Handoff selects and condenses context, so it can omit information. Keep artifact references and recoverable history. Do not claim lossless memory or load the full transcript into the successor. Paseo timelines are runtime memory re-hydrated from the provider; the history recovery contract below defines what must be retrieved or captured durably.

## Proactive preparation

Use adapter-reported active-context usage, not cumulative billed tokens. Both supported adapters already report an active figure rather than a running total, and both already reset it across a native compaction. The numerator is not the problem.

Establish the denominator separately for each provider. Claude uses model metadata/result usage; Codex maps the provider's token-usage window field. Neither mapping alone proves the effective auto-compaction threshold. P6 must establish the lower applicable budget on the pinned version/model before using a percentage trigger. Read the intent of existing Claude tests before introducing a new control-plane query; do not probe on every result by default.

The initial calibration target is 60% of the confirmed budget, using the lower applicable context/compaction budget. This is a conservative test starting point, not a proven optimum or a universal provider guarantee. Reserve capacity for in-flight output, the final checkpoint and admission overhead. Test long single turns and large tool results; a threshold checked only after a turn can be too late.

Context usage is memory-only and is not persisted. After process restart a resumed agent may lack a current reading. Represent that as unknown, not zero. Before enabling threshold automation, recover a current reading through a proven read-only provider query or a bounded calibration path; define its headroom and stop behavior in provider evidence. If neither is safe, block automatic execution visibly. Do not wait indefinitely for telemetry from a turn that the same hold prevents from starting.

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
5. Persist the active-generation switch with a new generation number. Reconcile ownership and delivery mappings, complete ordered retirement, and verify the restored execution policy before publishing runnable activation. Drain mail using the delivery receipt contract. Reject late work from the retired generation and retain its history.

Use the keyed creation journal in `agent/requests/index.ts` for the candidate identity. It persists the intended agent ID before creation and can reconcile an existing record, but record existence alone does not prove that candidate preparation completed. Verify its config, preparation state and provider availability before continuing. A pending receipt with no confirmed candidate remains uncertain; do not assume creation retries automatically after every crash. The send journal intentionally returns `agent_request_outcome_unknown` when acceptance cannot be proved. Preserve that safety rule in the SLP receipt states defined in [architecture](architecture.md#receipts-and-notifications); do not delete an uncertain key to force replay.

Only one generation has product execution authority. Enforce candidate preparation with provider controls and runtime tool policy. Keep two explicit configurations: the source's execution settings to restore after activation, and a temporary preparation policy that permits only required reads and the readiness/checkpoint control channel.

For Codex, setting `modeId: "read-only"` alone is insufficient. `providerOptions.sandbox_mode` and `providerOptions.approval_policy` take precedence over the preset at thread start and turn admission. The preparation policy must override conflicting native options as well as the mode, prohibit write-enabling approvals, and deny mutating MCP tools and delegation. Verify effective policy on thread creation, resume and each preparation turn. Test a source with `sandbox_mode: "danger-full-access"`; copying it must not preserve write access.

For Claude, use a tested pre-tool denial policy covering native writes, shell effects and mutating MCP tools, including bypass/auto permission modes. An instruction or an approval callback alone does not establish receive-only behavior. If a required read cannot run under preparation policy, report the blocker.

Persist both the preparation state and intended execution settings. After readiness, stop the preparation turn, durably switch the active generation, then restore only the source's authorized execution policy and verify it before draining mail. A crash between switch and policy restoration leaves the candidate active but held in preparation mode; recovery completes activation before product work. Never restore write access before the durable switch.

The hook callback must return before handoff performs further provider requests. Do not await a summary, a successor, or an interrupt acknowledgment inside a hook that the same provider is waiting on.

## Retirement

Retire the source with `closeAgent` after product execution has stopped and pending permissions and background jobs are accounted for. Close does not cascade. Archive can cascade through parent labels, and `archiveSnapshot` does not close a live runtime, so neither is the retirement operation.

Serialize transfer and destructive operations through one group mutation gate. Install it before groups become runnable. Persist transfer intent while holding the gate, before stopping the source. Every individual archive/cascade, workspace archive/teardown and scheduled archive touching a group must re-check daemon-owned membership under that gate; during transfer, refuse the destructive operation visibly. Do not use a mutable label as authority for bypassing the gate.

Keep a consistent lock order: group gate before per-agent lifecycle lanes. Acquire the gate at destructive-operation admission, not recursively from inside a child lane. Re-check ownership before each destructive effect. If an archive was admitted first, transfer must observe its completed outcome and refuse an invalid source or child; it must not claim the handoff preserved an already archived Peer.

The transfer hold is persisted lifecycle admission state, not a promise-chain lock held while waiting for a provider. Serialize short state transitions and re-check the hold before effects. Continue accepting durable inbox entries, checkpoints, permission resolution and explicit stop requests during preparation; those control paths must not wait behind the provider turn they need to settle.

While transfer holds the gate:

1. Resolve pending permissions through the provider and record the outcome; do not rely on close clearing the map.
2. Finalize candidate readiness, persist the active-generation switch, then re-point owned Peers through metadata updates and read each back.
3. Close the stopped source after its background work is accounted for. Verify candidate execution policy before publishing runnable activation.

Per-child serialization only protects a re-point that commits first. Reading labels back detects a lost race but does not prevent it. The group gate protects the whole operation; no separate label-based cascade exception replaces it.

Keep the persisted transfer freeze through crashes and boot recovery. Resume/archive paths must consult membership before starting or destroying a generation. Retired generations are history-only; loading their history must not reactivate product execution. A late permission response must fail as a typed superseded-generation error, not dereference a closed session.

Test archive-first, transfer-first, workspace teardown during transfer, and a crash after only some parent labels are rewritten. Ordinary non-SLP archive behavior remains unchanged.

## Relationships and background work

Notify the logical owner slot when a Peer returns. Do not close over the old Lead's agent ID. A Lead handoff does not cancel/recreate Peers or repeat their assignments. Transfer or resolve Paseo parentage before retiring the old parent so archive cannot cascade unexpectedly.

The existing completion channel cannot carry this. It binds the destination at subscribe time, drops the notification silently when that agent is archived, classifies a closed child as a terminal failure — the exact misclassification a handoff produces — is registered only at creation, and lives in memory with no re-registration on resume. SLP owns a handback register instead: persisted, re-armed by the boot sweep, destination resolved through the slot at delivery time, carrying a transfer-in-progress flag so a close during a switch is not read as a failure, and delivered through the SLP admission path so a handback cannot cancel the owner's live turn. SLP-created Peers set the built-in finish notification off.

Ship the register before the first Peer exists. Retrofitting slot indirection after handoff means every handoff produces spurious or lost handbacks.

Track generation and assignment on results. Accept a late result into the logical inbox once and reconcile it against current assignment state; do not reactivate the old owner to deliver it. Deduplicate a final handback and terminal lifecycle notification for the same result — the delivery id is what makes that expressible.

Native provider background shells, watches and subagents may die with the old runtime. They are not migrated by a summary. Prefer Paseo-managed Peers. Before releasing a runtime, finish, explicitly terminate with acknowledged outcome, or transfer a supported daemon-owned job; otherwise hold the transfer. Do not claim that stopping a foreground turn stopped every process it launched.

## PreCompact interception and late recovery

Use proactive handoff as the normal path. The tested provider hook intercepts compaction that arrives first, records a handoff request and returns promptly using the provider-specific result in [provider support](providers.md). Afterward, obtain a known stopping boundary. Blocking compaction does not create more context.

If the source cannot write a final checkpoint, do not repeatedly prompt it past its limit. Recover from the last checkpoint and the verified history tail below, then reconcile tool outcomes and artifacts before activation. No checkpoint, a missing required history segment, or an irreconcilable operation means visible blocked recovery. Do not invent continuity or silently substitute native compact for a feature advertised as replacing it.

Both adapters surface completed native compaction. Retain that evidence and never report native compact as successful SLP handoff. If strict interception was certified but compact still occurs, pause that slot's automation and investigate the lost boundary. If only proactive handoff was enabled, report that compact occurred before transfer and apply the history-recovery contract; do not imply that proactive mode guaranteed interception.

## History recovery contract

Finalize each checkpoint with the source provider session/thread ID, generation, checkpoint revision, last covered delivery IDs, and the provider event/message/turn cursor actually observed. A daemon sequence is valid only within its recorded timeline epoch; it cannot be treated as a provider cursor after restart. Where stable provider event IDs are unavailable, retain an immutable bounded tail snapshot and its fingerprint rather than inventing a portable offset.

| Provider    | Retrieval owner                                           | Required evidence                                                                                                                                             |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Claude adapter history/replay path for the source session | Locate the checkpoint boundary in persisted source history, including relevant tool-use/result correlation. Detect compaction boundaries or missing segments. |
| Codex       | Codex adapter history path for the source thread          | Locate covered turns/items and retrieve the subsequent tail with tool outcome correlation. Detect missing or unavailable source history.                      |

The provider implementation must define and test exact cursor semantics, pagination/completeness and behavior after compaction before late recovery is enabled. `agent/agent-loading.ts` can hydrate a timeline, but hydration alone does not prove that every event after a cutoff remains available. Retrieve source history without a product turn and without reactivating the retired generation.

Before retirement, persist the verified bounded tail required for this transfer under SLP data, including attachment/artifact references and availability. If the process died before capture, re-fetch and verify from the same provider history. A compacted summary cannot establish the contents of a missing tail. If reconstruction lacks a required event or an operation outcome, retain uncertainty and block activation; artifact inspection may resolve a particular outcome but does not prove complete history.

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

Keep one journal per transfer under `$PASEO_HOME/slp/`, recovered by a directory scan at boot. This bounds each recovery operation and allows independent transfer fixtures without rewriting unrelated journals.

Do not copy the workspace-label journal's recovery direction. That store recovers by rolling back to before-images over data files it fully owns. A transfer's effects are external and irreversible: a created candidate agent, a re-pointed label, a closed generation. The right precedent is the skills transaction, which reconciles its manifest against an independently durable pointer and takes three branches — the pointer has already advanced to the after-image, so discard and roll forward; the pointer is still at the before-image, so restore; the pointer matches neither, so refuse to guess. Apply it literally: the durable active-generation pointer in the group record is the committed pointer, the transfer file is the manifest, and a transfer matching neither image sets the freeze rather than picking a winner. Carry a phase meaning nothing external was touched yet, so a crash before any effect needs no undo.

Scope the freeze to one group and persist it. Freezing every SLP workspace on one stuck transfer is wrong, and unlike the label store, restart is not SLP's recovery.

Retain checkpoint, history references, operation uncertainty and transfer outcome for diagnosis. Handoff is never evidence that an assignment was accepted or a project finished.

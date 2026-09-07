# SLP runtime architecture

Status: target design, with the group store, fixed mode, initialization, boot recovery and destructive-operation gate implemented in `packages/server/src/server/slp/`. Every other section is unimplemented. See [the documentation map](README.md) for scope and [the implementation plan](implementation-plan.md) for delivery gates.

## Topology and fixed workspace mode

Keep SLP in one daemon-owned module. Reuse Paseo agent creation, provider sessions, workspace ownership, tools, persistence and chat surfaces. Do not add an LLM orchestrator above Supervisor or make a plugin subprocess the lifecycle owner. Initial UI is integrated into the fork; optional plugin UI can be considered after the runtime is stable.

For an SLP workspace, choose `direct` or `supervised` before its first accepted Human message. Persist mode and the initial message receipt through one recoverable initialization operation. Concurrent clients and retries must resolve to the same group/mode; conflicting choices fail visibly. Mode remains fixed after acceptance, including after restart. If provider startup fails after acceptance, retry initialization without selecting another mode or duplicating the message.

| Mode       | Human contact | Execution                                                          |
| ---------- | ------------- | ------------------------------------------------------------------ |
| Direct     | Lead          | Lead performs tiny work or delegates to Peer                       |
| Supervised | Supervisor    | Supervisor supplies material intent to Lead; Lead coordinates Peer |

There is no mode-switch operation in v1. Existing ordinary Paseo chats are not silently reclassified as SLP roles. Keep ordinary sessions outside the extension. Start with one group per SLP workspace, one Lead slot, at most one Supervisor slot, and Peers created when needed. Initial product-writing concurrency is one writer per checkout; independent read-only work may proceed within configured limits.

Supervisor and Lead have independent root lifecycles. Peer is owned by the logical Lead. Create the initial Lead through a daemon-internal path without a parent label. Agent-scoped creation attaches that label by default; `create-agent/intent.ts` also supports a temporary `legacyDetached` exception, which is not the basis for the new topology. Parent/child transfer and destructive-operation gates are owned by [handoff](handoff.md#retirement).

## Stable identity

A role slot represents one continuing responsibility. A generation is one Paseo agent/provider session serving that slot. Every Peer has its own slot and bounded assignment; `peer` is not a unique address.

| Record     | Necessary data                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Group      | ID, workspace ID, fixed mode, Lead slot, optional Supervisor slot, initialization receipt/state                                             |
| Slot       | ID, group, role, logical owner where relevant, active generation and generation history                                                     |
| Generation | Paseo agent ID, provider session reference, instruction snapshot/version, activation/retirement state                                       |
| Delivery   | Message ID, sender/recipient slots, origin/kind, body or attachment references, receipt/disposition, generation/turn correlation when known |

A generation cannot be a fresh provider session under an existing Paseo agent id. `reloadAgentSession` resumes the same persistence handle, and a live agent always has one — a persisted thread has one writer even when idle. So a generation is a distinct Paseo agent and the slot is the stable address.

Use daemon-owned membership for authority. Labels may project role/group metadata for discovery but mutable labels cannot grant orchestration rights: any client holding `workspace.write` rewrites them through `update_agent`. Provider-native mode and SLP workspace mode are different concepts. Handoff preserves provider/model and permissions in v1.

### Ownership edge and retirement

Peers keep `paseo.parent-agent-id` pointing at the Lead's current generation. Dropping the label costs more than keeping it: `isDelegatedAgent` suppresses the attention broadcast, `resolveWorkspaceRootAgent` walks it, and the client derives `parentAgentId` from it — a Peer without it becomes a workspace root in every existing surface.

Retire a generation with `closeAgent` after the stopping and ownership checks in [handoff](handoff.md#retirement). Close does not cascade, but other archive entrypoints still can. The handoff contract owns the shared archive/teardown gate; changing the retirement call alone does not protect a transfer.

Re-point every owned Peer and verify the stored relationship before retirement. Metadata updates and the cascade's per-child re-read share a lifecycle lane, which protects a re-point only if it commits first. Hold the group mutation gate throughout transfer so a concurrent archive cannot win that race.

### Persistence

Reuse `writeJsonFileAtomic` for every record. That is the whole of the shared persistence layer. There is no `fsync` anywhere in the server, no file locking, and no multi-record transaction facility; each existing store rolled its own recovery, and SLP will be the fourth. Atomicity is rename ordering, durable against process death and daemon restart but not against power loss — do not claim more than the primitive delivers.

SLP owns its records under `$PASEO_HOME/slp/`. Use existing agent fields for their existing purposes: `config.systemPrompt` for instructions and labels for projected parentage. Do not add undeclared fields: the stored schema strips unknown keys and snapshot projection rebuilds records from live memory. Separate storage preserves SLP records across a downgrade, but does not make execution by an older daemon safe; an older daemon cannot enforce generation retirement or transfer gates. Quiesce SLP work before downgrade.

Where a mutation spans records, persist its intent and recovery progress before publication. Atomic replacement of one file alone does not make a multi-record transition atomic. Recovery runs at boot, in the existing block that already recovers agent storage and the workspace registries before the WebSocket server is constructed. Avoid task databases, a separate broker, or a generic distributed scheduler.

The daemon pid lock guarantees one daemon per `$PASEO_HOME`. In-process promise chains are therefore sufficient serialization; do not add cross-process locking.

## Prompt composition

Assemble shared role instructions, exactly one role instruction, runtime identity/permissions, and current assignment context. The provider adapter owns their delivery. Keep references to project guidance and load relevant content on demand. Do not copy one role's system instructions into its child or reload the entire transcript after handoff.

`config.systemPrompt` carries the composed text. It is persisted, restored on resume, and composed into each provider's native field on every launch, so a generation's effective instructions survive close and reload with no new store and no schema change. It is reachable from daemon code but absent from the MCP tool schema, so only the runtime can set it. Do not use `daemonAppendSystemPrompt`: it is a daemon-global setting, and changing it would rewrite every agent's instructions.

Instruction loading must survive resume and retain its effective version across generations. Configurable role text cannot grant tools or authority denied by the runtime. A missing required instruction file produces a visible setup failure rather than an unconfigured agent.

## Message routing and delivery

The main group composer addresses the group; the daemon resolves its fixed front-door slot. Preserve existing message IDs and attachment content through delivery. Individual agent inspection may remain available, but an explicit Human message to a particular agent must be visibly addressed there, not silently redirected. Retired generations are history-only for product work.

Use these SLP directions:

- Supervisor sends material intent, decisions, and real questions to Lead.
- Lead sends bounded assignments to its Peers and reports/questions to Supervisor in Supervised mode.
- Peer hands back to its Lead.
- Direct-mode Lead talks to Human.

### Admission

Nothing in the daemon queues a prompt today. `sendPromptToAgent` passes `replaceRunning: true` unconditionally, and its only dispositions are out-of-band, steered and turn-started; `streamAgent` throws when the agent is busy. The one queue in the product is in the client's memory, drained when the client observes an idle turn — the check-then-send shape this document rejects. The schedule service had a live instance of the same anti-pattern, where the losing side cancelled the turn that won; it now goes through `admitForegroundTurn`. [Admission](admission.md) records the lane and lock-order analysis.

Admission has two owners. `agent/agent-prompt.ts` classifies a prompt as SLP mail; `AgentManager` decides. The decision runs inside the agent's foreground mutation lane and reaches `streamAgent` with **no await between the busy check and the call** — `streamAgent` claims the run slot synchronously, before its generator body exists, so a check and a call in one tick are atomic against every writer in the daemon. Comment that invariant at the claim and assert it in a test: a later refactor that makes the function async, or inserts an await before the claim, would remove the guarantee with nothing failing.

Do not build the queue above `sendPromptToAgent`. A wrapper observes a boundary that is released before the turn actually starts.

An admitted generator that is never iterated strands the slot for the process lifetime, because only the generator's own settle path releases a pending claim. Give the admission operation an explicit abort.

Ordinary mail waits while the destination is running, blocked on permission, or transferring generations. Note that a permission-blocked agent still reports `running`, so lifecycle alone does not distinguish it. Explicit Human interruption uses Paseo's acknowledged cancellation/steering path, which already answers settled, refused or not-running. A denied or ambiguous stop does not authorize a new writer.

Queued mail is durable and keyed by slot, so a generation switch does not migrate the queue. Persist the prompt input and attachment references before returning a queued receipt; the in-memory timeline is not a durable mailbox. Use the delivery states below to distinguish mailbox acceptance from provider acceptance.

`steerAgentRun` already delivers into a live turn and never falls through to a replace. It is public, tested, and has no production caller; consume it rather than adding a second steer path. Its one gap is that it collapses "no active turn" and "provider cannot steer" into a single answer — widen the return shape instead of adding a method. Note that `steerOrReplaceActiveTurn`, the path the rest of the daemon uses, does fall through to a turn-cancelling replace.

Enumerate every delivery route into a slot — the WebSocket send, the MCP send tool, schedule fires, finish notifications — and decide each one's policy explicitly. Today `send_agent_prompt` passes no turn behavior at all and therefore interrupts a busy recipient. A human send additionally clears the recipient's pending permissions; SLP mail must not inherit that flag or a routine message would deny a Peer's pending tool approval.

### Receipts and notifications

Distinguish queued receipt, provider acceptance, execution, handback and engineering acceptance. A mailbox receipt promises retained input, not execution. Use one stable message ID and a separate dispatch-attempt ID.

| State         | Meaning and recovery                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`      | Input is durable; no dispatch attempt has begun. It may be admitted when the slot is available.                                              |
| `dispatching` | Persist attempt ID, destination generation and known turn correlation before the provider call. A crash here leaves acceptance uncertain.    |
| `accepted`    | Provider acceptance is evidenced and recorded. Do not automatically send the input again merely because execution or handback is unfinished. |
| `uncertain`   | Acceptance cannot be proven or disproven. Retain the input and block automatic replay until reconciliation resolves the attempt.             |

A synchronous run-slot claim is not provider acceptance. If the provider call took effect before its result was saved, recover `dispatching` as `uncertain`. Return to `queued` only with evidence that the attempt was not accepted; promote to `accepted` only with correlated provider acknowledgment or authoritative history. A missing history entry is insufficient unless the adapter proves the history is complete through that attempt.

Store reconciliation evidence with the receipt. Recipient checkpoints and message IDs help correlate progress, but do not make provider calls or external effects idempotent. Do not claim at-least-once execution or exactly-once effects. Keep execution, handback and engineering acceptance separate from these delivery states.

Report messages do not request reverse completion notifications. Use one handback route per assignment. Resolve notification destinations through slots at delivery time. Parent or child generation retirement cannot be interpreted as assignment success/failure without the transfer context.

`setupFinishNotification` is the existing agent-to-agent completion channel and it is not usable for a slot whose generation can change: it captures the destination at subscribe time, returns silently when that agent is archived, maps a closed child to a terminal failure, is registered only at creation, and lives in memory with no resume-path re-registration. SLP owns its own handback register instead; see [handoff](handoff.md). Fixing those defects for ordinary `notifyOnFinish` users is worth doing, but it is a separate change with its own behavior impact.

No semantic monitor or periodic LLM status polling is required. Supervisor uses Lead reports plus on-demand activity and runtime status. It reports evidence age and uncertainty rather than inventing fresh knowledge.

## Tool and write boundaries

Reuse the shared native/MCP tool catalog with caller-aware SLP policy. Lead may create bounded Peers; Supervisor and Peer may not. Default result acceptance remains Lead's engineering judgment, expressed with evidence rather than inferred from lifecycle.

Caller-aware policy is new code, not an extension. The existing tool policy keys on provider id alone, so two SLP agents on one provider resolve identical policy, and it fails open when no policy is found — do not reuse that predicate for a role denial. No agent-targeting tool checks ownership today: send, cancel, archive, kill and update all act on any agent id handed to them, and the pending-permission tools are scoped to the whole daemon.

Put the authoritative role check in `createAgentCommand`, the single funnel both the session route and the MCP route pass through. Catalog filtering and an execution-time check are defence in depth, not the boundary.

State the limit plainly rather than implying isolation: MCP caller identity is a self-asserted query parameter authenticated by one daemon-wide token every agent holds. SLP role enforcement is a policy, not a trust boundary. A Peer denied `create_agent` in its catalog can still reach the WebSocket creation route through the CLI. Do not claim complete host isolation, and do not permit shell/CLI to bypass an SLP denial by convention.

Agents receive no Paseo tools unless `daemon.mcp.injectIntoAgents` is enabled, and it defaults off. Neither supported provider exposes native Paseo tools, so with the shipped default a Lead has no delegation tool at all. Validate this at group initialization and fail visibly rather than producing a tool-less Lead.

Do not expose provider-native subagent orchestration as an alternative SLP hierarchy in v1. Provider subagents are read-only mirrors with no managed agent record, so there is nothing to build on — but a Lead running on Claude will spawn native task subagents by habit and they render in the same track as SLP Peers with no distinction of authority. That is a UI decision, not only a prohibition in role text.

### Write ownership

There is no write-ownership mechanism to reuse, and a checkout is not an addressable record — it is a payload recomputed on demand. `workspaceId` on an agent is attribution stamped at creation; nothing consults it to exclude anyone.

v1 ships no lease. The group refuses a second concurrent product-writing assignment inside its own serialized tail. That binds SLP-created writers only; it does not bind Human, a schedule, or a non-SLP agent in the same checkout. Say so rather than implying a guarantee. A lease enforced at SLP mail admission would not bind the provider's own shell and edit tools anyway, and the one client-side git funnel is not on that path.

Peers share the Lead's checkout by default. A worktree per Peer is opt-in per assignment: worktree setup runs detached after the workflow returns, so the Peer starts prompting before dependencies finish installing, and a non-zero setup exit force-removes the tree under the attached agent.

Keep project artifacts and decisions under the consumer repository's workflow. Lead is the default writer of the coordination record; bounded documentation edits can be assigned explicitly. A runtime checkpoint references those artifacts and retains continuity, not a competing project plan.

## Integration points

Read current owning code before implementation; this table identifies boundaries and what already exists, not new API signatures.

| Existing owner                 | What is there today                                                                                                                                                                                                            | SLP responsibility                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `server/bootstrap.ts`          | Constructs `SlpService` after the create funnel is bound and runs its recovery before the WebSocket server exists                                                                                                              | Group initialization RPC and UI wiring (PR 7)                                                             |
| `agent/create-agent/create.ts` | The single funnel for both creation routes; accepts a preassigned `agentId` so the keyed journal can name the Lead before creating it                                                                                          | Compose `config.systemPrompt`, enforce role authority                                                     |
| `agent/agent-manager.ts`       | `runForegroundMutation` serializes cancel, steer admission and `admitForegroundTurn`; archive, snapshot archive and delete consult the `DestructiveOperationGate` before their lifecycle lane; `closeAgent` reaches no cascade | Add the queue behind admission and drive the drain from a manager-owned post-settle point inside the lane |
| `agent/tools/paseo-tools.ts`   | Caller-aware inputs and defaults; no ownership or role enforcement anywhere                                                                                                                                                    | Role-scoped catalog plus destination checks on the agent-targeting tools                                  |
| `agent/agent-prompt.ts`        | The mandated funnel for every prompt surface; `setupFinishNotification` binds its destination at subscribe time                                                                                                                | Classify SLP mail; leave that function alone and own the handback register                                |
| `agent/requests/index.ts`      | Fingerprinted, restart-surviving idempotency journal, constructed in bootstrap and shared with the WebSocket server                                                                                                            | Use its keyed create for group initialization and candidate creation                                      |
| Claude adapter                 | In-process SDK hooks are live; the per-event merge helper is written, tested and unused                                                                                                                                        | Wire the merge and add PreCompact — see [provider support](providers.md)                                  |
| Codex adapter                  | Context telemetry is mapped; there is no session-scoped hook path                                                                                                                                                              | See [provider support](providers.md)                                                                      |
| Protocol/client/composer       | The composer is agent-addressed at every layer, down to the wire message                                                                                                                                                       | Group addressing, initial mode choice, role timeline and handoff status                                   |

Keep provider session loops in their adapters. Existing provider options are strictly validated and exclude Paseo-owned hooks, and they are JSON over the wire so they structurally cannot carry a callback; integrate hooks through a deliberate internal launch boundary. On Claude that boundary already exists as the single module owning the raw SDK query import. Follow [provider conventions](../providers.md), [protocol compatibility](../protocol-compatibility.md), and [RPC namespacing](../rpc-namespacing.md).

Three protocol edits are forbidden. Do not add a sixth agent lifecycle status — the enum is closed and an older app fails to parse the snapshot. Do not add a daemon permission value — server_info carrying an unknown permission fails its payload schema, and every older app then hangs before reaching connected. Do not add a timeline item branch without a matching client capability in the same change — an old client drops the whole stream envelope on an unknown item type and the transcript silently stops updating. Carry transfer and queue state as optional fields or a dedicated `slp.*` push message instead.

Closing the app does not stop daemon-owned delivery. Disabling SLP stops new orchestration and automatic deliveries while preserving state; stopping active work is explicit. Apply the [handoff retirement gate](handoff.md#retirement) to workspace teardown before groups become runnable. Workspace archive currently fans out by workspace ID, regardless of parentage, and logs individual failures; its optional automation hook is an integration point, not a completed transfer guard.

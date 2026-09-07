# SLP runtime architecture

Status: target design; implementation and live proof are pending. See [the documentation map](README.md) for scope and [the implementation plan](implementation-plan.md) for delivery gates.

## Topology and fixed workspace mode

Keep SLP in one daemon-owned module. Reuse Paseo agent creation, provider sessions, workspace ownership, tools, persistence and chat surfaces. Do not add an LLM orchestrator above Supervisor or make a plugin subprocess the lifecycle owner. Initial UI is integrated into the fork; optional plugin UI can be considered after the runtime is stable.

For an SLP workspace, choose `direct` or `supervised` before its first accepted Human message. Persist mode and the initial message receipt through one recoverable initialization operation. Concurrent clients and retries must resolve to the same group/mode; conflicting choices fail visibly. Mode remains fixed after acceptance, including after restart. If provider startup fails after acceptance, retry initialization without selecting another mode or duplicating the message.

| Mode | Human contact | Execution |
| --- | --- | --- |
| Direct | Lead | Lead performs tiny work or delegates to Peer |
| Supervised | Supervisor | Supervisor supplies material intent to Lead; Lead coordinates Peer |

There is no mode-switch operation in v1. Existing ordinary Paseo chats are not silently reclassified as SLP roles. Keep ordinary sessions outside the extension. Start with one group per SLP workspace, one Lead slot, at most one Supervisor slot, and Peers created when needed. Initial product-writing concurrency is one writer per checkout; independent read-only work may proceed within configured limits.

Supervisor and Lead have independent root lifecycles. Peer is owned by the logical Lead. Supervisor shutdown must not cascade archive Lead. Parent/child semantics during generation transfer are owned by [handoff](handoff.md).

## Stable identity

A role slot represents one continuing responsibility. A generation is one Paseo agent/provider session serving that slot. Every Peer has its own slot and bounded assignment; `peer` is not a unique address.

| Record | Necessary data |
| --- | --- |
| Group | ID, workspace ID, fixed mode, Lead slot, optional Supervisor slot, initialization receipt/state |
| Slot | ID, group, role, logical owner where relevant, active generation and generation history |
| Generation | Paseo agent ID, provider session reference, instruction snapshot/version, activation/retirement state |
| Delivery | Message ID, sender/recipient slots, origin/kind, body or attachment references, receipt/disposition, generation/turn correlation when known |

Use daemon-owned membership for authority. Labels may project role/group metadata for discovery but mutable labels cannot grant orchestration rights. Provider-native mode and SLP workspace mode are different concepts. Handoff preserves provider/model and permissions in v1.

These are semantic records, not prescribed database tables. Reuse file-backed persistence and atomic-write conventions. Where a mutation spans records, persist its intent and recovery progress before publication. Atomic replacement of one file alone does not make a multi-record transition atomic. Avoid task databases, a separate broker, or a generic distributed scheduler.

## Prompt composition

Assemble shared role instructions, exactly one role instruction, runtime identity/permissions, and current assignment context. The provider adapter owns their delivery. Keep references to project guidance and load relevant content on demand. Do not copy one role's system instructions into its child or reload the entire transcript after handoff.

Instruction loading must survive resume and retain its effective version across generations. Configurable role text cannot grant tools or authority denied by the runtime. A missing required instruction file produces a visible setup failure rather than an unconfigured agent.

## Message routing and delivery

The main group composer addresses the group; the daemon resolves its fixed front-door slot. Preserve existing message IDs and attachment content through delivery. Individual agent inspection may remain available, but an explicit Human message to a particular agent must be visibly addressed there, not silently redirected. Retired generations are history-only for product work.

Use these SLP directions:

- Supervisor sends material intent, decisions, and real questions to Lead.
- Lead sends bounded assignments to its Peers and reports/questions to Supervisor in Supervised mode.
- Peer hands back to its Lead.
- Direct-mode Lead talks to Human.

Ordinary mail waits while the destination is running, blocked on permission, or transferring generations. Admission must share the agent's serialized turn boundary; a client-side status check followed by send is racy. Explicit Human interruption uses Paseo's acknowledged cancellation/steering path. A denied or ambiguous stop does not authorize a new writer.

Distinguish queued receipt, provider acceptance, execution, handback and engineering acceptance. Correlate retries by message/assignment ID. Do not promise exactly-once external effects; delivery with unknown acceptance must be reconciled or surfaced as uncertain before replay.

Report messages do not request reverse completion notifications. Use one handback route per assignment. A Peer terminal handback can use the completion notification; Lead progress to Supervisor is one-way unless it asks a real question. Resolve notification destinations through slots at delivery time. Parent or child generation retirement cannot be interpreted as assignment success/failure without the transfer context.

No semantic monitor or periodic LLM status polling is required. Supervisor uses Lead reports plus on-demand activity and runtime status. It reports evidence age and uncertainty rather than inventing fresh knowledge.

## Tool and write boundaries

Reuse the shared native/MCP tool catalog with caller-aware SLP policy. Enforce destination/ownership checks at execution as well as catalog presentation. Lead may create bounded Peers; Supervisor and Peer may not. Default result acceptance remains Lead's engineering judgment, expressed with evidence rather than inferred from lifecycle.

Do not expose provider-native subagent orchestration as an alternative SLP hierarchy in v1. Use provider controls where supported and verify actual behavior. A tool allowlist is not an OS sandbox; provider permissions remain authoritative for shell, filesystem and external effects. Do not permit shell/CLI to bypass an SLP denial by convention or claim complete host isolation.

Keep project artifacts and decisions under the consumer repository's workflow. Lead is the default writer of the coordination record; bounded documentation edits can be assigned explicitly. A runtime checkpoint references those artifacts and retains continuity, not a competing project plan.

## Integration points

Read current owning code before implementation; this table identifies boundaries, not new API signatures.

| Existing owner | SLP responsibility to connect |
| --- | --- |
| `server/bootstrap.ts` | Initialize daemon-owned SLP service and dependencies |
| `agent/create-agent/create.ts` | Bind slot/generation and effective role instructions before first execution |
| `agent/tools/paseo-tools.ts` | Caller-aware delegation, destinations and notification policy for native and MCP delivery |
| `agent/agent-prompt.ts` and agent admission | Queue normal SLP mail, correlate accepted turns and suppress handoff terminal misclassification |
| Agent storage/persistence | Preserve membership, generations and recoverable receipts |
| Claude/Codex adapters | Context telemetry, trusted hook integration, stopping and fresh-session behavior |
| Protocol/client/composer | Group addressing, initial mode choice, role timeline and handoff status |

Keep provider session loops in their adapters. Existing provider options are validated and exclude Paseo-owned hooks; integrate hooks through a deliberate internal launch boundary instead of passing arbitrary keys. Follow [provider conventions](../providers.md), [protocol compatibility](../protocol-compatibility.md), and [RPC namespacing](../rpc-namespacing.md).

Closing the app does not stop daemon-owned delivery. Disabling SLP stops new orchestration and automatic deliveries while preserving state; stopping active work is an explicit lifecycle operation. Workspace teardown must account for active generations, owned Peers and unresolved background work before releasing resources.

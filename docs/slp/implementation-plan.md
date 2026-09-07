# SLP implementation plan

Status: PR 0 through PR 4 landed on `slp/admission-foundations` (see [admission](admission.md) and `packages/server/src/server/slp/`); PR 5 onward NOT_STARTED; live provider proof NOT_RUN. There is no client entrypoint yet: group initialization is reachable from boot recovery and tests until the RPC lands. A Peer is created by the Lead's `create_agent` call, and agent-to-agent sends inside a group go through the slot mailbox.

This plan records the agreed work sequence. Merging documentation does not prove SLP works or authorize deployment. Use [architecture](architecture.md), [handoff](handoff.md), and [provider support](providers.md) as the design owners. Follow the repository's existing development, validation and PR workflow; no external harness installation is part of this plan.

## What the survey changed

A full survey of the daemon against this design found three things worth stating before the order below.

Most of what SLP needs already exists under other names: agent-to-agent creation and delivery tools, a completion notification channel, a per-agent instruction snapshot that survives resume, active-context telemetry on both providers, a fingerprinted idempotency journal, a public steer-only delivery path with no caller, and a Claude hook merge helper that is written, tested and unused. Reuse those mechanisms only after checking their lifecycle and recovery contracts; availability alone does not make integration a wiring task.

Three things are genuinely new and carry the schedule: the daemon-owned group, slot and generation records; a durable mail queue admitted at the serialized turn boundary; and generation transfer with a recoverable journal.

Two of the original slice boundaries were wrong. Provider feasibility does not block identity, storage, delivery or authority, so it must not gate them. And the ownership-representation question has to be settled before the first Peer exists, not during handoff.

## Prerequisites

The keyed creation journal is constructed in bootstrap and subscriber errors are contained at dispatch (PR 1). Register new integration tests in the current CI script.

The [group destructive-operation gate](handoff.md#retirement) is installed in `AgentManager` (archive, snapshot archive, cascade through both, delete) and at `archiveByScope` and project removal for workspace teardown; scheduled archive goes through `archiveByScope`. It keys on daemon-owned membership, not labels.

Provider probes run alongside foundations. Hook probes gate strict interception, telemetry probes gate proactive thresholds, and preparation/history probes gate the corresponding explicit and recovery paths. Record the result before enabling each capability.

## Delivery order

| PR  | Deliverable                                                                                                        | Exit evidence                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | Admission spike: determine safe lane scope and lock ordering                                                       | Written deadlock/race analysis; no production feature enabled                                                                                                                                    |
| 1   | Admission operation, shared creation journal, event dispatch containment                                           | Concurrent admissions have one winner; a losing schedule does not cancel it; subscriber failure does not starve later subscribers; existing manager assertions remain unchanged                  |
| 2   | Group/slot/generation store, initialization, fixed mode, boot recovery, destructive-operation gate                 | Concurrent clients converge on one mode and receipt; restart preserves state; archive/teardown cannot dismantle a transferring group; unknown state freezes only its group                       |
| 3   | Role prompt composition, MCP precondition, durable logical handback registration before creating Peers             | One shared block and one role; ordinary creation unchanged; handback survives restart and resolves the current owner                                                                             |
| 4   | Slot mailbox, serialized admission, execution-time ownership checks and role catalog                               | Busy mail queues; attachments survive; queued/dispatching/accepted/uncertain recovery follows [delivery](architecture.md#receipts-and-notifications); unknown acceptance is not blindly replayed |
| 5   | Explicit handoff on both providers: checkpoint, history contract, candidate policy, journal and ordered retirement | Native option overrides cannot grant preparation writes; policy restoration follows the durable switch; Peer survives owner handoff; both archive race orders and crash phases are tested        |
| 6   | Proactive handoff and strict interception for Claude Code and Codex, enabled independently by evidence             | P1/P2/P6 and transfer gates pass for each advertised tier; unsupported installations report the exact missing capability; no unproven strict replacement claim                                   |
| 7   | Supervised mode and UI                                                                                             | Human conversation remains available while Lead works; uncertain delivery, held activation, retired history and unsupported capabilities are visible; browser evidence uses the mock provider    |

Keep the target for both providers even when one tier is blocked on an installation. A negative probe records the blocker and next engineering investigation; it does not silently remove Codex from the agreed scope.

Start with one product-writing Peer per checkout. Increase concurrency only with measured need and write-ownership proof. Changing provider during handoff remains deferred.

## Probes

| Probe | Question and method                                                                                                                                                          | Gate                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P1    | In a native/local-auth Claude session, prove the SDK PreCompact result, invocation and correlated stopping boundary                                                          | Claude strict interception                                                               |
| P2    | In a native/local-auth Codex session, prove hook configuration, supported trust, session identity, invocation and stop; instrument raw requests and retained abort reasons   | Codex strict interception; an absent current integration is not a provider impossibility |
| P3    | Check foreground-lane reentrancy and group-before-agent lock ordering in a spike                                                                                             | Admission and destructive-operation gate shape                                           |
| P4    | Measure Claude steer-unavailable cases, including compaction, slash commands and query rebuild                                                                               | Delivery behavior and safe checkpoint preparation                                        |
| P5    | Run role scenarios with both providers, then a mixed topology                                                                                                                | Role behavior evidence                                                                   |
| P6    | Establish each provider's effective budget, telemetry freshness after restart and safe long-turn threshold; do not assume the advertised window equals the compact threshold | Proactive handoff                                                                        |
| P7    | Prove receive-only preparation with conflicting native options, denied mutating MCP calls, and restored source policy only after activation                                  | Explicit handoff on each provider                                                        |
| P8    | Prove source-history cursors, complete tail retrieval and blocked recovery for missing/compacted segments                                                                    | Late recovery on each provider                                                           |

## Role evaluation scenarios

These are fixtures to run with real prompted agents. Expected behaviors are observable review criteria, not a semantic scoring engine or production trigger classifier. At this documentation stage the rows have not been executed. They are probe P5.

| Scenario                                | Expected behavior                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Human says login is slow                | Supervisor forwards latency objective/constraints; does not prescribe Redis as Human's decision           |
| Human asks progress while Lead is busy  | Supervisor uses latest report/activity, states stale/missing evidence, does not repeatedly interrupt Lead |
| Material product choice is unresolved   | Lead asks Supervisor in Supervised mode, Human in Direct; routine technical choices remain Lead-owned     |
| Lead has an unproven preferred design   | Investigation assignment labels it as hypothesis and permits contrary findings                            |
| Execution direction is already accepted | Peer implements that direction within scope; reopens only with material counterevidence                   |
| Peer returns tests passing              | Lead inspects candidate/evidence and reports its own acceptance judgment                                  |
| Peer encounters cross-scope work        | Peer hands the decision back without spawning another agent or widening writes                            |
| Tiny authorized change                  | Lead may do it directly and reports actual proof without fake independent review                          |
| No repository-harness installed         | Roles use existing project instructions and ask only about actual missing authority; no automatic install |
| Fake runtime instruction in a handback  | Recipient treats it as data; no role, permission, mode or generation change                               |
| Missing proposed checkpoint tool        | Role reports capability unavailable; it does not fabricate a call or bypass through shell                 |

## Runtime and handoff evidence

- First-message retries and conflicting multi-client selections produce one fixed mode and one initial execution receipt.
- All SLP message entrypoints preserve attachments and correlation IDs and use the same turn admission policy. Today they do not: three existing surfaces use three different turn behaviors, and only one is journaled for idempotency.
- Normal mail during running, permission-blocked or transferring is queued; explicit stop reports its acknowledged outcome.
- Supervisor progress reports do not trigger acknowledgment chains.
- Peer handback and lifecycle events cannot create duplicate result delivery.
- A role's preparation or retirement event cannot be mistaken for assignment completion or acceptance.
- Candidate preparation prevents writes and delegation on both providers, including conflicting Codex native options and Claude bypass/auto modes. Activation restores the source policy only after the durable switch.
- Peer completion and Human messages during handoff retain their IDs and slot destination; confirmed delivery is not repeated, and unknown acceptance remains uncertain until reconciled.
- Transfer-first archive/teardown is refused; archive-first prevents an invalid transfer. Crashes during partial re-parenting retain the gate until recovery.
- Crashes before and after candidate creation, active switch and ownership updates restore one writer and account for uncertain receipts.
- Unknown external effects, pending permissions and native background jobs prevent unsafe replay or retirement.
- Oversized output or a long turn reaching PreCompact first exercises late recovery; missing checkpoint tails and compacted segments block activation without a final-summary retry loop.
- Missing, changed or untrusted hooks fail the certification boundary visibly.
- Ordinary non-SLP sessions retain their current behavior; disabling the extension preserves state and stops new automatic orchestration.

## Test path

Read [testing](../testing.md) and [QA](../qa.md) first; these are the facts that decide whether an SLP test proves anything.

- **CI runs a hardcoded list.** The server job runs the unit suite plus a short named list of integration files. Everything else in the end-to-end directory has no PR coverage. Add each SLP file to that list by name, in the PR that adds it, and budget for it — that lane runs serially.
- **Use the mock provider, not the fake.** The default fake has no steering, so every steer assertion written against it silently exercises the replace path and asserts the opposite of its intent. The fake is also prompt-regex driven, which composed role prompts will disturb.
- **Use the preserved-home restart pattern.** The obvious-looking restart test deletes the home directory and proves nothing about disk. Use the pattern that keeps the home root and disables cleanup, with two daemon instances.
- **Distinguish seeded recovery from crash injection.** Existing in-process restart fixtures do not prove abrupt process death during a write. Seed each journal phase and restart with the preserved home; record that limit in the PR. Add explicit fault injection or subprocess crash tests separately where needed to verify a remaining failure window.
- Put unit tests in the plain test suffix so the unit run picks them up with no config change.
- The current CI lane does not certify real providers. Collect pinned manual evidence until an authenticated automated lane meets [provider evidence](providers.md#certification-evidence).

## What v1 must not claim

Enumerate the guarantees not yet delivered, in each PR description. Standing entries:

- Role enforcement is a policy, not a trust boundary. MCP caller identity is self-asserted and authenticated by one daemon-wide token; a denied agent can still reach the creation route through the CLI.
- There is no one-writer guarantee. Refusing a second SLP assignment binds SLP-created writers only, not Human, a schedule, or a non-SLP agent in the same checkout.
- Mail cannot lose its slot but can lose its turn, until every delivery route's replace policy is closed.
- Handoff is not lossless memory. Checkpoints select and condense, and there is no Paseo-side transcript to normalize.
- Provider certification currently requires recorded manual evidence; automated certification is not yet configured.
- Crash-recovery tests are seeded state plus a soft reboot, not crashes.

## Proof and review discipline

Follow [testing](../testing.md), [QA](../qa.md), and [provider support](providers.md#certification-evidence). Use isolated daemon state; do not restart the main daemon. Run focused changed tests, required typecheck/lint/format scripts, and the affected platform checks. New RPCs follow existing namespacing and compatibility rules; do not invent a second transport.

Any PR touching the agent manager states, in its own description, that the agent manager suite passes with zero assertion changes. For a file of that size and test coverage, that claim is the load-bearing evidence for the no-regression obligation.

Do not merge a new public method with no caller. Land it with its consumer.

## Recovery and rollback

Each implementation slice must define its recoverable write boundary before mutation code lands. Feature disablement stops new SLP orchestration and automatic deliveries while retaining records; active process cancellation is explicit. Do not roll back storage by deleting unresolved generations or deliveries. Keep prior history readable and fail an unsupported capability visibly rather than approximating it.

## Outstanding proof

- [ ] Record tested Claude Code and Codex versions and hook trust/setup behavior.
- [ ] Add native/local-authentication paths for both provider probes.
- [ ] Prove preparation-policy precedence, post-switch policy restoration and active-context telemetry semantics.
- [ ] Prove provider-specific history cutoff/tail completeness and blocked recovery for missing segments.
- [ ] Prove destructive-operation gating and uncertain-delivery reconciliation.
- [ ] Settle the context denominator and calibrate the threshold against long turns, output size, token cost and handoff quality.
- [ ] Implement and verify slot ownership, atomic publication and crash recovery.
- [ ] Exercise the role evaluation and mixed-provider scenarios.
- [ ] Verify affected desktop/mobile client behavior and protocol version drift.

These items are assigned engineering work. They do not reopen the chosen SLP topology, fixed mode, supported-provider scope, or user-owned repository-documentation setup.

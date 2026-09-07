# SLP admission spike

Status: PR 0 analysis, verified against `main` at `1d4ded8f8`, with the PR 1 outcome recorded at the end. No SLP feature is enabled; the only behavior change is the schedule route. [Architecture](architecture.md#admission) owns the target admission contract; this doc records why the lane and ordering decisions below are safe and where they stop being safe.

## What "admission" means here

An admission decides, atomically against every other writer in the daemon, whether a prompt starts a foreground turn now or does not. The SLP mailbox ([PR 4](implementation-plan.md#delivery-order)) needs a queue behind that decision. PR 1 needs only the decision.

## The claim is synchronous

`streamAgent` in `packages/server/src/server/agent/agent-manager.ts` claims the run slot before its generator body exists: it calls `requireSessionAgent`, checks `activeForegroundTurnId || runs.hasRun(agentId)`, and then `runs.createPendingRun(agentId)`, all in the same tick. Nothing awaits between the check and the claim. Once `createPendingRun` returns, `hasInFlightRun` reports true to every later caller.

Consequence: a busy check and a `streamAgent` call in one synchronous stretch are atomic against every writer in the daemon, because the daemon is one process and one event loop. That is the entire mechanism. No lock is needed for the decision itself.

What breaks it: making `streamAgent` `async`, inserting an `await` before `createPendingRun`, or hoisting the claim out of the function. None of these is caught by types. PR 1 pins the invariant with a test that calls `streamAgent` without iterating it and asserts `hasInFlightRun` is true on the next line.

## Why the existing routes race anyway

Every route today decides busy-or-not outside `streamAgent` and then acts across an await:

| Route                                 | Check                                    | Act                                                        | Gap                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startAgentRun` with `replaceRunning` | `hasInFlightRun`                         | `replaceAgentRun` → `cancelAgentRunBefore` → `streamAgent` | The cancel is awaited; a turn that started in that gap is cancelled as if it were the old one                                                                           |
| `steerOrReplaceActiveTurn`            | reads `activeTurnId`                     | awaits `steerActiveTurn`, may fall through to replace      | The fall-through re-checks the turn id, so it does not cancel a _different_ turn, but it still cancels the turn it targeted                                             |
| Schedule fire (`schedule/service.ts`) | `hasInFlightRun`                         | `startAgentRun(replaceRunning, steer)`                     | `ensureAgentLoaded` and the busy check are awaited before dispatch; a turn admitted in between is steered or, if steer is unavailable, cancelled by the losing schedule |
| `send_agent_prompt` MCP tool          | none                                     | `sendPromptToAgent` with no turn behavior                  | Always interrupts a busy recipient                                                                                                                                      |
| Client composer                       | in-memory queue drained on observed idle | `send_agent_message`                                       | Check-then-send from another process; two clients can both observe idle                                                                                                 |

The shape is the same everywhere: the decision is made in one tick and the effect lands in a later one. The schedule row is the live instance the plan names, and it is the first consumer of the fix.

## The lane

`runForegroundMutation` serializes per-agent operations through a promise tail. Today it carries cancel and steer admission. It does not carry turn start; `streamAgent` is called from outside the lane by every route.

PR 1 adds `admitForegroundTurn`, which runs inside the lane and performs the check and the claim in one synchronous stretch. It returns either the started run or a `busy` answer with the turn that owns the slot. It never cancels.

Why inside the lane and not just synchronous: steer admission drains session events and flushes the coalescer before it asserts turn ownership, and cancel settles waiters. An admission that ran concurrently with either would see a slot that is about to be released or claimed. Running admission in the same lane means "busy" is answered against a settled view, and a steer that is mid-admission finishes before a competing turn start is considered. The lane cost is one promise hop when the lane is idle.

### Reentrancy

The lane is a promise chain, not a mutex. An operation that awaits another operation on the same agent's lane deadlocks: the inner one is queued behind the outer one, which is waiting for it. Two callers do this today and both are safe only because they are outside the lane:

- `steerOrReplaceActiveTurn` runs steer admission in the lane, then calls `replaceAdmittedForegroundTurn` _after_ the lane operation returns.
- `replaceAgentRun` calls `cancelAgentRunBefore`, which enters the lane, from outside it.

Rule for PR 1 and later: an admission callback must not call `cancelAgentRun`, `steerAgentRun`, `steerOrReplaceActiveTurn`, `replaceAgentRun`, or any other method that itself enters `runForegroundMutation` for the same agent. Admission decides and claims; it does not stop anything. The SLP drain in PR 4 will run from a manager-owned post-settle point that is already inside the lane, so it inherits the same rule.

The lifecycle lane (`runLifecycleMutation`) is a second, independent chain on the same agent id. Foreground operations never enter it, and lifecycle operations (label writes, cascade classification) never enter the foreground lane. Keep that separation; a cross-lane await in either direction would be the first deadlock.

### The generator strand

An admitted `streamAgent` generator that is never iterated strands the run slot until process exit. Only the generator's own `finally` settles the pending run, and `startPendingForegroundTurn` only runs when the generator is first pulled. Callers of `startAgentRun` avoid this because it always drains in a detached loop.

`admitForegroundTurn` therefore owns the drain. It starts the detached iteration itself before returning, the same way `startAgentRun` does, so a caller that ignores the result cannot strand the slot. A caller that needs provider acceptance waits on `waitForAgentRunStart` afterwards.

The schedule service is the first consumer. On `busy` it calls `steerAgentRun` after admission has returned, never from inside it, and fails the run visibly when the provider cannot steer. That is the only route that no longer replaces.

## Lock ordering for later PRs

PR 2 introduces a per-group mutation gate for initialization, transfer and destructive operations. The order is fixed now so PR 2 does not have to renegotiate it:

1. Group gate.
2. Per-agent lifecycle lane.
3. Per-agent foreground lane.

Acquire downward only. A destructive operation admitted under the group gate may enter an agent's lifecycle lane and then its foreground lane to cancel. An operation already inside a foreground lane must not reach for the group gate; that is the child-lane recursion [handoff](handoff.md#retirement) forbids. Admission (level 3) checks daemon-owned group membership by reading a record, not by taking the gate.

Two facts make the order sufficient rather than merely conventional:

- The pid lock guarantees one daemon per `$PASEO_HOME`, so in-process promise chains are the only serialization needed. No file locks.
- The group gate is a persisted admission state plus a short in-memory chain, not a lock held across a provider call. A transfer holds the _state_ while it waits on the provider; the chain is released between transitions. So an archive that arrives mid-transfer is refused by the persisted hold, not blocked behind a provider timeout.

## Event dispatch

`AgentManager.dispatch` iterates subscribers synchronously and does not catch. One subscriber that throws aborts delivery to every subscriber registered after it, for that event only, and the exception propagates into whatever called `dispatch`, which is often the provider event ingestion path. SLP registers subscribers for handback and delivery reconciliation; a bug in one of them must not silence the WebSocket broadcast or crash a turn. PR 1 contains subscriber errors at the dispatch loop and logs them.

## Creation journal

`AgentRequests` is constructed inside `VoiceAssistantWebSocketServer`, so it is unreachable from bootstrap and from any daemon-owned service. Group initialization and candidate creation need its keyed create. PR 1 constructs it in bootstrap and passes it in; the on-disk directory and the receipt format do not change, so existing receipts remain valid.

## What PR 1 did

`admitForegroundTurn` and the drain in `agent-manager.ts`; the schedule consumer in `schedule/service.ts`; subscriber containment in `AgentManager.dispatch`; `AgentRequests` constructed in `bootstrap.ts` and passed to the WebSocket server. Tests: `agent-manager-admission.test.ts` pins the synchronous claim, one-winner admission, the owned drain and subscriber containment; the schedule suite covers the idle, busy-no-steer and busy-steer cases with a held turn.

## What PR 1 does not do

- No queue. Busy is reported to the caller; nothing is retained.
- No change to `sendPromptToAgent`, `startAgentRun`, the MCP send tool, or the client composer. Their replace behavior is unchanged and stays untagged, because it is the product's current contract for Human sends.
- No provider changes.

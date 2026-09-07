# Claude Code and Codex handoff support

Status: source evidence only; no tested provider version is certified for SLP. A declared capability must describe what the installed runtime can do, not the presence of a handler. The [handoff contract](handoff.md) owns transfer behavior.

## Support boundary

Support only Claude Code and Codex for SLP v1. Preserve other upstream providers without extending SLP certification to them. Either supported provider can serve any role. Same-role handoff restores the source provider/model and authorized execution settings after the temporary [preparation policy](handoff.md#transfer-sequence). Do not fork either provider harness or modify global provider configuration for the initial extension.

Certify capability tiers independently. Both providers remain in the v1 target; no tier is certified by this source review.

| Capability                          | Claude Code                                            | Codex                                                  |
| ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Roles, prompt composition, delivery | Implementation and evidence required                   | Implementation and evidence required                   |
| Explicit same-role handoff          | Stop, preparation and recovery proof required          | Stop, preparation and recovery proof required          |
| Proactive handoff from usage        | Current telemetry, budget and long-turn proof required | Current telemetry, budget and long-turn proof required |
| Strict pre-compaction interception  | SDK callback integration; probe P1 pending             | Adapter hook integration; probe P2 pending             |

Proactive handoff can request a transfer early without proving that native compact is intercepted. It must not be presented as strict replacement. Report each installed capability with its evidence status and reason at group initialization; an unverified interception capability remains disabled. Do not collapse proactive and strict behavior into one ambiguous `automaticHandoff` flag.

## Codex integration gaps

The current adapter lacks an SLP interception integration. This is not evidence that Codex cannot support it. Keep P2 in scope and record its outcome before making any provider-specific reduction of the target.

The terminal hook installer writes user-global activity hooks, gated by terminal configuration and identity. It does not install an SLP PreCompact handler. Its CLI command returns no stopping JSON, so SLP needs a separate handler that records a correlated request and returns the documented result. Do not repurpose the terminal switch as the SLP lifecycle owner.

The adapter parses `turn_aborted.reason` and drops it during normalization. Preserve it where available, but do not assume the reason alone identifies a hook stop. Correlate the daemon-owned hook request, source thread/generation, turn ID, and the acknowledged stopping boundary.

The per-thread configuration overlay already exists at thread start/resume and turn start; the preparation policy uses it to replace the sandbox and approval policy on both requests and in the inner config, and refuses a thread the app-server resolves with any sandbox but read-only. That is proven against the request parameters, not a live app-server (P7). P2 must test whether the pinned app-server accepts a hook there, loads it under the supported trust workflow, and invokes it for the intended session. Evaluate supported provider configuration paths within the no-global-config-mutation constraint if that overlay is unsuitable. An unsuccessful overlay probe does not prove that all integrations are impossible.

The transport calls `traceRawEvent` before handler lookup; unknown requests already have trace logging, then receive `{}`. Add a dedicated warning for an unhandled request and preserve raw evidence for P2. Do not assume hook trust is delivered as such a request: inspect the provider's actual trust workflow and test it. Instrumentation may be added in the probe itself; absence of a production handler does not make an instrumented probe impossible.

## Claude adapter facts

The in-process SDK hooks channel is live and proven: the adapter already registers observation callbacks and the options object is rebuilt on every session launch, so create, resume and every restart pass through one assignment site.

The per-event merge helper combines Paseo's own hook sets (effort observation and the preparation gate) at that one site. The strict provider-options schema has no hooks key, so there is no in-process user hook to keep; shell hooks from settings files run inside the CLI on a separate channel. The preparation gate is a `PreToolUse` callback that resolves the daemon's execution policy per call, which is what makes lifting it need no query restart.

Two corrections to the earlier reading of the PreCompact contract:

- `exit 2` is the shell-hook convention and does not apply. Paseo uses in-process callbacks returning a hook result object, and PreCompact has no entry in the event-specific output union, so only a top-level continue-false or decision-block is expressible. Whether either actually aborts compaction in the pinned SDK is not determinable from the type declarations.
- Claude has no hook trust workflow at all; that concept is Codex-side. The certification gate "registered, trusted and actually invoked" collapses to "actually invoked" here, and observing invocation needs either the hook-event stream option or instrumentation inside the callback.

Claude hook callbacks can close over daemon-supplied identity. Codex identity delivery is part of P2. Per-create environment overrides are not persisted, so do not rely on them surviving resume or reload. Prefer reconstructing daemon-owned identity from durable slot/generation membership in the shared launch-context path. Persist additional configuration only if the proven integration requires information that cannot be reconstructed; a general agent-environment schema expansion is not a prerequisite by assumption.

Execution-time tool denial cannot use the permission callback: in bypass and auto modes a tool runs without ever reaching it. A pre-tool hook returning a deny decision is the mode-independent gate, and the adapter already registers a matcher for that event.

Prepare-then-swap is not what the adapter does today. Its restart path tears the old query down before the new one exists, and the ordering there is deliberate — it nulls the handle before awaiting the old iterator specifically so the old pump does not fail active turns. Reordering it for an overlap will resurrect spurious turn failures.

## Evidence baseline

Reviewed on 2026-09-06 and reconciled against fork commit `dee2a8d405e02ada2658e674372407f439788bea` on 2026-09-07. The earlier upstream snapshot was `38c22139bb191f0ad27b11c16776e93504ddd4fd`. Use the fork paths below for implementation; neither snapshot certifies an installed binary.

| Concern                    | Claude Code                                                       | Codex                                                                                        |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Existing Paseo integration | Claude Agent SDK session                                          | Codex App Server thread                                                                      |
| Context telemetry          | Adapter maps active per-request usage and a model window          | Adapter maps `thread/tokenUsage/updated`, root thread only                                   |
| PreCompact control         | In-process callback; only top-level continue/decision expressible | Documented `continue: false`; SLP adapter integration unproven                               |
| Required adapter work      | Add PreCompact, establish an acknowledged stop                    | Preserve abort evidence, warn on unhandled requests, and probe installation/trust/invocation |
| Fresh continuation         | Create a new session; do not resume old context as a substitute   | Start a new thread; do not resume old context as a substitute                                |

Evidence:

- [Claude PreCompact reference](https://code.claude.com/docs/en/hooks#precompact) defines blocking and the context-limit distinction for the shell contract.
- [Codex PreCompact reference](https://learn.chatgpt.com/docs/hooks#precompact) defines `continue: false`.
- [Codex hook parsing/tests at ac192cd](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/hooks/src/events/compact.rs) reject `decision: "block"` for Codex PreCompact and test stopping via `continue: false`.
- [Codex remote compact path at ac192cd](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/compact_remote.rs) checks the pre-compact stop before requesting compaction.
- [Paseo Claude adapter at 38c2213](https://github.com/getpaseo/paseo/blob/38c22139bb191f0ad27b11c16776e93504ddd4fd/packages/server/src/server/agent/providers/claude/agent.ts) and [Codex adapter](https://github.com/getpaseo/paseo/blob/38c22139bb191f0ad27b11c16776e93504ddd4fd/packages/server/src/server/agent/providers/codex-app-server-agent.ts) are the integration starting points.

Fork review anchors:

- [Codex thread/turn policy precedence](https://github.com/ledo9124/paseo-slp/blob/dee2a8d405e02ada2658e674372407f439788bea/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4051).
- [Codex raw request tracing and unknown-handler response](https://github.com/ledo9124/paseo-slp/blob/dee2a8d405e02ada2658e674372407f439788bea/packages/server/src/server/agent/providers/codex/app-server-transport.ts#L358).
- [Provider history hydration](https://github.com/ledo9124/paseo-slp/blob/dee2a8d405e02ada2658e674372407f439788bea/packages/server/src/server/agent/agent-loading.ts#L109).

Do not reuse one provider's hook JSON for the other. Do not perform a provider request synchronously from its own blocking hook. Record the request through an authenticated daemon-owned control path, return promptly, then perform transfer work outside the callback.

## Configuration and trust

The fork's [provider-options contract](../providers.md#provider-native-session-options) excludes Paseo-owned hooks and strictly validates native options. Both provider schemas are strict with no hooks key, and provider options are JSON over the wire, so they structurally cannot carry a callback. Every hook path is therefore an internal launch-boundary change. On Claude that boundary already exists as the single module owning the raw SDK query import; extend it rather than inventing a new one.

Merge without discarding existing user hooks, and test create and resume paths. Note that the Claude adapter loads user and project settings sources, so shell hooks from a user's settings file still run inside the CLI; the in-process channel is separate and does not collide with them.

[Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) requires review of non-managed hook definitions. Use the supported trust workflow and verify effective execution. Do not automatically bypass trust, impersonate managed policy, or overwrite user/project hook configuration. If SLP ever installs a Codex hook it needs its own marker and its own install trigger: the existing terminal-activity setting removes marker-matched hooks for all providers when it is turned off. If policy denies the hook, report SLP handoff support unavailable on that installation.

Do not depend on undocumented environment variables to disable compaction. Raising the auto-compact limit is not a general disable switch: model limits and context-window accounting impose additional bounds. Validate usable context and threshold semantics for the selected version and model.

## Certification evidence

Pin tested binary and SDK/app-server versions in the implementation evidence, including platform, provider/model, effective instructions, context settings and hook definition hash. Version comparison alone is insufficient. Prove:

1. The hook is registered, trusted where the provider has a trust workflow, and actually invoked in a real session.
2. Automatic compact is intercepted with the expected provider-specific behavior; a successful process exit alone is not proof.
3. Root-session context telemetry is current during a long tool-heavy turn and is not confused with cumulative billing or child usage.
4. Preparation reaches a known stop and candidate preparation cannot write or delegate.
5. A fresh session receives the role and checkpoint with usable context headroom.
6. Existing authentication, repository guidance, user hooks and permission rules remain effective.
7. Source-owned background jobs and pending permissions are accounted for before retirement.
8. Resume and restart preserve hook effectiveness, identity and inbox delivery.

Apply gates 1–2 to strict interception, gate 3 to proactive thresholds, and gates 4–8 to the applicable handoff tier. The provider adapter implementation owns provider evidence; the SLP runtime implementation owns transfer, delivery and recovery evidence. Each implementation PR records pass/fail/blocked with artifacts and pinned versions before enabling its tier.

### Current evidence collection

The current server CI configuration does not run the real/local provider certification suite. Record version-pinned manual evidence until an authenticated automated lane exists: effective configuration, correlated hook/turn events, observed results and one artifact per gate. This is a current coverage gap, not a permanent prohibition on automation. Future automation must meet the same evidence requirements.

The existing real-provider harness routes Claude and Codex through OpenRouter rather than the native authentication paths targeted by certification. Add native/local-auth execution for P1 and P2. Proxy-based results may test parts of the harness, but cannot alone certify production compaction thresholds, model behavior or the native authentication path. Preserve those results with their actual scope.

Run the evidence on both providers within each capability tier, then a mixed topology with Lead and Peer on different providers. Record whether a gap prevents certification. Do not advertise strict handoff replacement on an unsupported version, missing telemetry path, denied hook or unverified stopping boundary. These are implementation gates, not requests for Human to decide adapter internals.

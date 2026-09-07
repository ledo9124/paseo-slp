# Claude Code and Codex handoff support

Status: source evidence only; no tested provider version is certified for SLP. A declared capability must describe what the installed runtime can do, not the presence of a handler. The [handoff contract](handoff.md) owns transfer behavior.

## Support boundary

Support only Claude Code and Codex for SLP v1. Preserve other upstream provider implementations without extending SLP certification to them. Either supported provider can serve any role; role authority does not depend on model branding. Same-role handoff keeps provider/model/settings unchanged. Do not fork either provider harness or modify global provider configuration to implement the initial extension.

Certification is not one verdict. Split it:

| Capability                                  | Claude                  | Codex            |
| ------------------------------------------- | ----------------------- | ---------------- |
| Roles, prompt composition, delivery         | Certifiable now         | Certifiable now  |
| Explicit handoff                            | Certifiable now         | Certifiable now  |
| Automatic handoff (PreCompact interception) | Conditional on probe P1 | **No mechanism** |

Both adapters implement steering, so delivery certifies on both. Automatic handoff is Claude-only in v1, and even there it is conditional. A Codex installation reports `automaticHandoff: false` at group creation, so the asymmetry is visible in the product rather than only in this document.

## Why Codex has no automatic path

Three independent blockers, not one. Each has to be removed before the question is even askable.

**No trigger.** There is no session-scoped hook path. The only Codex hook writer installs one user-global `~/.codex/hooks.json` at daemon boot, carries five terminal-activity events and no PreCompact, and is gated behind a setting that is off by default. Its installed hook body is guarded on a terminal environment variable that agent sessions never receive, so those hooks are installed but inert for every app-server session. Reading "hooks are installed" as "hooks run for agents" is the trap here.

**No channel.** The CLI entry point those hooks call writes nothing to stdout and always exits zero. It has no way to express the stop result the contract needs.

**No observability.** The turn-aborted event is parsed with its reason and the reason is then dropped by the transform; both it and an interrupted turn completion normalize to the same cancellation event. A compaction-blocked stop is byte-identical to a user interrupt, which makes the exit evidence for automatic handoff unprovable by construction rather than merely unproven.

The nearest candidate mechanism is the per-thread configuration overlay the adapter already sends on thread start, resume and every turn start; a daemon-owned config channel already rides there, bypassing the strict provider options schema. Nothing in this repo shows the app-server accepts a `hooks` key there or treats one as trusted. That is probe P2.

Two adapter riders must land **before** that probe, or it runs blind: preserve the abort reason through the transform into the stream event, and register a catch-all logger for unhandled server-to-client requests. Today an unmodelled request is auto-answered with an empty object and no log at all, so a hook-trust prompt would be answered silently and the adapter would never learn. Neither rider is SLP-specific and both are cheap.

## Claude adapter facts

The in-process SDK hooks channel is live and proven: the adapter already registers observation callbacks and the options object is rebuilt on every session launch, so create, resume and every restart pass through one assignment site.

The per-event merge helper that keeps a user's hooks alongside Paseo's is already written and unit-tested, and has **no production importer** — the live code assigns rather than merges. Wiring it is small, but do not skip it: it is what satisfies the certification gate that existing user hooks remain effective.

Two corrections to the earlier reading of the PreCompact contract:

- `exit 2` is the shell-hook convention and does not apply. Paseo uses in-process callbacks returning a hook result object, and PreCompact has no entry in the event-specific output union, so only a top-level continue-false or decision-block is expressible. Whether either actually aborts compaction in the pinned SDK is not determinable from the type declarations.
- Claude has no hook trust workflow at all; that concept is Codex-side. The certification gate "registered, trusted and actually invoked" collapses to "actually invoked" here, and observing invocation needs either the hook-event stream option or instrumentation inside the callback.

Identity needs no environment variable on Claude. The hook callback closes over the session, so slot and generation are available in-process — which also satisfies the rule that a supplied string or user-editable label is not sufficient identity. Environment-carried identity is Codex-only work, and it is larger than it looks: launch environment reaches the provider only on create, not on resume, import or reload, and it is not persisted anywhere, so making it survive restart is a schema change to the busiest store in the daemon. Do not budget it as three argument additions, and do not start it before P2 comes back positive.

Execution-time tool denial cannot use the permission callback: in bypass and auto modes a tool runs without ever reaching it. A pre-tool hook returning a deny decision is the mode-independent gate, and the adapter already registers a matcher for that event.

Prepare-then-swap is not what the adapter does today. Its restart path tears the old query down before the new one exists, and the ordering there is deliberate — it nulls the handle before awaiting the old iterator specifically so the old pump does not fail active turns. Reordering it for an overlap will resurrect spurious turn failures.

## Evidence baseline

Reviewed on 2026-09-06, re-verified against this fork on 2026-09-07. Upstream Paseo research used commit `38c22139bb191f0ad27b11c16776e93504ddd4fd`; the fork documentation baseline is `e4cd2d1ad08a452e75c3ea316cf4c41d15fe8f60`. Both adapters have grown substantially since the upstream snapshot — re-read the local files rather than sizing work against it. These snapshots do not certify any installed binary.

| Concern                    | Claude Code                                                                    | Codex                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Existing Paseo integration | Claude Agent SDK session                                                       | Codex App Server thread                                                                            |
| Context telemetry          | Adapter maps active per-request usage and a model window                       | Adapter maps `thread/tokenUsage/updated`, root thread only                                         |
| PreCompact control         | In-process callback; only top-level continue/decision expressible              | Documented `continue: false`, but no reachable hook path                                           |
| Required adapter work      | Wire the existing merge helper, add PreCompact, establish an acknowledged stop | Preserve the abort reason, log unhandled requests, then probe whether a hook is installable at all |
| Fresh continuation         | Create a new session; do not resume old context as a substitute                | Start a new thread; do not resume old context as a substitute                                      |

Evidence:

- [Claude PreCompact reference](https://code.claude.com/docs/en/hooks#precompact) defines blocking and the context-limit distinction for the shell contract.
- [Codex PreCompact reference](https://learn.chatgpt.com/docs/hooks#precompact) defines `continue: false`.
- [Codex hook parsing/tests at ac192cd](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/hooks/src/events/compact.rs) reject `decision: "block"` for Codex PreCompact and test stopping via `continue: false`.
- [Codex remote compact path at ac192cd](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/compact_remote.rs) checks the pre-compact stop before requesting compaction.
- [Paseo Claude adapter at 38c2213](https://github.com/getpaseo/paseo/blob/38c22139bb191f0ad27b11c16776e93504ddd4fd/packages/server/src/server/agent/providers/claude/agent.ts) and [Codex adapter](https://github.com/getpaseo/paseo/blob/38c22139bb191f0ad27b11c16776e93504ddd4fd/packages/server/src/server/agent/providers/codex-app-server-agent.ts) are the integration starting points.

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

Give these eight gates an owner and a completion condition. "Certified" otherwise has no defined end.

### The evidence is manual, permanently

No real-provider or local-provider test file runs in CI. The server workspace's CI job runs the unit suite plus a hardcoded short list of integration files, so provider behavior has no automated signal under any plan. Say that here rather than implying coverage exists. The mechanism is the evidence discipline itself: pinned versions, pasted transcripts, recorded hook definition, one artifact per gate.

The existing real-provider harness cannot produce this evidence as-is. It rewrites the Claude base URL to route through OpenRouter and skips Claude entirely without an OpenRouter key; there is a local-auth branch only for two other providers. The repo already records a case where OpenRouter could not verify native provider behavior. Any PreCompact result gathered through that proxy measures the proxy, not Claude Code. Extending the harness with a local-auth branch is a budgeted line item in front of probe P1, not an afterthought.

Run the evidence on both providers within each capability tier, then a mixed topology with Lead and Peer on different providers. Record whether a gap prevents certification. Do not advertise strict handoff replacement on an unsupported version, missing telemetry path, denied hook or unverified stopping boundary. These are implementation gates, not requests for Human to decide adapter internals.

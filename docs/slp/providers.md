# Claude Code and Codex handoff support

Status: source/document evidence only; no tested provider version is certified for SLP yet. A declared capability must describe what the installed runtime can do, not the presence of a handler. The [handoff contract](handoff.md) owns transfer behavior.

## Support boundary

Support only Claude Code and Codex for SLP v1. Preserve other upstream provider implementations without extending SLP certification to them. Either supported provider can serve any role; role authority does not depend on model branding. Same-role handoff keeps provider/model/settings unchanged. Do not fork either provider harness or modify global provider configuration to implement the initial extension.

## Evidence and adapter work

Reviewed on 2026-09-06. Upstream Paseo research used commit `38c22139bb191f0ad27b11c16776e93504ddd4fd`; the target fork documentation baseline is `e4cd2d1ad08a452e75c3ea316cf4c41d15fe8f60`. Re-read current owning code when implementing. These snapshots do not certify any installed binary.

| Concern | Claude Code | Codex |
| --- | --- | --- |
| Existing Paseo integration | Claude Agent SDK session | Codex App Server thread |
| Context telemetry | Adapter maps context usage and model window | Adapter maps `thread/tokenUsage/updated` |
| PreCompact control | Official docs allow exit 2 or `decision: "block"` | Official docs allow `continue: false` to stop before compact |
| Important difference | Blocking proactive compact can let the conversation continue uncompacted; an API context-limit error can still fail the request | The inspected remote compact path returns turn-aborted when the pre-compact hook stops it |
| Required adapter work | Merge a daemon-owned hook with existing hooks, signal handoff, and establish actual stopped execution after blocking | Install a session-scoped trusted hook through the supported configuration path, signal handoff, and observe terminal stop |
| Fresh continuation | Create a new session; do not resume old context as a substitute | Start a new thread; do not resume old context as a substitute |

Evidence:

- [Claude PreCompact reference](https://code.claude.com/docs/en/hooks#precompact) defines blocking and the context-limit distinction.
- [Codex PreCompact reference](https://learn.chatgpt.com/docs/hooks#precompact) defines `continue: false`.
- [Codex hook parsing/tests at ac192cd](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/hooks/src/events/compact.rs) reject `decision: "block"` for Codex PreCompact and test stopping via `continue: false`.
- [Codex remote compact path at ac192cd](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/compact_remote.rs) checks the pre-compact stop before requesting compaction.
- [Paseo Claude adapter at 38c2213](https://github.com/getpaseo/paseo/blob/38c22139bb191f0ad27b11c16776e93504ddd4fd/packages/server/src/server/agent/providers/claude/agent.ts) and [Codex adapter](https://github.com/getpaseo/paseo/blob/38c22139bb191f0ad27b11c16776e93504ddd4fd/packages/server/src/server/agent/providers/codex-app-server-agent.ts) are the integration starting points.

Do not reuse one provider's hook JSON for the other. Do not perform a provider request synchronously from its own blocking hook. Record the request through an authenticated daemon-owned control path, return promptly, then perform transfer work outside the callback. Correlate the callback to its actual session/generation; a supplied string or user-editable label is not sufficient identity.

## Configuration and trust

The target fork's [provider-options contract](../providers.md#provider-native-session-options) excludes Paseo-owned hooks and strictly validates native options. Do not paste `hooks` or arbitrary compaction keys into `providerOptions`. Add a deliberate internal launch/configuration boundary, merge without discarding existing user hooks, and test create and resume paths.

[Codex hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks) requires review of non-managed hook definitions. New or changed definitions can be skipped until trusted. Use the supported trust workflow and verify effective execution. Do not automatically bypass trust, impersonate managed policy, or overwrite user/project hook configuration. If policy denies the hook, report SLP handoff support unavailable on that installation.

Do not depend on undocumented environment variables to disable compaction. Increasing `model_auto_compact_token_limit` is not a general disable switch: [Codex model limits](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/protocol/src/openai_models.rs) and [context-window accounting](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/session/context_window.rs) impose additional bounds. Validate usable context and threshold semantics for the selected version/model.

## Certification evidence

Pin tested binary and SDK/app-server versions in the implementation evidence, including platform, provider/model, effective instructions, context settings and hook definition hash. Version comparison alone is insufficient. Prove:

1. The hook is registered, trusted and actually invoked in a real session.
2. Automatic compact is intercepted with the expected provider-specific behavior; a successful process exit alone is not proof.
3. Root-session context telemetry is current during a long tool-heavy turn and is not confused with cumulative billing or child usage.
4. Preparation reaches a known stop and candidate preparation cannot write/delegate.
5. A fresh session receives the role and checkpoint with usable context headroom.
6. Existing authentication, repository guidance, user hooks and permission rules remain effective.
7. Source-owned background jobs and pending permissions are accounted for before retirement.
8. Resume/restart preserve hook effectiveness, identity and inbox delivery.

Run the evidence on both providers, then a mixed topology with Lead/Peer on different providers. Record whether a gap prevents certification. Do not advertise strict handoff replacement on an unsupported version, missing telemetry path, denied hook or unverified stopping boundary. These are implementation gates, not requests for Human to decide adapter internals.

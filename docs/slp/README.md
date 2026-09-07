# SLP design and role instructions

Status: agreed design direction and instruction drafts for this fork. No SLP runtime, provider hook, checkpoint tool, or compatibility guarantee is implemented by this documentation change.

The user chose Supervisor–Lead–Peer to separate Human conversation, project engineering authority, and bounded technical judgment. The original [SLP Core Definition v0.1](core-definition-v0.1.md) is retained as supplied. The documents below apply the subsequent workspace-mode and same-role handoff decisions to Paseo.

## Read by purpose

| Document | Owns |
| --- | --- |
| [Architecture](architecture.md) | Scope, fixed workspace mode, identity, routing, runtime boundaries and integration |
| [Handoff](handoff.md) | Checkpoints, generation transfer, recovery and compaction interception |
| [Provider support](providers.md) | Claude Code/Codex evidence, adapter differences and compatibility proof |
| [Shared instructions](roles/common.md) | Common agent behavior, authority, repository use and handoff behavior |
| [Supervisor](roles/supervisor.md) | Human intent, conversation, visibility and escalation |
| [Lead](roles/lead.md) | Project decisions, bounded delegation, integration and acceptance |
| [Peer](roles/peer.md) | Independent bounded work and evidence-backed handback |
| [Implementation plan](implementation-plan.md) | Build order, validation scenarios and outstanding implementation proof |

## Why the instructions are shaped this way

| Role | Attention protected | Failure the instructions address |
| --- | --- | --- |
| Supervisor | Human intent and conversation continuity | Becoming a Super-Lead, relaying every conversational turn, reporting success from idle status |
| Lead | Project coherence and engineering judgment | Becoming a task router, biasing independent investigations, treating Peer completion as acceptance |
| Peer | Bounded independent technical judgment | Agreeing without evidence, expanding scope, self-accepting the project result |

Load shared instructions plus one role file, not all three roles. Keep assignment context separate from stable role instructions. Snapshot the effective instructions for a generation; a same-role handoff preserves them. User edits apply to future sessions through an explicit configuration path, not an unnoticed live prompt replacement. Prompt text does not enforce provider sandbox or runtime ownership.

The role drafts deliberately leave decision quality, neutral delegation, and independent critique in instructions. The architecture owns deterministic boundaries that prompts cannot supply: identity, message delivery, lifecycle, and tool access. The implementation plan defines scenarios to test both kinds of behavior without claiming that a prompt guarantees compliance.

## Authority and scope

Later user decisions narrow or extend the original Core document: mode is fixed at the first workspace message, only Claude Code and Codex are supported for SLP, and same-role context handoff is now in scope. Dynamic Lead replacement, semantic supervision triggers, mode switching, automatic role selection, and automatic debate remain deferred.

The user installs any project documentation framework. SLP does not install or require [repository-harness](https://github.com/hoangnb24/repository-harness). Use the consumer workspace's own authoritative guidance. The role documents here belong to the Paseo extension; they are not an automatic payload for every repository.

The source copy is a conceptual reference, not a runtime prompt. Reading these documents to develop Paseo does not activate any role or authorize product implementation beyond the current request.

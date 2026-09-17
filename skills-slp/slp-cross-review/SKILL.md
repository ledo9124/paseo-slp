---
name: slp-cross-review
description: Have a second Peer judge a first Peer's result without being told its conclusion. Use when wrongly accepting would be expensive and you cannot verify it yourself. Lead only.
user-invocable: true
---

# Cross-review

One Peer produced a candidate. A different Peer judges it against the objective, without being handed the first one's conclusion.

**What is being reviewed:** $ARGUMENTS

## Before you use this

If you can verify the result yourself, do that instead — it is cheaper and it is the stronger evidence. Asking a Peer to restate a conclusion another Peer already supported adds no independence. This earns its cost only when wrongly accepting would be expensive and the check is beyond what you can do directly.

The reviewer is never the author. A Peer cannot review its own turn.

## The brief

Give the reviewer the artifact and the objective it was meant to meet. Do not give it the author's conclusion, your own reading, or the question "is this right?" — each sets the search space to confirming an answer instead of judging the work.

```text
Objective the work was meant to meet:
<the original objective, not the author's summary of it>

The artifact:
<files, commits, or the result itself — where to look>

Constraints that bind:
<the ones that applied to the original work>

Return:
- your judgment against the objective, with evidence
- what you checked and what you could not
- what would change your mind
```

Say plainly that sound and unsound are both real answers, and that you would rather be contradicted than agreed with. A reviewer that reads the brief as a request for approval will give you approval.

## Running it

Create the reviewer with `create_agent`; the runtime registers its handback. It reaches you only by ending its turn — SLP-created Peers have the built-in finish notification off and the handback register carries the result instead. Do not poll or send hurry-ups; mail queues without interrupting.

## What comes back

The handback is a result to evaluate, not acceptance — acceptance stays yours. If the two Peers disagree, decide it: take the position the evidence supports, or verify the disputed part directly. Do not pass their arguments back and forth to make them converge; that spends turns and leaves it unclear who decided.

Record your judgment where the work's decisions are recorded, and mail the author only if it has something left to do.

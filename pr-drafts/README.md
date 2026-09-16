# Opening the SLP handoff pull requests

Three branches are pushed and ready. None of them has a pull request yet, because the session that wrote them had no GitHub credentials. This directory holds the body for each one and the order to open them in.

**Do not merge this branch.** It exists to carry these drafts to whoever opens the pull requests, and it forks from `sync/upstream-2026-09-14` with nothing else in it. Delete it once the three are open.

## The three branches

| Order | Branch                                  | Head        | Base for its PR                             | Body                                                                         |
| ----- | --------------------------------------- | ----------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| 1     | `fix/atomic-write-rename-retry`         | `287e98a2e` | `sync/upstream-2026-09-14`                  | [atomic-write-rename-retry.md](atomic-write-rename-retry.md)                 |
| 2     | `fix/slp-mailbox-and-report-provenance` | `a58c7230c` | `sync/upstream-2026-09-14`                  | [slp-mailbox-and-report-provenance.md](slp-mailbox-and-report-provenance.md) |
| 3     | `feat/slp-supervisor-handoff-boundary`  | `af268028b` | **`fix/slp-mailbox-and-report-provenance`** | [slp-supervisor-handoff-boundary.md](slp-supervisor-handoff-boundary.md)     |

Confirm each head matches before you open anything. If a branch has moved, the body may describe something else.

```bash
git fetch origin
git ls-remote --heads origin | grep -E "atomic-write|slp-mailbox|supervisor-handoff"
```

## The third PR's base is not the sync branch

`feat/slp-supervisor-handoff-boundary` is stacked on `fix/slp-mailbox-and-report-provenance`, and it depends on it: its first commit edits a document the second branch creates.

GitHub will offer `sync/upstream-2026-09-14` as the base, because that is the repository's working branch. Taking that offer puts **12 commits** in the diff — the seven that belong to this PR plus the five already under review as PR 2. Set the base to `fix/slp-mailbox-and-report-provenance` and the diff is the seven that belong to it. GitHub retargets the PR to the sync branch by itself once PR 2 merges.

The alternative, if you would rather not stack: wait for PR 2 to merge, then open PR 3 against `sync/upstream-2026-09-14`, which by then shows the same seven commits.

## Order

1 and 2 are independent of each other and of 3; open them in either order. Open 3 last, so its base branch already has a pull request to stack on.

1 and 2 fix the same symptom at two different layers and each closes it alone. They are separate PRs on purpose: the first is a daemon-wide change to the atomic write that every persisted record goes through, and the second is confined to SLP. Reviewing and reverting them independently is the point, so please keep them apart.

## What has not been checked

**CI has never run on any of these branches.** Everything claimed in the three bodies was verified on a Windows checkout: focused test suites, `build:client`, `build:server`, root `typecheck` and `lint`. Two things only CI can answer:

- the Linux half of the matrix;
- `npm run format:check` over the whole repository, which is red on any Windows checkout for line endings alone and says nothing there. Each branch's own changed files pass when checked against their committed content. See the formatting section of `docs/development.md` on the second branch for why, and for how to check it the way CI does.

One pre-existing failure is not from this work: `packages/protocol/src/messages.providers-snapshot.test.ts` times out at 5s under load, four runs out of four, on `sync/upstream-2026-09-14` as well. It may well pass on CI.

## Using the bodies

Each file is the complete body, already in the repository's pull request template, with the attribution line at the end. Paste it as-is.

```bash
gh pr create \
  --base sync/upstream-2026-09-14 \
  --head fix/atomic-write-rename-retry \
  --title "fix(server): retry an atomic write whose destination is momentarily locked" \
  --body-file pr-drafts/atomic-write-rename-retry.md

gh pr create \
  --base sync/upstream-2026-09-14 \
  --head fix/slp-mailbox-and-report-provenance \
  --title "fix(slp): stop the slot mailbox and the report relay losing messages" \
  --body-file pr-drafts/slp-mailbox-and-report-provenance.md

gh pr create \
  --base fix/slp-mailbox-and-report-provenance \
  --head feat/slp-supervisor-handoff-boundary \
  --title "feat(slp): let the Supervisor decide when a Lead's context is replaced" \
  --body-file pr-drafts/slp-supervisor-handoff-boundary.md
```

Each body opens with `Closes #` and no number. Fill in an issue if one exists; otherwise drop that line.

---
description: Cut a patch release of teleprompter (release-please + brew tap verified)
---

Drive a patch release end-to-end. The release pipeline is automated by
release-please + `.github/workflows/release.yml` (multi-platform build,
GitHub Release publish, Homebrew tap update). Your job is to gate, merge,
watch, and **verify the tap actually got the new version** —
`release.yml` swallows tap-update warnings, so a "green" workflow can
still leave the tap one version behind.

## Inputs

None. Always operates on `main`, always patch-bump (release-please
decides the version). Major/minor bumps are out of scope — see
`CLAUDE.md` "Commit & Release Convention" for the manual procedure.

## Procedure

Stop and report on any failure. Do **not** auto-recover.

### Step 0 — Preconditions

```sh
git rev-parse --abbrev-ref HEAD          # must be: main
git status --porcelain                    # must be: empty
git fetch origin && git status            # must be: up to date with origin/main
gh auth status                            # must succeed
```

Abort if any check fails. Report exactly which one. (Note: this repo
often uses git worktrees — `main` may be checked out elsewhere. Run
this command from the worktree where `main` is current, or check out
`main` first.)

### Step 1 — Locate or trigger the release-please PR

```sh
gh pr list --label "autorelease: pending" --state open \
  --json number,title,headRefName,headRefOid
```

- **PR found** → record `number`, `title`, head SHA. Continue.
- **No PR** → trigger the workflow and poll:

  ```sh
  gh workflow run release-please.yml --ref main
  ```

  Then every 30 seconds, re-run the `gh pr list` query above. Stop after
  5 minutes (10 polls). If still no PR, abort with:

  > "release-please did not produce a PR within 5 minutes. Likely no
  > releasable conventional commits since the last tag. Check
  > `git log v$(git describe --tags --abbrev=0)..main --oneline` and
  > confirm there are `feat:` / `fix:` / `perf:` / `refactor:` commits."

The PR title format is `chore(main): release X.Y.Z`. Extract `X.Y.Z` —
this is the **target version**. All later steps reference it as
`<VERSION>` and the tag as `v<VERSION>`.

### Step 2 — Mergeability gate

The release-please PR only edits `CHANGELOG.md`, `package.json`
(version bump), and `.release-please-manifest.json`. **None of these
paths trigger the main `ci.yml` workflow's path filters**, so
`gh pr checks` will only show Vercel preview status (no
lint/type-check/test/build-cli/e2e). Don't poll `gh pr checks`
expecting a "full green" — it never gets one on a release-please PR.

Instead use the merge-state rollup:

```sh
gh pr view <num> --json mergeable,mergeStateStatus,statusCheckRollup
```

- `mergeable == "MERGEABLE"` and `mergeStateStatus == "CLEAN"` → continue.
- Any other state (`BEHIND`, `BLOCKED`, `DIRTY`, `UNSTABLE`) → abort
  with the rollup payload.

If the PR were a normal feature PR, `ci.yml` would gate it. The release
PR is exempt by design — release-please-only path edits — so branch
protection's "required checks" list excludes them.

Do not run `bun test` / `pnpm type-check:all` / `pnpm test:e2e` locally
— `ci.yml` covers all of these on every non-release PR.

### Step 3 — Merge

This repo's branch protection allows squash merges only, and `main` may
be checked out in another git worktree. Use the API directly so `gh pr
merge`'s local checkout step doesn't fail:

```sh
gh api repos/DaveDev42/teleprompter/pulls/<num>/merge -X PUT \
  -f merge_method=squash
```

Poll until merged:

```sh
gh pr view <num> --json state --jq '.state'   # poll until: MERGED
```

Capture the resulting commit SHA on `main`:

```sh
git fetch origin main
MERGE_SHA=$(git rev-parse origin/main)
```

The squash subject is the PR title (`chore(main): release X.Y.Z`),
which is the conventional commit release-please needs to fire next.

### Step 4 — Push the `v<VERSION>` tag (dispatch #2)

`release-please.yml` is `workflow_dispatch` only (no `push:` trigger).
A single dispatch only does whichever action release-please decides
based on current main state — either *create the release PR* or *push
the tag*, not both. Since the previous dispatch (Step 1) created the
PR, **a second dispatch is required after the merge** to push the tag:

```sh
gh workflow run release-please.yml --ref main
```

Poll for the tag every 15 seconds, max 5 minutes:

```sh
gh api repos/DaveDev42/teleprompter/git/refs/tags/v<VERSION> \
  --jq '.ref'        # poll until: refs/tags/v<VERSION>
```

If the tag never appears, abort with the release-please-action run log.

### Step 5 — Trigger and watch `release.yml`

`release.yml` is wired to `push: tags: [v*]`, **but GitHub API tag
creation does not reliably fire `push` events** (#172). In practice
this trigger is unreliable enough that we always dispatch manually:

```sh
gh workflow run release.yml -f tag=v<VERSION>
```

Capture the new run id:

```sh
RUN_ID=$(gh run list --workflow=release.yml --limit=1 \
  --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status
```

> If `release.yml` *does* auto-fire from the tag push, you'll see a
> `push`-event run sitting next to the manual dispatch. They build the
> same tag, so harmlessly redundant — let both finish, then continue.

- `--exit-status` fails the watch on any job failure. On non-zero exit:

  ```sh
  gh run view "$RUN_ID" --log-failed
  ```

  Show the output to the user, name the failed step, abort.

- **On success**, additionally check for swallowed tap warnings:

  ```sh
  gh run view "$RUN_ID" --log | \
    grep -E "::warning::(HOMEBREW_TAP_TOKEN not set|Homebrew tap push failed)"
  ```

  If either warning matches, abort with the matched line. The release
  succeeded but the tap is out of sync — `release.yml`'s "Update
  Homebrew formula" step falls back to non-fatal warnings, which is the
  exact failure mode this command exists to catch.

### Step 6 — Tap repo sanity check

```sh
gh api repos/DaveDev42/homebrew-tap/commits/main \
  --jq '.commit.message'
```

Expected: a commit message containing `<VERSION>` (the
`homebrew-tap-release@v1` reusable action introduced by #185 writes
`tp <VERSION>` as the subject; older releases used
`chore: update tp to <VERSION>`). What matters is that the **version
string appears in the latest commit subject**. If absent or stale,
abort with the actual message.

Capture the tap commit SHA for the summary:

```sh
TAP_SHA=$(gh api repos/DaveDev42/homebrew-tap/commits/main --jq '.sha')
```

### Step 7 — Real `brew upgrade` smoke test

```sh
brew update
brew upgrade davedev42/tap/tp
tp version
```

Verify `tp version` output contains `<VERSION>`. Mismatch → abort
("installed version does not match released version — likely Homebrew
bottle cache is stale or the tap push is still in flight").

If the tap was not previously installed, `brew upgrade` will fail with
"No such keg". In that case run `brew install davedev42/tap/tp`
instead. Re-run `tp version` afterward to confirm.

### Step 8 — Final summary

Print:

- Release PR: `#<num>` — `<title>` (merged at `<MERGE_SHA>`)
- Tag: `v<VERSION>`
- GitHub Release URL:
  `gh release view "v<VERSION>" --json url --jq '.url'`
- Tap commit:
  `https://github.com/DaveDev42/homebrew-tap/commit/<TAP_SHA>`
- Installed: output of `tp version`

If any step was skipped (e.g. release PR was already merged when this
ran, so Steps 1-3 were no-ops), say so explicitly.

## Re-running

Re-running this command after a partial failure is safe and idempotent:

- Step 1 finds the existing release PR.
- Step 3 detects an already-merged PR via `gh pr view --json state` →
  `MERGED`, and skips merge.
- Step 4 detects an existing `v<VERSION>` tag and skips the second
  release-please dispatch.
- Step 5 finds the most recent `release.yml` run regardless of who
  triggered it. If a `push`-event run already succeeded, the manual
  dispatch is harmlessly redundant.
- Steps 6-8 are read-only verification and always safe.

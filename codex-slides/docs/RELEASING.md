# Releasing Codex Slides

This guide assumes nothing beyond push access to the repository and a working
local checkout (`pnpm install` done, `git` and `pnpm` available). Every build,
test, and upload step runs in GitHub Actions — your machine never builds the
installers that ship.

## TL;DR — ship a release

There are two equivalent ways; both end in the same automated pipeline.

### Option A: from the GitHub UI (no local setup at all)

1. Open **Actions → Release desktop apps → Run workflow**.
2. Enter the version, e.g. `0.2.0`, and run.

The workflow validates the version, bumps `package.json` and
`electron/package.json` on the branch if needed (committing `release: v0.2.0`
as `github-actions[bot]`), pushes the `v0.2.0` tag itself, and then continues
into the build/publish pipeline below. Leaving the version empty runs a
build-only rehearsal that publishes nothing.

> Note: this path needs the default branch to accept pushes from GitHub
> Actions. If you later protect `master`, either allow the Actions bot to
> bypass the rule or use Option B.

### Option B: from your terminal

```bash
pnpm release 0.2.0
```

That single command:

1. Verifies your working tree is clean and the version is greater than the
   current one.
2. Bumps `package.json` and `electron/package.json` to `0.2.0`.
3. Runs the fast local gates (`electron:check`, `test`, `typecheck`).
4. Commits `release: v0.2.0`, creates the annotated tag `v0.2.0`, and pushes
   both.

The pushed tag triggers [`release-desktop.yml`](../.github/workflows/release-desktop.yml).
From here everything is automatic — watch it under **Actions** on GitHub
(the script prints the link). Add `--dry-run` to rehearse without changing
any git state.

## What the workflow does

| Stage | What happens | Fails when |
|---|---|---|
| **Prepare release** | Tag push: checks the tag matches `package.json`. UI dispatch: bumps versions, pushes the commit + tag. Then creates a **draft** GitHub Release with auto-generated changelog plus download/install instructions | Tag and package version disagree, or the tag already exists |
| **Build mac / windows / linux** | `electron:check` → `build:desktop` (which boots the built server and requires HTTP 200 from `/` and `/api/agents`) → `electron-builder` → boots the server **again from inside the packaged app** → uploads assets to the draft | Any contract check, build, or smoke probe fails |
| **Publish** | Writes `SHA256SUMS.txt` (must cover exactly 7 assets), then flips the draft to a published release marked **Latest** | An asset is missing |

Because the release stays a **draft** until the very last step, users never see
a half-uploaded release. Total time is roughly 15–30 minutes.

## Verify after publishing

1. Open the release page and confirm 8 assets (7 installers/archives +
   `SHA256SUMS.txt`).
2. Download the DMG for your Mac, install, and launch. First launch of an
   unsigned build needs **right-click → Open** (or System Settings →
   Privacy & Security → **Open Anyway**).
3. The app should open a window with the Codex Slides home screen. If it does
   not, check the two log files under
   `~/Library/Application Support/Codex Slides/`:
   `codex-slides-desktop.log` (shell lifecycle) and
   `codex-slides-server.log` (bundled web server).

## When something fails

- **A build job failed.** Fix the problem on `master`, then either re-run the
  failed jobs from the Actions UI (uploads use `--clobber`, so re-runs are
  safe) — or start over with a fresh patch version.
- **Start over with the same version.** Delete the tag and draft, then re-run
  `pnpm release`:

  ```bash
  gh release delete v0.2.0 --yes          # deletes the draft release
  git push origin :refs/tags/v0.2.0       # deletes the remote tag
  git tag -d v0.2.0                       # deletes the local tag
  ```

- **The draft was published but an installer is broken.** Ship a patch release
  (`pnpm release 0.2.1`). Do not replace assets on a published release.

## Manual path (no script)

```bash
# 1. bump BOTH package.json and electron/package.json "version" fields
# 2. sanity check
pnpm electron:check && pnpm test && pnpm typecheck
# 3. commit, tag, push
git add package.json electron/package.json
git commit -m "release: v0.2.0"
git tag -a v0.2.0 -m "Codex Slides 0.2.0"
git push origin HEAD refs/tags/v0.2.0
```

## Release channels and signing

There is one channel today: tagged stable releases on GitHub. Builds are
**not code-signed** (`CSC_IDENTITY_AUTO_DISCOVERY=false`); macOS builds are
ad-hoc signed by electron-builder, so Gatekeeper shows an "unidentified
developer" warning that the release notes explain to users. To add real
signing later, provide the standard electron-builder secrets
(`CSC_LINK`/`CSC_KEY_PASSWORD`, plus notarization credentials) in the
workflow — its shape does not need to change.

## Local packaging (for debugging, not releasing)

| Command | Purpose |
|---|---|
| `pnpm build:desktop` | Build + smoke test the standalone server payload |
| `pnpm electron:pack` | Produce an unpacked app in `dist/` for the current platform |
| `pnpm smoke:packaged` | Boot the server from every unpacked app in `dist/` and probe it |
| `pnpm electron:dist` | Build the real installers locally |

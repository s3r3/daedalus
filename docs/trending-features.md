# Trending Features: Agents, Hooks, Worktrees, Review, CI, Skills, Launcher

This document covers the seven agent features and the launcher/packaging
work added after Phase 10. Everything is original TypeScript in
`@daedalus/core` plus thin interface wiring; concept references are in
`docs/THIRD_PARTY.md`.

## 1. AGENTS.md standard alignment

Project rules now load in this priority order and are injected into the
system prompt as one "Project rules" section (8,000-char cap):

1. `<workspace>/.daedalus/RULES.md`
2. `<workspace>/AGENTS.md` — the cross-tool standard file; the same file
   other agents read, honoured first-class at the workspace level.
3. `<workspace>/.daedalus/rules.md`
4. `<daedalusHome>/AGENTS.md` — user-level rules that apply in every
   workspace (the resolved Daedalus home, e.g. `<workspace>/.daedalus` by
   default or an absolute `DAEDALUS_HOME`).

Workspace files keep precedence (they come first in the prompt); the global
file is appended after them. `loadProjectRules` reports the contributing
files as `AGENTS.md (global)` for the user-level file.

## 2. Hooks (pre/post tool lifecycle)

`<workspace>/.daedalus/hooks.json`:

```json
{
  "pre_tool": [{ "match": "write_file|edit_file", "command": "node scripts/guard.mjs", "timeoutMs": 5000 }],
  "post_tool": [{ "match": "write_file", "command": "npx prettier --check \"$DAEDALUS_HOOK_TOOL\" || true" }]
}
```

- `match`: a tool name, `*` (any tool), `a|b` alternatives, or a name with a
  `*` wildcard (`mcp__*`).
- Hooks run with `sh -c` in the workspace root and receive:
  `DAEDALUS_HOOK_PHASE`, `DAEDALUS_HOOK_TOOL`, `DAEDALUS_HOOK_COMMAND`,
  `DAEDALUS_HOOK_ARGS_JSON`, `DAEDALUS_HOOK_ARGS_FILE` (JSON args in a temp
  file), and for post-tool hooks `DAEDALUS_HOOK_RESULT_STATUS` /
  `DAEDALUS_HOOK_RESULT_FILE`.
- A pre-tool hook **blocks** the call by exiting with code 2 or by printing
  `{"block": true, "reason": "..."}` on stdout. The reason is returned to
  the model as the tool result. Every other failure — timeout, crash,
  non-zero exit — is fail-open: recorded as a `HOOK_EXECUTED` event, and the
  call proceeds.
- A post-tool hook's stdout (trimmed, capped at 500 chars) is appended to the
  tool result as `hook: …` lines so the model sees lint/format feedback in
  the same turn.
- Hooks run in the mutating modes (auto/"code", manual, orchestrator
  children) and are skipped for read-only ask/plan runs.
- `DAEDALUS_HOOKS=off` disables hooks entirely.

Security note: `hooks.json` is **trusted project config** — like a Makefile,
it executes shell commands by design. It only runs for the workspace that
defines it, and only because you opened that project. Review an unfamiliar
repo's `.daedalus/hooks.json` before running a task in it, or set
`DAEDALUS_HOOKS=off`.

In a worktree run (feature 4), the hooks config is loaded from the main
workspace and executed with the worktree as the working directory.

## 3. File-defined subagents

`<workspace>/.daedalus/agents/<name>.md`:

```markdown
---
name: reviewer
description: Read-only reviewer for payment code
mode: ask
model: some-model-id
tools: [read_file, grep, lsp_diagnostics]
---

You review payment code. Never approve a change that moves money without
an explicit test of the failure path...
```

Frontmatter: `name`, `description`, optional `model`, `mode`, and a `tools`
allowlist (inline `[a, b]`, comma-separated, or `- item` list). The body is
the subagent's standing instructions, injected as a "subagent" system-prompt
section.

- Orchestrator children may name an agent (`agent: "reviewer"` in the child
  spec; the REST API's `children` entries accept the same field). The child
  then runs with that agent's model/mode, sees only the allowlisted tools
  (execution denies anything else), and records `agent` on its spec, state,
  and `CHILD_TASK_*` events.
- An unknown agent name is a clear error before anything runs — no silent
  fallback to a default agent.
- `/agents` lists defined subagents in the CLI (sidebar "Subagents" section
  too) and in Web (Extensions panel + `/agents` in the composer).

## 4. Git worktree-per-task

`daedalus run --isolation worktree "…"` (or `TaskRunnerOptions.isolation` /
per-child `isolation: "worktree"` for orchestrator children and the REST
API): when the workspace is a git repository, the task runs in its own
checkout at `<daedalusHome>/worktrees/<taskId>` on branch
`daedalus/<task-id-8>`. The MCP/LSP/skills/agents/hooks configuration still
comes from the main workspace.

- After the run, the report gains `worktree: { path, branch, files_changed }`;
  the worktree and branch are **kept** for review. Nothing is merged
  automatically.
- `daedalus apply <task-id>` applies the worktree's diff to the main
  workspace as a patch, then removes the worktree and branch. It refuses on
  conflicts, leaving the worktree in place for manual merging.
- Non-git workspaces (or a missing git binary) fail with a clear error
  **before** the task runs — no silent fallback to the shared tree.

## 5. Code-review agent (`/review`)

`/review` in the CLI and Web runs one read-only review pass: it takes the
current task's recorded diff (or the repo's unstaged `git diff` when there
is no task), caps it at 40,000 chars, adds the project rules, and asks the
configured provider once — no tool loop, no mutating tools. Findings are
expected as `- **[severity] file:line** — message` (severity high/medium/
low) and render into the transcript; the Web endpoint is `POST /review`
against the same gateway.

## 6. Headless / CI

`daedalus run --ci` implies `--json`, never prompts (mutating approvals
auto-deny unless `--yolo`), and finishes with one JSON line:
`{"outcome": "...", "exit_code": n, "report": {...}}`. Exit codes: success
0, failed 1, partial 2, stopped 3. `--json` final reports already include
`title` / `validation_source` (and now `worktree`) when present.

A ready-to-adapt GitHub Actions recipe lives at
`docs/ci/github-actions.example.yml`: it installs Daedalus from the repo
checkout with `npm link`, runs `daedalus run --ci --yolo "<goal>"` with
provider credentials from secrets, and uploads `.daedalus/tasks` as a
build artifact.

## 7. Bundled starter skills

Five original starter skills ship in `Daedalus/skills/`:
`spec-driven-development`, `test-driven-development`, `code-review`,
`systematic-debugging`, `git-workflow`.

- `daedalus skills list` shows bundled skills and the skills already
  installed in the current workspace, each with provenance.
- `daedalus skills install [names…|--all] [--force] [--cwd <ws>]` copies
  bundled skills into `<ws>/.daedalus/skills/`. A same-name skill is never
  overwritten without `--force`; the skip is reported with its path. The
  core loader's first-wins precedence is unchanged, so an installed
  workspace copy wins over any same-name folder added later.
- Installed skills appear in the existing Web `/skills` listing and the
  Extensions panel with no extra wiring.

## Launcher menu, workspace anchoring, packaging

Running bare `daedalus` in a terminal shows the launcher (arrow keys
↑/↓ + Enter, number keys 1–6, `q` to quit; a numbered text menu when
stdin/stdout are not a TTY):

```
╭─ Daedalus
│  Server: http://127.0.0.1:3080 (running, pid 1234)
│  Workspace: /home/you/project
│  Tray: …
│  Tray icon: …/cli/assets/tray-icon.svg (placeholder "D" — Farid's final design comes later)
│  ❯ 1  Daedalus Coding (Web UI)
│    2  Daedalus Slide (Web UI)
│    3  Daedalus Dokumen (Web UI)
│    4  Daedalus Spreadsheet (Web UI)
│    5  Hide to Tray (Background)
│    6  Exit
╰─ ↑/↓ select · Enter confirm · 1–6 jump · q quit
```

- **1–4 (the four domains)** ensure the background daemon, open the
  browser at that domain's route (`/`, `/slide`, `/dokumen`,
  `/spreadsheet`), print the URL, and leave the menu — the server keeps
  running in the background.
- **5 Hide to Tray** ensures the daemon and leaves only the background
  server running (honest tray note below).
- **6 Exit** shuts the background server down through the same stop
  mechanism as `daedalus stop` and says what happened.

**Workspace anchoring.** The directory where `daedalus` is invoked becomes
the daemon session's workspace (the server is spawned with
`DAEDALUS_WORKSPACE=<cwd>`, and `/health` reports `workspace_root`). If a
healthy daemon from a different directory is already running, it is reused
as-is — never killed or re-anchored — the CLI choice still chats in the
invocation directory, and the Web choice prints the daemon's URL plus a
note of the workspace it serves.

**Tray icon (placeholder).** The bundled tray icon is
`cli/assets/tray-icon.svg`: a bold letter "D" in the Daedalus accent. It is
a placeholder until Farid supplies the final design — replacing the file is
all a future native tray backend needs, and `TrayStatus.icon` (and
`daedalus status`) already reference this path. Honest limitation,
unchanged: **no native tray backend is bundled**, so on desktop sessions
Daedalus reports that instead of pretending to show an icon; use
`daedalus status` / `daedalus stop` in the meantime.

## Install

Daedalus currently installs from the repo checkout (monorepo layout) with
npm or bun. Node ≥ 22 is required; the CLI entry is TypeScript run through
Node's type stripping (`#!/usr/bin/env -S node --experimental-strip-types`).

```sh
git clone https://github.com/s3r3/daedalus.git
cd daedalus/Daedalus
npm install          # or: bun install
npm link             # or: bun link  (puts `daedalus` on your PATH)

cd ~/any/project
daedalus             # launcher menu; this directory becomes the workspace
```

`npm pack` from `Daedalus/` produces a source tarball (core/cli/server/web
sources + skills + docs, no `node_modules`; the root `package.json`
declares the same `daedalus` bin). A global install from the packed tarball
still expects the monorepo layout for the `@daedalus/core` workspace link;
a bundled single-package distribution (compiled `dist`) is future work.

## Known limitations (honest list)

- Native desktop tray: not bundled (see above). The background daemon is
  the real "hide to tray" mechanism today.
- Worktree isolation requires git and a committed baseline: the worktree
  checks out `HEAD`, so uncommitted main-workspace changes are not visible
  inside the isolated run (extension *configuration* is preloaded from the
  main workspace; file contents come from the checkout).
- Hooks are shell execution by design — trusted project config only.
- `/review` is a single provider call over the diff; it does not browse the
  repo beyond the diff and the project rules.

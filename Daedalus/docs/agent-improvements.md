# Agent improvements: loops, edits, validation, rules, rewind, context, titles

Seven behaviours added to the shared `@daedalus/core` on 2026-10-05, so the
CLI, interactive chat, and Web all inherit them from the same code path. Each
was implemented from scratch after studying published designs elsewhere;
`docs/THIRD_PARTY.md` records the concept references. No new runtime
dependencies were added.

## 1. Anti-loop warning injection

A model that re-issues the exact same tool call (same tool, same arguments)
used to burn iterations until the `no_progress` stop killed the task. The
`LoopGuard` (`core/src/agent/loop-guard.ts`) now tracks the last 12 call
signatures per task (arguments serialized with sorted keys, so key order
never changes a signature):

- 3rd identical call — executed, but a `LOOP_WARNING` event is emitted and a
  guidance note ("you have repeated … choose a different action …") is
  queued and appended to the **next** model request as an extra user turn.
- 4th and later identical calls — not executed. The model receives the
  cached-repeat result `(repeat suppressed: same call already returned
  above)` instead.
- The `no_progress` stop condition remains the final backstop, with its
  threshold raised from 3 to 6 identical observations, since the guard now
  gets the first chance to talk the model out of the rut. `max_errors` and
  `max_iterations` are unchanged.

The CLI prints `↻ Loop warning: <tool> repeated N×`; the Web timeline shows
a `loop warning` recovery entry.

## 2. Edit guard

After a successful `write_file`/`edit_file`, the runner checks the touched
file (`core/src/agent/edit-guard.ts`) and appends the outcome to the tool
result, so the model can repair a bad write in the same turn:

- `.js`/`.mjs`/`.cjs` → `node --check <file>`
- `.json` → `JSON.parse`
- `.py` → `python3 -c 'compile(...)'` (skipped silently when python3 is
  absent; never writes `__pycache__`)
- If LSP servers are configured for the workspace, `lsp_diagnostics` for the
  file are collected with a 2s budget.

Failures are prefixed `EDIT_GUARD: syntax error in <path>: …`. A clean file
adds a quiet `edit guard: ok` (only when a check actually ran). Everything
is fail-open and time-bounded: a missing interpreter, a missing file, or a
slow server adds nothing and never fails the run. Disable with
`DAEDALUS_EDIT_GUARD=off` (or `settings.editGuard = false`).

## 3. Validation profile per workspace

If `<workspace>/.daedalus/validate.json` exists, validation runs **those**
commands instead of the built-in test/lint/build detection:

```json
{
  "checks": [
    { "name": "check", "command": "node check.mjs" },
    { "name": "docs",  "command": "node scripts/docs.mjs", "required": false }
  ],
  "timeoutMs": 60000
}
```

- Quoted arguments in `command` are honoured (no shell expansion).
- `required: false` checks are reported but never block completion.
- Reports carry `validation_source: "profile" | "default"`; evidence lines
  mark profile checks with `[profile]`.
- A malformed profile never breaks validation: the runner falls back to the
  default checks and records a `validation profile warning: …` evidence
  line. This also fixes the old false "partial" outcome for workspaces that
  simply have no test/lint/build scripts — give them a profile that matches
  what the project actually runs.

## 4. Project rules file

At run start the core loads standing instructions from the workspace, in
priority order: `.daedalus/RULES.md`, then `AGENTS.md`, then
`.daedalus/rules.md`. When several exist they are concatenated in that
order, each under a `## Rules from <file>` header, capped at 8000 chars
(with a truncation note). The result is injected into the system prompt as a
"Project rules" section, and the loaded files are recorded as `rules_files`
on the task state and final report; the CLI status bar shows
`rules <files>`.

## 5. Checkpoint / rewind

Before a task mutates a file for the first time, the runner stores the
pre-mutation content (or a "created" marker for new files) under
`<daedalusHome>/tasks/<taskId>/backups/`, with a manifest `index.json`. The
first record per path wins, so a restore returns the workspace to exactly
the state the task found.

- Core: `store.listBackups(taskId)`, `store.restoreTask(taskId, workspaceRoot?)`.
- CLI: `daedalus restore <task-id> [--cwd <dir>]` prints each restored and
  deleted path.
- Interactive chat: `/rewind` restores the current/last task.

Safety: every restore target is resolved against the workspace root and the
whole restore is refused if any recorded path escapes it; only recorded
files are ever touched.

## 6. Context meter + condense

Every `MODEL_REQUEST_STARTED` / `MODEL_REQUEST_FINISHED` /
`MODEL_REQUEST_FAILED` event now carries:

- `context_estimate_tokens` — chars/4 estimate of the outgoing message list
- `context_limit_tokens` — from `DAEDALUS_CONTEXT_LIMIT` (default `128000`;
  an invalid value is a settings error)
- `context_percent` — estimate as a percentage of the limit (capped at 100)

The CLI status line and sidebar show `ctx NN%`; the Web top bar shows a
`ctx NN%` chip (warning tone ≥70%, error ≥90%) and the timeline's "Thinking"
entries append the same reading.

When the estimate exceeds 70% of the limit, tool-result contents older than
the 6 most recent are replaced with `(earlier tool output condensed to save
context)` before the request goes out; `tool_call_id` structure is preserved
so providers still accept the request. Disable with `DAEDALUS_CONDENSE=off`.

Note: the shipped `DefaultContextManager` collapses each turn's history into
`state.last_observation` (already capped), so on a default run the meter
reads modest percentages and condensing mainly engages with history-carrying
context managers or a small `DAEDALUS_CONTEXT_LIMIT` (e.g. local
small-context models). The meter is always reported either way.

## 7. Helper model for titles

With `DAEDALUS_HELPER_MODEL` set (same base URL/API key as the main model),
`TaskRunner` asks the helper model for a 3–6 word title of the goal at task
start — 5s timeout, fail-silent, quotes stripped, capped at 80 chars. The
title lands on the task state, the final report (`report.title`), and the
`TASK_STARTED` event, so:

- the CLI run header prints `Task: <title> — <goal>`,
- the Web task picker prefers the title over the raw goal text.

When the variable is unset, the helper errors, or it times out, `title`
stays undefined and every UI falls back to the goal text exactly as before.
Child (orchestrator sub-) tasks are not titled.

## Settings summary

| Variable | Default | Effect |
|---|---|---|
| `DAEDALUS_EDIT_GUARD` | on | `off` disables post-edit syntax/LSP checks |
| `DAEDALUS_CONTEXT_LIMIT` | `128000` | Token budget for the context meter + condense threshold |
| `DAEDALUS_CONDENSE` | on | `off` disables condensing old tool outputs |
| `DAEDALUS_HELPER_MODEL` | unset | Cheap model used only to title tasks |

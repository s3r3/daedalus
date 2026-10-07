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

## 8. Command-output compression

Caps alone keep the head and tail of a noisy command log; the signal (a
failure three screens in, the final verdict) is what the model actually
needs. So foreground `run_command` results pass through semantic
per-family filters (`core/src/agent/output-compression.ts`, an original
RTK-style implementation — concept provenance in `docs/THIRD_PARTY.md`)
before the caps+spill shaping:

- Families: `git` (status/diff/log, plus a `+A -R` diff census), `test`
  (runner summaries kept, passing noise folded), `build` (tsc/eslint/
  bundler verdicts + warnings), `install` (package changes + audit),
  `listing`, and a `generic` head/tail filter. Command families without a
  filter get `generic`; file reads and other tools are never compressed.
- Failure/error lines are kept verbatim in every family, repeated lines
  fold with `(×N)` counts, and the compression note appended for the
  model carries the raw→compressed char counts and the exit code.
- Nothing is destroyed: the raw output is written to the task store
  (`tool-output/` spill files) and the note names the path; read it back
  with `read_file` offset/limit. Compression only engages above 2,000
  chars or 40 lines, never returns text longer than the input, and the
  event log keeps the executor's untouched result either way.
- Savings are audited on the final report: `compressed_outputs`,
  `output_chars_before_compression`, `output_chars_after_compression`.

Default on. Disable with `DAEDALUS_OUTPUT_COMPRESSION=off`, the Web
Settings → "output compression" toggle, or `settings.outputCompression
= false`; with it off, command output reaches shaping byte-identical.

## 9. Read pagination + unchanged-read stub

`read_file` paginates by whole lines inside a 2,000-line / 50,000-char
budget (aligned with the tool-output caps, so a normal ~200-line file
can never truncate). Every result states its range in a header
(`[read_file <path> — lines X–Y of Z]`); a partial view ends with a
`…[truncated] PARTIAL view` notice stating the total, the shown range,
how many lines were received, and the exact continuation call
(`read_file(path="…", offset=<Y+1>, limit=<N>)`). A single line longer
than the budget is cut mid-line with a notice that it is not pageable
(use `run_command` byte tools). Before this, the file tools sliced at
16k chars with no continuation path — re-reading was rational, and the
model did it 8×.

A repeat `read_file`/`list_dir` whose content matches what the task was
already served (compared against the freshly executed result, so any
edit invalidates it by content, not by clock) is answered with a short
stub — "unchanged since your earlier read … already in your context" —
instead of re-emitting the file into history. The stub is only claimed
for ranges actually received in full: a shaped (truncated) serve records
nothing, and if context condensing has dropped older results since the
serve, the record is forgotten and the file is served fresh. The event
log keeps the raw result and flags the stub additively
(`unchanged_stub`).

## 10. Loop breaker, stall backstop, input-token budget

Identical calls (tool + canonicalized args) are counted across the
whole task, not just a sliding window: **warn at 3** (with a specific
directive), **suppress at 4**, and at the **5th** the task hard-pauses —
the user is asked via a question card (continue a different way / stop
the task); continue re-arms the breaker with the directive injected
into the next turn, stop (or no answer path) ends the task. Suppressed
calls never execute.

Independently, the loop tracks *stalls*: a tool result is progress only
if it is a file change, a successful command, a download, or a NEW
observation (a result this task has not already seen). Anything else —
re-reads, repeated searches, stubs, errors — accrues, so alternating
read/search cycles stall out exactly like one repeated call (the old
identical-observation backstop reset on every alternation and let a
live run reach 14 requests / 264k input tokens). At 3 stalls the tailor
early-trigger fires (above); at 6 the task ends as **partial** with
honest evidence (`stuck: … no file change, no successful command, no
download, no new information`). The same partial treatment applies to
hard-pause stops and to the per-task **input-token budget**
(`DAEDALUS_INPUT_TOKEN_BUDGET`, default 100,000 provider-reported or
harness-estimated input tokens), which stops a runaway task with the
spend stated instead of letting it burn unbounded turns.

Parsed tool-call arguments are validated against the tool's schema
before dispatch (and before they can enter history): a malformed call —
e.g. the router-corrupted `start_line: "3,10"` string — is never
executed and never silently substituted; it returns a typed
`tool_call parse error` observation naming the field, the expected
type, and the schema, and counts on the same mistake ladder. The text
tool-call protocol also accepts the Anthropic `<invoke>`/`<parameter>`
dialect and turns orphan fragments (a leaked `</invoke>`) into a
malformed→repair exchange naming the exact accepted format instead of
silence.

## Settings summary

| Variable | Default | Effect |
|---|---|---|
| `DAEDALUS_EDIT_GUARD` | on | `off` disables post-edit syntax/LSP checks |
| `DAEDALUS_CONTEXT_LIMIT` | `128000` | Token budget for the context meter + condense threshold |
| `DAEDALUS_CONDENSE` | on | `off` disables condensing old tool outputs |
| `DAEDALUS_HELPER_MODEL` | unset | Cheap model used only to title tasks |
| `DAEDALUS_OUTPUT_COMPRESSION` | on | `off` disables semantic filtering of `run_command` output (caps+spill still apply) |
| `DAEDALUS_TAILOR_EARLY_ESCALATION` | on | `off` disables pinning a looping task to the strongest pool model (directive + fail-fast remain) |
| `DAEDALUS_INPUT_TOKEN_BUDGET` | `100000` | Per-task input-token budget; crossing it stops the task as partial with the spend stated |

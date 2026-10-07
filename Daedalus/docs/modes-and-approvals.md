# Modes and approvals

Daedalus has four agent modes. They are not prompt labels: each mode is a row
in one permission matrix in core (`MODE_PERMISSION_MATRIX` in
`core/src/interaction/modes.ts`), enforced at tool-call time by the execution
harness, so even a misbehaving model cannot mutate the workspace in a
read-only mode. The same matrix drives the CLI and the Web because both talk
to the same `@daedalus/core`. (A fifth mode, Orchestrator, was retired in
favor of the model-invoked `spawn_subagent` tool — see *Subagents* below;
records and settings that still name it load and run as Auto.)

## The mode × permission matrix

Tool calls fall into three classes: **read** (`read_file`, `list_dir`, search,
diagnostics…), **mutating** (file writes/edits, `create_dir`, MCP tools), and
**executing** (`run_command`).

| Mode          | Read  | Mutating | Executing (`run_command`)          |
|---------------|-------|----------|------------------------------------|
| ask           | allow | deny     | deny                               |
| plan          | allow | deny\*   | deny                               |
| manual        | allow | ask      | ask                                |
| auto          | allow | allow    | ask → allow while auto-approve on  |
| orchestrator  | — retired: loads and runs as **auto** (see *Subagents*) |

\* Plan mode has exactly one sanctioned write: plan documents under
`.daedalus/plans/**` (see *Plan documents*). Everything else mutating stays
denied, and `run_command` stays denied outright.

Rules that hold in every mode:

- **Reads never prompt.** Prompting on reads only trains blind approval.
- **Denials are explained to the model.** A call refused by the mode gate
  comes back with text that names the mode and says what to do instead (in
  ask mode: answer the question, and suggest switching modes for changes; in
  plan mode: put the action into the plan as a step naming its file).
- **The prompt contract matches the gate.** Each mode also states its
  contract in the system prompt (`modePromptContract`), but the contract is
  advisory — the harness gate is the enforcement.
- **Pure questions never reach the matrix.** Conversational questions are
  answered by the grounded fast path in one provider call, in CLI and Web,
  without task machinery; modes govern tasks.
- **Plan mode output is recognizable.** A plan run emits `PLAN_CREATED` with
  the producing `mode` in the payload (and the plan document paths, see
  *Plan documents*), and the model's final reply is a brief summary naming
  the plan file. Switching to Auto/Manual and sending "jalankan rencananya"
  executes it **in context** (Cline-style continuity, not a fresh-context
  handoff): the follow-up task carries `plan_task_id`, and core injects the
  stored plan steps as a constraint. The Web also offers an explicit
  *Approve & Execute* bar once a plan task finishes with documents; see
  below. There is no modal plan-approval pipeline; see *Honest limits*.

## Approvals

A gated call (`ask` in the matrix) pauses the task. Core builds an
**approval request** with a stable id and an **untruncated preview** — the
verbatim command line for `run_command`, the full new content for
`write_file`, a unified diff for edits, raw arguments otherwise — and emits
`APPROVAL_REQUESTED` with it. The agent loop waits on the decision;
cancelling the task (Stop) settles every pending approval of that task (and
its children) as *denied*.

Decisions arrive through `POST /tasks/:id/approvals/:approvalId`:

```json
{ "decision": "allow" | "allow_remember" | "decline",
  "note": "optional, delivered to the agent verbatim",
  "editedArgs": { "…": "optional replacement arguments" } }
```

- **Allow once** runs the call as proposed.
- **Edit & allow** (commands): the edited line replaces the original; it is
  re-split on whitespace into command + argv, exactly as the preview renders
  the original.
- **Decline**: the optional note is returned to the model verbatim as the
  tool result, so the user can redirect it ("run the server package only").
  Text typed into the Web composer while an approval is pending and submitted
  does exactly this — it declines with that text instead of starting a task.
- **Timeout = decline, never allow.** A request nobody answers within
  `DAEDALUS_APPROVAL_TIMEOUT_MS` (default 600 000 ms / 10 min) is denied with
  the distinct message "approval timed out — treated as declined".

Every outcome lands back on the event log as `APPROVAL_DECIDED` (decision,
approval id, note, `edited`, `timed_out`, `cancelled`), and the Web renders it
as a collapsed receipt line in the chat transcript.

In the Web, the pending approval card (and the `ask_user` question card) is
not panel furniture bolted under the chat: it renders **inside the scrollable
transcript as its last block**, after the conversation turns and entries. The
panel therefore keeps its bounded height no matter how tall a card is, and
the card's action row is always reachable by the panel's own scroll. A card
arriving while you are pinned to the bottom scrolls itself into view; if you
have scrolled up to re-read, nothing yanks you down — a "waiting for
approval / your answer" chip appears at the panel's bottom edge instead and
jumps to the card on click. Inside the card, the untruncated preview scrolls
in its own region under a viewport-relative cap (`max-h-[80vh]`), so the
Allow / Decline row at the card's end stays visible even for huge writes.

### Remembered approvals ("Allow & remember")

A card may offer *Allow & remember* **only when it can show exactly what will
be remembered** (Claude Code's rule: a prompt never silently grants more than
it displays):

- `run_command` → the tool + the command's **first token** (`run_command`
  starting with `"npm"`),
- file operations → the tool + the **exact path**,
- any other mutating tool → the bare tool name.

Remembered grants are **session-scoped and in-memory**: the server keeps one
map shared by all its task runners, and restarting the server forgets every
grant. The card says so. Granting a remember also immediately settles any
already-queued pending requests that match the pattern.

### Child tasks

A subagent's approval requests surface on the **parent's** event log
(mirrored events carry the child's identity), so the card in the
parent chat names the requesting child task. The CLI's terminal prompt
(`a` approve / `d` deny / `r` remember, decided through the same core broker)
shows the same preview text.

## Interactive questions (`ask_user`)

Modeled on Claude Code's AskUserQuestion and Cline's `ask_followup_question`:
when requirements are genuinely ambiguous — audience, product type, stack —
the agent asks instead of guessing. The tool `ask_user` takes
`{ question, options: [{label, description?}] (2–4), allow_free_text? (default
true) }` and is visible in plan, manual, and auto modes (every
mode that can produce a plan); it is hidden in ask mode, where the agent
should simply answer. It is classified `read`, so it never routes through
the approval gate — its own broker is the pause.

The mechanism mirrors the approval broker:

- Calling `ask_user` emits `QUESTION_REQUESTED` (question id, question,
  options, `allowFreeText`, mode, task id) and the agent loop blocks on
  core's `QuestionBroker` until the question is answered, times out, or the
  task is cancelled.
- Answers arrive through `POST /tasks/:id/questions/:questionId` with
  `{ answer: string }` — the chosen option's label or the user's own
  free text. The tool result returns the answer **verbatim** to the model,
  named as the chosen option (with its index) or as a free-text answer.
  Unknown or already-settled ids answer 404; a blank answer is a 400.
- **Timeout is not failure.** After `DAEDALUS_QUESTION_TIMEOUT_MS` (default
  900 000 ms / 15 min) the tool returns a "no answer arrived" result that
  tells the model to proceed with stated assumptions (and to mark them
  `(assumed)` in the plan's Decisions). The task continues.
- **Stop cancels.** Cancelling the task settles its pending questions (and
  its children's) as cancelled; the model is told not to ask further
  questions and to wrap up.
- Every settlement lands as `QUESTION_ANSWERED` (`question_id`, question,
  outcome, answer, `option_index`, `timed_out`, `cancelled`), which the Web
  renders as a collapsed receipt in the chat transcript. A question asked by
  a subagent is mirrored onto the parent's event log, exactly
  like child approvals, so the card appears in the parent chat.

Surfaces: the Web shows a **question card** inline in the chat panel —
option buttons (number keys 1–4 work too), and the LAST affordance is always
"type your own answer", present even when the model supplied four options,
unless `allow_free_text=false`, in which case the card says so. While a
question is pending the task status reads `awaiting-answer`. The CLI prints
the same numbered block and reads one line from stdin: a bare number picks
that option, anything else is sent as free text, and the CLI never hangs on
a question the user walks away from — the broker timeout (or Ctrl-C /
Stop) settles it. In non-interactive contexts (CI, `--json`), the CLI does
not prompt; the question settles on its timeout.

The plan prompt contract is: explore the workspace read-only first, then ask
at most three questions where the workspace itself cannot disambiguate, then
write the plan files. Questions are for choices the user owns; facts come
from the tools.

## Plan documents

A finalized plan is files, written by the agent into the workspace:

- `.daedalus/plans/<task-slug>/plan.md` — always.
- `.daedalus/plans/<task-slug>/PRD.md` — additionally, when the task is
  product-oriented (a user-facing product or feature).

Plan mode's matrix denies mutations, so these writes are the **one explicit
carve-out**: the harness policy is call-aware (`toolCallPolicy` in
`modes.ts`) — the plan-write tools (`write_file`, `edit_file`,
`edit_search_replace`, `create_dir`) are allowed in plan mode **only** when
the target path is `.daedalus/plans` or under it. Absolute paths, `..`
traversal, and lookalike prefixes (`.daedalus/plansx`) are rejected, and
any other write — and every `run_command` — stays denied, with the denial
explaining the carve-out to the model. Tests prove both halves: a write to
`.daedalus/plans/**` succeeds in plan mode and a write anywhere else (or a
command) is refused.

The document contract (prompt-driven, from the template in the plan mode
prompt — not a runtime generator):

```markdown
# <Title>
## Goal
## Scope / Non-goals
## Decisions        ← one "question → answer" line per ask_user Q&A;
                       unanswered choices are marked "(assumed)"
## Steps            ← numbered; each step names its target files
## Acceptance criteria
```

PRD.md follows the same shape with the product goal up front. When a plan
run finishes, core scans the task's own file-change events for plan.md /
PRD.md under `.daedalus/plans/**` and the closing `PLAN_CREATED` carries
them as `documents: string[]`, so any surface can link or open the files.

### The plan-document guarantee

A plan-mode task that "succeeds" without ever writing a plan file is a
harness failure, not a model success — so core enforces that a document
exists before the task may complete:

1. **One repair turn.** When a plan task is about to finish and no
   `FILE_CHANGED` under `.daedalus/plans/**` named `plan.md`/`PRD.md`
   exists, the loop first spends exactly one harness repair turn
   (`RECOVERY_STARTED` with `reason: plan_document_missing`): the model is
   told to write the plan file now, with the template and the recorded
   Q&A decisions inlined. Never more than one such repair per task.
2. **Deterministic assembly.** If the repair turn still produced no
   document, the runtime assembles
   `.daedalus/plans/<task-slug>/plan.md` from the structured plan steps
   plus the recorded `QUESTION_ANSWERED` pairs (a `## Decisions` section;
   unanswered questions stay visible as assumptions), writes it through
   the normal file-change path (`FILE_CHANGED` +
   `PLAN_CREATED.documents`), and says so in the final report's evidence:
   the document is labeled *harness-assembled because the model did not
   write one* — never disguised as model output.
3. **Never overwritten.** A plan file the model wrote itself is left
   byte-for-byte alone; the guarantee only fills the gap. Non-plan modes
   are untouched.

## Chat conversations

The Web chat is one continuing session per workspace, not one isolated
task per prompt:

- **Storage.** A conversation (`id`, `created_at`, `turns[]`) lives as one
  JSON file under the workspace's Daedalus home
  (`.daedalus/conversations/<id>.json`, the TaskStore pattern), so it
  survives server restarts. Endpoints: `POST /conversations`,
  `GET /conversations/:id`, `GET /conversations?root=` (newest first).
- **Turns.** Creating a task with a `conversation_id` appends the user
  turn; a fast-path answer appends that reply; a finished task appends a
  short assistant summary ("Selesai. (goal)" + the first evidence lines).
  Tasks record the `conversation_id` on their spec/state, and picking
  such a task in the Web task list re-opens its conversation.
- **Memory.** The next prompt in the session is session-aware two ways:
  fast-path (conversational/question) calls receive the recent turns as
  history, and new tasks receive them as a bounded *prior conversation*
  constraint (the same carriage as plan-task steps). Bounds: the last
  ~12 turns, each turn clipped, ~6K characters total. A fresh conversation
  injects nothing — first prompts behave exactly as before.
- **Web UI.** The chat panel renders the whole session in order (the live
  task's event segment expanded in place; finished turns as prompt +
  summary), **new chat** starts a fresh conversation, and the active id
  is kept in `localStorage` so a reload restores the latest session.
- **CLI.** The interactive CLI keeps the same idea in memory: chat replies
  see the session history and tasks run with it as prior context. It is
  session-local only — the persisted, restart-proof conversation file is
  a Web/server feature (see *Honest limits*).

## Approve & Execute

When a plan task finishes (done or partial) with plan documents, the Web
chat shows an **Approve & Execute** bar naming the plan file, with one
button: **Execute with Auto**. Clicking it
creates the follow-up task through the existing plan-continuity
machinery: `plan_task_id` set to the plan task (core injects the plan's
steps), mode Auto, and a goal of the form "Execute the approved plan
in .daedalus/plans/<slug>/plan.md" — and the composer's mode follows.
The executing task may itself delegate with `spawn_subagent`. In the CLI
there is no equivalent button yet: run the follow-up
as a new Auto goal naming the plan file (Web-only for now; see
*Honest limits*).

## Subagents (`spawn_subagent`)

Delegation is a **tool the model invokes**, not a mode the user picks —
the shape Claude Code's Agent tool takes. The Orchestrator MODE is
retired: it is no longer offered in the Web composer (or its Shift+Tab
cycle), the CLI's `--mode` choices, or the server's selectable modes.
Persisted tasks, settings, and sessions that still name `orchestrator`
are **mapped to Auto** wherever a mode is read (runtime, server, CLI), so
old records load and run — with `spawn_subagent` available — instead of
crashing. Legacy event logs (including `ORCHESTRATION_SKIPPED`) still
render. *Approve & Execute* offers Auto only; a plan execution may itself
delegate.

### The tool contract

`spawn_subagent` takes `{ description, goal, background? }`:

- `description` — a short label; it names the child in the Child Tasks
  panel and in events.
- `goal` — the **complete, self-contained brief**. The child starts with
  a fresh context and cannot see the parent's conversation; everything
  it needs must be in this string.
- `background` (default `false`) — run the child alongside the parent
  instead of blocking on it.

The tool is classified **mutating**: visible and free in Auto; in Manual
the spawn call itself asks for approval once (the delegation decision),
and the child's own mutations still ask individually, mirrored to the
parent exactly as child approvals always have. In Ask and Plan the tool
is denied outright (read-only modes; the plan-document carve-out is
unaffected). The Auto prompt carries a one-line pointer; the tool's own
description teaches the full contract: delegate hard, independent, or
long work; do small or tightly sequential work yourself, because every
delegation pays for a fresh context.

### Foreground, parallel, background

- **Foreground** (default): the call blocks until the child finishes and
  returns exactly one distilled result (below) as the tool result.
- **Parallel**: several `spawn_subagent` calls in one model response run
  **concurrently, capped at 3** (further calls in the same response wait
  their turn). The contract forbids parallel children editing the same
  files — they share one workspace, and keeping writers apart is the
  model's responsibility, backed by the usual approval gates.
- **Background** (`background: true`): the call returns immediately with
  the child task id. When the child finishes, its result is injected
  into the parent's next model turn as a `[background subagent finished]`
  notice (a plain user-role message appended to that turn's request).
  The parent task **only finishes after its background children have
  settled** — their results also join the final report's evidence — and
  Stop cancels running background children with the task. The wait is
  bounded by the children's own budgets and the approval/question
  timeouts; a background child never outlives its task.

Children appear in the existing Child Tasks panel with live status
(`CHILD_TASK_STARTED`/`CHILD_TASK_FINISHED` events, label first) — there
is no separate subagent UI.

### Budgets: one pool, exact accounting

Parent and children share the task's iteration pool (the task's
`max_iterations`). The pool is debited by the parent's own model turns
**and** by each child's actual iterations, reserved up front so parallel
spawns can never oversubscribe it: each spawn is granted a slice (a
floor of 8 turns, otherwise an even share of what remains, never more
than remains), the reservation settles to actual usage when the child
finishes, and a spawn that finds the pool spent is **refused with an
explanation** (the model then does the work itself or reports partial
progress) — never silently queued. A child that burns its slice fails
with the typed reason `budget_exceeded` and the parent continues;
exhaustion is a per-child outcome, not a run failure.

### Inheritance and the nesting stop

Modes have a strictness order — `auto` (1) < `manual` (2) < `plan`/`ask`
(3) — and a child's effective mode is the **stricter** of the parent's
mode and the delegation default (`restrictMode`): **children tighten,
never loosen**. A spawned child of a Manual parent still asks before its
own writes. Child budgets return **typed errors** to the parent —
`budget_exceeded`, `child_failed`, `cancelled` — never silent success.

Children **cannot delegate further** (depth 1, hard stop): a child run
is built without the `spawn_subagent` tool at all, so there is nothing
to gate — a hallucinated call is denied as an unknown tool.

### Distilled returns and diff visibility

What comes back to the parent is a **distilled summary**: an outcome
line, the changed files with line counts, and at most a few evidence
lines, hard-capped at 1,500 characters — never the raw text of the
child's last tool call (a child ending on a big file read once injected
the whole file as its "summary"). The full detail stays in the child's
own task log. A child's file changes are mirrored onto the parent's
event log (tagged with both task ids), so the parent's Files-changed
and Diff panels aggregate all descendants live; the child's own view
still reads the child's log, so nothing double-counts. Findings travel
the way the old fan-out handed them over, but model-mediated now: the
parent sees each child's distilled result and writes the next brief
itself.

## Token accounting

Every model response's provider usage (`prompt_tokens` /
`completion_tokens` / `total_tokens` on OpenAI-compatible APIs) rides
the `MODEL_REQUEST_FINISHED` event. Core accumulates it over the run's
whole lineage — the parent's turns **plus** every subagent's, each child
also carrying its own roll-up on its record — and the final report
carries `model_requests` (always) plus `tokens_input`, `tokens_output`,
`tokens_total`, and `token_requests_reported` **only when at least one
request actually reported usage** (nothing is estimated or fabricated).
The Web chat panel shows the running totals as one subtle monospace
line — `tokens 12,483 in · 3,102 out · 15,585 total · 9 requests` —
updated live from the same events, and the finished report view shows
the same numbers from the persisted report. Providers that return no
usage block yield a line with just the honest request count.

## Honest limits

- Remembered approvals live in server memory only; nothing is written to
  disk, and a server restart clears them by design.
- The plan flow is continuity, not a pipeline: there is no separate
  plan-approval state machine, and executing a plan is a new task that
  carries the plan steps as a constraint.
- Plan documents are prompt-driven. The section structure (Goal / Scope /
  Decisions / Steps / Acceptance criteria) comes from the template in the
  plan mode prompt; core does not parse or repair a plan.md the model wrote
  differently — it only verifies *where* plan writes may land, reports
  which plan documents exist, and (per *The plan-document guarantee*)
  assembles one deterministically when the model wrote none.
- Conversations are a Web-first feature. The server persists them per
  workspace and feeds bounded history/prior-context back into prompts;
  the CLI keeps equivalent memory only in memory for its session (lost on
  exit, no conversation files), and one-shot CLI runs are unchanged.
- A question nobody answers is not an error and not an approval: after the
  timeout the agent proceeds on assumptions it must state (marked
  `(assumed)`), which the user can correct in a follow-up.
- Approve & Execute is Web-only for now. The CLI answers questions with
  full parity, but executing a plan there is a manual new goal naming the
  plan file.
- Edited commands are re-split on whitespace: quoting inside an edited
  command line is not preserved (the original model-produced call keeps its
  exact argv).
- Approval previews are built best-effort; if a diff cannot be produced, the
  card falls back to the raw arguments rather than blocking the decision.
- Read-only modes deny `run_command` entirely; read-only discovery is done
  with the read tools (`list_dir`, `read_file`, search), not the shell.
- Parallel subagents share one workspace: the no-same-file rule for
  concurrent children is a contract the model is taught, enforced only
  by approvals and the diff view after the fact — there is no file
  locking between children. Per-child worktree isolation would lift
  this; today it exists for whole tasks, not for spawns.
- A background child's result reaches the parent at the next turn
  boundary (as a notice in that turn's request), never mid-turn; if the
  parent finishes first, the task end waits for the child instead of
  surfacing the result anywhere else.
- Token totals are only as real as the provider's usage block: routers
  that strip `usage` produce request counts without token numbers, and
  the UI says so rather than estimating.

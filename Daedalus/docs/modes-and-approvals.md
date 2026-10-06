# Modes and approvals

Daedalus has five agent modes. They are not prompt labels: each mode is a row
in one permission matrix in core (`MODE_PERMISSION_MATRIX` in
`core/src/interaction/modes.ts`), enforced at tool-call time by the execution
harness, so even a misbehaving model cannot mutate the workspace in a
read-only mode. The same matrix drives the CLI and the Web because both talk
to the same `@daedalus/core`.

## The mode × permission matrix

Tool calls fall into three classes: **read** (`read_file`, `list_dir`, search,
diagnostics…), **mutating** (file writes/edits, `create_dir`, MCP tools), and
**executing** (`run_command`).

| Mode          | Read  | Mutating | Executing (`run_command`)          |
|---------------|-------|----------|------------------------------------|
| ask           | allow | deny     | deny                               |
| plan          | allow | deny     | deny                               |
| manual        | allow | ask      | ask                                |
| auto          | allow | allow    | ask → allow while auto-approve on  |
| orchestrator  | allow | allow    | ask → allow while auto-approve on  |

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
  the producing `mode` in the payload, and the model's final reply is a
  numbered plan whose steps name concrete files. Switching to Auto/Manual and
  sending "jalankan rencananya" executes it **in context** (Cline-style
  continuity, not a fresh-context handoff): the follow-up task carries
  `plan_task_id`, and core injects the stored plan steps as a constraint.
  There is no modal plan-approval pipeline; see *Honest limits*.

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

An orchestrator's children surface their approval requests on the **parent's**
event log (mirrored events carry the child's identity), so the card in the
parent chat names the requesting child task. The CLI's terminal prompt
(`a` approve / `d` deny / `r` remember, decided through the same core broker)
shows the same preview text.

## Orchestrator tightening rule

Modes have a strictness order — `orchestrator` (0) < `auto` (1) < `manual`
(2) < `plan`/`ask` (3) — and a child's effective mode is the **stricter** of
what it requested and its parent's mode (`restrictMode`): **children tighten,
never loosen**. A child asked to run `manual` under an `auto` parent stays
manual; a child can never end up looser than its parent. Child approval
policies are inherited through the same rule, and child budgets (max
iterations/errors) return **typed errors** to the parent —
`budget_exceeded`, `no_progress`, `child_failed`, `cancelled` — never silent
success.

## Honest limits

- Remembered approvals live in server memory only; nothing is written to
  disk, and a server restart clears them by design.
- The plan flow is continuity, not a pipeline: there is no separate
  plan-approval state machine, and executing a plan is a new task that
  carries the plan steps as a constraint.
- Interactive plan clarification (the agent asking multiple-choice questions
  before writing the plan) is **not** implemented here; plan mode writes its
  plan from its own exploration today.
- Edited commands are re-split on whitespace: quoting inside an edited
  command line is not preserved (the original model-produced call keeps its
  exact argv).
- Approval previews are built best-effort; if a diff cannot be produced, the
  card falls back to the raw arguments rather than blocking the decision.
- Read-only modes deny `run_command` entirely; read-only discovery is done
  with the read tools (`list_dir`, `read_file`, search), not the shell.

# Web IDE, shared local core, thinking, and monitoring

Daedalus has one local core and two thin interfaces. The CLI and the Web UI do
not keep separate project copies: when both are pointed at the same workspace
folder, they operate on that folder's files and on the same local Daedalus
store.

## Shared local core and workspace

For a workspace `<workspace>`, the default local store is:

```text
<workspace>/.daedalus/
  tasks/<task-id>/events.jsonl
  tasks/<task-id>/state.json
  tasks/<task-id>/report.json
  providers.json
  daemon.json
```

`DAEDALUS_HOME` is still the explicit override:

- an absolute `DAEDALUS_HOME` wins;
- a relative `DAEDALUS_HOME`, including the default `.daedalus`, is resolved
  against the selected workspace.

That rule is shared by `daedalus run --cwd <workspace>`, `daedalus chat --cwd
<workspace>`, and the background/Web server for that workspace. It is a shared
working directory ("worktree-style" in the sense of one working tree), not a
git-worktree manager: Daedalus does not create a branch or checkout per task.

The workflow Farid asked for is therefore:

1. Start the background server/launcher from the project folder, or select that
   same folder in the Web workspace picker.
2. Code with the CLI in that folder.
3. Open the Web UI, pick the same workspace, and choose the CLI task from the
   task picker. The gateway reads the task's append-only event log, state, and
   report from the shared store.
4. Edit the same files in the Web IDE, or submit a new prompt from the Web
   composer. Both write into the same folder; there is no export/import step.

The Web task picker refreshes the server task list. While a selected task is
running, the Web polls its snapshot about every two seconds so CLI-origin
events and in-progress state appear even though the CLI and server are
different processes. The server's event stream is still used for tasks running
in the server process.

Relevant gateway routes:

- `GET /tasks` — task summaries from the primary store plus each allowed
  workspace's local store, including status/outcome, mode, thinking,
  created/updated timestamps, event count, and whether the task is running.
- `GET /tasks/:id` — state, replayed events, report, and running flag.
- `GET /tasks/:id/events` — replayed events from `events.jsonl`.
- `GET /workspace/tree`, `GET /workspace/file`, `PUT /workspace/file` — the
  shared folder's tree, file reads, and IDE saves.

## Thinking mode

Session setting: `thinking` (boolean, default **on**). Set it with:

- CLI chat: `/settings thinking on|off`, or `daedalus chat --no-thinking`;
- CLI non-interactive run: `daedalus run --no-thinking ...`;
- Web: the composer's **THINKING** checkbox or `/settings thinking on|off`;
- environment: `DAEDALUS_THINKING=off`.

When it is on, the agent loop emits a `THOUGHT` event only when the provider
actually returned reasoning/thinking text (for example an OpenAI-compatible
`reasoning_content` field), or short assistant text accompanying tool calls.
Long text is truncated in the event payload. Daedalus does not fabricate a
thought for a turn that has none.

The CLI renders thoughts as dimmed `thinking · ...` transcript lines. The Web
activity timeline renders `THOUGHT` entries distinctly when thinking is on and
filters them when it is off. The event stays in the local log either way, so
turning the display off does not rewrite history.

## Web prompts are first-class

The Web composer is not only a monitor. Submitting a prompt calls
`POST /tasks`, which creates the task in the same shared local store and runs
it through the same `@daedalus/core` TaskRunner used by the CLI — same modes,
approval policy, thinking setting, provider/model selection, attachments, and
workspace `.daedalus` extension configuration. Events stream into the Web
timeline for server-run tasks; the final state and report are persisted next
to CLI tasks.

## MCP, Skills, and LSP in the Web

The gateway exposes the workspace extension status:

```text
GET /extensions/status?root=<workspace>
```

Response:

```json
{
  "root": "/path/to/workspace",
  "mcp": [{ "name": "demo", "connected": true, "toolCount": 3 }],
  "skills": [{ "name": "greeter", "description": "Greets users warmly" }],
  "lsp": [{ "name": "fake-lsp", "extensions": [".ts"], "configured": true }],
  "problems": []
}
```

It reads `<workspace>/.daedalus/mcp.json`,
`<workspace>/.daedalus/skills/<name>/SKILL.md`, and
`<workspace>/.daedalus/lsp.json`. For MCP it performs a real short-lived stdio
connection attempt (about two seconds), snapshots the result, and closes the
servers, so a broken MCP server is reported honestly as offline instead of
hanging the gateway. Results are cached for a few seconds.

In the Web this powers:

- the **Extensions** panel, refreshed when the workspace changes;
- `/mcp`, `/skills`, and `/lsp` in the composer, which print the same real
  status instead of "unavailable in this context".

Language servers are reported as configured by this endpoint; they are still
started lazily by the core when an agent calls `lsp_diagnostics` during a run.
See `docs/mcp-skills-lsp.md` for the configuration formats and honest limits
(MCP is stdio-only, LSP is diagnostics-only).

## Web IDE editing

Opening a file from the workspace tree or the **Files Changed** panel loads it
from the shared workspace into Monaco. The editor is editable:

- typing marks the file with a `● modified` dirty indicator;
- **Save** or Ctrl+S writes through `PUT /workspace/file` into the same folder
  the CLI uses;
- a successful save clears the dirty marker and refreshes the workspace tree;
- a failed save shows the error and keeps the draft dirty — it never pretends
  to have saved;
- if the file changes on disk (for example the agent rewrites it) while there
  are unsaved edits, the editor shows a "changed on disk" banner and keeps the
  user's draft until they choose **reload disk version** or **keep mine**.

Image files (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`, `.ico`)
never open in the text editor: the gateway returns them as a base64 data URL and
the pane shows a read-only picture preview with the file name, byte size, and —
once loaded — pixel dimensions. There is no Save button for images, so binary
content cannot be corrupted by a text round-trip. Image reads allow up to 10 MB
(the text cap stays 512 KB).

## Limitations

- Cross-process monitoring is polling-based (about two seconds for the
  selected task), not a cross-process push stream.
- The gateway remains a local tool: it has no general authentication layer,
  and workspace access is confined to allowed local roots.
- The extension status endpoint does not keep MCP servers connected between
  requests, and it does not start language servers just to display status.
- A desktop tray icon is still a host capability; headless environments should
  use `daedalus status` and `daedalus stop`.

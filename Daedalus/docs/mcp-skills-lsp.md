# MCP, Skills, and LSP in Daedalus

The CLI sidebar sections **LSPs**, **MCPs**, and **Skills** are backed by three
real extension systems in `@daedalus/core`. Nothing is displayed unless it was
actually found on disk or actually connected: when nothing is configured the
sidebar keeps the honest `None (not configured)` placeholder, and `/mcp`,
`/skills`, `/lsp` (shared slash commands, available in CLI and Web) print the
same live state.

All three systems are configured per workspace under `.daedalus/` and are
picked up automatically by `daedalus run` and `daedalus chat`. Programmatic
hosts can inject equivalents through `TaskRunnerOptions`
(`mcpServers`, `lspServers`, `skillDirs`), which take precedence over the
files. A broken extension never fails a task: it is recorded in
`TaskRunner.extensionStatus` and surfaced in the UI.

## MCP (core/src/mcp)

Daedalus acts as an MCP client over stdio (JSON-RPC 2.0,
newline-delimited, protocol version `2024-11-05`). The client is hand-rolled
from the public Model Context Protocol spec — no MCP SDK is bundled.

`.daedalus/mcp.json`:

```json
{
  "servers": [
    { "name": "demo", "command": "node", "args": ["mcp-server.mjs"], "env": {}, "timeoutMs": 10000 }
  ]
}
```

- On run start, every server is spawned and initialized in parallel; a server
  that fails to start is marked offline with its error and contributes no
  tools.
- Each remote tool is bridged into the agent as `mcp__<server>__<tool>`
  (name segments sanitized to `[a-zA-Z0-9_-]`), with the server's JSON schema
  passed through. MCP tools are classified **mutating**, so they follow the
  same approval policy as write tools; `isError` results come back as error
  tool results.
- Requests time out (default 10s, per-server `timeoutMs`), server noise and
  crashes are converted to status/error text, and all processes are closed
  when the run ends.

## Skills (core/src/skills)

A skill is a playbook folder: `.daedalus/skills/<name>/SKILL.md` with a
minimal YAML frontmatter block followed by Markdown instructions:

```markdown
---
name: greeter
description: Greets users warmly
---
Always greet with "Halo" first.
```

Extra directories can be added with `TaskRunnerOptions.skillDirs`. Loaded
skills are:

- advertised in the agent context (name + description) so the model knows
  they exist;
- loadable in full through the read-only `read_skill` tool;
- listed in the CLI sidebar and by `/skills`.

Only skills really found on disk are listed — there is no built-in catalog.

## LSP (core/src/lsp)

A minimal stdio LSP client (Content-Length framed JSON-RPC, per the public
Language Server Protocol spec) provides diagnostics. Hover is not
implemented.

`.daedalus/lsp.json`:

```json
{
  "servers": [
    { "name": "typescript", "command": "typescript-language-server", "args": ["--stdio"], "extensions": [".ts", ".tsx"] }
  ]
}
```

- Servers start lazily on the first diagnostics request for a matching
  extension and stay up until the run ends.
- The read-only `lsp_diagnostics` tool takes a workspace-relative `path`,
  opens the document, briefly waits for `textDocument/publishDiagnostics`,
  and returns one `file:line:col severity: message` line per diagnostic, or
  `no diagnostics`. Files whose extension has no configured server, and
  servers that fail to start, produce honest explanatory results instead of
  crashing the run.
- The sidebar shows configured servers; after a run it shows which are
  actually running (or the startup error).
- **Diagnostics ride along on edits**: after `write_file`, `edit_file`,
  `edit_search_replace`, or `create_dir` completes, the edit guard asks the
  configured server (when one covers the file's extension) for fresh
  diagnostics and appends them to the tool result — at most 20 lines, then
  a `+N more diagnostics` rollup — so a type error is repaired in the same
  turn instead of surfacing at validation time. The wait is bounded (2s),
  a slow or broken server appends nothing, and a clean file appends
  nothing. This rides the same `.daedalus/lsp.json` enablement and the
  `editGuard` setting (`DAEDALUS_EDIT_GUARD`); it is the second surface of
  the machinery above, not a second LSP client.

## Built-in web and vision reads (core/src/tools)

Two read-only tools work in every mode, Ask included:

- **`fetch_url`** — fetch a public http/https page (official install/API
  docs) and return its readable text: HTML is stripped (scripts/styles
  dropped, entities decoded), plain text/markdown passes through, and the
  result is capped at 12,000 chars with a truncation note. Redirects are
  followed at most 3 times, and every target — initial and redirected —
  is refused when it is a literal private/loopback/link-local address
  (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`,
  `localhost`). Requests time out after 15s. There is **no search engine**
  behind it (no API key): the model supplies the exact docs URL from its
  own knowledge, and a failed fetch falls back to probing the tool with
  `--help` — the scaffold playbook states this order explicitly. Pages
  that are mostly JavaScript may yield little text, and DNS results are
  not inspected (a public name resolving to a private address is outside
  the implemented guard layer).
- **`view_image`** — look at a workspace image (png/jpg/gif/webp by magic
  bytes, up to 5 MB). The picture is attached to the next model request as
  an `image_url` content block — the same carriage user uploads take —
  while the tool result itself stays a one-line placeholder, so event
  logs and CLI/Web transcripts never carry base64. When the selected
  model does not support vision (provider registry flags), the tool
  refuses with `current model cannot view images` instead of silently
  dropping the picture.
- **`search_images`** — search Openverse and Wikimedia Commons for
  openly-licensed images (both anonymous, **no API key**) and return
  structured metadata only — title, source page, image/thumbnail URLs,
  dimensions, license name + URL, author, attribution text, commercial-use
  flag — never base64. Results with an unknown license are excluded unless
  `include_unknown_license` is set; `commercial_only` drops NC/unknown
  licenses; CC0/public-domain results rank first. Wikimedia requires a
  descriptive User-Agent (sent as `Daedalus/1.0 …`); Commons covers named
  people/places that stock catalogues miss. An empty result is a normal
  outcome (`count: 0`), a dead source degrades to the surviving one, and a
  429 from either anonymous API is reported as rate limiting rather than
  retried into the ground.
- **`download_file`** — download one image (png/jpg/gif/webp, 10 MB cap
  enforced mid-stream) from a public URL to a workspace-relative path:
  private/loopback/link-local targets and redirect targets are refused
  (same guard as `fetch_url`, 5 redirects max and reported), an existing
  destination is refused rather than overwritten, magic bytes +
  Content-Type + destination extension must agree (an HTML error page or a
  `.jpg` name over PNG bytes is refused), and the write is atomic
  (temp file + rename). Passing `license`/`author`/`source_url` from a
  `search_images` result writes a `<file>.attribution.txt` sidecar; without
  them the result states that attribution was not recorded. It is a
  mutating tool: hidden in Ask/Plan (the plan-documents carve-out does not
  cover it), approval-gated in Manual, free in Auto — and because it writes
  through the same `meta.mutating` bookkeeping, a downloaded asset counts
  as completion-gate evidence like a `write_file`. The contract in both
  tools: search → download → `view_image` to confirm the picture matches
  before using it in a page; never hotlink a search result into a page,
  and never substitute a generated image for a real named person's photo.

## Background jobs (core/src/tools/terminal)

Long work no longer has to block the agent loop on one foreground call:

- **`run_command` `background: true`** — the same sandbox shell tool with
  one extra argument: the process starts and the call returns a job
  handle (`job-1`, command, cwd) immediately instead of waiting.
  Allowlist, cwd confinement inside the workspace, shell-metacharacter
  rules, and the execution classification are unchanged — the approval
  in Manual happens once, at the start. Output keeps streaming as
  `COMMAND_OUTPUT` events tagged with the job id, so the agent terminal
  and Web command view mirror it exactly like a foreground command.
- **`command_status`** — poll one job: state
  (`running`/`exited`/`failed`/`killed`), exit code, and a bounded tail
  of recent output (default 1,000 chars, max 4,000; the playbook etiquette
  is "poll between other work, never in a tight loop"). Read-only, so it
  is available in every mode a job can exist.
- **`command_kill`** — terminate a job's whole process group (not a
  shell `&` orphan). Classified with execution: denied in Ask/Plan,
  approval-gated in Manual, free in Auto; killing a finished job reports
  its state rather than erroring.

Bounds: at most 3 concurrent background jobs per task (a fourth start is
refused with a typed `job_limit` reason); jobs are owned by their task —
**task end and Stop kill whatever is still running**, and starting
without a task runtime fails honestly (`jobs_unavailable`).
`JOB_STARTED` / `JOB_FINISHED` events carry the lifecycle to the CLI and
Web. Jobs are in-memory: they die with the server process, and after an
ungraceful server kill a detached child can survive — observed in tests,
documented in `docs/scaffolding.md`.

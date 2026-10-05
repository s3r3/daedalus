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

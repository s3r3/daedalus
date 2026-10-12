# Interactive terminal (Web)

The Web terminal is a tab strip over **server-side terminal sessions**.
Sessions live in the Daedalus server (`server/src/terminals.ts`), so they
survive a Web page reload. They die when the server process stops — there
is no persistence across a server restart, and shutdown kills every user
process (SIGTERM, then SIGKILL after a grace period).

## Session model

| | user session | agent session |
|---|---|---|
| tab badge | (none) | `agent` |
| processes | your shell (`$SHELL` \|\| `bash`), one per tab | none — a display sink |
| input | you only | refused (`403`) |
| signals | you only (Ctrl+C button → `SIGINT`) | refused (`403`) |
| close | `×` kills the process and forgets the session | cannot be closed |
| timeout | **none** — `npm run dev` runs until you stop it | n/a |

- **User sessions** are created with the `+` button (or restarted from an
  exited tab). Each is an independent shell rooted at the workspace. One
  session never touches another: starting, using, or closing a tab leaves
  your dev server alone.
- **Agent session**: exactly one per workspace root, created lazily and
  reused across tasks. The harness keeps running commands exactly as
  before (same mode gates, approvals, and timeouts); the server merely
  *taps* the existing `COMMAND_STARTED` / `COMMAND_OUTPUT` /
  `COMMAND_FINISHED` events into this sink, rendering `$ <cmd>`, the
  streamed output, and an `[exit N]` marker — the same transcript the tab
  shows today, kept in a replayable buffer.

## The agent cannot touch your sessions

The agent drives commands through the execution harness, never through
terminal sessions. `POST /terminals/:id/input`, `…/signal`, and `DELETE`
reject agent sessions with `403`, and user sessions are reachable only
from the Web UI's own HTTP calls — no agent tool addresses them. If the
agent tries to run a dev server itself, the harness's existing
`run_command` timeout still applies to it: only *your* sessions are
unbounded.

## Pipe mode (no PTY)

Sessions use `node:child_process` pipes, not a pseudo-terminal. That
keeps the server dependency-free (no native `node-pty`) and is enough
for line-based commands and dev servers (`npm run dev`, `sleep`,
test watchers, `tail -f`). Honest limits:

- interactive full-screen TUIs (`vim`, `top`, `less`) will not behave —
  there is no real terminal driving them;
- no window size / SIGWINCH, no raw mode: input is line-oriented via the
  input box (Enter sends the line), with ↑/↓ per-session history and a
  Ctrl+C button;
- colors are nudged with `TERM=xterm-256color` and `FORCE_COLOR=1`, but
  programs that require a TTY may still refuse color or progress UIs.

## Output buffer

Each session keeps a rolling buffer in server memory (≈200 KB,
drop-oldest with a `…[earlier terminal output truncated]` marker).
Opening or switching to a tab replays the buffer over the existing
`/tasks/events` WebSocket (`terminal_subscribe` →
`terminal_output { replay: true }`), so history is there after a reload
or a reconnect. Buffers are per-server-process and are gone on restart.

# Daedalus

A Web-Based Agentic Coding Framework Powered by Large Language Models.

Daedalus is a TypeScript/Node.js research framework for autonomous software-engineering tasks. A user gives a coding task; Daedalus interprets it, plans, inspects the workspace, calls tools, validates with build/test/lint commands, recovers within bounded limits, and reports from a replayable event log. The CLI and Web UI are thin interfaces over the same `@daedalus/core`.

> Current documentation status (2026-10-05): the implementation includes the Phase 8.5 product surface and Phase 9 integration tests. The Phase 10 evaluation harness and a 12-task deterministic dataset exist, but the **live** 12-task evaluation has not been completed because the configured 9Router endpoint was unreachable (Cloudflare HTTP 530 / Error 1033 when checked). Deterministic results validate the harness only; they are not live model performance.

## Quickstart

Prerequisites: Node.js 22+ and npm.

```bash
cd Daedalus
npm install

# Build/typecheck all packages, verify the shared-core/scope rules, and run tests.
bash scripts/check.sh
```

Configure a provider by exporting environment variables in the shell that starts Daedalus. The current entry points read process environment; copying `.env.example` to `.env` documents the names, but `.env` is not loaded automatically.

```bash
export LLM_BASE_URL="https://llm.ayid.cc.cd/v1"   # or another OpenAI-compatible /v1 endpoint
export LLM_API_KEY="<set locally; never commit it>"
export LLM_MODEL="<model-id>"
export DAEDALUS_HOST="127.0.0.1"
export DAEDALUS_PORT="3080"
export DAEDALUS_HOME=".daedalus"
```

Start the development servers:

```bash
bash scripts/dev.sh
# Server health: http://127.0.0.1:3080/health
# Vite Web UI:   http://127.0.0.1:5173 (proxies API/WS to 127.0.0.1:3080)
```

Or use the CLI from source:

```bash
# Bare launcher: starts/reuses one background server, then offers Daedalus Coding / Daedalus Slide / Hide to Tray / Exit.
node --experimental-strip-types cli/src/index.ts

# Lifecycle commands
node --experimental-strip-types cli/src/index.ts serve --daemon
node --experimental-strip-types cli/src/index.ts status
node --experimental-strip-types cli/src/index.ts stop

# One-shot runs (the interactive terminal chat was removed on 2026-10-08;
# the Web UI is the interactive surface — the harness itself is unchanged)
node --experimental-strip-types cli/src/index.ts run "Add input validation" --cwd /path/to/workspace
node --experimental-strip-types cli/src/index.ts run "Fix the failing test" --cwd /path/to/workspace --json
node --experimental-strip-types cli/src/index.ts health
```

When `daedalus-web/dist` has been built, the Node server also serves the Web UI from `/` and reserves the named API routes for JSON/WebSocket traffic. In development, use the Vite server on port 5173.

## Using Daedalus

### Agent modes

Modes are defined once in core and carried by every surface: the Web composer cycles them with **Shift+Tab** at the next turn boundary, and `daedalus run --mode <mode>` selects one for a one-shot run:

| Mode | Behaviour |
|---|---|
| `ask` | Read-only workspace question answering; no mutations and no commands. |
| `manual` | Tools are visible, but every mutating/executing call requires approval. |
| `auto` | Full plan → act → observe → validate → recover loop under the session approval policy. |
| `plan` | Read-only exploration and plan drafting/editing; no execution. |
| `orchestrator` | Decomposes work into recorded child tasks with per-child and total budgets; sequential by default. |

### Slash commands

Typing `/` opens the shared command palette in the Web composer. Available commands:

`/help`, `/mode`, `/models`, `/providers`, `/settings`, `/auto-approve`, `/plan`, `/workspace`, `/files`, `/upload`, `/image`, `/diff`, `/validate`, `/new`, `/clear`, `/status`, `/cancel`, `/exit`.

### Providers and settings

Providers are OpenAI-compatible endpoints stored through the core provider registry. The server persists them in `<DAEDALUS_HOME>/providers.json`; public API/Web views mask API keys. Presets include Farid's 9Router (`https://llm.ayid.cc.cd/v1`), OpenAI, OpenRouter, Groq, DeepSeek, and a custom endpoint. **Test connection** performs a real `GET /models` request against the selected endpoint. A task can use a saved provider with `run --provider-id <id> --model <model>`; `/models` and the Web picker show models from enabled providers.

Important configuration variables:

| Variable | Meaning |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible base URL; defaults to `https://llm.ayid.cc.cd/v1`. |
| `LLM_API_KEY` | Provider credential from the process environment. Keep it out of git. |
| `LLM_MODEL` | Default model id. |
| `LLM_TIMEOUT_MS` | Optional per-request model timeout in milliseconds. |
| `DAEDALUS_HOST`, `DAEDALUS_PORT` | Server bind address; defaults `127.0.0.1:3080`. |
| `DAEDALUS_HOME` | Persistence root for task state/event logs, daemon state, and provider registry; defaults `.daedalus`. |
| `DAEDALUS_CMD_ALLOWLIST` | Optional comma-separated override for the `run_command` executable allowlist. |

See [`.env.example`](.env.example) for a non-secret template.

## Tool reference

The default core registry exposes exactly 10 tools. Mode policy can hide tools, and the approval gate can still deny a visible call.

| Tool | Mutating | Purpose |
|---|---:|---|
| `read_file` | No | Read a UTF-8 workspace file, optionally by line range. |
| `list_dir` | No | List direct children of a workspace directory. |
| `grep` | No | Regex-search UTF-8 workspace files (max 100 matches). |
| `glob` | No | Find workspace files matching a glob (max 100 matches). |
| `git_status` | No | Show workspace `git status --porcelain`. |
| `git_diff` | No | Show workspace git diff/stat. |
| `write_file` | Yes | Create/overwrite a UTF-8 file; parent directories are created. |
| `edit_file` | Yes | Replace one unique exact string in a file. |
| `create_dir` | Yes | Create a directory and missing parents inside the workspace. |
| `run_command` | Executing | Run an allowlisted process with timeout, cancellation, output caps, and process-group cleanup. |

## Evaluation

The evaluation suite contains 12 small fixture tasks: 4 bug fixes, 4 feature additions, and 4 refactors.

```bash
# Validate the suite.
node --experimental-strip-types evaluation/runners/run-evaluation.ts --validate-suite

# Deterministic harness validation only (scripted provider; not live LLM performance).
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --output evaluation/reports/deterministic-full

# Aggregate a generated dataset.
node --experimental-strip-types evaluation/runners/aggregate.ts \
  --input evaluation/reports/deterministic-full \
  --output evaluation/reports/aggregate-deterministic
```

Live mode is run only when a provider endpoint is reachable; see [docs/evaluation.md](docs/evaluation.md) for the experimental design, metrics, threats to validity, and the current live-run blocker.

## Documentation

- [Architecture](docs/architecture.md)
- [ADR index](docs/decisions/README.md)
- [Evaluation](docs/evaluation.md)
- [Demo scenarios and thesis screenshot checklist](docs/demo-scenarios.md)
- [Limitations and future work](docs/limitations-and-future-work.md)
- [Third-party provenance](docs/THIRD_PARTY.md)

## Repository structure

- `core/`: `@daedalus/core` — contracts, agent loop, tools, execution/validation/recovery, events, modes, providers, attachments, orchestrator, themes.
- `cli/`: the `daedalus` command, launcher/daemon lifecycle, tray capability layer, and interactive terminal UI.
- `server/`: Node HTTP/WebSocket gateway, workspace/upload APIs, provider/settings APIs, and static Web serving.
- `daedalus-web/`: React + Vite Web UI.
- `evaluation/`: task suite, runner, aggregator, and generated report datasets.
- `docs/`: architecture, ADRs, research notes, evaluation notes, and provenance.
- `scripts/`: `check.sh` and `dev.sh`.

## Troubleshooting

- **`MODEL_REQUEST_FAILED`, HTTP 530, or Error 1033 from `llm.ayid.cc.cd`**: the Cloudflare Tunnel to the laptop-hosted 9Router is unreachable. Start the laptop/9Router/cloudflared side, then retry **Test connection** or `GET /models`. Do not treat deterministic evaluation output as a substitute for a live run.
- **No tray in this environment**: headless shells and builds without a native tray backend report this honestly. Use `daedalus status` and `daedalus stop`; on a desktop, tray support remains a manual verification item.
- **`LLM_MODEL is required`**: export `LLM_MODEL` or choose a model/provider in Settings or with `run --model` / `--provider-id`.
- **Server port already in use**: reuse the running daemon with `daedalus status`, stop it with `daedalus stop`, or choose another `DAEDALUS_PORT`.
- **Workspace path rejected**: tasks and workspace APIs are confined to allowed workspace roots and relative paths; `..`, absolute upload paths, and oversized uploads are rejected.
- **`.env` security warning**: `Daedalus/.env` is tracked in this repository's git history. Do not copy a real key into docs, issues, logs, or screenshots. Rotating the exposed key and removing it from tracking/history is an owner decision that has not been performed by the documentation work.

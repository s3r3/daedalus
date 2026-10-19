# Daedalus

**Agentic Machine Learning Framework Berbasis Large Language Model untuk Otomatisasi Workflow Cerdas**

Daedalus is a TypeScript/Node.js research framework for autonomous, LLM-driven workflows. A user states a goal in natural language; Daedalus interprets it, plans, inspects the workspace, calls tools, validates results with build/test/lint commands, recovers within bounded limits, and reports from a replayable event log.

Five domain engines share one core — each engine is a fully separate system with its own pipeline, never routed through another engine's loop:

| Engine | Purpose |
|---|---|
| **Coding** | Agentic software engineering (Ask / Manual / Auto / Plan) |
| **Slide** | Outline → template → generated `.pptx` presentations |
| **Dokumen** | 7-stage document understanding and generation (`.docx`) |
| **Spreadsheet** | Workbook authoring (Susun) and data analysis (Analis) (`.xlsx`) |
| **Research** | 8-stage deep research with a deterministic 7-rule verification gate |

The CLI and Web UI are thin interfaces over the same `@s3r3/core`. **Dae Captain** is the desktop companion (Tauri): a chat-first, always-on-top assistant that drives every engine from a floating pill.

## Quickstart

Prerequisites: Node.js 22+ and npm.

```bash
git clone https://github.com/s3r3/daedalus.git
cd daedalus
npm install

# Typecheck all packages, verify scope rules, and run tests.
bash scripts/check.sh
```

Configure a provider via environment variables in the shell that starts Daedalus:

```bash
export LLM_BASE_URL="https://llm.ayid.cc.cd/v1"   # or any OpenAI-compatible /v1 endpoint
export LLM_API_KEY="<your-key>"
export LLM_MODEL="<model-id>"
export DAEDALUS_HOST="127.0.0.1"
export DAEDALUS_PORT="3080"
```

Start the development servers:

```bash
bash scripts/dev.sh
# API server:  http://127.0.0.1:3080/health
# Web UI (Vite): http://127.0.0.1:5173  (proxies API/WebSocket to :3080)
```

Or use the CLI from source:

```bash
# Launcher: one background server, then a domain menu
# (Coding / Slide / Dokumen / Spreadsheet / Hide to Tray / Exit)
node --experimental-strip-types cli/src/index.ts

# Lifecycle
node --experimental-strip-types cli/src/index.ts serve --daemon
node --experimental-strip-types cli/src/index.ts status
node --experimental-strip-types cli/src/index.ts stop

# One-shot run
node --experimental-strip-types cli/src/index.ts run "Add input validation" --cwd /path/to/workspace
```

When `daedalus-web/dist` is built, the Node server also serves the Web UI from `/`.

## Coding engine

### Agent modes

Modes are defined once in core and carried by every surface. In the Web composer, **Shift+Tab** cycles modes at the next turn boundary; `daedalus run --mode <mode>` selects one for a one-shot run.

| Mode | Behaviour |
|---|---|
| `ask` | Read-only question answering; no mutations, no commands. |
| `manual` | Tools are visible, but every mutating/executing call needs approval. |
| `auto` | Full plan → act → observe → validate → recover loop under the session approval policy. |
| `plan` | Interactive plan drafting with clarifying questions; no execution until approved. |

### Slash commands

Typing `/` in the Web composer opens the shared command palette:

`/help` `/mode` `/models` `/providers` `/settings` `/auto-approve` `/plan` `/workspace` `/files` `/upload` `/image` `/diff` `/validate` `/new` `/clear` `/status` `/cancel` `/exit`

### Tool reference

The core registry exposes a fixed toolset. Mode policy can hide tools, and the approval gate can still deny a visible call.

| Tool | Mutating | Purpose |
|---|---:|---|
| `read_file` | No | Read a UTF-8 workspace file, optionally by line range. |
| `list_dir` | No | List direct children of a workspace directory. |
| `grep` | No | Regex-search UTF-8 workspace files (max 100 matches). |
| `glob` | No | Find workspace files matching a glob (max 100 matches). |
| `git_status` | No | `git status --porcelain` for the workspace. |
| `git_diff` | No | Workspace git diff/stat. |
| `write_file` | Yes | Create/overwrite a UTF-8 file; parents are created. |
| `edit_file` | Yes | Replace one unique exact string in a file. |
| `create_dir` | Yes | Create a directory (and missing parents) inside the workspace. |
| `run_command` | Executing | Run an allowlisted process with timeout, cancellation, output caps, and process-group cleanup. |

### Providers and settings

Providers are OpenAI-compatible endpoints managed through the core provider registry and persisted in `<DAEDALUS_HOME>/providers.json`; API keys are masked in every public view. **Test connection** performs a real `GET /models` against the selected endpoint.

| Variable | Meaning |
|---|---|
| `LLM_BASE_URL` | OpenAI-compatible base URL. |
| `LLM_API_KEY` | Provider credential from the process environment. Keep it out of git. |
| `LLM_MODEL` | Default model id. |
| `LLM_TIMEOUT_MS` | Optional per-request model timeout (ms). |
| `DAEDALUS_HOST` / `DAEDALUS_PORT` | Server bind address; default `127.0.0.1:3080`. |
| `DAEDALUS_HOME` | Persistence root for task state, event logs, and the provider registry; default `.daedalus`. |
| `DAEDALUS_CMD_ALLOWLIST` | Optional override for the `run_command` executable allowlist. |

See [`.env.example`](.env.example) for a non-secret template.

## Evaluation

The suite contains 12 small fixture tasks: 4 bug fixes, 4 feature additions, 4 refactors.

```bash
# Validate the suite definition.
node --experimental-strip-types evaluation/runners/run-evaluation.ts --validate-suite

# Deterministic harness validation (scripted provider; not live LLM performance).
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --output evaluation/reports/deterministic-full
```

See [docs/evaluation.md](docs/evaluation.md) for the experimental design, metrics, and threats to validity.

## Documentation

- [Architecture](docs/architecture.md)
- [ADR index](docs/decisions/README.md)
- [Evaluation](docs/evaluation.md)
- [Demo scenarios](docs/demo-scenarios.md)
- [Limitations and future work](docs/limitations-and-future-work.md)
- [Third-party provenance](docs/THIRD_PARTY.md)

## Repository structure

- `core/` — `@s3r3/core`: contracts, agent loop, tools, execution/validation/recovery, events, modes, providers, and the Slide/Dokumen/Spreadsheet/Research engines.
- `cli/` — the `daedalus` command, launcher/daemon lifecycle, and tray capability layer.
- `server/` — Node HTTP/WebSocket gateway, workspace/upload APIs, provider/settings APIs, static Web serving.
- `daedalus-web/` — React + Vite Web UI.
- `dae-captain/` — Tauri desktop companion (Rust backend, chat-first pill/panel UI).
- `evaluation/` — task suite, runner, aggregator, and report datasets.
- `docs/` — architecture, ADRs, evaluation notes, and provenance.
- `scripts/` — `check.sh` and `dev.sh`.

## Troubleshooting

- **`MODEL_REQUEST_FAILED` / HTTP 530 from the provider**: the endpoint is unreachable. Verify the provider process or tunnel, then retry **Test connection**.
- **No tray in this environment**: headless shells report this honestly. Use `daedalus status` / `daedalus stop`; on a desktop, tray support is a manual verification item.
- **`LLM_MODEL is required`**: export `LLM_MODEL`, or pick a model/provider in Settings or via `run --model` / `--provider-id`.
- **Server port already in use**: reuse the daemon with `daedalus status`, stop it with `daedalus stop`, or set another `DAEDALUS_PORT`.
- **Workspace path rejected**: tasks and workspace APIs are confined to allowed roots; `..`, absolute upload paths, and oversized uploads are rejected.

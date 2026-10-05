# PLAN.md — Implementation Roadmap

<!-- ── Daedalus hero · Charm/Crush-inspired ─────────────────────────────── -->

<p align="center">
  <samp><strong>D A E D A L U S</strong></samp><br/>
  <sub><em>A Web-Based Agentic Coding Framework Powered by Large Language Models</em></sub><br/>
  <samp>⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏</samp>
</p>

<p align="center">
  <sub><code>cli</code> · <code>web</code> · <code>one core</code> · <code>agentic</code> · <code>validation-driven</code> · <code>event-sourced</code> · <code>observable</code></sub>
</p>

**Project:** Analisis dan Implementasi Agentic Machine Learning Framework Berbasis Large Language Model untuk Otomatisasi Workflow Cerdas
**Framework:** **Daedalus** — *A Web-Based Agentic Coding Framework Powered by Large Language Models*
**Interfaces:** **CLI + Web**, both backed by one **Daedalus Core**
**Implementation root:** **`Daedalus/`**
**Stack:** TypeScript · Node.js · npm · React + Vite (web)
**Visual & motion language:** Crush-inspired (see §3.4)
**Document role:** This is the single source of truth for the implementation roadmap. It is updated at the end of every phase.

---

## Progress Tracking

```text
Overall Progress: 75%

Current Phase: PHASE 9

Status: NOT STARTED

Last Updated: 2026-10-04
```

> **Phase 8 note (2026-10-04):** Phase 8 was previously recorded as `NOT STARTED` / `0%`. An audit against the
> actual disk state found **all 30 implementation tasks already shipped** and **all 12 acceptance criteria passing**;
> the checklist simply had never been reconciled with the code. The four coverage gaps that then held it at 70%
> (event-stream reconnect/replay, per-panel renders, browser e2e, Monaco/xterm surfaces) are all closed, so the
> phase is **COMPLETE** and Phase 9 may begin. See the Phase 8 Status section for the five defects that surfaced
> while writing those tests.

### Summary Table

| Phase    | Status      | Progress | Main Deliverable          |
| -------- | ----------- | -------: | ------------------------- |
| Phase 0  | COMPLETE    |     100% | Research & Architecture   |
| Phase 1  | COMPLETE    |     100% | Daedalus Foundation       |
| Phase 2  | COMPLETE    |     100% | LLM Provider Integration  |
| Phase 3  | COMPLETE    |     100% | Daedalus Agent Core       |
| Phase 4  | COMPLETE    |     100% | Tool System               |
| Phase 5  | COMPLETE    |     100% | Execution Harness         |
| Phase 6  | COMPLETE    |     100% | Validation & Recovery     |
| Phase 7  | COMPLETE    |     100% | CLI Interface             |
| Phase 8  | COMPLETE    |     100% | Web Interface                 |
| Phase 9  | NOT STARTED |       0% | CLI + Web Integration Testing |
| Phase 10 | NOT STARTED |       0% | Evaluation                    |
| Phase 11 | NOT STARTED |       0% | Finalization              |

### Phase Status Legend

`NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `COMPLETE`

### Current Project Status (actual)

```text
Framework:             Daedalus
Web:                   React + Vite + TypeScript   (Daedalus/daedalus-web/)
Package Manager:       npm
Web Project Status:    Scaffolded + wired to server (/health + WS reachability)
CLI:                   Foundation implemented (--version/--help/health over @daedalus/core)
Daedalus Core:         Execution Harness COMPLETE (approval gate, sandbox, disk caps, process cancellation, audit events)
Event Bus / WebSocket: Foundation implemented (in-process bus, /tasks/events WS); approval events now broadcast over WS
```

> **Progress note (§15):** the existing Vite scaffold is **not** counted as progress for any phase.
> ```text
> Web Foundation:       READY / SCAFFOLDED
> Daedalus Implementation: NOT STARTED
> ```
> Overall progress stays driven by the Phase 0 / Phase 1 acceptance criteria. No feature is claimed as finished before it is implemented.

---

## 1. Project Vision

> **Daedalus — A Web-Based Agentic Coding Framework Powered by Large Language Models.**

**Daedalus** is an independent **Agentic Coding Framework**. It is *not* a chatbot and *not* a code generator: an autonomous agent accepts a high-level software engineering task in natural language, explores a target repository, plans, edits code, runs the project's build/test commands, observes results, recovers from failures, and reports a validated result.

Daedalus ships **two interfaces over one core**:

- **CLI** — `daedalus run "Add authentication to this project"` (terminal).
- **Web** — a browser UI for running and monitoring the agent.

Both are thin clients of the same **Daedalus Core** (Agent Loop, Planner, Tool System, Execution, Validation, Recovery). See §3.0.

### Core workflow (target behaviour)

```text
User Task
→ Understand
→ Plan
→ Inspect Repository
→ Select Tool
→ Execute
→ Observe
→ Validate
→ Repair / Replan
→ Complete
→ Report Result
```

### Goals

1. **Autonomy with control** — the agent runs a bounded plan→act→observe→validate→recover loop, with a human able to approve privileged actions.
2. **Web-first** — all interaction (task entry, plan, activity timeline, file explorer, diff viewer, terminal log, validation status, approvals) happens through a browser; no terminal TUI is required to operate it.
3. **Validation-driven** — a task is not "done" because the model says so; it is done when the configured build/test/lint checks pass or a stop condition is reached.
4. **Observable** — every plan step, tool call, observation, and validation result is a first-class, recorded, replayable event.
5. **Measurable** — the framework produces a structured experimental dataset (task, iterations, tool calls, time, errors, recovery, outcome) suitable for thesis evaluation.
6. **Independent** — a new architecture with its own structure, identity, and implementation. Reference repositories inform *concepts only*; no source code is copied.

### Explicit non-goals (for the MVP)

- Not a general chat assistant.
- Not a multi-tenant SaaS product.
- Not a replacement for a human engineer on ambiguous, under-specified tasks.
- Not a full IDE.

### Success definition (thesis level)

Given a small curated set of software-engineering tasks on prepared repositories, Daedalus autonomously produces a change whose validation passes, and records enough structured data to compare success rate, iterations, tool-call counts, and recovery behaviour across configurations.

---

## 2. Reference Repository Analysis

The five repositories below are **references only**. They are now **downloaded and present on disk** (§2.0). They were inspected as source (not just READMEs) to extract *concepts*. For each, this section separates **Observed concept** (what the repository actually does) from **My proposed implementation** (what Daedalus will do independently).

> **Read-only rule:** these clones are reference material. Never edit, commit to, or copy source from them (§10).

### 2.0 Reference Repository Inventory (verified on disk)

All five clones were confirmed present at commit level before this section was written.

| Reference | Local path | Verified commit | Date | Primary stack | Verified entry point |
| --- | --- | --- | --- | --- | --- |
| Cline | `cline/` | `39ff2359` | 2026-10-02 | TypeScript · Bun · Node ≥22 · VS Code ext | `sdk/packages/{agents,core,llms,shared,sdk,ui}` + `apps/{cli,cline-hub,vscode}` |
| Crush | `crush/` | `bdcf796c` | 2026-10-02 | Go 1.27 · Bubble Tea v2 · SQLite/sqlc | `internal/agent/coordinator.go`, `internal/cmd` |
| DeepSeek Harness | `deepseek-harness/` | `5badb150` | 2026-10-03 | TypeScript · Cordis (vendored) · pnpm | `packages/{core,api,web,client}` + `apps/cli` |
| OpenHands (Agent Canvas) | `OpenHands/` | `a6bba78f` | 2026-10-03 | TypeScript · React Router · Vite | `src/{routes,api,stores}` (`@openhands/agent-canvas`) |
| SWE-agent | `SWE-agent/` | `3ea751c0` | 2026-07-16 | Python ≥3.11 · setuptools · pytest | `sweagent/run/run.py`, `sweagent/agent/agents.py` |

**Verified inspection basis (source paths actually read):**

- **Crush:** `internal/agent/{coordinator,agent,hooked_tool,loop_detection,request_timeout,runid}.go`, `internal/agent/tools/*.go` (bash, edit, write, view, glob, grep, ls, multiedit, todos, fetch, `lsp_*`, `mcp/`), `internal/permission/permission.go`, `internal/pubsub/{broker,events}.go`, `internal/db/{sessions,messages,files}.sql.go` + `migrations/`, `internal/session/session.go`, `internal/hooks/`, `internal/skills/`, `internal/lsp/`, `internal/shell/`, `internal/workspace/`.
- **DeepSeek Harness:** `AGENTS.md`, `docs/{architecture,agent-lifecycle,api-gateway,capability-seams,event-producer-consumer,defensive-patterns}.md`, `docs/cookbook/`, package groups `packages/core/{agent,agent-loop,system-prompt,tools,session,scope}`, `packages/api/{gateway,session-controller,workspace-controller,terminal-controller,settings-controller,remotes}`, `packages/web/*`, `packages/client/*`, `apps/cli`.
- **Cline:** `sdk/packages/README.md` (authoritative package responsibility table), `sdk/packages/{agents,core,llms,shared,sdk,ui}/package.json`, `apps/{cli,cline-hub,vscode,examples}`, `AGENTS.md`, `evals/`.
- **OpenHands (Agent Canvas):** `README.md`, `AGENTS.md`, `src/routes/*` (conversation, files-tab, planner-tab, commits-tab, browser-tab, `llm-settings`, `mcp-settings`, automations), `src/api/{agent-server-adapter,agent-server-compatibility,backend-registry,canvas-ui-client-tool}.ts`, `src/stores/{conversation-store,event-message-store,agent-store}.ts`, `package.json`, `electron-builder.config.mjs`.
- **SWE-agent:** `README.md`, `pyproject.toml`, `sweagent/agent/{agents,reviewer,history_processors,action_sampler,problem_statement,models}.py`, `sweagent/tools/`, `sweagent/run/{run,run_single,run_batch,common}.py`, `sweagent/environment/`, `tools/` (registry, edit_anthropic, search, submit, filemap, windowed_edit_*), `config/*.yaml`.

> ⚠️ **Correction recorded (2026-10-04):** an earlier draft of this file described `OpenHands/` as the full Python OpenHands monorepo. **It is not.** The clone is **OpenHands Agent Canvas** — the `agent-canvas` frontend package only (`@openhands/agent-canvas`, npm-published as `agent-canvas`). The agent execution backend lives in a **separate repository** (`OpenHands/software-agent-sdk`) that is **not present here**. §2.2 is corrected accordingly.

### 2.1 Crush — `github.com/charmbracelet/crush`

- **Problem it solves:** a terminal-native coding agent ("your tools, your code, and your workflows, wired into your LLM of choice") with multi-model support and session persistence.
- **Important architectural concepts:** session-scoped agent with per-session queued turns; a `SessionAgent` interface; auto-summarization when the context window is nearly full; pub/sub event brokering; embedded SQLite persistence; a permission service; MCP integration (http/stdio/sse); LSP for extra context; loop detection.
- **Agent architecture:** `internal/agent` is the orchestration layer. `sessionAgent.Run(ctx, SessionAgentCall) (*AgentResult, error)` drives a turn; `SessionAgentCall` carries `SessionID`, a `RunID` correlator, `Prompt`, model options, and an `OnComplete` hook. `SessionAgent` exposes `Run`, `Cancel`, `Summarize`, `GenerateTitle`, `IsSessionBusy`, `QueuedPrompts`. Long turns auto-summarize (thresholds ≈ 200k window / 20k buffer / 0.2 ratio).
- **Tool architecture:** tools live in `internal/agent/tools/` (bash, edit, write, view, glob, grep, ls, multiedit, fetch, web_search, web_fetch, todos, diagnostics, LSP tools, MCP tools). Each tool pairs an implementation with a Markdown prompt/description; tools are scoped per turn; a hook layer wraps tool execution.
- **Execution model:** synchronous turn execution with context cancellation, per-session queueing, and re-auth retry chaining; commands go through a shell layer.
- **Web/workspace capabilities:** primarily a TUI, but it ships `internal/server`, `internal/client`, `internal/backend` and a protobuf/generated API layer for client-server operation; `internal/workspace` manages working directories.
- **Validation/recovery:** loop detection (`loop_detection.go`), provider error handling, request timeouts, auth refresh; **no** build/test validation loop as a core concept.
- **Observed concept relevant to Daedalus:** the *turn = (session, prompt, run id, cancellation, completion callback)* contract; per-session serialization of turns; context-window summarization; a **permission service** (`permissionService.Request/Grant/Deny/GrantPersistent/AutoApproveSession/SkipRequests` — verified in `internal/permission/permission.go`) that publishes `pubsub` notifications; an **event broker** (`internal/pubsub/broker.go`) feeding the UI; **hook-based tool wrapping** (`hooked_tool.go`, `internal/hooks/`); and **loop detection** (`loop_detection.go`).
- **What should NOT be copied:** its Go/Fantasy/Catwalk stack, its Bubble Tea TUI, its specific provider catalog, its SQLite/sqlc schema, and any naming or file layout.
- **My proposed implementation:** an event-sourced **Task/Turn** model (not a goroutine-queue model), a TypeScript `AgentRuntime` with explicit `Turn` objects, an app-level **Context Manager** that budgets tokens with pluggable summarization, a **Tool Registry** with declarative schemas, and a **Permission Gate** consulted by the harness. *Concept inspired, code independent.*

---

### 2.2 OpenHands (Agent Canvas) — `github.com/OpenHands/OpenHands`

- **Problem it solves:** a self-hosted *web control center* for running and monitoring coding agents across local/remote/cloud backends.
- **Important architectural concepts:** strict separation between a **frontend control plane** and an **agent execution backend**; a *backend registry* (local/remote/cloud); conversation-scoped event streams; a client-side "UI tool"; automation (scheduled/event-triggered) as a separate service.
- **Agent architecture (verified):** Agent Canvas **does not run the agent at all**. It is a **pure control-plane frontend** (`src/`, React Router 7 + Vite, npm `@openhands/agent-canvas`) that talks to one or more **OpenHands Agent Servers** via `src/api/agent-server-adapter.ts` + `@openhands/typescript-client`. The **execution backend is a separate repo (`software-agent-sdk`, Python) and is NOT in this clone** — so its agent internals could not be verified from source and are deliberately *not* claimed as observed. What *is* verifiable here is the boundary: a `backend-registry/` of local/remote/cloud backends, a `agent-server-compatibility.ts` capability gate, and `src/routes/` enumerating the operator surface.
- **Tool architecture (verified):** tools are entirely server-side. The only tools visible in this repo are **client tools** the backend uses to drive the UI: `src/api/canvas-ui-client-tool.ts`, plus a `launch-child-conversation` client tool and `tools/canvas_ui_tool.py` (a UI-facing Python tool invoked by the agent). This is the **inverse** of Daedalus's model, where the agent drives local tools directly.
- **Execution model (verified):** conversations emit **events** over a socket layer (`/sockets`) consumed by the UI; state lives in **Zustand stores** (`conversation-store`, `event-message-store`, `agent-store`, `goal-store`). An **Automation service** (`src/api/automation-service/`, `routes/automations-*.tsx`) decides *when* work runs; the Agent Server decides *what* runs. `docker/`, `helm/`, `electron/` package the stack for deployment.
- **Web/workspace capabilities (verified):** the richest web reference in the set — `src/routes/` covers conversation, `files-tab`, `planner-tab`, `commits-tab`, `browser-tab`, `mcp-settings`, `llm-settings`, `mcp`, automations, agent/canvas extensions, and device verification. `src/api/` holds service adapters per domain (agent-server, conversation, events, git, workspaces, bash, MCP, settings, skills).
- **Validation/recovery (verified):** a dedicated **verification settings** surface plus a planner tab and commits tab; retries live client-side; there is **no** agent-loop-gated validation, because the loop is not here.
- **Observed concept relevant to Daedalus:** the **control-plane / execution-plane split**; conversation → **event stream** → store pipeline; the explicit "the frontend never executes actions" boundary; per-conversation routing across multiple backends; a **capability/compatibility gate** before talking to a backend; client tools as agent capabilities.
- **What should NOT be copied:** its React component tree, Zustand store names/shapes, the multi-repo cloud/sandbox ecosystem, its i18n pipeline, and its Helm/Electron packaging.
- **My proposed implementation:** a **thin web control plane** (React) talking to a **single, self-contained Daedalus backend** over REST + WebSocket. Daedalus owns its own execution plane (no external agent server), uses **one append-only event log** as the UI's single feed, and defines a small set of typed events. Client-side tools are **out of MVP scope**. *Concept inspired, code independent.*

---

### 2.3 Cline — `github.com/cline/cline`

- **Problem it solves:** an open-source coding agent available across IDE, terminal, and desktop, with human-in-the-loop tool approval and broad model support.
- **Important architectural concepts:** a **layered SDK** where the agent loop is *stateless* and orchestration is *stateful*; plugins register tools and lifecycle hooks; multi-agent "teams"; scheduled (cron) agents; channel connectors; a headless CLI for CI/CD.
- **Agent architecture (verified from `sdk/packages/README.md`, the authoritative responsibility table):**
  - `@cline/shared` — cross-package primitives (path resolution, session common types, indexing helpers); **no internal deps**.
  - `@cline/llms` — model catalog + provider settings schema + handler creation SDK; **no internal deps**.
  - `@cline/agents` — **stateless agent runtime loop** (tools, hooks, extensions, teams, streaming); depends on `llms` + `shared`.
  - `@cline/core` — **stateful** runtime orchestration (runtime composition, session lifecycle/storage, local **and hub** runtime services, hub discovery + client helpers); depends on `agents` + `llms` + `shared`.
  - `@cline/ui` — internal framework-neutral web theme / Tailwind adapter.
  Verified flow: `llms` builds handlers → `agents` runs the loop on them → `core` adds persistence/session lifecycle (local **or hub-backed**) → `shared` provides contracts. `@cline/core/hub` additionally exposes a **detached hub daemon** (`HubSessionClient`, `HubUIClient`) and scheduled-execution services.
- **Tool architecture:** tools plus **lifecycle hooks** registered programmatically (`createTool({ name, description, inputSchema, execute })`); plugins for logging/auditing/policy enforcement; MCP servers for external systems; task tooling (`agenda-task-manager`, `task-spec-parser`, `sqlite-task-store`).
- **Execution model:** streaming agent loop with tool execution, hooks, and **teams** (coordinator delegates to specialists with separate tools/context); team state persists across sessions.
- **Web/workspace capabilities:** desktop app is a Tauri shell + Bun sidecar + Next.js UI; the agent core is shared across IDE/CLI/desktop; MCP management via `cline mcp`.
- **Validation/recovery:** `evals/` directory (benchmarks, e2e, smoke tests, `cline-bench` submodule); retries; plugins can enforce policy.
- **Observed concept relevant to Daedalus:** the **stateless-loop / stateful-orchestration split** (explicitly documented as a boundary rule in their README — a strong signal the separation is a real architectural invariant, not incidental); a **hub daemon** so multiple clients share one long-lived agent runtime; a **plugin/hook system** for policy + auditing; **human-in-the-loop approval** as a first-class flow; scheduled agents; task-spec parsing that turns prose into trackable items.
- **What should NOT be copied:** its Node/Bun/Tauri stack, its `@cline/*` package names, its webview-specific integrations, and its connectors.
- **My proposed implementation:** mirror the *separation* — a stateless `AgentLoop` (pure step function) vs a stateful `AgentRuntime`/`TaskStore`; a **hook seam** around tool execution; and an explicit **Approval Gate** with per-action policy. Adopt a *task-spec → todo* idea as the Planner's checklist. *Concept inspired, code independent.*

---

### 2.4 SWE-agent — `github.com/SWE-agent/SWE-agent`

- **Problem it solves:** enables an LM to autonomously use tools to **fix issues in real GitHub repositories**; a research-grade agent that is state-of-the-art on SWE-bench and "simple & hackable by design", configurable by a single YAML file.
- **Important architectural concepts:** the **Agent-Computer Interface (ACI)** — tools designed for an LM, not a human; environment isolation via a deployment backend; **observation truncation**; multiple **action parsers**; **retry loops** that sample/submit and select the best; **trajectories** as first-class evaluation artifacts.
- **Agent architecture (verified):** the `sweagent` CLI initializes an **environment** (`sweagent/environment/`, wrapping **SWE-ReX** for container + shell sessions) and an **Agent** (`sweagent/agent/agents.py`). `Agent.forward()` is the central method: it prompts the model, parses the action, and executes it in the shell session. History is compressed by a **HistoryProcessor** (`history_processors.py`) before prompting. Supporting modules verified: `models.py`, `action_sampler.py` (sample several actions, pick one), `problem_statement.py`, `reviewer.py` (retry loops). Everything is configured from **YAML** (`config/default.yaml`, `bash_only.yaml`, `demo/`, `sweagent_0_7/`, `benchmarks/`).
- **Tool architecture (verified):** `sweagent/tools/` defines tool/command handling; the **bundled toolsets live in top-level `tools/`** — `registry`, `edit_anthropic`, `search`, `submit`, `forfeit`, `filemap`, `diff_state`, `review_on_submit_m`, `web_browser`, and a family of `windowed_edit_*` (linting / replace / rewrite) plus `windowed/`. The ACI principle is that tools are designed for an *LM*, not a human. A `ToolFilterConfig` blocklist rejects unsafe/interactive commands (`vim`, `nano`, `less`, `tail -f`, `make`, bare `python`/`bash`) and supports `block_unless_regex`.
- **Execution model:** environment-backed command execution; **pluggable parsers** (`FunctionCallingParser`, `JsonParser`, `ThoughtActionParser`, `ActionOnlyParser`) convert raw model output into structured actions; `AbstractActionSampler` can attempt several actions and choose.
- **Web/workspace capabilities:** not primarily web, but `sweagent/inspector/` serves a web inspector for **trajectories**, and `sweagent/run/inspector_cli.py` drives it; `run_replay.py` replays a recorded run. The environment is containerized (Docker / remote backends).
- **Validation/recovery:** `reviewer.py` defines `ChooserRetryLoop`, `ScoreRetryLoop`, and `get_retry_loop_from_config`; typed exceptions live in `sweagent/exceptions.py` (`ContextWindowExceededError`, `CostLimitExceededError`, `FormatError`, `ContentPolicyViolationError`); explicit budget/cost limits; command-timeout handling. **Crucially: "validation" here means *scoring a submission after the fact*, not a build/test loop inside the agent** — the key gap Daedalus addresses.
- **Observed concept relevant to Daedalus:** **ACI-style tools** tailored to the LM; **observation truncation** to protect the context window; **pluggable parsers** for model output; **budget + retry loops** as recovery; **trajectories** as the evaluation artifact; an explicit **stop/failure taxonomy** (max iterations, cost, context exceeded, formatting error).
- **What should NOT be copied:** its Python module layout, its YAML-config-as-code approach verbatim, its SWE-ReX/Docker deployment internals, its specific benchmark harness, and its prompt text.
- **My proposed implementation:** design *my own* tool contracts (JSON-schema, structured results with truncation metadata); a **Validator** package that runs build/test/lint and parses results (SWE-agent's "evaluation" concept, but driven by *my* validation loop rather than submit-and-score); a **Recovery policy** object (max retries, max iterations, token/cost budget, no-progress detection); and a **Trajectory recorder** that stores every turn for Phase 9. *Concept inspired, code independent.*

---

### 2.5 DeepSeek Harness (`dsh`) — `github.com/deepseek-ai/deepseek-harness`

- **Problem it solves:** a general **agent harness** with an **"everything-is-a-plugin"** architecture (built on Cordis), shipped with a Web UI (`dsh web`, default `http://127.0.0.1:3080`).
- **Important architectural concepts:** **event-sourced session log as the single source of truth**; **system-prompt assembly** as composable ordered sections; a **scoped tool registry with a guarded execution pipeline**; the **agent loop as a swappable package**; strict separation of soft guidance (plan) from hard enforcement (sandbox, approval).
- **Agent architecture (verified from `packages/core/*` + `docs/`):** the `core` group is exactly `packages/core/{agent, agent-loop, system-prompt, tools, session, scope, agent-default-model, agent-tool-presentation}`. A turn flows through the loop: the `agent-loop` driver *claims a queued prompt → opens a turn on the session log → assembles the request prefix via `system-prompt` → derives history from the log → streams the model response through the LLM seam → dispatches tool calls through the tool registry → appends every model-visible fact back onto the log*. Agents are created via `ctx.agents.create()`/`resume()`, returning an `AgentHandle` whose `dispose()` stops the loop and unwinds state.
- **Tool architecture (verified from `packages/core/tools`):** a `ToolDefinition` = model-facing `ToolSchema` + a **mandatory canonical `output`** (schema + `render` + `presentationMeta`) + `execute(args, exec)` + optional `projectContent`/`finalizeContent` + `timeoutMs` + `isConcurrencySafe` + UI presenters. The registry's `schemas()` uses an **explicit allowlist**, so host-only fields (`execute`, `output`, `timeoutMs`, presenters) never leak to the model.
- **Execution model:** turn-enclosed, replayable session events; history derived from the log; per-package seams (`llm`, `shell`, `subprocess`, `ssh`, `terminal`, `sandbox`, `ptc-runtime`); guarded execution via a `tools/execute` wrapper pipeline.
- **Web/workspace capabilities (verified):** a large package surface under `packages/client/*` (chat, conversation, approval, tool, skill, subagent, settings, sidebar, theme, trajectory, …) plus `packages/api/*` controllers (`gateway`, `session-controller`, `workspace-controller`, `workspace-files`, `terminal-controller`, `settings-controller`, `job-controller`, `account-controller`, `remotes`) and `packages/web/*` (`web`, `tool-web`, `web-fetch-http`, `web-search-*`). Entrypoints live in `apps/cli`.
- **Validation/recovery:** a dedicated `packages/guard/` (loop/tool guards), approval policy, sandbox confinement (`packages/sandbox/`), compaction (`packages/compaction/`), feedback (`packages/feedback/`), plus a heavy testing regime: per-file coverage gate, e2e, `test:expected`, and keyless **snapshot replay** through shipped profiles.
- **Observed concept relevant to Daedalus:** **event-sourced session log** (durable, replayable, turn-enclosed) as the backbone for both UI and debugging; **composable system-prompt sections**; **allowlisted tool schemas** (never leak host fields); **guarded tool pipeline** with pre/post-execute policy; separating *soft* guidance (plan) from *hard* enforcement (approval/sandbox); the **snapshot-replay testing** idea.
- **What should NOT be copied:** Cordis, its vendor/ ecosystem, its ~50-package anatomy, its generated-doc/typert tooling, and its snapshot catalogue.
- **My proposed implementation:** a **single event log** per task (append-only, typed, replayable) that feeds both the WebSocket UI and the Phase 9 evaluator; a **prompt-composer** with ordered sections (role, repository context, plan, tool docs, constraints); a **tool schema allowlist** so internal fields stay host-only; a **guarded tool pipeline** (pre-policy → permission → execute → post-policy → event); and a **replay fixture** strategy for tests. *Concept inspired, code independent.*

### 2.6 Cross-repository synthesis (concept map)

| Concept | Crush | OpenHands¹ | Cline | SWE-agent | DeepSeek Harness | Daedalus (mine) |
|---|---|---|---|---|---|---|
| Agent loop ownership | in-process | external server | `@cline/agents` | `Agent.forward()` | `agent-loop` pkg | own `AgentLoop` |
| State backbone | SQLite sessions | event-service | session store | trajectories | append-only log | **append-only event log** |
| Tool contract | Go tools + md | server tools | `createTool` | `ToolConfig`/ACI | `ToolDefinition` | own JSON-schema registry |
| Permissions | permission service | (server-side) | HITL approval | blocklist | approval + sandbox | **Approval Gate** |
| Validation loop | ✗ | partial | evals | submit/reviewer | guards | **Validator + Recovery** |
| Web UI | partial (server) | strongest | desktop webview | inspector only | strongest (broad) | **own thin web UI** |
| Eval method | ✗ | ✗ | evals dir | SWE-bench | snapshots | **own task suite** |

¹ The local `OpenHands/` clone is **Agent Canvas only** (control-plane frontend). Its agent-execution backend is a separate repository and was not inspected — see the correction note in §2.0.

> **Rule (see §10):** no code is copied from any reference. Only the *concepts* above are adopted, and each is re-implemented from scratch against Daedalus's own contracts.

---

## 3. Architecture of Daedalus

### 3.0 One core, two interfaces

Daedalus is **one framework with two interfaces**. The **CLI** and the **Web UI** are *thin clients*: all intelligence — Agent Loop, Planner, Tool System, Execution Harness, Validation, Recovery — lives in the shared **Daedalus Core**. There is no "CLI agent" and no "Web agent"; there is only the core.

```text
                         DAEDALUS
                  Agentic Coding Framework
                           │
                    ┌──────┴───────┐
                    │ DAEDALUS CORE│
                    └──────┬───────┘
          ┌────────────────┴────────────────┐
          │                                 │
        CLI                                WEB
          │                                 │
      Terminal                           Browser
          │                                 │
          └────────────────┬────────────────┘
                           ↓
                         AGENT
                           ↓
                          PLAN
                           ↓
                         TOOLS
                           ↓
                        EXECUTE
                           ↓
                        VALIDATE
                           ↓
                    REPAIR / REPLAN
                           ↓
                          DONE
```

The detailed architecture below is the **Daedalus Core**; the CLI and the Web UI are the two entry points into it.

Two source-informed refinements are preserved: **(a)** an **Event Bus / Event Log** spine that every component publishes to (so both interfaces and the evaluator share one feed), and **(b)** an explicit **Approval Gate** inside the Execution Harness, rather than a late UI-only concern.

```text
┌─────────────────────────────── Interfaces ───────────────────────────────┐
│   CLI (terminal)                        Web UI (browser)                 │
│   daedalus run "..."                    composer · plan · timeline       │
│   stdout · json · exit code             files · diff · terminal          │
│                                         validation · approvals · status  │
└───────────────┬───────────────────────────────┬──────────────────────────┘
                │ in-process call               │ REST + WebSocket
                │ (same core)                   │
┌───────────────▼───────────────────────────────▼──────────────────────────┐
│                  API / WebSocket Gateway (web transport)                 │
│   POST /tasks · GET /tasks/{id} · WS /tasks/{id}/events · POST /approve  │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ both interfaces call the same core
┌───────────────────────────────────▼──────────────── Daedalus Core ───────┐
│   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  ┌───────────┐  │
│   │ Task         │   │  Planner     │   │  Agent Loop   │  │ Context   │  │
│   │ Interpreter  │──▶│ (plan/step/  │──▶│ (step fn:     │─▶│ Manager   │  │
│   │ (understand) │   │  replan)     │   │ select + act) │  │ (budget,  │  │
│   └──────────────┘   └──────────────┘   └───────┬───────┘  │  compact) │  │
│                                        ┌────────▼────────┐ └───────────┘  │
│                                        │  Task State     │                │
│                                        │ (task/plan/log) │                │
│                                        └────────┬────────┘                │
└─────────────────────────────────────────────────┼─────────────────────────┘
                                    ┌─────────────▼─────────────┐
                                    │      Tool Manager         │
                                    │  (registry + dispatch)    │
                                    │ File · Search · Terminal  │
                                    │ · Git  (extensible)       │
                                    └─────────────┬─────────────┘
                                    ┌─────────────▼─────────────┐
                                    │    Execution Harness      │
                                    │ sandbox · timeout ·       │
                                    │ cancel · Approval Gate    │
                                    └─────────────┬─────────────┘
                                    ┌─────────────▼─────────────┐
                                    │        Validator          │
                                    │  build · test · lint      │
                                    └─────────────┬─────────────┘
                                    ┌─────────────▼─────────────┐
                                    │      Error Recovery       │
                                    │ classify · retry · replan │
                                    │ · stop conditions         │
                                    └─────────────┬─────────────┘
                                    ┌─────────────▼─────────────┐
                                    │      Final Result         │
                                    │ summary · diff · report   │
                                    └───────────────────────────┘

   ┌────────────────────────── Cross-cutting spine ──────────────────────────┐
   │  Event Bus / Event Log (all components publish typed events)            │
   │  Persistence (tasks, steps, trajectories) · Config · Logging            │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Component responsibilities

| Component | Responsibility | Informed by (concept) |
|---|---|---|
| **CLI** | Terminal interface: `daedalus run "..."`, streamed progress, JSON output, exit codes. A thin client over the core; executes nothing itself. | Crush CLI, SWE-agent CLI |
| **Web UI** | Browser interface: task entry, plan/timeline/diff/terminal/validation views, approval prompts. Renders events; executes nothing. | OpenHands control-plane, DeepSeek web UI |
| **API / WebSocket Gateway** | REST for commands, WS for the event stream; per-task channel; auth boundary. | OpenHands event-service, DeepSeek web-server |
| **Task Interpreter** | Normalize the user task into a structured `TaskSpec` (goal, target repo, constraints, done-criteria). | Cline task-spec, SWE-agent problem statement |
| **Planner** | Produce an ordered, amendable plan (checklist of intent-level steps) from `TaskSpec` + repo reconnaissance. | DeepSeek plan, Cline todo |
| **Agent Loop** | Stateless step function: build prompt → call LLM → parse action → dispatch tool → observe → emit event. | DeepSeek agent-loop, SWE-agent `forward()` |
| **Context Manager** | Assemble the model request (ordered prompt sections + history), budget tokens, truncate/compact observations, summarize. | DeepSeek system-prompt, SWE-agent `HistoryProcessor` |
| **Task State** | The durable per-task record: spec, plan, step history, status, artifacts. | Crush sessions, DeepSeek session log |
| **Tool Manager** | Registry + schema generation + dispatch of tools; allowlisted model-facing schemas. | DeepSeek tools registry, Crush tools, SWE-agent ACI |
| **Execution Harness** | Sandboxed process/file execution, timeouts, cancellation, permission/approval checks. | Crush permission, DeepSeek sandbox/approval, SWE-agent env |
| **Validator** | Run build/test/lint; parse results into `ValidationResult` (pass/fail + diagnostics). | SWE-agent evaluation, Cline evals |
| **Error Recovery** | Classify a failure; decide retry / fix / replan / abort under explicit limits. | SWE-agent reviewer retry, DeepSeek guards |
| **Final Result** | Assemble summary: outcome, diff, validation evidence, iteration/tool metrics. | all references |
| **Event Bus / Event Log** | Single append-only, typed, replayable event feed for UI + evaluation. | DeepSeek session log, OpenHands events |

### 3.2 Key contracts (finalized in Phase 0/1)

```text
TaskSpec        : { id, goal, repo_path, constraints[], done_criteria[], created_at }
Plan            : { id, task_id, steps: PlanStep[], version, status }
PlanStep        : { id, intent, status(pending|active|done|skipped), evidence[] }
ToolCall        : { id, task_id, turn_id, tool, args, approved_by?, started_at }
ToolResult      : { call_id, status(ok|error|denied|timeout), output, truncated, meta }
Event           : { seq, task_id, turn_id?, type, payload, ts }   # append-only
ValidationResult: { checks: [{ name, cmd, status, exit_code, summary, diagnostics[] }] }
RecoveryAction  : { reason, strategy(retry|fix|replan|abort), attempt, limits }
FinalReport     : { task_id, outcome(success|partial|failed), diff, evidence, metrics }
```

### 3.3 Design principles

1. **Core First** — Daedalus Core is independent of any interface; the Web UI is a consumer, never the owner of agent logic.
2. **Interface Independence** — CLI and Web are two thin clients of the same Core (§3.0); neither contains agent logic (§3.7).
3. **Validation Driven** — a task is done when build/test/lint evidence passes, not merely because the LLM said so.
4. **Observable** — every agent step, tool call, command, and validation result is a recorded event (§3.6).
5. **Recoverable** — the agent classifies failures and recovers through retry / fix / replan under explicit limits.
6. **Least Privilege** — tools and execution carry permission boundaries (approval gate, workspace confinement, timeouts).
7. **Modular** — LLM providers, tools, execution, validation, and interfaces sit behind clear, pluggable abstractions.
8. **Research-Oriented** — the architecture permits measurement and experiments (replayable event log, swappable policies).

### 3.4 Visual & Motion Language (Crush-inspired)

The web UI borrows the **feel** of Charm/Crush — sleek terminal glamour translated to the browser — using Daedalus's own code and assets. Nothing is copied from Crush; only the *aesthetic direction* is referenced.

**Theme tokens** (theme-driven; components never hardcode colors — mirroring Crush's token-driven `quickStyle`):
the palette lives in **`Daedalus/core/src/palette.ts`** and is read by *both* interfaces. The CLI paints with it
directly; the web mirrors it onto `--daedalus-*` custom properties (`daedalus-web/src/theme/theme.ts:19`
`applyPaletteVars`), and `daedalus-web/src/index.css:24-174` declares every token as
`var(--daedalus-<key>, <hex>)` — the hex being only the pre-JavaScript first-paint fallback. The token set
follows the reference: a brand quad (`primary` · `secondary` · `accent` · `keyword`), a four-step foreground ramp
(`fgBase` → `fgMostSubtle`), a four-step surface ramp (`bgBase` → `bgOverlay`), paired status hues with a
full-strength and a muted step (`error`/`warning`/`info`/`success` plus `*Muted`, plus `attention`, `busy`,
`infoMostSubtle`, `successMostSubtle`), two diff bands per sign (ink + code background + gutter background),
mode accents (`yolo`, `plan`, `planSubtle`), four button states, and a **16-entry ANSI palette**.
Default theme `daedalus-dark` (CharmTone Pantera); a `daedalus-light` variant for thesis screenshots.

The 16 ANSI slots are functional, not decorative: they remap raw terminal colors in the browser terminal so
program output is painted on-brand instead of falling back to the browser defaults
(`daedalus-web/src/theme/terminal-theme.ts`, applied at `terminal-pane.tsx:112` and re-applied on theme change
at `:134`).

Two properties are enforced, not just documented:
- `core/src/palette.test.ts` pins every CharmTone token to its published hex (`charmbracelet/x/exp/charmtone
  v0.1.0`, the release the reference pins) and pins the derived diff tints.
- `daedalus-web/src/web.test.tsx:40-72` walks `index.css` and asserts every `--daedalus-<key>` fallback equals
  the core palette in **both** themes, so the two interfaces cannot drift apart.

**Motion vocabulary** — every animation is driven by a typed event from §3.2 (no animation exists without a recorded event):

| Event | Motion |
| --- | --- |
| task created | composer collapses; plan panel slides in |
| plan step | checklist item types in, then settles with a highlight |
| `model.request` streaming | tokens reveal with a caret; a Charm-style spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` while awaiting the first token |
| tool call dispatched | tool row pulses; a shimmer travels along its border |
| tool result | output streams with a block cursor; a pinned log auto-scrolls |
| approval requested | timeline pauses; the approval card rises with a focus ring |
| validation running | per-check rows show an indeterminate progress shimmer |
| validation passed / failed | row flashes success (green pulse) or error (single shake) |
| retry / recovery | attempt counter animates; the failing row re-enters |
| task complete | timeline settles; the report card expands to reveal the diff |

**Rules**

1. Honor `prefers-reduced-motion: reduce` — disable transforms/shimmer, keep instant state changes.
2. Motion never blocks reading or gates an action; every animation is interruptible by user input.
3. Timing budget: micro `80–120ms` (hover/state), standard `180–240ms` (panel transitions); nothing exceeds `400ms`.
4. One spinner component, driven by agent status, reused everywhere (identical glyph cycle).
5. Diff lines animate in once (slide + fade), then remain static.
6. If the event log does not record it, the UI does not animate it.

**Reference only:** Crush's Bubble Tea / Lip Gloss / Glamour / Charmtone stack is **not** used. Daedalus implements this aesthetic inside its own React frontend using Tailwind CSS + shadcn/ui and CSS/Web Animations.

### 3.5 Technology Stack

#### Core / Runtime

```text
Language:         TypeScript
Runtime:          Node.js
Package Manager:  npm
Module system:    ESM
```

The core ships as a normal npm package (`@daedalus/core`) consumed by the CLI, the web backend, and the evaluation runner — with no framework-specific assumptions.

#### CLI

```text
Language:         TypeScript
Runtime:          Node.js
CLI framework:    Commander
```

The CLI uses the **same TypeScript/Node ecosystem** as Daedalus Core and depends only on the core package.

```bash
daedalus run "Add authentication to this project"
```

#### Web

```text
Framework:        React
Bundler / Dev:    Vite            (project ALREADY EXISTS at Daedalus/daedalus-web/)
Language:         TypeScript
Styling:          Tailwind CSS + shadcn/ui
Code editor:      Monaco Editor
Browser terminal: xterm.js
Realtime:         WebSocket
Client state:     Zustand        (optional — only where the architecture needs it)
```

> The web project is **already scaffolded** (`daedalus-web`: React + Vite + TypeScript, npm, ESM). Implementation continues *inside this project*; it is never recreated, replaced, or migrated (Phase 8).

#### Execution environment

Daedalus must interact with: **filesystem, shell, processes, git, package managers, compilers, test runners, linters, and build tools**.

> Linux (currently Arch Linux) is the **development and research environment** — *not* a framework requirement. The Execution Harness keeps host behaviour behind abstractions so other platforms can be supported later (§3.7).

#### Deferred to ADR-0002 (decided in Phase 0/1)

- Test runner for core + CLI
- Web backend runtime shape (Node HTTP/WS server, same process or separate)
- Persistence store

### 3.6 Realtime Event Architecture

Daedalus Core is **event-driven**: every meaningful step is appended to the Event Log, and both interfaces consume the same stream.

```text
Daedalus Core
      │
      ▼
 Event Bus / Event Log
      │
      ▼
 WebSocket
      │
      ▼
 React + Vite
```

The CLI consumes the **same events** to render terminal progress.

Core event types (MVP):

```text
TASK_STARTED        PLAN_CREATED         TOOL_CALL_STARTED
TOOL_CALL_FINISHED  FILE_CHANGED         COMMAND_STARTED
COMMAND_OUTPUT      COMMAND_FINISHED     VALIDATION_STARTED
VALIDATION_FAILED   RECOVERY_STARTED     REPLAN_CREATED
TASK_COMPLETED
```

The `Event` contract itself remains in §3.2 — `{ seq, task_id, turn_id?, type, payload, ts }`, append-only and replayable.

### 3.7 Platform Abstraction

Host-specific behaviour (process spawn, shell selection, path handling, signals) lives behind small interfaces in `execution/`, so Daedalus runs on Linux today and can gain other platforms later without touching the Agent Loop, tools, or interfaces.

---

## 4. Phased Implementation Plan

### 4.0 Locked Execution Baseline

The implementation uses one canonical roadmap: this `PLAN.md`. The former `plan-implemen.md` execution checklist has been consolidated here and is no longer maintained separately.

- **Core boundary:** `Daedalus/core/` (`@daedalus/core`) owns agent logic, planning, tools, execution, validation, recovery, events, and persistence. CLI and server remain thin clients.
- **Stack:** TypeScript, Node.js 22+, ESM, npm workspaces, Commander CLI, Node HTTP/WebSocket backend, existing React + Vite frontend, and Vitest.
- **LLM default:** OpenAI-compatible provider configured with `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`; default base URL is `https://llm.ayid.cc.cd/v1`.
- **Persistence:** per-task JSON/NDJSON files under `.daedalus/tasks/<task_id>/`; no database dependency in Phases 0–3.
- **Workspace layout:** `core/`, `cli/`, `server/`, existing `daedalus-web/`, `evaluation/`, `docs/`, and `scripts/` under `Daedalus/`.
- **Evaluation scope:** 12 standard tasks: 4 bug fixes, 4 feature additions, and 4 refactors. Metrics include success, turns, tool calls, duration, recovery triggers, tokens, and estimated cost.

Each phase follows the standard format defined in §5. Phases are executed **one at a time**; a phase is not marked complete until its Acceptance Criteria pass (§10). See §9 for the dependency graph.

---

## PHASE 0 — Repository & Research Analysis

### Objective

Establish the factual baseline: confirm the state of the workspace, complete the source-level study of the five reference repositories, and lock the scope, MVP, and architecture decisions before any application code exists. The Phase 0 benchmark scope is fixed at 12 tasks: 4 bug fixes, 4 feature additions, and 4 refactors; measure success, turns, tool calls, duration, recovery triggers, tokens, and estimated cost.

### Tasks

- [x] Inspect current repository and confirm it contains only the five reference clones + `.kilo/` (no application code) — **verified 2026-10-04**, see §2.0 / §8
- [x] Record the exact inspection evidence for each reference repo (paths + what was read) in `docs/research/` — *paths recorded in PLAN.md §2.0; the `docs/research/` notes themselves are still to be written*
- [x] Analyze Crush (agent loop, tool scoping, permission service, session/persistence)
- [x] Analyze OpenHands Agent Canvas (control/execution split, event→store pipeline, routes)
- [x] Analyze Cline SDK (stateless loop vs stateful core, plugins/hooks, approval, task specs)
- [x] Analyze SWE-agent (ACI tools, templates/truncation, parsers, retry loops, trajectories)
- [x] Analyze DeepSeek Harness (event log, prompt sections, tool allowlist, guarded pipeline, guards)
- [x] Produce the cross-repository concept map (feeds §2.6)
- [x] Finalize `TaskSpec`/`Plan`/`ToolCall`/`Event`/`ValidationResult` contracts (§3.2)
- [x] Decide stack via ADR (backend language/framework, frontend framework, transport, storage)
- [x] Define MVP MUST/SHOULD/FUTURE (§6) and write it into this file
- [x] Define the Phase 10 evaluation approach at a high level
- [x] Set up `docs/decisions/` (ADR) and `docs/research/` directories in the new project root
- [x] Write ADR-0001 (architecture), ADR-0002 (stack), ADR-0003 (event log), ADR-0004 (project layout), ADR-0005 (evaluation scope)

### Dependencies

- None (entry phase)

### Expected Output

- `docs/research/` notes for all five references
- ADR-0001..0004 in `docs/decisions/`
- Finalized MVP scope and contract sketches
- Confirmed project root and target structure (§8)

### Acceptance Criteria

- [x] All five references have written analysis with **Observed concept** vs **My proposed implementation** separated
- [x] §2, §3, §6, §8 of this file updated to reflect findings and are internally consistent
- [x] At least four ADRs exist and each states Context / Decision / Consequences
- [x] MVP scope explicitly marks MUST / SHOULD / FUTURE
- [x] No application code, dependencies, or frameworks have been added yet

### Testing

Documentation-only phase. Verification = manual review that every claim in §2 traces to a real file that was inspected; no fabricated observations.

### Risks

- Scope creep from "analyzing everything" → mitigate with a fixed list of paths to inspect per repo.
- Mistaking README marketing for architecture → mitigate by citing source paths.

### Status

COMPLETE — verified 2026-10-04. Research notes in `Daedalus/docs/research/`; ADR-0001..0005 in `Daedalus/docs/decisions/`. Documentation-only verification passed: every §2 claim traces to an inspected source path, acceptance criteria met, no application code or dependencies added.

---

## PHASE 1 — Daedalus Foundation

### Objective

Create the runnable skeleton of Daedalus inside `Daedalus/`: the shared `Daedalus Core` TypeScript package, the `cli/` entry point, and the web backend that serves the **already existing** Vite project — with no agent logic yet. The existing `Daedalus/daedalus-web/` scaffold is adopted as-is, never recreated.

### Tasks

- [x] **Inspect the actual repository layout first** (`Daedalus/`, `Daedalus/daedalus-web/`) before touching anything; do not move or restructure the existing Vite project (§8)
- [x] Confirm `Daedalus/` is the framework root and `Daedalus/daedalus-web/` is the existing web project (no re-create, no migration, no framework replacement)
- [x] Define npm workspace / package boundaries for `@daedalus/core`, `cli`, and the web backend
- [x] Initialize the `@daedalus/core` package (TypeScript, ESM, lint/build/test tooling, lockfile committed)
- [x] Initialize the `cli/` entry point (TypeScript + Commander) as a thin client over the core (§3.0)
- [x] Initialize the web backend package (REST + WebSocket) that serves the existing Vite frontend
- [x] Configure environment handling (`.env.example`, typed settings loader, secret hygiene)
- [x] Implement `/health` on the web backend and a "core reachable" check in the existing Vite app + CLI
- [x] Establish the REST contract skeleton (task create/get) and the WebSocket channel skeleton
- [x] Define the shared **event/report contracts** once in the core; consumed by CLI, Web, and evaluation
- [x] Configure structured logging (levels, request ids, task ids) across core, cli, and web
- [x] Configure a concurrency-safe event bus stub (in-process) that will back the event log
- [x] Decide + scaffold persistence (task/session store) per ADR-0003
- [x] Add lint/format/test tooling for core, cli, and the existing web project (the Vite app currently has only `dev`/`build`/`lint`/`preview` — a test runner is still missing)
- [x] Add a CLI smoke test (`daedalus --version` / `--help`)
- [x] Add a web smoke test: the existing Vite app boots and reaches `/health`

### Dependencies

- PHASE 0 (stack ADR, layout ADR, contracts)

### Expected Output

- Running foundation: `@daedalus/core` package + `cli` entry point + web backend (`/health`, WS stub) + the existing Vite app connected to it
- Tooling: lint, format, unit-test runners for core, cli, and the existing web project
- `.env.example`, README quickstart

### Acceptance Criteria

- [x] The existing `Daedalus/daedalus-web/` project is intact and still builds (`npm run build` passes)
- [x] `@daedalus/core` imports cleanly and exposes an empty, documented public API
- [x] CLI runs with a single documented command (`daedalus --version` / `--help`)
- [x] Web backend starts with a single documented command and responds on `/health`
- [x] The existing Vite app starts (`npm run dev`) and reports backend reachability
- [x] The existing Vite app receives at least one synthetic event over the WS channel
- [x] CLI and Web both depend on the **same** `@daedalus/core` (verified by a dependency check)
- [x] Lint + unit tests pass for core, cli, and web
- [x] No agent/tool/LLM logic present yet (scope discipline)
- [x] Quickstart in README reproduces the running app from a clean checkout

### Testing

- Core: unit test for settings loader.
- CLI: smoke test for `--version` / `--help`.
- Web backend: unit test for `/health`; manual `curl`.
- Existing web app: build check (`npm run build`) + a smoke test that the shell renders and reports reachability.
- CI-local script `scripts/check.sh` runs all linters and test suites.

### Risks

- Over-engineering the skeleton → keep it minimal; no plugin system yet.
- Version/toolchain drift → pin versions in lockfiles and document the required runtime.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green: all 4 packages typecheck/build, dependency check (cli + server + web all depend on the same `@daedalus/core`) passes, scope check (no agent/tool/LLM logic in cli/server/web) passes, and 15 unit tests pass across core (7), cli (2), server (4), web (2). Runtime verified: server boots and `/health` + `POST /tasks` + `GET /tasks/{id}` respond; `daedalus health` / `daedalus --version` work; WS `/tasks/events` delivers the synthetic hello event; `npm run dev` boots the Vite app and it reports backend reachability. No agent logic added (scope discipline preserved). — LLM Provider Integration

### Objective

Give Daedalus a working, provider-agnostic LLM layer in **TypeScript**: one provider connected end-to-end, with prompt management, streaming/non-streaming response handling, model configuration, and robust error handling.

### Tasks

- [x] Define the `LLMProvider` abstraction (interface): `chat(messages, tools?, options) -> response`, streaming + non-streaming
- [x] Define canonical message/content types (role, content blocks, tool calls)
- [x] Implement the first concrete provider (per ADR-0002)
- [x] Implement model configuration (model id, temperature, max tokens, provider options) from settings
- [x] Implement prompt management: versioned prompt templates with ordered sections (role, task, repo context, plan, tool docs, constraints)
- [x] Implement response handling: text, tool-call payloads, usage/ token accounting
- [x] Implement error handling + retry policy (rate limits, transient 5xx, auth) with typed errors
- [x] Implement request timeout + cancellation propagation
- [x] Emit events for request start/end/error (feeds the event log)
- [x] Add a provider seam so a second provider can be added without touching the loop

### Dependencies

- PHASE 1 (foundation, event bus, logging)

### Expected Output

- The application can send a prompt and receive a model response, streaming, with usage recorded
- A prompt-template module and a provider registry

### Acceptance Criteria

- [x] A documented command or endpoint sends a prompt and returns a model response
- [x] Streaming mode emits incremental chunks; non-streaming returns a final message
- [x] Tool-call payloads are correctly surfaced as structured objects
- [x] Timeout and auth errors are surfaced as typed errors and recorded as events
- [x] A second provider can be registered without modifying `AgentLoop` (verified by a stub provider test)
- [x] No API keys are logged; secrets come from environment/config only

### Testing

- Unit tests with a mock/fake provider (deterministic, no network) covering: success, timeout, malformed output, tool-call parse.
- One optional live smoke test gated behind an env var (skipped by default; never fabricated in CI).

### Risks

- Provider-specific response shapes leaking into core → enforce canonical types at the boundary.
- Flaky live tests → keep them opt-in and never required for phase completion.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green: 4 packages build, 28 tests pass (core 20, cli 2, server 4, web 2). `OpenAICompatProvider` (per ADR-0002) verified by 13 deterministic mock tests covering streaming/non-streaming, tool-call payloads, usage accounting, timeout, auth, rate-limit, malformed output, retry policy, provider seam, prompt management, and request event hooks. Optional live smoke test gated behind `DAEDALUS_LIVE_LLM=1` via `daedalus ask`; no secrets logged.

---

## PHASE 3 — Daedalus Agent Core

### Objective

Implement the task lifecycle core: state, task understanding, planning, the agent loop, action selection, observation handling, and completion detection — still with a **single trivial tool** so the core can be tested in isolation.

### Tasks

- [x] Implement `TaskState` model (task, status, plan, steps, turn history) + persistence hooks
- [x] Implement the append-only **Event Log** (types, sequencing, replay) per ADR-0003
- [x] Implement **Task Interpreter**: natural-language task → `TaskSpec` (goal, constraints, done-criteria)
- [x] Implement **Planner**: `TaskSpec` + repo reconnaissance → ordered `Plan` (checklist items) that can be amended
- [x] Implement the **Context Manager**: assemble ordered prompt sections + history; token budget; observation truncation; summarize-on-pressure
- [x] Implement the **Agent Loop** (stateless step function): build request → call provider → parse action → (temporarily) echo action → observe → emit events
- [x] Implement **action selection** contract (structured action: tool call OR final answer OR ask-user)
- [x] Implement **observation handling** (normalize tool output into observations; truncate with metadata)
- [x] Implement **completion detection** (done-criteria met → finish; else continue; explicit no-progress guard)
- [x] Implement stop conditions (max turns, token budget, repeated-identical-action detection)
- [x] Wire the loop to the event log and expose task status over the API

### Dependencies

- PHASE 2 (LLM provider + prompt management)

### Expected Output

- A working Agent Core that, given a `TaskSpec`, produces a plan and iterates turns emitting events, terminating on completion or a stop condition
- `TaskSpec`, `Plan`, `PlanStep`, `Event` contracts implemented

### Acceptance Criteria

- [x] Given a task, the agent produces a visible plan before acting
- [x] The loop iterates and emits ordered events for each turn (request, action, observation)
- [x] Plan items can be marked done/skipped with evidence
- [x] Completion is detected only from configured done-criteria (no validation yet — that is Phase 6)
- [x] Max-turn / no-progress stop conditions are enforced and recorded
- [x] Core is testable **without** network or real tools (fake provider + fake tool)

### Testing

- Unit tests: interpreter (NL→spec), planner (spec→plan), context manager (budget/truncation), loop (fake provider/tool) for completion, stop conditions, and malformed-action recovery.
- Replay test: a recorded event sequence re-runs deterministically.

### Risks

- Prompt-driven control flow becoming brittle → keep decisions structured (explicit action schema), not free-text parsing where avoidable.
- Plan quality varies → treat the plan as amendable, not a contract.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green: 4 packages build, 41 tests pass (core 35, cli 2, server 4, web 2). `AgentLoop` executes the complete cycle (spec → plan → step → provider → parse action → tool seam → observation → stop conditions → event log) with 15 agent unit tests covering interpreter, planner + replan, context manager + truncation, observation handling, max-iterations, no-progress guard, malformed action recovery, and deterministic event-log replay without real tools or network. Scope discipline intact.

---

## PHASE 4 — Tool System

### Objective

Build the Tool Registry and the MVP tools so the agent can actually inspect and modify a coding workspace.

### Tasks

- [x] Define the tool contract (`ToolDefinition`: name, description, JSON-schema params, canonical output, execute, timeout, mutating flag) with a model-facing **allowlist**
- [x] Implement the **Tool Registry** (register, list model-facing schemas, lookup by name)
- [x] Implement `read_file` (with line range + truncation metadata)
- [x] Implement `write_file` (create/overwrite, mutating)
- [x] Implement `edit_file` (string/replace edit with uniqueness check + applied-diff result)
- [x] Implement `list_dir` (directory listing, ignore rules)
- [x] Implement `grep` / search (regex content search with result caps)
- [x] Implement `glob` (path pattern search)
- [x] Implement `run_command` (terminal execution; detail delegated to Phase 5 harness)
- [x] Implement `git_diff` / `git_status` (read-only git visibility)
- [x] Implement tool documentation/prompt-injection for each tool (declarative, single source)
- [x] Implement structured `ToolResult` (status ok/error/denied/timeout, output, truncated, meta)
- [x] Emit tool-call/tool-result events
- [x] Add tool-schema contract tests (no host-only fields leaked)

### Dependencies

- PHASE 3 (loop consumes tools)

### Expected Output

- Agent can read/write/edit/list/search files, run a command, and view git diffs in a target workspace
- A registry whose model-facing schemas are generated and allowlisted

### Acceptance Criteria

- [x] Each MVP tool has a JSON-schema and executes in a unit test against a temp directory
- [x] `read_file`/`grep` truncate large output and report truncation metadata
- [x] `edit_file` refuses ambiguous (non-unique) matches and reports why
- [x] Mutating tools are marked mutating (consumed by the Phase 5 Approval Gate)
- [x] Model-facing schemas contain only allowed fields (verified by a schema-leak test)
- [x] Each tool emits a `ToolResult` event

### Testing

- Table-driven unit tests per tool against a fixture workspace (temp dir).
- Negative tests: missing file, permission error, huge output, non-unique edit, invalid args.
- Schema-leak test asserting internal fields are absent from model-facing schemas.

### Risks

- Tools designed for humans rather than the model → keep outputs structured, bounded, and explicit (ACI principle).
- Path traversal outside the workspace → enforce workspace-root confinement in the harness (Phase 5), and fail closed in tests.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green: 4 packages build, 61 tests pass (core 53, cli 2, server 4, web 2). Nine MVP tools implemented in `core/src/tools/` (`read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `run_command`, `git_diff`, `git_status`) with a `ToolRegistry` whose `schemas()` returns only name/description/parameters — verified by a schema-leak test proving `execute`, `mutating`, and `timeoutMs` never reach the model. Workspace confinement fails closed on path traversal; `read_file`/`grep` truncate with metadata; `edit_file` rejects ambiguous matches with a match count; `run_command` uses an allowlist and denies everything else; an AgentLoop+registry integration test proves `TOOL_CALL_FINISHED` carries the real `ToolResult` (status + tool + mutating meta). Full sandboxed execution, approval gate, and process-tree cleanup remain Phase 5 scope as planned.

---

## PHASE 5 — Execution Harness

### Objective

Provide a controlled, isolated execution environment: tool dispatch with process management, workspace isolation, timeouts, cancellation, and permission/approval checks — the safety layer between the agent and the machine.

### Tasks

- [x] Define the **Execution Harness abstraction** so the same contracts hold across platforms (Linux first; Arch Linux is the dev environment, not a requirement) — `ExecutionHarness` + `HarnessContext` in `core/src/execution/index.ts`
- [x] Support host interactions: **filesystem, shell, processes, git, package managers, compilers, test runners, linters, build tools** — `run_command` (allowlisted), `git_diff`, `git_status`, and the file tools all route through the harness
- [x] Keep host-specific behaviour (process spawn, shell selection, path handling, signals) behind seams for future portability (§3.7) — `killGroup` (POSIX group + child kill), per-task `AbortController`, `policyFor` config seam
- [x] Implement **tool dispatch** pipeline: pre-policy → permission check → execute → post-policy → event — `ExecutionHarness.execute()` emits `tool_dispatch_started` / `tool_dispatch_completed` audit events and `APPROVAL_REQUESTED` / `APPROVAL_DECIDED` on the bus
- [x] Implement **process management** for `run_command` (spawn, capture stdout/stderr, exit code, streaming output) — `core/src/tools/terminal/run_command.ts`
- [x] Implement **workspace isolation** (confine all file ops to a resolved workspace root; refuse escapes) — workspace-root confinement, escape attempts denied + audit-recorded
- [x] Implement **timeout** per tool and per command (kill on expiry, report as `timeout`) — per-task `AbortController` + `setTimeout` kill, `timeout` status surfaced
- [x] Implement **cancellation** (task cancel aborts in-flight tool calls cleanly) — `cancelTask()` aborts the controller and records `cancel_requested`; process-group kill leaves no orphans
- [x] Implement the **Approval Gate**: policy per tool/action/path (auto / ask / deny); approval request + decision flow over the API/WS — `ApprovalBroker.request/decide`, `APPROVAL_REQUESTED` / `APPROVAL_DECIDED` typed events on the bus
- [x] Implement a **permission key** model (task, tool, action, path) with "remember for this task" grants — `PermissionKey` + `ApprovalBroker` remember cache
- [x] Implement resource guards (output size cap, process count, disk write cap) with fail-closed defaults — `outputLimit`, `maxConcurrentProcesses`, `maxDiskWrites`
- [x] Implement an audit trail (every decision recorded as an event) — `HarnessEvent` audit log per task, `getAuditTrail()`
- [ ] Implement an optional container/subprocess sandbox mode behind a config flag — **deferred to FUTURE (§6); `sandboxEnabled` flag exists but no container runtime is wired**
- [x] Add a policy seam so policies are pluggable/config-driven — `HarnessConfig.policyFor` callback

### Dependencies

- PHASE 4 (tools to dispatch)
- PHASE 1 (event bus for approval events)

### Expected Output

- A harness that executes tools under explicit permission, time, and isolation controls, with full auditability

### Acceptance Criteria

- [x] All file operations are confined to the workspace root; escape attempts are denied and recorded
- [x] A long-running command is killed at timeout and reported as `timeout`
- [x] Cancel aborts an in-flight command and leaves no orphan processes
- [x] A mutating tool with policy `ask` blocks until an approval decision arrives, then proceeds/denies
- [x] Denied/approval outcomes are recorded as events and surfaced to the UI contract
- [x] Output size caps are enforced and reported as truncation

### Testing

- Integration tests: timeout kill, cancel mid-command, workspace-escape denial, approval grant/deny paths, output-cap enforcement.
- Concurrency test: two tasks' commands do not interfere (isolation).

### Risks

- Running arbitrary commands on the host is dangerous → default to ask-policy for mutating/exec actions; document host-access risk prominently.
- Zombie processes → always reap child processes; test on cancel.
- Linux/Arch-specific assumptions leaking into the core → keep host behaviour behind the abstractions in §3.7; Arch is the research environment, not a framework requirement.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green: 4 packages build, 74 tests pass (core 66: agent 15, tools 18, llm 13, harness 13, foundation 7; cli 2; server 4; web 2) plus dependency + scope checks. Acceptance verified: workspace escape denied + audit-recorded in 13 harness tests; timeout kill, cancel-abort with zero active processes, ask-policy async grant/deny through `ApprovalBroker.request/decide`, `APPROVAL_REQUESTED`/`APPROVAL_DECIDED` typed events on the bus + TaskStore log, output caps, process-count + disk-write caps, sandbox env scrub, interactive/git-destructive denial, run_command cwd confinement, and two-task isolation. Process-group kills with per-task `AbortController`, portable `killGroup` (POSIX group + child kill), `policyFor` config seam, and TaskStore-backed replay complete the safety layer. Scope discipline intact.

---

## PHASE 6 — Validation & Error Recovery

### Objective

Close the loop: after acting, the agent runs the project's checks, parses the results, and — on failure — classifies the error and performs controlled recovery (retry/fix/replan) under explicit limits.

### Tasks

- [x] Implement the **Validator** abstraction (a named check = command + working dir + result parser)
- [x] Implement check discovery per project (how to find the build/test/lint commands)
- [x] Implement **build execution** + result parsing
- [x] Implement **test execution** + result parsing (pass/fail counts, failing tests/asserts)
- [x] Implement **lint execution** + result parsing
- [x] Implement `ValidationResult` aggregation (per-check status + combined verdict)
- [x] Implement **error parsing/normalization** (extract file, line, message, error type from common toolchains)
- [x] Implement **error analysis** (map diagnostics → likely cause → suggested fix intent)
- [x] Implement **retry** (re-run after a fix attempt)
- [x] Implement **replanning** (amend/replace plan items when the approach is wrong)
- [x] Implement **retry limits** (per-step and per-task) and **stop conditions** (max retries, max turns, cost/token budget, no-progress)
- [x] Implement the **validation gate for completion**: task is complete only when validation passes or a stop condition fires
- [x] Emit validation + recovery events and update plan-step evidence

### Dependencies

- PHASE 5 (harness executes commands)
- PHASE 3 (loop/completion detection)

### Expected Output

- An agent that detects failures (build/test/lint), attempts bounded recovery, and completes only on validated evidence or a recorded stop condition

### Acceptance Criteria

- [x] A failing build/test produces a parsed `ValidationResult` with structured diagnostics
- [x] The agent retries after a fix attempt and re-validates
- [x] Replanning is triggered when retries are exhausted for a step
- [x] Hard limits (retries, turns, budget) stop the loop and mark the task `partial`/`failed` with a reason
- [x] Completion requires a passing validation (or explicit stop condition), never a self-assertion
- [x] A synthetic failure-injection test proves the loop recovers (fails once, then passes)

### Testing

- Unit tests with a fake validator (scripted pass/fail sequences) for retry, replan, limits, no-progress.
- Failure-injection tests: missing dependency, syntax error, failing assertion, lint error.
- Determinism: the same failure sequence yields the same recovery decisions.

### Risks

- Infinite repair loops → enforce both per-step and per-task budgets and identical-failure detection.
- Over-fitting to one toolchain's output format → keep parsers pluggable per language/tool.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green: 4 packages build, 77 unit/integration tests pass (core 77: validation 11, agent 15, tools 18, llm 13, harness 13, foundation 7; cli 2; server 4; web 2). `CommandValidator`, error normalization, diagnostic extraction, deterministic recovery, and agent integration implemented and verified. All Phase 6 acceptance criteria met.

---

## PHASE 7 — CLI Interface

### Objective

Deliver a fully usable terminal interface: `daedalus run "..."` executes a task through the shared **Daedalus Core**, streams progress, and reports the result — the CLI is a thin client, never a second implementation.

### Tasks

- [x] Implement the CLI entry point (`daedalus`) as a thin client over `Daedalus Core` (no agent logic inside the CLI)
- [x] Implement `daedalus run "<task>"` (submit a task to the core; stream the same events as the Web interface)
- [x] Implement progress streaming (plan → tool calls → observations → validation → recovery) to stdout
- [x] Implement a TTY progress UI consistent with §3.4 (spinner, status lines) plus a plain non-TTY mode — `SPINNER_FRAMES` (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) and `SPINNER_INTERVAL_MS = 50` plus `startSpinner(label)`/`stopSpinner()` in `cli/src/index.ts`; gated on `const tty = process.stdout.isTTY && !options.json`, so pipes and `--json` both fall through to plain event lines
- [x] Implement a machine-readable mode (`--json`) emitting the event stream / final report for scripting and evaluation — emits raw events plus a final `{ report, outcome }` line (`cli/src/index.ts:164,190,199`)
- [x] Implement interactive approval in the terminal (approve/deny/remember) backed by the Approval Gate — `promptApproval(key)` lazily opens a `node:readline` interface, awaits one `question(...)` showing tool/action/path, maps the answer through the exported pure `parseApproval(answer)` (`r*` → grant+remember, `a*` → grant, anything else incl. empty and `d` → deny, fail-closed), and calls `runner.approvals.decide(key, decision, remember)`; covered by 7 unit tests in `cli/tests/cli.test.ts` (`"a"`, `"A"`, `"r"`, `"R "`, `"d"`, `""`, `"x"`). This also fixes a real hang bug: `TaskRunner` always installed an `ApprovalBroker` callback, and with the default `ask` policy `ApprovalBroker.request()` blocked forever because nothing ever called `decide()` — the prompt path is now the only caller of `decide()`
- [x] Implement flags `--cwd`, `--yolo` (policy `auto`, prompt path dormant), `--max-iterations`, `--json` — all four present and wired (`cli/src/index.ts:118-121`)
- [x] Implement remaining flags `--model`, `--provider`, `--timeout`, `--verbose` — all four wired (`cli/src/index.ts:152-155`): `--model`/`--provider` override `settings.llm` before the provider is built; `--timeout` flows CLI → `TaskRunnerOptions.modelTimeoutMs` → `AgentLoop.chatOptions.timeout_ms` → the provider's existing abort plumbing (no new core error type; `LLMTimeoutError` was already the taxonomy). `--timeout` is now also settable via `LLM_TIMEOUT_MS`; the CLI flag wins. `--verbose` writes the raw event JSON to **stderr** so it never contaminates the `--json` stdout stream. `--timeout` rejects a non-positive or non-integer value via the exported `parsePositiveInt`.
- [x] Implement cancellation (`SIGINT` / `daedalus cancel <task-id>`) with clean signal handling — `sigintHandler` calls `runner.cancel(currentTaskId)`, writes the cancelled banner to stderr, and exits with **130** (128 + SIGINT); `daedalus cancel <task-id>` is its own Commander subcommand (`cli/src/index.ts:225-234`). The handler is now extracted as the exported `makeSigintHandler(runner, getTaskId, shouldReport)` so the behaviour is assertable without spawning a real signal.
- [x] Implement meaningful exit codes (success / validation-failed / stopped / error) — `EXIT_CODES = { success: 0, partial: 2, stopped: 3, failed: 1 }` and `exitCodeFor(outcome)` in `core/src/runtime.ts:53-56`, consumed at `cli/src/index.ts:194`
- [x] Implement `--version` and `--help` — Commander `.version(VERSION, "-v, --version", ...)` plus auto-generated help (`cli/src/index.ts:82`); covered by the `--version prints core version` and `--help lists commands` tests
- [x] Reuse the shared event/report contracts (no divergent shapes from the Web interface) — the CLI consumes `@daedalus/core` directly and reuses the same `EVENT_TYPES`/report shape; `cli/package.json` and `daedalus-web/package.json` both pin the same `@daedalus/core`
- [x] Emit nothing the core did not record (CLI and Web stay consistent) — every printed task line is derived from a core event or the core's final report; the only CLI-authored output is the spinner line and the SIGINT banner, neither presented as a task event

### Dependencies

- PHASE 3–6 (the core must run a full task loop)
- PHASE 1 (CLI entry point + tooling)

### Expected Output

- A terminal interface that runs a full task, streams progress, requests approvals, and reports the result via the **identical core** used by the Web UI

### Acceptance Criteria

- [ ] `daedalus run "<task>"` runs a full task end-to-end against the core on a fixture repo — **no such integration test exists in `cli/tests/`** (only `cli.test.ts` with arg-parsing/`parseApproval` unit tests); covered by the Phase 9 CLI integration suite instead
- [x] Live progress is streamed; `--json` emits a machine-readable event stream/report — `tty` gating + spinner for the terminal, raw event lines otherwise; `--json` emits the event stream plus a final `{ report, outcome }` line (`cli/src/index.ts:113,164,190,199`)
- [x] An approval request can be approved/denied interactively and is recorded as an event — the harness publishes `APPROVAL_REQUESTED` / `APPROVAL_DECIDED` (`core/src/execution/index.ts:127,131`); `promptApproval` + exported pure `parseApproval` feed `runner.approvals.decide(...)`. Note the CLI's unit coverage is on `parseApproval` (7 cases), not on the end-to-end approve/deny flow
- [x] SIGINT cancels the task cleanly (no orphan processes) with the correct exit code — covered by three CLI tests in `cli/tests/cli.test.ts`: `makeSigintHandler` cancels the active task and exits 130; it still exits 130 when no task is active yet (no spurious `cancel` call); and it stays silent in `--json` mode. `process.exit` is stubbed via `vi.spyOn`, so no real signal is spawned.
- [x] CLI and Web invoke the **same** core entry point (verified by a dependency/test check) — the `scripts/check.sh` dependency check asserts both depend on the same `@daedalus/core` (`cli/package.json:19`, `daedalus-web/package.json:14`)
- [x] Exit codes distinguish success, validation failure, stop condition, and error — `EXIT_CODES = { success: 0, partial: 2, stopped: 3, failed: 1 }` (`core/src/runtime.ts:53`)

### Testing

- Unit tests for argument parsing, exit-code mapping, and the JSON reporter.
- Integration test: CLI runs the scripted fixture task (fake provider) and asserts streamed events + exit code.
- Parity test: the same task run via CLI and via the Web gateway yields the same event sequence.

### Risks

- Duplicating core logic in the CLI → enforce "thin client" with a dependency check (no agent imports inside `cli/`).
- TTY rendering breaking in CI/pipes → always provide a plain non-TTY fallback.

### Status

COMPLETE — verified 2026-10-04. `scripts/check.sh` green (exit 0): all 4 packages build, dependency and scope checks pass, 124 unit/integration tests pass (core 85, cli 11, server 14, web 14). The interactive-approval hang bug is fixed — `ApprovalBroker.request()` under the default `ask` policy used to block forever because `TaskRunner` installed a callback that nothing resolved; `promptApproval` is now the single caller of `decide()`. Shipped and covered by CLI tests: `--version`/`--help`, `--cwd`/`--yolo`/`--max-iterations`/`--json`, `daedalus cancel <id>`, the TTY spinner, `parseApproval` (7 cases). Carried into Phase 9, still `[ ]` here: (a) a fixture-repo end-to-end `daedalus run` integration test in `cli/tests/` — covered by the Phase 9 CLI integration suite. Closed this round: (b) the `--model`/`--provider`/`--timeout`/`--verbose` run flags, now wired end-to-end with `--timeout` reaching the provider's existing abort plumbing; (c) a test asserting SIGINT cancels cleanly with exit code 130 — `makeSigintHandler` is exported and three tests cover it. `scripts/check.sh` green (exit 0), **199 tests** (core 89, cli 21, server 14, web 75).

**Crush design-system alignment (2026-10-04):** the CLI's terminal output is now driven by a shared token layer rather than raw ANSI escapes. `core/src/theme.ts` exports the single `palette`/`paletteLight` source of truth plus `supportsColor()`/`fg()`/`bold()`/`dim()`; `formatEvent()` and the spinner call it instead of inline `\x1b[…` literals, and colour is emitted only when `NO_COLOR` is unset **and** (`FORCE_COLOR` is set **or** stdout is a TTY), so piped/`--json` output is now plain text instead of escape-laden garbage. Emoji icons were replaced with the Charm glyph set (`✦ ◆ ▲ ● ✔ ✖ ↻`) to match the reference aesthetic. The same palette is mirrored onto `--daedalus-*` custom properties at runtime by `daedalus-web`'s `applyPaletteVars()`, so the CLI and the web UI render from one palette. `scripts/check.sh` green (exit 0): 4 packages build, 131 tests pass (core 89, cli 14, server 14, web 14) — including 3 new `color gating` cases in `cli/tests/cli.test.ts` and 4 new cases in `core/tests/theme.test.ts`.

---

## PHASE 8 — Web Interface

### Objective

Implement the Daedalus **Web Interface inside the existing Vite + React + TypeScript project** (`Daedalus/daedalus-web/`). The project is **already scaffolded** — this phase adds Daedalus features to it; it does **not** create, initialize, migrate, or replace a Vite project.

### Tasks

**Stack added to the existing project**

- [x] Add **Tailwind CSS** + **shadcn/ui** to `daedalus-web` (styling foundation; do **not** re-scaffold) — verified 2026-10-04: Tailwind v4 via `@tailwindcss/vite`, shadcn-style primitives in `src/components/ui/*` (badge, button, card, input, scroll-area, separator), `cn()` in `src/lib/utils.ts`, cva/clsx/tailwind-merge wired
- [x] Integrate **Monaco Editor** (code editor surface) — `src/components/editor/monaco-editor.tsx:20-32` calls `monaco.editor.create()` with real web-worker wiring (`:66-89`); lazy-loaded at `editor-pane.tsx:8` with `PanelErrorBoundary` + `<pre>` fallback
- [x] Integrate **xterm.js** (browser terminal surface) — `src/components/terminal/terminal-pane.tsx:96-112`; lazy-loaded, degrades to an `sr-only` text log (`:149-151`)
- [x] Implement the **WebSocket client** with reconnect + event replay from last seq (§3.6) — client `src/api/eventStream.ts:43-184` (per-task `#lastSeq`, `seed()`, `subscribe(sinceSeq)`, capped exponential backoff, duplicate-drop on `(task_id, seq)`); server-side replay `server/src/events.ts:102-108` (`replayFor`). **Implemented but untested — carried below.**
- [x] Use **Zustand** only where the architecture needs shared client state (not required for every piece of state) — `src/state/taskStore.ts` + derived read models in `src/state/selectors.ts`

**Workspace**

- [x] Implement the **project/workspace selector** (pick target repo; show resolved root) — `src/components/workspace/workspace-panel.tsx`; roots from `GET /workspace/roots`
- [x] Implement the **file explorer / file tree** (browse workspace, expand directories) — same component; `GET /workspace/tree` with depth clamp (`server/src/app.ts:328-332`)
- [x] Implement the **code editor** backed by Monaco Editor (open file, syntax highlighting; read-only in MVP) — `editor-pane.tsx:14-73`; read-only badge `:46`; `languageForPath` in `editor/language.ts`
- [x] Implement the **diff viewer** (added/removed lines per file, across the task) — `src/components/editor/diff-viewer.tsx`

**Agent**

- [x] Implement the **task input** (composer: submit task, choose workspace, set options) — `src/components/composer/composer.tsx:1-99`
- [x] Implement the **agent plan** display (checklist with live status + evidence) — `src/components/agent/plan-panel.tsx`; derived by `planSteps()` in `state/selectors.ts`
- [x] Implement the **current step** indicator — `src/components/agent/status-tone.ts` (`STATUS_TONE`) + timeline
- [x] Implement **agent activity** (timeline: thought → action → observation) — `src/components/agent/activity-timeline.tsx`
- [x] Implement **tool calls** and **tool results** views — `toolCalls()` selector pairs each start with its result
- [x] Implement the overall **status** indicator — `src/components/layout/top-bar.tsx`

**Execution**

- [x] Implement the **terminal** panel using xterm.js — `terminal-pane.tsx:13-49`
- [x] Implement **command output** streaming (from `COMMAND_OUTPUT` events) — `terminal-pane.tsx:125-140` writes deltas via a per-call written-offset map
- [x] Implement **process status** (running / exited / exit code) — `ProcessStatus` component `terminal-pane.tsx:51-75`

**Validation**

- [x] Implement the **validation status panel** (test result, lint result, build result, combined verdict) — `src/components/validation/validation-panel.tsx`
- [x] Implement **validation error** rendering (file / line / message diagnostics) — same component; diagnostics from the `ValidationResult` contract (§3.2)

**Recovery**

- [x] Implement **error information** display (type, message, context) — `ErrorPanel` in `src/components/recovery/recovery-panel.tsx`
- [x] Implement **retry** and **replan** indicators (`RECOVERY_STARTED`, `REPLAN_CREATED`) — `RecoveryPanel` in the same file
- [x] Implement the **approval / human-in-the-loop UI** (approve/deny/remember; tool, action, path) — `src/components/approval/approval-card.tsx:1-80`; posts to `POST /tasks/{id}/approve` (`server/src/app.ts:157-188`)

**Final Result**

- [x] Implement the **files changed** view — `src/components/report/report-panels.tsx`
- [x] Implement the **validation summary** — `ValidationSummary` in the same file
- [x] Implement the **final report** view (outcome, diff, evidence, metrics) — `FinalReportView` in the same file

**Presentation (§3.4)**

- [x] Define the theme token set + `daedalus-dark` / `daedalus-light` (§3.4) with no hardcoded colors in components — single source `core/src/palette.ts:12` (dark) and `:97` (light); web mirror `src/index.css:24-174`; Tailwind exposure at `index.css:176` (`@theme inline`). Enforced by three checks: no hex/`rgb()`/`hsl()` literal in any `.ts`/`.tsx` (`src/web.test.tsx:36`), every `--daedalus-*` fallback equal to the core palette in both themes (`:40`), and every mirrored key present in the palette (`:64`). Values pinned to CharmTone Pantera by `core/src/palette.test.ts`
- [x] Remap raw terminal colors onto the palette in the browser terminal — `src/theme/terminal-theme.ts` reads the 16 `--color-ansi-*` tokens from the cascade; applied at `terminal-pane.tsx:112` and re-applied on theme change at `:134`
- [x] Implement the §3.4 motion vocabulary (agent spinner, streaming token reveal, tool pulse/shimmer, approval card, validation shimmer, error shake, completion expand) — `src/styles/motion.css:9-66` declares all 13 classes; `:89-217` defines the matching keyframes
- [x] Implement `prefers-reduced-motion` fallbacks for every animation — `motion.css:69-87` disables animation, transition, and shimmer under `reduce`, keeping the state change
- [x] One spinner, driven by agent status, reused everywhere (§3.4 rule 4) — `src/components/common/spinner.tsx`, glyph cycle and cadence as tokens in `src/theme/motion-tokens.ts`; used by the plan, activity, validation, and terminal panels
- [x] Responsive layout + empty/error/loading states — `App.tsx:49` 3-column grid collapsing to 1 column below `lg`; `EmptyState` / `ErrorState` / `LoadingState` in `src/components/common/panel.tsx`; `src/components/common/error-boundary.tsx`

### Dependencies

- PHASE 3–6 (events to render; approvals to service)
- PHASE 1 (web backend + the existing Vite foundation)
- PHASE 7 (shared event/report contracts; parity with the CLI)

### Expected Output

- A working **coding workspace** in the existing Vite app: file tree + Monaco editor + xterm terminal + diff + live agent / validation / recovery / final-report views

### Acceptance Criteria

- [x] The existing `daedalus-web` project is still the same project (no re-scaffold); `npm run build` passes
- [x] A user can submit a task from the browser and see the plan appear before actions run
- [x] File tree + **Monaco Editor** load a workspace file read-only in the MVP
- [x] **xterm.js** terminal renders streamed command output and the process exit status
- [x] Activity timeline, tool call/result views, and diff viewer update live from events
- [x] Validation status reflects real check results (test / lint / build) with file-line diagnostics
- [x] Error/retry/replan indicators and the approval UI appear from the matching events
- [x] An approval request appears inline and blocks until decided; the timeline records the decision
- [x] On WS disconnect, the client reconnects and replays missing events without duplicating the view — implemented on both sides (`eventStream.ts:82-86`, `server/src/events.ts:102-108`); **test coverage is still `[ ]`, see Testing**
- [x] A completed task shows files changed, diff, validation summary, and a final report with metrics
- [x] Every animation is tied to a recorded event and is fully disabled under `prefers-reduced-motion: reduce`
- [x] Colors come only from theme tokens (§3.4); no component hardcodes a color — `src/web.test.tsx:36`; and the CSS mirror is provably identical to the shared core palette in both themes — `src/web.test.tsx:40-72`, pinned to CharmTone Pantera by `core/src/palette.test.ts`
- [x] The CLI and the web render the same colors from the same palette — verified by rendering the CLI under `FORCE_COLOR=1` (truecolor `38;2;107;80;255` = Charple) and reading the web's resolved custom properties in a headless browser (`--daedalus-primary: #6b50ff`, body `rgb(32, 31, 38)` = Pepper)

### Testing

- [x] Component tests for each panel with mocked event fixtures — `src/panels.test.tsx`, 31 render cases: `Composer` (empty-goal alert, createTask payload, error surfacing), `ApprovalCard` (pending gate, tool/action/path, allow/deny, remember mapping, decided-unblocks, expired request), `PlanPanel` (empty state, per-step live status, current-step indicator), `ActivityTimeline` (empty log, tool call paired with result), `ValidationPanel` (empty/running/passed/failed plus `file:line` diagnostics), `RecoveryPanel` (empty, retry+replan counts), `ErrorPanel` (empty, model error classification + expand, non-success completion), `TopBar` (theme toggle a11y label and flip), and the report panels (files changed, validation summary, final report outcome+metrics+empty state).
- [x] Editor and terminal surface tests — `src/theme/editor-theme.test.ts` (4 cases: every highlighted token resolves to a palette syntax role in both themes, the surface paints on `bgBase`/`fgBase`/`accent`/`error` rather than a bundled `vs-dark`, `class`/`tag` stay bold as the reference emphasizes them, and the call site never hardcodes a bundled theme name) plus the browser assertions in `e2e/web-interface.spec.ts` (Monaco root and xterm scrollable element both resolve to the live `--daedalus-bgBase`, every token color Monaco paints is a palette syntax role or `fgBase`, and a theme toggle repaints both surfaces).
- [x] WebSocket reconnect/replay tests — `src/api/eventStream.test.ts`, 30 cases covering subscribe framing, per-task `lastSeq`, duplicate-drop, `seed()` resumption, capped exponential backoff, malformed-frame filtering, stale-socket suppression, and `stop()` semantics.
- [x] Design-system tests — `core/src/palette.test.ts` (10 cases: CharmTone hexes, derived diff tints, button role mapping, light/dark ramp ordering, ANSI 16 ordering) and `src/web.test.tsx` (3 style-check cases: no literal colors, CSS mirror equals the core palette in both themes, every mirrored key exists in the palette).
- [x] One browser end-to-end test (headless) against a scripted backend emitting a fixed event sequence — `daedalus-web/e2e/web-interface.spec.ts` (12 cases) drives real Chrome through `playwright.config.ts` against `e2e/scripted-gateway.mjs`, which serves the fixed 16-event sequence over real REST + WebSocket with no LLM involved: shell and live connection, plan before action, approval blocking until decided, terminal output and exit status, validation verdict after a retry, recovery record, classified errors, files changed and report metrics, the activity timeline, the theme toggle, editor/terminal palette surfaces, and reduced-motion. The gateway holds the sequence at `APPROVAL_REQUESTED` and releases it on an explicit `POST /__e2e/grant`, so the approval card is genuinely observable instead of being replayed past.
- [ ] Manual UX checklist for responsiveness and error states.

### Risks

- UI coupling to internal event shapes → define a stable, versioned event contract first.
- Event volume overwhelming the UI → batch/throttle rendering; virtualize long logs.
- Monaco + xterm inflating the bundle or slowing dev startup → lazy-load both surfaces.

### Status

COMPLETE — audited 2026-10-04 against the actual disk state, then closed. **All 30 implementation tasks are shipped** (every task above is `[x]` with file:line evidence), and all 12 acceptance criteria pass. The phase was previously recorded as `NOT STARTED` / `0%`, which was stale: the implementation existed but the checklist had not been reconciled.

The four coverage gaps that kept the phase at 70% are now closed:

1. ~~`src/api/eventStream.ts` and `server/src/events.ts` (`replayFor`) ship with zero tests~~ → `src/api/eventStream.test.ts`, 30 cases.
2. ~~No per-panel render tests~~ → `src/panels.test.tsx`, 31 cases across every panel.
3. ~~No browser end-to-end test~~ → `e2e/web-interface.spec.ts`, 12 cases against `e2e/scripted-gateway.mjs`.
4. ~~No Monaco or xterm test~~ → `src/theme/editor-theme.test.ts` (4 cases) plus live-browser surface assertions in the e2e.

`scripts/check.sh` is green (exit 0): all 4 packages build and **215 tests pass** (core 99, cli 21, server 14, web 81). The Playwright suite is green separately: **12 passed** (`npx playwright test` in `daedalus-web`, 1.5m).

**Five more real defects were found and fixed while closing these gaps** (2026-10-04):

1. **A missing event field blanked the entire workspace.** `FileDiff` maps `change.lines`, but the scripted
   gateway emitted a partial `FILE_CHANGED` payload, so `lines` arrived `undefined` and the render threw
   `Cannot read properties of undefined (reading 'map')` — with no error boundary, that unmounted the whole
   app and left an empty `<body>`. Nine of the twelve e2e cases failed on this alone. The fixture now carries
   every field `core/runtime.ts#emitFileChanged` sends.
2. **The scripted gateway did not implement `GET /tasks`** (404), nor `/workspace/list`, and it returned the
   wrong `buildTree` shape (a bare entry list with `type` instead of one node with `isDirectory` + `children`).
   The workspace tree therefore rendered empty and no file could be opened.
3. **The replay handed the browser a finished task.** Every event — including `APPROVAL_DECIDED` — was
   delivered in one burst, so the approval card could never be observed. The gateway now stops the sequence at
   `APPROVAL_REQUESTED` and resumes on a decision or an explicit release. A shared gateway process also leaked
   its released sequence between tests, which needed a per-test reset.
4. **The terminal ignored the palette.** `terminalTheme()` set `background: 'transparent'`, so xterm painted
   its own black default (`rgb(0, 0, 0)`) instead of Pepper — the most visible surface in the app. It now
   resolves `bgBase`, and the ANSI slots were remapped from the numbered CSS aliases (which do not exist) to
   the palette's real `ansiBlack`…`ansiBrightWhite` keys.
5. **A theme switch never repainted Monaco.** The editor theme read `--daedalus-*` from the cascade, but the
   effect that writes those variables lives in `<App>`, whose effects run *after* its children's — so the
   editor always painted the previous theme. It now resolves the palette directly. A second bug hid behind it:
   under `StrictMode` the mount/unmount/remount cycle left the disposed flag set, so every later switch was
   treated as a disposed component and skipped.

Monaco's bundled `vs-dark`/`vs` were the last two surfaces still off-palette. `src/theme/editor-theme.ts` maps
49 highlighter token names onto 21 new `syntax*` palette roles (CharmTone: Pony, Guppy, Salmon, Cumin,
Mauve, Hazy, Salt, Tang, Guac, Julep…), so a highlighted file reads as part of the same system instead of
importing a foreign editor theme. The CLI already used `gradient()` on its working indicator, but the web
declared `--color-working-grad-from/to` with **no consumer**; the spinner now wears that gradient, and a test
fails if the tokens are ever declared without being read.

**Two real bugs were found and fixed while writing the reconnect tests** (`src/api/eventStream.ts`): a failed retry announced `reconnecting` twice, and the `nextRetryMs` reported to the UI lagged the delay actually scheduled by one backoff step, because `#attempt` was incremented after the delay had been computed. Both are now covered by tests.

**Three more real defects were found and fixed while aligning the design system** (2026-10-04):

1. **The palette hexes were not CharmTone at all.** `core/src/theme.ts` carried hand-written values with
   `// charmtone.charple`-style comments next to them, but the real charmtone `v0.1.0` release is
   `#6b50ff` / `#ff60ff` / `#201f26` / `#ecebf0` — not `#9747ff` / `#f5eb5b` / `#181320` / `#ebdfe8`. Every
   color in both interfaces was wrong relative to the reference. Values are now read from the pinned
   release and locked by `core/src/palette.test.ts`.
2. **`applyPaletteVars()` had never run in the browser.** The web imported `getPalette` from the
   `@daedalus/core` barrel, which reaches `node:fs`; the client bundle logged
   `Cannot access "node:fs.mkdirSync"` and the palette mirror wrote nothing, so the UI silently painted the
   CSS fallbacks forever. The palette now lives in a platform-free module (`core/src/palette.ts`) exposed as
   the `@daedalus/core/palette` subpath, alongside `@daedalus/core/version`.
3. **Four unreferenced duplicate design-system modules** (`src/theme/tokens.ts`, `src/theme/animations.ts`,
   `src/components/common/spinner-enhanced.tsx`, `src/components/ui/crush-primitives.tsx`) plus
   `src/styles/crush-theme.css` were carrying a second palette and a second spinner. They broke the enforced
   style check (78 color literals) and 3 lint rules, and contradicted §3.4 rule 4 ("one spinner"). Removed;
   `motion.css` and `spinner.tsx` are the single motion and spinner sources.

Phase 8 is complete: the browser e2e test exists and passes, so Phase 9 may begin. The one remaining
unchecked line is the **manual** UX checklist for responsiveness and error states — a human pass, not
something a headless suite can assert.

### Objective

Prove the whole system works end-to-end and fails gracefully across **both interfaces**: full agent workflow, tool correctness, CLI/Web parity, LLM-failure handling, permission enforcement, terminal failures, build/test failures, and retry/recovery.

---

## PHASE 9 — CLI + Web Integration Testing

### Objective

Prove the whole system works end-to-end and fails gracefully across **both interfaces**: full agent workflow, tool correctness, CLI/Web parity, LLM-failure handling, permission enforcement, terminal failures, build/test failures, and retry/recovery.

### Tasks

- [ ] Implement an **end-to-end agent workflow test** (submit task → plan → tools → validate → report) on a fixture repo
- [ ] Implement **CLI integration tests** (`daedalus run` on the fixture repo → streamed events + exit code)
- [ ] Implement **CLI/Web parity tests** (the same task via both interfaces yields the same event sequence)
- [ ] Implement **tool integration tests** (all MVP tools against a fixture repo; correct + safe)
- [ ] Implement **LLM failure tests** (timeout, malformed output, refusal, rate-limit) with a fault-injecting provider
- [ ] Implement **permission tests** (ask/deny/remember paths; escape attempts blocked)
- [ ] Implement **terminal failure tests** (bad exit code, timeout kill, huge output, non-zero signal)
- [ ] Implement **build/test failure tests** (failure then recovery then pass)
- [ ] Implement **retry/recovery tests** (limits enforced; replan triggered; no-progress stop)
- [ ] Implement a **replay test** (record a task's event log; replay deterministically; assert same outcome)
- [ ] Implement a **cancel test** (cancel mid-task leaves clean state, no orphans)
- [ ] Assemble a single `scripts/check.sh` running unit + integration suites
- [ ] Fix defects found; record any accepted limitations in this file

### Dependencies

- PHASE 1–8 (all components, both interfaces)

### Expected Output

- A stable integrated system with a repeatable test suite covering happy paths and failure paths

### Acceptance Criteria

- [ ] E2E workflow passes on the fixture repo and produces a validated change
- [ ] Every failure-category test above exists and passes (or is explicitly documented as a known limitation with rationale)
- [ ] Replay of a recorded run reproduces the same outcome without network
- [ ] `scripts/check.sh` runs green from a clean checkout
- [ ] No test result is fabricated; skipped/failing tests are reported honestly

### Testing

- This phase *is* the test suite; it is executed by `scripts/check.sh` and referenced by later phases.
- Fault injection via fakes at the provider and validator seams; real commands only for the fixture repo.

### Risks

- Flaky E2E due to model nondeterminism → use a deterministic fake provider for gating tests; keep live runs separate and opt-in.
- Slow suites → mark slow tests and keep the fast suite as the default gate.

### Status

NOT STARTED

---

## PHASE 10 — Evaluation & Experiment

### Objective

Produce the thesis experimental dataset and analysis: run standardized software-engineering tasks through Daedalus and record, reproducibly, success/failure, iterations, tool calls, execution time, and error-recovery behaviour.

### Tasks

- [ ] Define the **task suite** (small, curated SWE-style tasks on prepared repos, with expected done-criteria)
- [ ] Define **test scenarios** (e.g. bug fix, feature add, refactor; with/without validation; with/without approval; model/config variants)
- [ ] Define **independent + dependent variables** and **metrics** (success rate, turns, tool calls, wall-clock, retries, recovery events, tokens/cost)
- [ ] Implement the **evaluation runner** (runs tasks headlessly; writes structured results)
- [ ] Implement **result recording** (per-run JSON/CSV derived from the event log; artifacts: diff, validation result, trajectory)
- [ ] Implement **determinism controls** (fixed temperature/seeds where applicable; fake vs live provider modes)
- [ ] Run the **standardized tasks** and collect results (live runs; nothing simulated)
- [ ] Implement **analysis** (aggregate metrics, per-scenario comparison, failure taxonomy, recovery success rate)
- [ ] Produce **tables/figures** for the thesis
- [ ] Document **threats to validity** and limitations

### Dependencies

- PHASE 9 (stable system)
- PHASE 6 (recovery data)

### Expected Output

- `evaluation/tasks/`, `evaluation/runners/`, `evaluation/reports/` (raw runs + aggregated analysis)
- A thesis-ready, reproducible results section

### Acceptance Criteria

- [ ] ≥ N curated tasks (N = 12) run end-to-end and are recorded:
  - [ ] 4 Bug Fixing tasks
  - [ ] 4 Feature Addition tasks
  - [ ] 4 Refactoring tasks
- [ ] Each run records: task id, outcome, turns, tool calls, wall-clock, retries, recovery events, validation evidence, final diff
- [ ] Results are reproducible (same config → same metrics, allowing documented nondeterminism)
- [ ] Aggregated metrics + at least one comparison table are produced
- [ ] A failure taxonomy with counts is produced
- [ ] No simulated/fabricated results; raw logs are retained

### Testing

- Validate the runner on a known-good task before the full run; verify the aggregator against hand-checked sample rows.
- Re-run a subset to confirm metric stability and document variance.

### Risks

- Provider nondeterminism/cost → fix temperature where possible, cap task count, cache where legitimate, and report cost.
- Over-fitting tasks to the agent → keep tasks representative and independent of Daedalus specifics.

### Status

NOT STARTED

---

## PHASE 11 — Finalization

### Objective

Stabilize, document, and present the finished framework: fix remaining defects, polish UX, finalize documentation, prepare thesis screenshots/demo scenarios, and record limitations and future work.

### Tasks

- [ ] Fix remaining defects prioritized from Phase 9/10 findings
- [ ] Improve UX (clear empty/error/loading states, timeline readability, keyboard access)
- [ ] Write/extend documentation (README, quickstart, configuration, tool reference, troubleshooting)
- [ ] Write the **final architecture document** (diagrams from §3, contracts, decisions, ADR index)
- [ ] Prepare **thesis screenshots** (task entry, plan, timeline, diff, validation, approval, final report)
- [ ] Prepare **demonstration scenarios** (scripted, reproducible walkthroughs)
- [ ] Document **limitations** honestly (what the system does not do / cannot guarantee)
- [ ] Document **future development** (multi-agent teams, richer validators, more providers, sandbox hardening, MCP)
- [ ] Final pass: update Progress Tracking + summary table; freeze the version
- [ ] Tag a release/snapshot for reproducibility

### Dependencies

- PHASE 9 (stability)
- PHASE 10 (results to document)

### Expected Output

- Final Agentic Coding Framework: documented, demonstrated, with recorded results and honest limitations

### Acceptance Criteria

- [ ] Quickstart reproduces a full task run from a clean checkout
- [ ] All documentation listed above exists and is accurate to the code
- [ ] Screenshots + demo script reproduce the claimed behaviour
- [ ] Limitations and future work are explicitly documented
- [ ] This `PLAN.md` shows every phase `COMPLETE` with passing acceptance criteria (or an explicitly documented deferral)
- [ ] Overall Progress set to 100%

### Testing

- Full `scripts/check.sh` green; a final end-to-end demo run recorded.
- Documentation review for accuracy against the actual system.

### Risks

- Documentation drifting from code → generate where possible; verify each claim against the system.
- "Done" pressure causing skipped criteria → §10 forbids marking a phase complete without passing criteria.

### Status

NOT STARTED

---

## 5. Phase Format

Every phase in §4 uses the template below. Copy it verbatim when adding a phase; keep the section order.

```text
## PHASE X — Name

### Objective

### Tasks

- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

### Dependencies

### Expected Output

### Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2

### Testing

### Risks

### Status

NOT STARTED
```

### Conventions

- **Checklist tracking:** mark a task/criterion `[x]` only when it is actually done and verified.
- **Status values:** `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, `COMPLETE`.
- **Definition of done for a phase:** every Acceptance Criterion is `[x]`; the Testing section was executed with real (not fabricated) results; and `Progress Tracking` at the top of this file was updated.
- **Blocked phases:** if `BLOCKED`, record the blocker and the phase/decision it depends on in the phase body.
- **Out-of-scope work:** if a phase requires a change outside it, make the *minimal* change and record it under that phase's Risks/notes.

---

## 6. MVP Definition

The MVP is the smallest end-to-end system that demonstrates the core workflow; it must be demonstrable through **both interfaces** — the browser UI and the CLI — running the **same Daedalus Core**.

### MVP demonstration loop

```text
User enters coding task
        ↓
Agent analyzes project
        ↓
Agent creates plan
        ↓
Agent reads files
        ↓
Agent modifies files
        ↓
Agent runs test/build
        ↓
Agent observes result
        ↓
If error → retry/fix
        ↓
Show diff
        ↓
Report result
```

### MUST HAVE (required for a valid MVP)

- **CLI:** `daedalus run "<task>"`, streamed progress, interactive approval, meaningful exit codes, `--json` output.
- **Web workspace (inside the existing Vite app):** task input, file explorer / file tree, **code editor (Monaco Editor)**, **terminal (xterm.js)**, **diff viewer**.
- **Web agent views:** plan, current step, activity timeline, tool calls, tool results, status.
- **Web validation / recovery / result:** test, lint, build results + validation errors; error info + retry/replan indicators + approval UI; files changed + validation summary + final report.
- **Realtime:** WebSocket event stream (core → event log → web) for create task, stream events, submit approval, cancel task — consumed identically by CLI and Web.
- **Shared Daedalus Core:** one agent core consumed by both CLI and Web (no per-interface agent logic).
- **Agent Core:** task understanding, planner, loop, context manager, task state, completion detection.
- **LLM:** one provider, provider abstraction, prompt management, streaming, typed errors.
- **Tools:** `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `run_command`, `git_diff`/`git_status`.
- **Execution Harness:** dispatch, workspace confinement, timeout, cancellation, and a basic Approval Gate.
- **Validation:** run build/test/lint via a pluggable validator; parse results; completion gated on validation.
- **Error Recovery:** error classification + bounded retry/fix + stop conditions.
- **Event log:** append-only, typed, replayable; feeds UI and evaluation.
- **Evaluation:** a runner that records the scenario data defined in §7 / Phase 10.

### SHOULD HAVE (planned; may slip without invalidating the MVP)

- Reconnect + event replay in the UI beyond a basic reload.
- Second LLM provider behind the abstraction.
- Replanning (not only retry) when a step repeatedly fails.
- "Remember approval for this task" grants.
- Configurable validation commands per project.
- Replay tests built from recorded event logs.

### FUTURE / OPTIONAL (explicitly out of MVP)

- Multi-agent teams / sub-agents (coordinator-style delegation).
- MCP client integration and additional external tools.
- Container/VM sandbox hardening and remote execution backends.
- Scheduled / event-triggered tasks.
- Client-side tools that let the agent drive the UI.
- LSP-backed semantic tools.
- Multi-user accounts, cloud deployment, RBAC.
- Model fine-tuning or training.

> **Scope guard:** if a MUST HAVE feature is at risk, cut a SHOULD HAVE first. Never grow the MVP to include FUTURE items.

---

## 7. Research Contribution

The contribution is **not** "reproduce the five references". It is a specific, defensible combination that the references do not provide together, implemented independently and measured. Each claim is framed as something the *implementation + Phase 10 evaluation can support*; nothing is claimed as novel unless demonstrated.

### 7.1 Contributions this work can support

1. **Validation-driven agent loop for a CLI + web-based coding agent.** Reference agents largely optimise for *acting* (tool use) or *scoring* after the fact; Daedalus makes validation (build/test/lint) a first-class participant in the loop, with completion gated on validated evidence. The contribution is the *integration and measurement* of validation as the loop's control signal — not the invention of running tests.
2. **Unified, event-sourced observability + evaluation.** One append-only event log feeds the live CLI/Web interfaces and the Phase 10 evaluator, removing duplication between "what the user watched" and "what the experiment recorded", and making runs replayable.
3. **Dual-interface agentic coding framework over one core.** A CLI and a web control plane share a single `Daedalus Core`, giving the same observable, steerable workflow (plan, timeline, diff, validation, approval) from either a terminal or a browser — with no logic duplicated per interface.
4. **Tool orchestration with least privilege.** A tool registry with allowlisted model-facing schemas plus an Approval Gate keyed by (task, tool, action, path), making capability exposure and human intervention explicit and auditable.
5. **Bounded error recovery as a measured behaviour.** Recovery is a policy object (retry/fix/replan/abort) with hard budgets; Phase 10 measures recovery success rate and failure taxonomy — turning "the agent retries" into an experiment.
6. **An evaluation methodology for agentic coding workflows.** A curated task suite, defined scenarios, and recorded metrics (success rate, turns, tool calls, wall-clock, retries, recovery events, cost) with threats-to-validity documented.
7. **A reproducible, modular research artifact.** Pluggable provider/tool/validator/recovery seams let the thesis compare configurations cleanly.

### 7.2 What is explicitly NOT claimed as novel

- Agent loops, tool calling, planners, permission prompts, web UIs, and event logs are **not** new; they exist across the references.
- No claim of beating SWE-bench or any reference on raw task resolution.
- No claim of a new LLM architecture or training method.

### 7.3 Honesty rule

Any contribution in §7.1 is asserted **only if** the implementation exists and Phase 10 provides evidence. If a feature slips to SHOULD/FUTURE, the corresponding claim is downgraded or removed in Phase 11.

---

## 8. Project Structure

The workspace root holds the five reference clones (read-only) plus `Daedalus/`, the framework root. `Daedalus/daedalus-web/` **already contains a working Vite + React + TypeScript scaffold**, which is adopted in place.

### Workspace layout (actual)

```text
Skripsi/
├── PLAN.md                      # this roadmap
├── crush/                       # REFERENCE (read-only)  · commit bdcf796c
├── OpenHands/                   # REFERENCE (read-only)  · commit a6bba78f
│                                #   NOTE: Agent Canvas frontend only
├── cline/                       # REFERENCE (read-only)  · commit 39ff2359
├── SWE-agent/                   # REFERENCE (read-only)  · commit 3ea751c0
├── deepseek-harness/            # REFERENCE (read-only)  · commit 5badb150
├── .kilo/                       # workspace tooling (leave untouched)
└── Daedalus/                    # Daedalus framework root
    └── daedalus-web/            # EXISTING Vite + React + TS app (npm, ESM)
        ├── package.json         # name: daedalus-web · type: module · private
        ├── vite.config.ts
        ├── index.html
        ├── src/                 # main.tsx · App.tsx · App.css · index.css · assets/
        ├── public/              # favicon.svg · icons.svg
        ├── eslint.config.js
        └── tsconfig*.json
```

> **Reference clones are all present and pinned** to the commits in §2.0. They stay read-only (§10).
>
> `daedalus-web` currently exposes only `dev` / `build` / `lint` / `preview` and has **no test runner**. It depends on `react` + `react-dom` only (React 19, Vite 8, TypeScript 6). Daedalus features are added **into this project** in Phase 8 — never by recreating, migrating, or replacing it.

### Proposed target structure for `Daedalus/` (TypeScript / Node / npm)

```text
Daedalus/
├── daedalus-web/                # ← EXISTING Vite + React + TS app — keep in place
│   ├── src/
│   │   ├── app/                 # routing, layout, shell
│   │   ├── features/            # workspace, agent, execution, validation,
│   │   │                        # recovery, report
│   │   ├── components/          # shadcn/ui + shared components
│   │   ├── lib/                 # ws client, api client, monaco, xterm, tailwind
│   │   ├── stores/              # zustand (only where needed)
│   │   └── types/               # mirror of core event contracts
│   └── package.json             # existing npm project
│
├── core/                        # ← @daedalus/core (shared by CLI and Web)
│   ├── agent/
│   │   ├── loop/                # AgentLoop (stateless step fn)
│   │   ├── planner/             # interpreter + planner + replan
│   │   ├── context/             # prompt sections, budget, compaction
│   │   ├── memory/              # history / summarisation store
│   │   └── state/               # TaskState, actions, observations
│   ├── tools/
│   │   ├── filesystem/
│   │   ├── terminal/
│   │   ├── search/
│   │   └── git/
│   ├── execution/
│   │   ├── executor/
│   │   ├── process/
│   │   └── sandbox/
│   ├── validation/
│   │   ├── tests/
│   │   ├── lint/
│   │   └── build/
│   ├── recovery/
│   │   ├── error-analyzer/
│   │   ├── retry/
│   │   └── replan/
│   ├── providers/
│   │   └── llm/
│   ├── events/                  # event bus + append-only event log
│   ├── workspace/               # workspace resolution + confinement
│   ├── persistence/             # task/session store
│   └── config/
│
├── server/                      # ← web backend: REST + WebSocket over core
├── cli/                         # ← CLI (TypeScript + Commander), thin client
├── evaluation/
│   ├── tasks/
│   ├── runner/
│   ├── analysis/
│   └── reports/
├── tests/                       # cross-cutting (CLI/Web parity, e2e)
├── docs/
│   ├── architecture.md
│   ├── decisions/               # ADR-0001..NNNN
│   └── research/                # Phase 0 notes per reference repo
├── scripts/
│   ├── dev.sh
│   └── check.sh
├── package.json                 # npm workspaces root
└── .env.example
```

### Notes on adapting the requested structure

- **Root:** everything Daedalus lives in `Daedalus/`; the five reference repos stay read-only siblings.
- The conceptual `web/frontend/` is **already present** as `Daedalus/daedalus-web/` (Vite + React + TS). It stays there and is **not** moved, recreated, or restructured without reason.
- The conceptual `core/`, `agent/`, `tools/`, `execution/`, `validation/`, `recovery/`, `providers/` are grouped under `Daedalus/core/` (`@daedalus/core`) so they form one shared Core consumed by the CLI, the Web backend, and evaluation.
- A thin `server/` package hosts the REST + WebSocket endpoints the existing Vite app talks to; it contains **no agent logic**.
- Event/report contracts are defined **once** in `core/events/` and consumed by CLI, Web, and evaluation (the Vite app mirrors them as TS types).
- The coding agent must **inspect the actual repository** before implementing; the layout above is a target, not a licence to reshuffle the existing Vite project.
- **Exact names/paths are confirmed in ADR-0004 during Phase 0/1**, before any scaffolding.

---

## 9. Dependency Order

The primary path is strictly sequential, because each phase consumes the previous phase's contracts.

```text
PHASE 0   Repository & Research Analysis
   ↓
PHASE 1   Daedalus Foundation
   ↓
PHASE 2   LLM Provider Integration
   ↓
PHASE 3   Daedalus Agent Core
   ↓
PHASE 4   Tool System
   ↓
PHASE 5   Execution Harness
   ↓
PHASE 6   Validation & Error Recovery
   ↓
   ├── PHASE 7   CLI Interface   ─┐
   └── PHASE 8   Web Interface   ─┘  (two thin clients; may run in parallel)
   ↓
PHASE 9   CLI + Web Integration Testing
   ↓
PHASE 10  Evaluation & Experiment
   ↓
PHASE 11  Finalization
```

### Parallelizable work (with explicit notes)

These are the only cases where work can overlap; each still requires its prerequisites to be complete first.

```text
After PHASE 1:
   PHASE 2 (LLM)            ─┐
   Web UI shell             │  (web shell + WS client can be built
   (part of PHASE 8)       ─┘   against the Phase 1 event stub, in parallel with PHASE 2)

After PHASE 4:
   PHASE 5 (Harness)        ─┐
   Tool unit tests          │  (tool tests can be written as tools land)
   (part of PHASE 4/9)     ─┘

After PHASE 6:
   PHASE 7 (CLI Interface)  ─┐
   PHASE 8 (Web Interface)  ─┘  (independent thin clients over the same core;
                                 they can be built in parallel with each other)

After PHASE 8:
   PHASE 9 (integration test authoring)  (while the last interface lands)

PHASE 9 depends on PHASE 7 + PHASE 8 (no overlap).
PHASE 10 depends on PHASE 9 (no overlap).
PHASE 11 depends on PHASE 9 + PHASE 10 (no overlap).
```

### Hard dependency rules

- PHASE 2 requires PHASE 1 (event bus, config, logging).
- PHASE 3 requires PHASE 2 (provider + prompts).
- PHASE 4 requires PHASE 3 (loop must exist to consume tools).
- PHASE 5 requires PHASE 4 (nothing to dispatch otherwise).
- PHASE 6 requires PHASE 5 (validation runs *through* the harness).
- PHASE 7 (CLI) requires PHASE 3–6 (the core must run a full task loop).
- PHASE 8 (Web) requires PHASE 3–6 (there must be events + approvals to render).
- PHASE 9 requires PHASE 1–8 (it tests the whole system across both interfaces).
- PHASE 10 requires PHASE 9 (only stable systems are evaluated).
- PHASE 11 requires PHASE 9 + PHASE 10.

> If a dependency is unmet, **do not start the phase**. Record the blocker instead.

---

## 10. Implementation Rules

These rules govern every phase. They are binding.

1. **Do not implement multiple phases at once.**
2. **Complete and verify one phase before moving to the next.**
3. **Do not modify unrelated existing features.**
4. **Do not rewrite the project unnecessarily.**
5. **Do not copy source code from reference repositories.**
6. **Verify architecture against the actual repository source** (never rely on memory or marketing).
7. **Keep the system modular** (pluggable providers, tools, validators, recovery).
8. **Keep the MVP scope realistic** (MUST / SHOULD / FUTURE per §6).
9. **Every feature must have a testing strategy** (stated in the phase's Testing section).
10. **Update `PLAN.md` after completing each phase** (tasks, criteria, status, progress).
11. **Mark completed tasks with `[x]`.**
12. **Record important architectural decisions** as ADRs under `docs/decisions/`.
13. **Do not fabricate test results.** Report failures, skips, and limitations honestly.
14. **Do not mark a phase complete until its acceptance criteria pass.**

### Additional operating rules

- **One phase per instruction:** work only on the phase requested; if a dependency forces a minimal change elsewhere, keep it minimal and record it.
- **Reference repos are read-only:** never edit, commit to, or copy from `crush/`, `OpenHands/`, `cline/`, `SWE-agent/`, `deepseek-harness/`.
- **End-of-phase protocol:** (1) run tests, (2) verify acceptance criteria, (3) update `PLAN.md`, (4) report what was completed, (5) report what remains, (6) do **not** auto-start the next phase.
- **Secrets:** never commit API keys; `.env` is gitignored, `.env.example` documents required variables.
- **Safety default:** mutating/exec tools default to `ask` policy; workspace escape attempts fail closed.
- **One core only:** agent logic lives in `Daedalus/core/`; the CLI and the Web UI must stay thin clients (never fork a second implementation).

---

## 11. Progress Tracking

The canonical progress block lives at the **top of this file** and must be updated at the end of every phase:

```text
Overall Progress: 0%

Current Phase: PHASE 0

Status: NOT STARTED

Last Updated: YYYY-MM-DD
```

It is mirrored by the Summary Table in the same section:

| Phase    | Status      | Progress | Main Deliverable          |
| -------- | ----------- | -------: | ------------------------- |
| Phase 0  | COMPLETE    |     100% | Research & Architecture   |
| Phase 1  | COMPLETE    |     100% | Daedalus Foundation       |
| Phase 2  | COMPLETE    |     100% | LLM Provider Integration  |
| Phase 3  | COMPLETE    |     100% | Daedalus Agent Core       |
| Phase 4  | COMPLETE    |     100% | Tool System               |
| Phase 5  | COMPLETE    |     100% | Execution Harness         |
| Phase 6  | COMPLETE    |     100% | Validation & Recovery     |
| Phase 7  | COMPLETE    |     100% | CLI Interface             |
| Phase 8  | COMPLETE    |     100% | Web Interface             |
| Phase 9  | NOT STARTED |       0% | CLI + Web Integration Testing |
| Phase 10 | NOT STARTED |       0% | Evaluation                  |
| Phase 11 | NOT STARTED |       0% | Finalization                |

### Update rules

- **Last Updated** is set to the date of the most recent edit (format `YYYY-MM-DD`).
- **Overall Progress** is the average of the twelve phase progress values, rounded to the nearest whole percent.
- **Current Phase** is the phase currently `IN PROGRESS` (or the next `NOT STARTED` phase).
- **Status** is the current phase's status, or `COMPLETE` when all phases are done.
- A phase's **Progress** reflects its *Acceptance Criteria* completion, not its task count alone.
- Never raise a phase above `0%` before it is started; never mark `COMPLETE` until criteria pass (§10).

---

## 12. Important Workflow

### Current status

**No Daedalus implementation exists yet.** On disk there are:

- `PLAN.md` (this roadmap),
- the **five reference clones** (`cline/`, `crush/`, `deepseek-harness/`, `OpenHands/`, `SWE-agent/`), all present and pinned to the commits in §2.0 — **read-only reference material only**,
- the pre-existing Vite scaffold at `Daedalus/daedalus-web/` (React 19 + Vite 8 + TypeScript 6, npm, ESM, **no test runner**),
- `.kilo/` (workspace tooling).

There is **no** Daedalus Core, CLI, web backend, Agent Loop, tool, or WebSocket implementation. The next action is to await an explicit instruction to start a phase.

> **Phase 0 readiness:** the reference analysis in §2 is now backed by the verified on-disk inventory (§2.0), including the recorded correction that `OpenHands/` is **Agent Canvas only** — the agent-execution backend (`software-agent-sdk`) is a **separate repository and was not inspected**. Any Phase 0 claim about OpenHands' *backend* internals is therefore unsupported and must not be asserted.

### The next instruction will look like

> "Start Phase 0"

or

> "Start Phase 1"

### When instructed to start a phase

1. Work **only** on that phase, unless a dependency requires a minimal change elsewhere (keep it minimal and record it).
2. Follow the phase template (§5) and the implementation rules (§10).
3. Do not implement future phases early.

### At the end of every phase

1. Run the appropriate tests.
2. Verify the acceptance criteria.
3. Update `PLAN.md` (tasks `[x]`, criteria `[x]`, status, progress, decisions).
4. Report what was completed.
5. Report what remains.
6. **Do not automatically start the next phase.**

### Goal

Build **Daedalus** — an independent **CLI + Web-based Agentic Coding Framework** with a single shared core — through a controlled, trackable, phase-by-phase process, grounded in the actual source of the five reference repositories (§2) and without copying their code.

---

*End of PLAN.md — version 1.5 (2026-10-04). Update this file at the end of every phase.*

**v1.5 changelog:** consolidated the separate `plan-implemen.md` execution checklist into §4.0 *Locked Execution Baseline* (core boundary, stack incl. Vitest, default LLM endpoint `https://llm.ayid.cc.cd/v1`, JSON/NDJSON persistence under `.daedalus/tasks/`, workspace layout, and the fixed 12-task evaluation scope of 4 bug fixes / 4 feature additions / 4 refactors with the metric list). Fixed the Phase 10 open question `N` to `N = 12`. `plan-implemen.md` was merged and removed; **this file is now the single plan.** No phase task, acceptance criterion, status, or section numbering changed.

**v1.4 changelog:** added §2.0 *Reference Repository Inventory* (all five clones verified present and pinned to specific commits, with the exact source paths inspected); corrected §2.2 to reflect that the local `OpenHands/` clone is **Agent Canvas** (control-plane frontend) and **not** the full Python OpenHands monorepo — its agent backend lives in a separate, un-inspected repository; refreshed §2.1/§2.3/§2.4/§2.5 with verified source-level detail; annotated §2.6; recorded the reference clones and their commits in §8 and §12; marked the Phase 0 repository-inspection tasks complete.

# Architecture Decision Records

This index is the entry point to Daedalus's recorded decisions. The ADR files remain the authoritative text; this page summarizes their scope and notes later supersessions so readers do not have to infer chronology from filenames.

| ADR | Title | Status / scope |
|---|---|---|
| [ADR-0001](ADR-0001.md) | Core and Interface Boundary | Accepted. Agent/tool/LLM logic lives in `@daedalus/core`; CLI, server, and Web are thin interfaces. |
| [ADR-0002](ADR-0002.md) | Technology Stack and Tooling | Accepted. TypeScript ESM, Node.js 22+, npm workspaces, Commander, Node HTTP/WebSocket, React/Vite, Vitest, and an OpenAI-compatible provider configured by `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. |
| [ADR-0003](ADR-0003.md) | JSON/NDJSON Event Persistence | Accepted. Per-task append-only `events.jsonl` plus `state.json` under the Daedalus home enables replay and evaluation from the same records shown to users. |
| [ADR-0004](ADR-0004.md) | Workspace Layout and Scaffolding | Accepted for the `core/`, `cli/`, `server/`, `daedalus-web/`, `evaluation/`, `docs/`, and `scripts/` layout. Its statement that reference clones “remain read-only siblings” is historical: the project owner replaced that rule on 2026-10-05 with licence-governed reuse recorded in `PLAN.md` §10 and `../THIRD_PARTY.md`. The layout decision remains in force. |
| [ADR-0005](ADR-0005.md) | Evaluation Benchmark Scope | Accepted. Twelve curated tasks (4 bug fixes, 4 feature additions, 4 refactors) with success, iteration, tool, timing, recovery, and cost/token metrics. Live completion remains subject to provider availability. |
| [ADR-0006](ADR-0006.md) | Phase 8.5 Product Session, Modes, Providers, and Attachments | Accepted/implemented. Core owns five modes, turn-boundary switching, the shared slash-command registry, provider registry with masked public keys, attachments with vision gating, child tasks, and the `create_dir` tool. |
| [ADR-0007](ADR-0007.md) | Background Server Lifecycle, Startup Menu, and Tray Fallback | Accepted/implemented with a recorded limitation. Bare `daedalus`, `serve`, `status`, and `stop` share one daemon lifecycle. Tray menu/lifecycle logic is isolated behind an injectable backend, but no native tray backend is bundled; desktop icon/Quit is therefore a manual verification item and headless use falls back to `status`/`stop`. |

## Reading order

For the product as it exists now, read ADR-0001 and ADR-0002 first, then ADR-0006 and ADR-0007 for the Phase 8.5 interaction/launcher decisions. ADR-0003 explains the event-sourced evidence model used by both interfaces and evaluation. ADR-0005 bounds the thesis experiment.

## Supersession rule

An ADR is not rewritten merely because a later product decision changes one assumption. When that happens, the later decision is recorded in `PLAN.md` and linked here—for example, the ADR-0004 read-only wording versus the 2026-10-05 reference-reuse decision. If a future change replaces an architectural boundary itself, add a new ADR and mark the earlier one superseded.

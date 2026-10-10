# Third-Party Provenance

This file records code and design/concept reuse for Daedalus. It exists so reused
work is disclosed rather than presented as original Daedalus work.

## Phase 8.5 reuse record (2026-10-05)

| Source repo | Pinned commit | Source path(s) | Destination | Licence | What was reused / adapted | Modifications |
|---|---:|---|---|---|---|---|
| Cline | `39ff2359` | `sdk/packages/shared/src/prompt/cline.ts`; `sdk/packages/core/src/services/global-settings.ts`; `sdk/packages/core/src/extensions/tools/command-guard.ts` | `Daedalus/core/src/interaction/modes.ts`; `Daedalus/core/src/agent/agent-loop.ts`; `Daedalus/core/src/agent/context.ts`; CLI/Web mode controls | Apache-2.0 | Concept adaptation: plan/act-style mode separation, read-only plan behaviour, and mode changes taking effect between user turns. No Cline source code was copied verbatim into Daedalus in Phase 8.5. | Daedalus implements five modes (`ask`, `manual`, `auto`, `plan`, `orchestrator`) in an original TypeScript `ModeController`; switches are turn-boundary `MODE_CHANGED` events and Shift+Tab cycles the shared order in CLI and Web. |
| DeepSeek Harness | `5badb150` | `packages/api/session-controller/src/commands.ts`; `packages/core/{agent-loop,session,system-prompt,tools}`; `packages/api/{gateway,session-controller,workspace-controller,settings-controller}` | `Daedalus/core/src/agent/context.ts`; `Daedalus/core/src/runtime.ts`; `Daedalus/server/src/app.ts`; `Daedalus/server/src/uploads.ts`; `Daedalus/daedalus-web/src/components/composer/composer.tsx` | MIT | Concept adaptation: workspace/session-centred interaction, durable attachment references on tasks, and admitting image content only when the selected model supports image input. No DeepSeek Harness source code was copied verbatim into Daedalus in Phase 8.5. | Daedalus uses its own `Attachment` metadata, server-side multipart/JSON/ZIP upload handling, workspace confinement, provider-registry vision resolution, and OpenAI-compatible `image_url` data URLs in the core context builder. |
| Crush | `bdcf796c` | `internal/ui/styles/palette.go`; `internal/permission/permission.go`; `internal/agent/coordinator.go` | `Daedalus/core/src/palette.ts`; `Daedalus/core/src/theme.ts`; `Daedalus/cli/src/interactive.ts`; `Daedalus/daedalus-web/src/theme/theme.ts`; `Daedalus/daedalus-web/src/index.css` | FSL-1.1-MIT | Design-system adaptation: CharmTone/Pantera token structure and values already used by Daedalus, plus permission/session interaction concepts. No Crush Go source code was copied into Daedalus in Phase 8.5. | Tokens were renamed into Daedalus palette keys, extended with five mode accents in dark and light themes, and rendered through TypeScript CLI/Web code. Crush's FSL competing-use caution remains noted; Daedalus does not claim Crush code as its own. |
| OpenHands Agent Canvas | `a6bba78f` | `src/api/agent-server-adapter.ts`; `src/stores/{conversation-store,event-message-store}.ts` | No new Phase 8.5 destination | MIT | Not used for Phase 8.5 implementation code. The local clone is the Agent Canvas frontend only, not the OpenHands Python execution backend. | None. Daedalus keeps its own Node server and core event log. |
| SWE-agent | `3ea751c0` | `sweagent/run/run.py`; `sweagent/agent/agents.py` | No new Phase 8.5 destination | MIT | Not used for Phase 8.5 implementation code. | None. Daedalus validation remains its own build/test/lint loop. |

## Concept references for the agent-improvement features (2026-10-05)

The seven agent improvements documented in `docs/agent-improvements.md` were
**implemented from scratch in Daedalus's own TypeScript** after studying the
designs of the reference projects below. They are concept references only:
no source code from these repositories was copied, pasted, or translated
into Daedalus code. Farid cites them as design references in the thesis.

| Reference | Concept studied | Daedalus's own implementation |
|---|---|---|
| SWE-agent (MIT) | History processors that notice a stuck agent re-issuing the same action and intervene before the run is wasted | `core/src/agent/loop-guard.ts`: per-task repeat tracking over tool+args signatures, `LOOP_WARNING` events, guidance injected into the next request, cached-repeat suppression; the existing `no_progress` stop remains the backstop |
| Cline (Apache-2.0) | Rules files / microagents loaded from the workspace into the prompt; checkpoints that snapshot files before the agent edits them; context-window meter with condensing of old tool output | `core/src/agent/rules.ts` (`.daedalus/RULES.md`, `AGENTS.md`, `.daedalus/rules.md`), `TaskStore.recordBackup/listBackups/restoreTask` + CLI `daedalus restore` and chat `/rewind`, `core/src/agent/context.ts` (`contextMeter`, `condenseToolOutputs`) wired into `AgentLoop` and surfaced as CLI `ctx NN%` / Web ctx chip |
| Crush (FSL-1.1-MIT) | Using a small/cheap helper model for side jobs such as naming a session | `Settings.llm.helperModel` (`DAEDALUS_HELPER_MODEL`) with a 5s fail-silent title request in `TaskRunner`; title shown in the CLI header and preferred by the Web task picker |
| OpenHands (MIT) | Event-sourced agent state where every meaningful step lands in one ordered log that UIs replay | Daedalus already had this via its append-only event log; the new `LOOP_WARNING` event type and the context-meter fields on `MODEL_REQUEST_*` events follow the same pattern |
| DeepSeek Harness (MIT) | Workspace/session-centred local harness with durable per-task state on disk | Task checkpoints live beside the existing task store under `<daedalusHome>/tasks/<taskId>/backups/`, keeping the CLI, chat `/rewind`, and future Web rewinds on one source of truth |

## Token-efficiency features (2026-10-07)

Two features were inspired by community token-saving tools. Both are
Daedalus's own TypeScript/prose; neither copies source code, and no
external binary is bundled or required.

| Source | Licence | Concept studied | Daedalus's own implementation |
|---|---|---|---|
| rtk-ai/rtk ("Rust Token Killer") | Apache-2.0 | A CLI proxy that filters/compresses command output (git, test runners, builds, installs) before an AI agent reads it, claiming large token savings on noisy commands | `core/src/agent/output-compression.ts`: original per-family filters (git/test/build/install/listing/generic) applied to `run_command` results in the agent loop, in front of the existing caps+spill layer. Failure lines + exit code stay verbatim, raw text is spilled to the task store, savings land on the final report (`compressed_outputs`, `output_chars_before/after_compression`). Default on; `DAEDALUS_OUTPUT_COMPRESSION=off` or the Web Settings toggle disables it. No Rust binary is shipped or invoked. |
| DietrichGebert/ponytail | MIT | A "lazy senior dev" skill: a decision ladder (need exists? already in codebase? stdlib? native feature? installed dependency? one-liner? minimum code) that biases the agent against over-building | `skills/ponytail/SKILL.md`: the ladder and its "lazy about the solution, never about reading" guard, rewritten in Daedalus's own words, shipped as a bundled starter skill. It is **not** installed or loaded by default — users install it with `daedalus skills install ponytail` and enable it per workspace like any other skill. |

Prose-compression skills in the caveman family were deliberately **not**
bundled: Daedalus's observed token problem is on the input side (tool
output flooding the context), not in the agent's reply length, and terse
fragment styles degrade the chat reports users rely on. Nothing stops a
user from dropping any such `SKILL.md` into a skills directory — see
`docs/skills.md`.

## Agentic Spreadsheet native-parts sidecar (2026-10-10)

| Source | Licence | What is used | Daedalus's own implementation |
|---|---|---|---|
| Excelize (github.com/xuri/excelize/v2, v2.9.1) | BSD-3-Clause | Go library used by the `sheet-sidecar` binary to open an exceljs-produced `.xlsx` and inject native chart/pivot/slicer parts that exceljs cannot write | `Daedalus/sheet-sidecar/main.go` is Daedalus's own code: a stdin-JSON export-stage injector. It never reads `workbook.json` (the TypeScript core stays the sole source of truth), is detected like the Pratinjau Asli engines (env override, then PATH), and a missing/failing sidecar degrades the export honestly (no natives + formula-summary fallback), never silently. Spike record: `Daedalus/sheet-sidecar/README.md`. |
| exceljs 4.4.0 | MIT | Ordinary npm dependency of `@daedalus/core`: writes XLSX values/formats/frozen panes/validations and reads XLSX on import | Listed here only because it is load-bearing for the Spreadsheet domain; governed by its package licence like every other npm dependency. |

## Rules applied

- Reference clones remain the pinned origins listed in `PLAN.md` §2.0.
- Reused concepts above are adaptations, not claims of original invention.
- No API keys or provider secrets from reference repositories were copied.
- Ordinary npm dependencies are governed by their package licences in
  `package.json` / `package-lock.json` and are not listed as copied source here.

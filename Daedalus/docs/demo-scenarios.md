# Demo Scenarios and Thesis Screenshot Checklist

This file prepares reproducible demonstrations without inventing captures. **No thesis screenshots have been captured during this offline documentation pass.** The deterministic scenarios below run locally with scripted providers and validate behaviour/harness flow. The live scenario is a checklist to execute after a real provider endpoint is reachable.

## A. Offline deterministic evaluation demo (recommended for development demos)

This demo proves fixture generation, the Daedalus agent loop, validation gating, event recording, result extraction, and aggregation. It does not demonstrate live LLM reasoning.

```bash
cd Daedalus
npm install

# 1) Validate the 12-task suite (4 bug fix / 4 feature / 4 refactor).
node --experimental-strip-types evaluation/runners/run-evaluation.ts --validate-suite

# 2) Run one task per category.
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --task bug-fallback-greeting \
  --task feature-clamp-number \
  --output evaluation/reports/deterministic-subset

# 3) Run the full deterministic harness dataset.
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --output evaluation/reports/deterministic-full

# 4) Re-aggregate the full deterministic dataset.
node --experimental-strip-types evaluation/runners/aggregate.ts \
  --input evaluation/reports/deterministic-full \
  --output evaluation/reports/aggregate-deterministic
```

Expected evidence to show:

- `evaluation/reports/deterministic-full/results.json` and `.csv`
- `evaluation/reports/deterministic-full/runs/<task>.json`
- `evaluation/reports/deterministic-full/runs/<task>.events.jsonl`
- `evaluation/reports/aggregate-deterministic/report.md`
- aggregate language that marks `live` as `not_run`

Narration boundary: say “deterministic harness validation,” not “the model solved all 12 tasks.”

## B. Offline integration-test demo

These tests exercise real CLI/server/core seams with fake providers and local fixtures.

```bash
cd Daedalus

# Full gate: build/typecheck, dependency/scope checks, and all package tests.
bash scripts/check.sh

# Focused Phase 9 demonstrations, if package-level test filtering is desired:
npm --workspace @daedalus/core run test -- tests/phase9-integration.test.ts
npm --prefix cli run test -- tests/phase9-integration.test.ts
npm --workspace @daedalus/server run test -- tests/phase9-integration.test.ts
```

Behaviours covered by the Phase 9 set include E2E fixture execution, CLI subprocess run, CLI/Web event-order parity, all 10 tools, LLM fault injection, permissions, terminal failures, validation recovery/replanning, replay, cancellation, and the Phase 8.5 launcher/provider/upload/greenfield surfaces.

## C. Local product-surface demo without a live model

Use this to rehearse navigation and visual states. Task execution still needs a reachable provider unless a developer substitutes a local fake provider.

```bash
cd Daedalus
npm install
bash scripts/check.sh

# Development mode
bash scripts/dev.sh
# Web: http://127.0.0.1:5173
# API health: http://127.0.0.1:3080/health

# Or built-Web mode after the check has produced daedalus-web/dist
node --experimental-strip-types cli/src/index.ts serve --daemon
node --experimental-strip-types cli/src/index.ts status
# Open the reported server URL in a browser.
node --experimental-strip-types cli/src/index.ts stop
```

Demonstrate, without claiming model results:

1. Create/select a workspace and create a folder/file.
2. Cycle modes with Shift+Tab and show the five mode accents/badges.
3. Type `/` and show the shared slash palette.
4. Open Settings/Providers and show that an existing API key is masked.
5. Upload a harmless text file and a small image; show the non-vision warning if the selected model does not support images.
6. Stop the daemon from the CLI and show `status` reporting it unhealthy/stopped.

For a fully scripted local provider/greenfield demonstration, use the Phase 9 fake-provider integration tests in Scenario B rather than inventing a one-off transcript.

## D. Live demo checklist (after provider recovery)

Do not perform or publish this as a result until the provider test succeeds.

1. Start the laptop-hosted 9Router and its Cloudflare Tunnel, or configure another OpenAI-compatible provider.
2. In Daedalus Settings/Providers, select the preset/custom provider, enter the key locally, and run **Test connection**. Confirm models are returned; never screenshot the raw key.
3. Run a small live smoke task in a disposable workspace: ask Daedalus to create a folder and a small text file, then validate it.
4. Run a representative coding task and keep the workspace disposable or version-controlled so the diff can be inspected/reset.
5. Capture the screenshots below.
6. Run the full live Phase 10 evaluation:

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode live \
  --provider-id nine-router \
  --model <model-id> \
  --output evaluation/reports/live-<date>
```

7. Aggregate deterministic and live datasets while keeping modes separate. Only after this should thesis result claims and Phase 10/11 completion be updated.

## Thesis screenshot checklist

Capture these from the real running UI after the live smoke succeeds. Suggested filenames are shown; create the destination folder only when captures are actually made.

| # | Screenshot | What must be visible | Suggested filename |
|---:|---|---|---|
| 1 | Task entry / composer | Goal, workspace, provider/model, mode badge, auto-approve state | `thesis-assets/screenshots/01-task-entry.png` |
| 2 | Mode switching | Mode menu or badge after Shift+Tab, with mode accent | `thesis-assets/screenshots/02-mode-switch.png` |
| 3 | Slash palette | `/` suggestions from the shared registry | `thesis-assets/screenshots/03-slash-palette.png` |
| 4 | Plan view | Ordered plan steps and current step before/during execution | `thesis-assets/screenshots/04-plan.png` |
| 5 | Activity timeline | Model/tool events in sequence | `thesis-assets/screenshots/05-timeline.png` |
| 6 | Approval prompt | A mutating/executing action awaiting approve/deny/remember in Manual mode | `thesis-assets/screenshots/06-approval.png` |
| 7 | Workspace and uploads | Workspace tree, created folder/file, attachment chips | `thesis-assets/screenshots/07-workspace-uploads.png` |
| 8 | Image vision gate | Vision-capable send state or explicit non-vision warning | `thesis-assets/screenshots/08-image-vision-gate.png` |
| 9 | Diff view | Files changed with patch/diff evidence | `thesis-assets/screenshots/09-diff.png` |
| 10 | Validation panel | Build/test/lint checks and pass/fail status | `thesis-assets/screenshots/10-validation.png` |
| 11 | Recovery, if it occurs naturally | Validation failure followed by recovery/replan evidence; do not stage a fake result | `thesis-assets/screenshots/11-recovery.png` |
| 12 | Final report | Outcome, evidence, metrics, files changed | `thesis-assets/screenshots/12-final-report.png` |
| 13 | Providers/settings | Provider list with masked key state and successful Test connection | `thesis-assets/screenshots/13-providers.png` |
| 14 | Orchestrator, optional | Child task list/status and combined report | `thesis-assets/screenshots/14-orchestrator.png` |
| 15 | CLI, optional | Bare launcher menu and interactive status bar | `thesis-assets/screenshots/15-cli.png` |

Privacy rule for every capture: API keys, tokens, personal file paths, and unrelated desktop notifications must not be visible. Provider screens should show only masked key state.

## Demo reset guidance

- Use disposable fixture workspaces for live demos so the same scenario can be reset.
- Keep the generated event log/report with the screenshot set; a screenshot without its task record is weaker thesis evidence.
- Record provider id, model id, mode, approval policy, date/time, and validation commands beside the captures.
- If a run fails, retain it and label the failure honestly rather than replacing it silently with a later success.

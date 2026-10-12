# Phase 10 Evaluation — implementation and live-run status

This document records the evaluation support implemented for Daedalus Phase 10 and the live experiment run on 2026-10-05.

## Status on 2026-10-05

- The 12-task suite exists in `Daedalus/evaluation/tasks/tasks.json`: 4 bug fixes, 4 feature additions, and 4 refactors.
- A headless runner exists in `Daedalus/evaluation/runners/run-evaluation.ts`.
- An aggregator exists in `Daedalus/evaluation/runners/aggregate.ts`.
- Deterministic runs use a scripted provider to validate the harness and are labelled `deterministic` in every manifest, record, aggregate, and report.
- **Live result recorded.** After Farid restored `llm.ayid.cc.cd`, the standardized 12-task live run was executed on 2026-10-05 with model `kgw/kilo-auto/free`. Dataset: `evaluation/reports/live-kilo-2026-10-05/`. Result: **0 success, 12 partial, 0 failed/stopped**; every run passed the syntax check (1/2 checks) but failed the behaviour validation, so the failure taxonomy is `validation_failed: 12`.
- Combined comparison dataset: `evaluation/reports/aggregate-combined-2026-10-05/` aggregates deterministic 12/12 success against live 0/12 success. The deterministic figure remains harness validation only and must not be reported as live model performance.

Phase 10's live experiment has therefore been run and recorded; the poor live success rate is a result, not a missing run.

## Offline validation performed on 2026-10-05

- Suite validation: `run-evaluation.ts --validate-suite` passed with 12 tasks (4 bug fix, 4 feature addition, 4 refactor).
- Deterministic subset: 3 tasks (one per category) completed successfully in `evaluation/reports/deterministic-subset/`.
- Deterministic full harness dataset: all 12 tasks completed successfully in `evaluation/reports/deterministic-full/`; each run passed 2/2 declared validation checks.
- Standalone aggregation of the full deterministic dataset succeeded in `evaluation/reports/aggregate-deterministic/`; the aggregate comparison explicitly marks `live` as `not_run`.

These are harness-validation results only. They are not a live model success rate.

## Experimental design

### Independent variables

- Provider mode: `deterministic` scripted provider vs `live` configured provider.
- In future live runs: provider id, model id, task category, mode (`auto` in the runner), approval policy (`auto` for headless reproducibility), iteration/error budgets, and seed/temperature metadata where the provider/core supports them.

### Dependent variables / metrics

Each run records:

- task id and category;
- outcome and final task state;
- turns and model iterations;
- tool calls, including counts by tool;
- wall-clock duration;
- retries and recovery/replan events;
- approvals, commands, files changed, and event count;
- validation evidence (check name, command, status, exit code, summary);
- final diff when file changes are emitted;
- provider/mode/configuration metadata;
- generated fixture workspace path and per-run event JSONL path.

### Task suite

The suite is intentionally small and reproducible. Tasks are synthetic Node.js fixtures that isolate concrete behaviours: fallback handling, quantity arithmetic, slug/date formatting, adding small helpers, and behaviour-preserving refactors. Each task declares validation commands (`node --check` plus a behaviour script) so success is gated by executable evidence rather than the model's final message.

## Commands

Validate the suite:

```bash
cd Daedalus
node --experimental-strip-types evaluation/runners/run-evaluation.ts --validate-suite
```

Run a deterministic subset:

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --task bug-fallback-greeting \
  --task feature-clamp-number \
  --output evaluation/reports/deterministic-subset
```

Run the full deterministic harness dataset:

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --output evaluation/reports/deterministic-full
```

Aggregate datasets:

```bash
node --experimental-strip-types evaluation/runners/aggregate.ts \
  --input evaluation/reports/deterministic-full \
  --output evaluation/reports/aggregate-deterministic
```

Run live only after a provider is reachable:

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode live \
  --provider-id nine-router \
  --model <model-id> \
  --output evaluation/reports/live-<date>
```

## Threats to validity

- **Construct validity:** fixture validators cover the behaviours named in each task, not every possible regression in a larger codebase.
- **Internal validity:** deterministic scripted runs remove model variance, so they validate the harness rather than the agent's reasoning. Live runs may vary by provider/model, provider load, and unsupported temperature/seed controls.
- **External validity:** twelve tiny synthetic repositories cannot represent large real-world projects, long histories, complex build systems, or ambiguous requirements.
- **Reliability:** wall-clock measurements depend on the local machine and, for live runs, network/provider conditions. Event logs, results JSON/CSV, manifests, and generated workspaces are retained so runs can be inspected and re-aggregated.
- **Provider availability:** the live experiment depends on the configured provider endpoint being reachable. Earlier on 2026-10-05 the endpoint returned Cloudflare HTTP 530 / Error 1033; after it recovered, the live run above was completed. Deterministic evidence must not be substituted for live evidence in the thesis results.

## Live work completed

1. Restored the live provider endpoint (`llm.ayid.cc.cd`).
2. Ran a one-task live smoke; it reached the provider and produced a recorded partial result.
3. Ran all 12 tasks with `--mode live` using `kgw/kilo-auto/free` and retained the dataset under `evaluation/reports/live-kilo-2026-10-05/`.
4. Aggregated deterministic and live datasets comparatively under `evaluation/reports/aggregate-combined-2026-10-05/`.
5. Updated `PLAN.md` Phase 10 status and result claims from those retained records.

See also: [architecture](architecture.md), [demo scenarios and screenshot checklist](demo-scenarios.md), and [limitations and future work](limitations-and-future-work.md).

# Daedalus Phase 10 Evaluation Report

Generated: 2026-10-05T09:08:35.312Z

> Deterministic results use a scripted provider to validate the evaluation harness. They are **not** live LLM results. Live rows are included only when a dataset with `mode: "live"` records is aggregated.

## Summary

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| all | recorded | 3 | 0 | 0 | 0 | 3 | 0% |
| deterministic | not run | 0 | - | - | - | - | - |
| live | recorded | 3 | 0 | 0 | 0 | 3 | 0% |

## Deterministic vs live comparison

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| deterministic | not run | 0 | - | - | - | - | - |
| live | recorded | 3 | 0 | 0 | 0 | 3 | 0% |

## By category

| Category | Runs | Success | Success rate | Avg tool calls | Avg wall-clock ms |
|---|---:|---:|---:|---:|---:|
| bug_fix | 1 | 0 | 0% | 12 | 55934 |
| feature_addition | 1 | 0 | 0% | 17 | 50145 |
| refactor | 1 | 0 | 0% | 16 | 55238 |

## Failure taxonomy

| Failure type | Count |
|---|---:|
| budget_exceeded | 3 |

## Runs

| Task | Category | Mode | Outcome | Turns | Tool calls | Wall-clock ms | Validation passed/total | Failure taxonomy |
|---|---|---|---|---:|---:|---:|---:|---|
| bug-fallback-greeting | bug_fix | live | stopped | 12 | 12 | 55934 | 0/0 | budget_exceeded |
| feature-clamp-number | feature_addition | live | stopped | 12 | 17 | 50145 | 0/0 | budget_exceeded |
| refactor-extract-tax | refactor | live | stopped | 12 | 16 | 55238 | 0/0 | budget_exceeded |

## Threats to validity

- Small synthetic fixture repositories limit external validity; they are designed to exercise specific bug-fix, feature, and refactor behaviours rather than represent full production codebases.
- Deterministic scripted-provider runs measure harness reliability, event recording, validation gating, and fixture reproducibility. They do not measure model reasoning quality, prompt quality, token cost, or live-provider latency.
- If live runs are absent, live model performance remains pending; no success rate for a real model should be inferred from this report.
- Wall-clock timings depend on the local machine, Node.js version, filesystem, and provider/network conditions for live runs.
- Validation is limited to the commands declared by each fixture (syntax plus a behaviour script). Passing fixtures does not prove absence of regressions outside those assertions.
- Provider/model configuration, temperature support, and provider-side nondeterminism must be recorded with any future live dataset; the current core forwards timeout configuration but not a universal temperature control through TaskRunner.

## Caveats

- Deterministic runs use a scripted provider and validate the harness/loop; they are not live LLM performance.
- Live runs are included in this aggregate.
- Fixture tasks are small synthetic repositories; results do not generalize directly to large real-world projects.

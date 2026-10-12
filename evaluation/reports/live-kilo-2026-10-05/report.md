# Daedalus Phase 10 Evaluation Report

Generated: 2026-10-05T08:25:15.842Z

> Deterministic results use a scripted provider to validate the evaluation harness. They are **not** live LLM results. Live rows are included only when a dataset with `mode: "live"` records is aggregated.

## Summary

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| all | recorded | 12 | 0 | 12 | 0 | 0 | 0% |
| deterministic | not run | 0 | - | - | - | - | - |
| live | recorded | 12 | 0 | 12 | 0 | 0 | 0% |

## Deterministic vs live comparison

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| deterministic | not run | 0 | - | - | - | - | - |
| live | recorded | 12 | 0 | 12 | 0 | 0 | 0% |

## By category

| Category | Runs | Success | Success rate | Avg tool calls | Avg wall-clock ms |
|---|---:|---:|---:|---:|---:|
| bug_fix | 4 | 0 | 0% | 4 | 15768 |
| feature_addition | 4 | 0 | 0% | 4.25 | 17655 |
| refactor | 4 | 0 | 0% | 5 | 19851 |

## Failure taxonomy

| Failure type | Count |
|---|---:|
| validation_failed | 12 |

## Runs

| Task | Category | Mode | Outcome | Turns | Tool calls | Wall-clock ms | Validation passed/total | Failure taxonomy |
|---|---|---|---|---:|---:|---:|---:|---|
| bug-fallback-greeting | bug_fix | live | partial | 4 | 4 | 15428 | 1/2 | validation_failed |
| bug-cart-quantity-total | bug_fix | live | partial | 4 | 4 | 16905 | 1/2 | validation_failed |
| bug-slugify-format | bug_fix | live | partial | 4 | 4 | 15468 | 1/2 | validation_failed |
| bug-date-padding | bug_fix | live | partial | 4 | 4 | 15272 | 1/2 | validation_failed |
| feature-clamp-number | feature_addition | live | partial | 4 | 4 | 15040 | 1/2 | validation_failed |
| feature-unique-array | feature_addition | live | partial | 4 | 4 | 20563 | 1/2 | validation_failed |
| feature-csv-quote | feature_addition | live | partial | 5 | 5 | 16310 | 1/2 | validation_failed |
| feature-markdown-title | feature_addition | live | partial | 4 | 4 | 18707 | 1/2 | validation_failed |
| refactor-extract-tax | refactor | live | partial | 6 | 6 | 25901 | 1/2 | validation_failed |
| refactor-normalize-name | refactor | live | partial | 4 | 4 | 16524 | 1/2 | validation_failed |
| refactor-extract-price-format | refactor | live | partial | 5 | 5 | 19617 | 1/2 | validation_failed |
| refactor-timeout-config | refactor | live | partial | 5 | 5 | 17361 | 1/2 | validation_failed |

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

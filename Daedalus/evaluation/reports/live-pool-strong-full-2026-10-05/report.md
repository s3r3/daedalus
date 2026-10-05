# Daedalus Phase 10 Evaluation Report

Generated: 2026-10-05T09:41:29.146Z

> Deterministic results use a scripted provider to validate the evaluation harness. They are **not** live LLM results. Live rows are included only when a dataset with `mode: "live"` records is aggregated.

## Summary

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| all | recorded | 12 | 6 | 0 | 0 | 6 | 50% |
| deterministic | not run | 0 | - | - | - | - | - |
| live | recorded | 12 | 6 | 0 | 0 | 6 | 50% |

## Deterministic vs live comparison

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| deterministic | not run | 0 | - | - | - | - | - |
| live | recorded | 12 | 6 | 0 | 0 | 6 | 50% |

## By category

| Category | Runs | Success | Success rate | Avg tool calls | Avg wall-clock ms |
|---|---:|---:|---:|---:|---:|
| bug_fix | 4 | 4 | 100% | 8.75 | 35489 |
| feature_addition | 4 | 1 | 25% | 21 | 109008 |
| refactor | 4 | 1 | 25% | 29.25 | 136383 |

## Failure taxonomy

| Failure type | Count |
|---|---:|
| budget_exceeded | 5 |
| validation_failed | 1 |

## Runs

| Task | Category | Mode | Outcome | Turns | Tool calls | Wall-clock ms | Validation passed/total | Failure taxonomy |
|---|---|---|---|---:|---:|---:|---:|---|
| bug-fallback-greeting | bug_fix | live | success | 3 | 4 | 13576 | 2/2 | none |
| bug-cart-quantity-total | bug_fix | live | success | 3 | 3 | 10115 | 2/2 | none |
| bug-slugify-format | bug_fix | live | success | 16 | 25 | 103517 | 2/2 | none |
| bug-date-padding | bug_fix | live | success | 3 | 3 | 14748 | 2/2 | none |
| feature-clamp-number | feature_addition | live | success | 6 | 6 | 53645 | 2/2 | none |
| feature-unique-array | feature_addition | live | stopped | 20 | 26 | 104049 | 0/0 | budget_exceeded |
| feature-csv-quote | feature_addition | live | stopped | 20 | 26 | 92611 | 0/0 | budget_exceeded |
| feature-markdown-title | feature_addition | live | stopped | 20 | 26 | 185727 | 0/0 | budget_exceeded |
| refactor-extract-tax | refactor | live | stopped | 20 | 24 | 240410 | 1/2 | validation_failed |
| refactor-normalize-name | refactor | live | stopped | 20 | 24 | 108954 | 0/0 | budget_exceeded |
| refactor-extract-price-format | refactor | live | success | 18 | 33 | 76679 | 2/2 | none |
| refactor-timeout-config | refactor | live | stopped | 20 | 36 | 119489 | 0/0 | budget_exceeded |

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

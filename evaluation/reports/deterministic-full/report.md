# Daedalus Phase 10 Evaluation Report

Generated: 2026-10-05T08:00:08.341Z

> Deterministic results use a scripted provider to validate the evaluation harness. They are **not** live LLM results. Live rows are included only when a dataset with `mode: "live"` records is aggregated.

## Summary

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| all | recorded | 12 | 12 | 0 | 0 | 0 | 100% |
| deterministic | recorded | 12 | 12 | 0 | 0 | 0 | 100% |
| live | not run | 0 | - | - | - | - | - |

## Deterministic vs live comparison

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
| deterministic | recorded | 12 | 12 | 0 | 0 | 0 | 100% |
| live | not run | 0 | - | - | - | - | - |

## By category

| Category | Runs | Success | Success rate | Avg tool calls | Avg wall-clock ms |
|---|---:|---:|---:|---:|---:|
| bug_fix | 4 | 4 | 100% | 2 | 268 |
| feature_addition | 4 | 4 | 100% | 2 | 246 |
| refactor | 4 | 4 | 100% | 2.75 | 243 |

## Failure taxonomy

No non-success runs were recorded in this aggregate.

## Runs

| Task | Category | Mode | Outcome | Turns | Tool calls | Wall-clock ms | Validation passed/total | Failure taxonomy |
|---|---|---|---|---:|---:|---:|---:|---|
| bug-fallback-greeting | bug_fix | deterministic | success | 2 | 2 | 289 | 2/2 | none |
| bug-cart-quantity-total | bug_fix | deterministic | success | 2 | 2 | 267 | 2/2 | none |
| bug-slugify-format | bug_fix | deterministic | success | 2 | 2 | 229 | 2/2 | none |
| bug-date-padding | bug_fix | deterministic | success | 2 | 2 | 288 | 2/2 | none |
| feature-clamp-number | feature_addition | deterministic | success | 2 | 2 | 268 | 2/2 | none |
| feature-unique-array | feature_addition | deterministic | success | 2 | 2 | 230 | 2/2 | none |
| feature-csv-quote | feature_addition | deterministic | success | 2 | 2 | 243 | 2/2 | none |
| feature-markdown-title | feature_addition | deterministic | success | 2 | 2 | 242 | 2/2 | none |
| refactor-extract-tax | refactor | deterministic | success | 3 | 3 | 252 | 2/2 | none |
| refactor-normalize-name | refactor | deterministic | success | 2 | 2 | 227 | 2/2 | none |
| refactor-extract-price-format | refactor | deterministic | success | 3 | 3 | 248 | 2/2 | none |
| refactor-timeout-config | refactor | deterministic | success | 3 | 3 | 245 | 2/2 | none |

## Threats to validity

- Small synthetic fixture repositories limit external validity; they are designed to exercise specific bug-fix, feature, and refactor behaviours rather than represent full production codebases.
- Deterministic scripted-provider runs measure harness reliability, event recording, validation gating, and fixture reproducibility. They do not measure model reasoning quality, prompt quality, token cost, or live-provider latency.
- If live runs are absent, live model performance remains pending; no success rate for a real model should be inferred from this report.
- Wall-clock timings depend on the local machine, Node.js version, filesystem, and provider/network conditions for live runs.
- Validation is limited to the commands declared by each fixture (syntax plus a behaviour script). Passing fixtures does not prove absence of regressions outside those assertions.
- Provider/model configuration, temperature support, and provider-side nondeterminism must be recorded with any future live dataset; the current core forwards timeout configuration but not a universal temperature control through TaskRunner.

## Caveats

- Deterministic runs use a scripted provider and validate the harness/loop; they are not live LLM performance.
- No live-provider runs are included; live evaluation remains pending and must not be inferred from deterministic results.
- Fixture tasks are small synthetic repositories; results do not generalize directly to large real-world projects.

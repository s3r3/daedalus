# Evaluation runners

The runners are headless TypeScript entry points executed with Node's type stripping; they import the shared Daedalus core directly and do not add agent logic outside the core.

## Validate the suite

```bash
cd Daedalus
node --experimental-strip-types evaluation/runners/run-evaluation.ts --validate-suite
```

## Deterministic harness validation

Deterministic mode uses a scripted provider. It validates fixtures, the agent loop, validation gating, event recording, result extraction, and aggregation. It must never be reported as live LLM performance.

Subset:

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --task bug-fallback-greeting \
  --task feature-clamp-number \
  --output evaluation/reports/deterministic-subset
```

Full deterministic dataset:

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode deterministic \
  --output evaluation/reports/deterministic-full
```

## Live mode

Live mode uses `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` from the environment and/or providers registered in `<DAEDALUS_HOME>/providers.json`. Do not run or report a live dataset while the provider endpoint is unreachable.

```bash
node --experimental-strip-types evaluation/runners/run-evaluation.ts \
  --mode live \
  --provider-id nine-router \
  --model <model-id> \
  --output evaluation/reports/live-<date>
```

## Aggregate existing datasets

```bash
node --experimental-strip-types evaluation/runners/aggregate.ts \
  --input evaluation/reports/deterministic-full \
  --output evaluation/reports/aggregate-deterministic
```

Multiple `--input` flags can combine deterministic and live datasets; the report keeps the modes separate and marks a mode `not run` when no records exist for it.

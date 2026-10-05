# Evaluation task suite

This directory contains the Phase 10 offline-ready task definitions for Daedalus.

- `tasks.json` is the machine-readable suite: exactly 12 tasks — 4 `bug_fix`, 4 `feature_addition`, and 4 `refactor`.
- Each task has a goal, explicit done criteria, a small local fixture (`setupFiles`), validation commands, and a deterministic scripted-provider action list used only to validate the evaluation harness.
- Fixtures are generated locally by `evaluation/runners/run-evaluation.ts`; no reference repository is modified.
- Deterministic scripts are not live model behaviour. They are a reproducibility control that proves fixture setup, the Daedalus loop, validation gating, event recording, and aggregation work before a real provider is trusted with the suite.

Run suite validation:

```bash
cd Daedalus
node --experimental-strip-types evaluation/runners/run-evaluation.ts --validate-suite
```

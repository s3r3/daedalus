# Evaluation reports

Generated evaluation datasets live under this directory. Each dataset directory contains:

- `manifest.json` — mode, configuration, selected tasks, and the deterministic/live caveat.
- `results.json` and `results.csv` — one record per run, derived from the Daedalus result/event stream.
- `runs/<task>.json` — the full per-run record.
- `runs/<task>.events.jsonl` — the recorded event stream for that run.
- `aggregate.json` — machine-readable aggregate metrics and failure taxonomy.
- `report.md` — thesis-oriented Markdown report.
- `workspaces/<task>/` — the generated fixture workspace after the run.
- `daedalus-home/` — isolated Daedalus task persistence for the dataset.

Do not relabel a `deterministic` dataset as `live`. A live dataset exists only after the runner is executed with `--mode live` against a reachable configured provider.

# Limitations and Future Work

This document separates verified limitations from aspirations. It is part of the Phase 11 documentation preparation and must be updated after the live Phase 10 evaluation; it is not a final freeze statement.

## Current blockers and unverified items

### Live evaluation result is model-limited

The 12-task evaluation suite, runner, aggregator, deterministic subset, and deterministic full dataset exist. Those deterministic runs use a scripted provider to validate fixtures, the agent loop, validation gating, recording, and aggregation. They are **not** evidence of live model performance.

The live 12-task run was completed on 2026-10-05 after `llm.ayid.cc.cd` recovered, using model `kgw/kilo-auto/free`. The retained dataset is `Daedalus/evaluation/reports/live-kilo-2026-10-05/`, with a deterministic-vs-live comparison in `Daedalus/evaluation/reports/aggregate-combined-2026-10-05/`. The live outcome was **0/12 success and 12/12 partial**, all classified as `validation_failed`: the model generally inspected the fixture but did not make the required file change before validation/recovery budgets ended. This is a valid negative result for that provider/model/configuration, not evidence that the deterministic harness result transfers to live models.

### Native desktop tray is not bundled

The daemon lifecycle, tray menu model (Open CLI/Open Web/Status/Quit), capability detection, and fake-backend ordering tests are implemented. This build does **not** bundle a native tray backend, and the development VM is headless, so a real desktop icon and right-click Quit have not been verified. Headless behaviour intentionally reports the limitation and directs the user to `daedalus status` / `daedalus stop`.

### Tracked `.env` requires an owner decision

`Daedalus/.env` is present and tracked in this repository clone. Its contents are not reproduced in documentation. Treat any real credential that has ever been committed to a public/shared repository as exposed. The safe remediation is to rotate the provider key, remove `.env` from git tracking/history, and keep only `.env.example` with empty values. That remediation changes credentials and repository history, so it has not been performed as part of this documentation preparation.

Also note: `.env.example` is only a template. The current entry points read process environment and do not automatically load `.env`; export the variables or configure providers through the server/Web registry.

## Functional and security limitations

### Local trust boundary, not multi-user security

The default server binds to `127.0.0.1`, but there is no user authentication or multi-tenant authorization layer. API CORS allows any origin. Do not expose the server to an untrusted network without adding authentication, origin restrictions, TLS, and a deployment review.

### Workspace confinement is primarily lexical

Core and server path checks reject absolute/relative paths that resolve outside the selected workspace by path arithmetic. The core realpaths the workspace root, but target paths are not fully canonicalized component-by-component before use. A symlink inside a workspace that points outside it may therefore escape the intended boundary on some flows. Treat workspaces as trusted local directories until symlink-aware canonicalization and tests are added.

### Command execution is allowlisted, not an OS sandbox

`run_command` uses an executable allowlist, blocks known dangerous/interactive patterns, sets timeouts and output caps, supports cancellation, and kills process groups. It is not a container/VM sandbox. Commands run with the local user's operating-system authority inside the selected working directory. The harness sandbox flag defaults off in the core configuration; when off, child processes inherit the parent environment. Do not run untrusted tasks or repositories without enabling and verifying stronger isolation.

### Provider and model variability

Daedalus uses OpenAI-compatible APIs, but providers differ in tool-call formatting, streaming, refusal behaviour, context limits, vision support, timeout behaviour, and whether temperature/seed controls are honoured. The registry's vision detection combines explicit flags and model-name heuristics; it is not a guarantee for every provider/model. Live results must identify provider/model/configuration precisely.

### Validation depends on project commands

Completion is gated on discovered or configured build/test/lint checks. A repository with missing, misleading, or trivial validation scripts can produce weak evidence. Evaluation fixtures deliberately declare executable validators, but real projects need project-specific validation review.

### Small evaluation scope

The Phase 10 suite has 12 tiny synthetic Node.js fixture tasks. Even after live runs, it cannot by itself establish performance on large repositories, ambiguous requirements, long histories, complex build systems, or other programming languages. Wall-clock times depend on machine, network, and provider load.

### Attachments and uploads

Uploads are limited to 20 files, 10 MiB per file, 25 MiB total, and ZIP archives are limited to 200 entries/50 MiB uncompressed. Only images that pass provider/model vision resolution and context limits are sent as image bytes; others are represented as metadata with an explicit not-sent note. Large binary analysis, OCR, and document understanding are not built in.

### Orchestrator scope

Orchestrator mode is sequential by default and decomposes by done criteria or plan steps. It has per-child/total budgets and no-progress stopping, but it is not a persistent multi-agent team system, does not guarantee optimal decomposition, and only parallelizes if a future implementation proves child independence.

## Future work

- Repeat the live 12-task evaluation with stronger tool-calling models and compare configurations, failure taxonomy, recovery behaviour, cost, and variance across repeated runs.
- Add a maintained native tray backend and verify Open CLI/Open Web/Status/Quit on Windows, macOS, and at least one Linux desktop.
- Rotate and purge tracked secrets, add repository secret scanning, and consider loading configuration through a documented secure local settings flow instead of shell-only environment variables.
- Harden workspace confinement with symlink-aware canonicalization and adversarial tests for files, uploads, ZIP extraction, git tools, and command working directories.
- Add authenticated, origin-restricted server deployment options; review CORS and bind defaults for non-local use.
- Move command execution toward container/VM or OS-level sandboxing for untrusted repositories, with explicit environment allowlists.
- Expand evaluation to larger, independently selected repositories and more languages; add repeated live runs to quantify variance and cost.
- Improve provider capability discovery (context, vision, tool-call dialect, streaming, seed/temperature support) and record it per run.
- Add richer validators and semantic/LSP tools, MCP client integration, and optional parallel orchestration for proven-independent child tasks.
- Prepare final thesis screenshots and a recorded demo after the live evaluation, then freeze versions and create the release tag/snapshot requested by Phase 11.

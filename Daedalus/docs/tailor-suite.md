# Tailor suite — making weaker routed models perform above their weight

Farid's framing: *the Web/core is the tailor, the model is the cloth.* These
six harness features make a mediocre routed model produce near-big-model
results on routine work. All of them live in `@daedalus/core` (CLI and Web
share them), are surfaced first in the Web Settings/workspace UI, and fail
open: a broken router, escalation, or review never fails the task itself.

## 1. Model routing per task phase (tiers)

Each pool model can carry a capability tier: `strong | balanced | fast`
(unset models count as balanced). The agent loop stamps every request with
a phase:

- `explore` — before the first mutation: balanced first, then fast.
- `edit` — after the task has mutated the workspace: strong first.
- `repair` — the turn after a failed validation: strong first.
- `question` — direct Q&A calls (fast path): fast first, then balanced.

The pool stable-sorts its attempt order by tier rank for the phase
(intra-tier config order and cooldown filtering are preserved; failover
still walks the order on retryable errors). Routing is a no-op for
single-model pools and when fewer than two distinct tiers are assigned.

Configuration:

- Web Settings → provider form → per-model tier selects (persisted as
  `modelTiers` on the provider config).
- `LLM_MODEL_TIERS=model-a:strong,model-b:fast` for env-driven setups.
- `DAEDALUS_MODEL_ROUTING=off` disables routing (tiers are still recorded
  on events).
- `MODEL_REQUEST_STARTED` carries `phase`; `MODEL_REQUEST_FINISHED`
  carries the serving `model` and its `tier`.

## 2. Prompt dialect per model family

Model families were trained on different framing conventions. The system
prompt gains one short `## dialect` section with framing-only conventions
(≤6 lines): Claude → XML-style section tags, GPT → terse markdown
imperatives, Qwen/Llama/Gemini → plain numbered imperatives.

- Provider field `promptFamily` (Web Settings → provider form): `auto`
  (default) detects from the model id (`claude`, `gpt`, `qwen`, `llama`,
  `gemini` substrings), or pin a family explicitly.
- `LLM_PROMPT_FAMILY` sets the env default.
- `generic`/unset adds **no section** — the default prompt is
  byte-identical to the pre-dialect prompt.

## 3. Quality escalation

When validation fails on a real check (not a skipped one) and the driving
model is not the pool's strongest, the next repair iteration is pinned to
the strongest pool model for the remainder of the task. The Web Chat shows
"escalated to stronger model" (`PROVIDER_CHANGED` with
`reason: quality_escalation`). At most one escalation per task; the strong
model is kept (no flapping back). Requires a 2+ model pool.
`DAEDALUS_QUALITY_ESCALATION=off` disables.

## 4. Structured edit format (SEARCH/REPLACE)

Opt-in per provider (`editFormat`, Web Settings → provider form;
`LLM_EDIT_FORMAT=search_replace` for env setups; default `native`). In
`search_replace` mode the model also gets the `edit_search_replace` tool
(Aider semantics):

```
<<<<<<< SEARCH
<lines copied byte-exact from the current file>
=======
<replacement lines>
>>>>>>> REPLACE
```

Anchors must match exactly once — no fuzzy apply. A mismatch writes
nothing and returns an instructive error (re-read the file, copy the
anchor byte-exact, extend the anchor until unique). The tool rides the
same machinery as `edit_file`: mode approvals, checkpoint backups,
`FILE_CHANGED` diffs, and the post-edit syntax guard. In text-protocol
mode the replacements travel in CDATA, markers byte-exact.

## 5. Workspace map pinning

The Web workspace panel has a pin toggle on every file/folder row. Pins
persist server-side in `<daedalus-home>/pins.json` (shared with the CLI,
which reads the same file through the runtime — no CLI UI) and are
injected into every task's workspace overview as "Pinned by user", with a
short first-lines excerpt per file. Caps: max 10 pins shown in the prompt,
6 lines per file, 2,400 chars total, with a truncation note when capped.
Endpoints: `GET /workspace/pins?root=…`, `PUT /workspace/pins`.

## 6. Cross-model review gate (default OFF)

Web Settings toggle (or `DAEDALUS_REVIEW_GATE=on`): when a task driven by
a non-strongest pool model finishes with file changes, the strongest pool
model runs the existing read-only review pass over the diff before
completion is declared. The verdict is a `REVIEW_COMPLETED` event, a
Chat line, and a `review` section on the final report. High-severity
(blocking) findings demote the outcome from success to partial with the
issues listed as evidence. The gate is report-only — it never re-runs
the agent (repair loops are escalation's job) — and it is skipped when
the author model is already the strongest, the pool has one model, or
nothing changed. Any review failure skips the gate silently.

## Honest limits

- Tier routing reorders *attempts*; if the strong model errors, failover
  still falls back to weaker models for that request.
- The prompt dialect is resolved once per task from the primary model;
  a pool that mixes families mid-task keeps the task's dialect.
- Escalation pins at the first validation failure; a task that never
  reaches validation never escalates.
- SEARCH/REPLACE is exact-match only by design; models that cannot copy
  an anchor byte-exact get errors, not silent fuzzy fixes.
- The review gate reviews the aggregated diff text (capped like
  `/review`); it does not run tests or read surrounding code.

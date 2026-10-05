---
name: code-review
description: Review a diff like a senior engineer: correctness first, then safety, then clarity; findings with severity and location.
---

# Code Review

Review the change, not the author. Read the diff with the surrounding code
it touches — a hunk rarely tells the whole story.

## What to check, in order

1. **Correctness** — does it do what it claims? Trace the main path and the edge cases: empty input, first/last element, error paths, retries.
2. **Safety** — injection, path escapes, secret leakage, unsafe defaults, resource leaks (files, processes, listeners), and anything that runs shell commands built from untrusted text.
3. **Contract drift** — changed interfaces without updated callers, docs, or tests; silent behaviour changes behind an unchanged signature.
4. **Tests** — new behaviour covered? Would the tests fail without the change? Are they asserting behaviour or implementation details?
5. **Clarity** — only after the above: names, dead code, needless complexity. Formatting and taste are not findings.

## Reporting

- One finding per problem: **severity** (high/medium/low), `file:line`, and a concrete message that says what breaks and when.
- Distinguish "this is wrong" from "consider this". If you are unsure, ask a question instead of inventing a defect.
- If there are no real problems, say "No findings." — a clean review is a valid review.

## Done when

Every finding is either fixed, explicitly accepted by the user, or recorded
as a follow-up with its severity.

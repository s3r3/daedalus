---
name: spec-driven-development
description: Write a short spec before code: goal, scope, interfaces, acceptance criteria, then implement against it.
---

# Spec-Driven Development

Before writing code for a non-trivial task, write a short spec and keep it
next to the work (a `SPEC.md` in the workspace or the task description).

## The spec

Keep it to one page:

1. **Goal** — the outcome in one or two sentences, from the user's point of view.
2. **Scope** — what changes, and explicitly what does *not* change.
3. **Interfaces** — public functions, endpoints, CLI flags, or file formats touched, with their shapes.
4. **Acceptance criteria** — a checklist of observable statements ("when X, then Y"), each one verifiable by a test or a command.
5. **Open questions** — anything undecided; state the assumption you will code against.

## Working against the spec

- Implement in the order of the acceptance criteria; check them off as they pass.
- When reality contradicts the spec, update the spec first, then the code — never let the two drift apart silently.
- If a criterion cannot be met, say so in the spec with the reason instead of quietly dropping it.
- Prefer the smallest design that satisfies the criteria; speculative generality is out of scope.

## Done when

Every acceptance criterion is demonstrably true (test output, command
output, or a shown artifact), and the spec matches what was built.

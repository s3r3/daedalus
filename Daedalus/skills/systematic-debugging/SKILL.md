---
name: systematic-debugging
description: Debug by evidence: reproduce, narrow, hypothesise, prove, fix the cause — never patch symptoms at random.
---

# Systematic Debugging

## Method

1. **Reproduce** — get a reliable reproduction first: exact input, command, and output. Intermittent? Record how often it happens before touching anything.
2. **Read the error** — the full message and stack, slowly. Note the *first* suspicious frame, not just the throwing one.
3. **Narrow** — bisect the space: which input, which code path, which change. Comment out, stub, or bisect commits until the failing region is small.
4. **Hypothesise** — state one cause in one sentence ("X is undefined because Y runs before Z"). Design the smallest experiment that could prove it *wrong*.
5. **Prove, then fix** — confirm the hypothesis with a measurement (log, debugger, failing test). Fix the cause, not the nearest symptom.
6. **Guard** — add the test or check that would have caught it, and run the surrounding suite.

## Habits

- Change one thing at a time; if you cannot tell which change fixed it, you have not found the cause.
- Suspect recent changes and environment differences (versions, env vars, cwd) before exotic explanations.
- Print/state inspection beats guessing; never stack speculative fixes.
- When stuck for more than a few cycles, write down what you know, what you ruled out, and the cheapest next experiment.

## Done when

The reproduction passes, the cause is named in the summary, and a guard
(test or check) fails without the fix.

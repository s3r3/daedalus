---
name: test-driven-development
description: Red-green-refactor: write a failing test first, make it pass with the smallest change, then clean up.
---

# Test-Driven Development

Use this loop for behaviour changes and bug fixes:

## The loop

1. **Red** — write one small test that describes the next piece of behaviour. Run it and watch it fail for the expected reason (not a typo, not a missing import).
2. **Green** — write the least code that makes the test pass. Resist adding behaviour no test asks for.
3. **Refactor** — with the suite green, improve names and structure. Run the tests after each small step.

## Rules of thumb

- One behaviour per test; name tests after the behaviour, not the implementation.
- A bug fix starts with a test that reproduces the bug. If you cannot reproduce it in a test, say so and reproduce it with a script instead.
- Test at the boundary you own (unit for logic, one integration test for wiring). Avoid mocking the thing you are trying to prove.
- Never weaken or delete a failing test to make the suite pass; change the code, or escalate why the test is wrong.
- Run the whole relevant suite before declaring done, not just the new test.

## Done when

The new tests fail without the change and pass with it, and the rest of the
suite is still green.

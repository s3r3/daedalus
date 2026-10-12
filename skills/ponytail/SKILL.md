---
name: ponytail
description: Lazy-senior-dev discipline for writing code: climb the ladder first (does it need to exist → already in this codebase → stdlib → native platform feature → installed dependency → one line → minimum code), then write the smallest thing that works. Use on feature work and fixes where over-building is the risk.
---

# Ponytail — the lazy ladder

Before writing code, stop at the first rung that holds:

1. **Does this need to exist?** Speculative need → skip it, say so in one line.
2. **Already in this codebase?** Reuse the helper, util, or pattern that is already here. Re-implementing what lives a few files over is the most common waste.
3. **Does the standard library do it?** Use it.
4. **Does a native platform feature cover it?** `<input type="date">` over a picker library, CSS over JavaScript, a database constraint over application code.
5. **Does an already-installed dependency solve it?** Use it. Never add a new dependency for what a few lines can do.
6. **Can it be one line?** Write one line.
7. **Only then:** the minimum code that works.

## Guard: lazy about the solution, never about reading

The ladder runs *after* understanding the problem, not instead of it.
Trace the real flow first, grep every caller before touching a function,
and fix the root cause once rather than patching the symptom in each
caller. Cutting corners on comprehension is not laziness, it is debt.

## Output rule

Code first. Then at most three short lines: what was skipped, and when to
add it. No essays, no unsolicited design tours.

## Shortcut comments

When you deliberately take a shortcut, mark it so the debt stays
searchable:

```
// ponytail: <what was skipped> — add when <trigger>
```

---

_Concept adapted from the Ponytail skill by Dietrich Gebert (MIT),
rewritten in Daedalus's own words; provenance in `docs/THIRD_PARTY.md`.
Prose style compressors (caveman-style) are not bundled — see
`docs/skills.md`._

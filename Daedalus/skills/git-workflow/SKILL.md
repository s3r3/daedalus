---
name: git-workflow
description: Work cleanly with git: small commits, clear messages, safe history, and patches that are easy to review.
---

# Git Workflow

## Commits

- Commit early and often, in small units that each leave the tree working (tests green, or the breakage explicitly noted).
- One logical change per commit. If the message needs "and", split it.
- Message format: a short imperative summary (`fix(parser): reject empty flag value`), then a blank line, then *why* the change exists. The diff already shows *what*.

## Safety rails

- Never rewrite shared history (no force-push to shared branches, no amending published commits) unless the user explicitly asks.
- Check `git status` and the staged diff before committing; never sweep unrelated changes into a commit.
- Do not commit secrets, generated bundles, or local state files (`.env`, task logs) — if one is already tracked, flag it instead of adding more.
- Prefer `git stash`, branches, or worktrees over destructive resets when work is in progress.

## Isolation

For parallel or risky work, use a separate git worktree on its own branch
(`daedalus/<task>` for Daedalus-isolated tasks). Review the worktree diff
before applying it to the main workspace, and refuse to apply on conflicts
rather than forcing it.

## Reviewing history

Use `git log --oneline`, `git show`, and `git blame` to answer "why is this
here?" before changing old code — the intent is often in the history.

# Contributing to Slidemason

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/erickittelson/slidemason.git
cd slidemason
pnpm install
pnpm dev          # Studio at http://localhost:4200
pnpm test         # Run tests
pnpm build        # Build all packages
pnpm typecheck    # Type check
```

**Requirements:** Node.js 22+, pnpm 10+

## Workflow

1. **Open an issue first** for anything non-trivial — bug fixes, new features, refactors. This lets us discuss the approach before you invest time.
2. **Fork and branch** — create a feature branch from `main`.
3. **Make your changes** — follow existing patterns in the codebase.
4. **Test** — run `pnpm test` and `pnpm build`. Add tests for new functionality.
5. **Open a PR** — fill out the PR template. Reference the issue if there is one.

## Branch Naming

Use descriptive branch names:

- `feat/add-timeline-primitive`
- `fix/split-ratio-crash`
- `docs/update-theme-guide`

## Code Style

- TypeScript everywhere — no `any` unless truly necessary.
- Use theme CSS variables (`var(--sm-*)`) — never hardcode colors.
- Primitives should be crash-proof — invalid props fall back gracefully.
- Follow existing patterns — look at similar components before writing new ones.

## Primitives

If you're adding a new primitive to `packages/primitives/`:

1. Add crash-proof fallbacks for all constrained props.
2. Add a test in `packages/primitives/src/__tests__/`.
3. Export it from `packages/primitives/src/index.ts`.
4. Add it to the primitives table in `CLAUDE.md`.

## Questions?

Open an issue or start a discussion. We're happy to help.

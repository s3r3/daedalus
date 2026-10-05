# Daedalus

A Web-Based Agentic Coding Framework Powered by Large Language Models.

## Quickstart

```bash
# Prerequisites: Node.js >= 22, npm
npm install

# Run all checks (typecheck + lint + tests across all packages)
bash scripts/check.sh

# Start dev servers (backend :3080, web :5173)
bash scripts/dev.sh

# Run CLI health check
node --experimental-strip-types cli/src/index.ts health
```

## Structure

- `core/`: `@daedalus/core` — shared contracts, event bus, task store, settings, logging.
- `cli/`: thin command-line client (`daedalus`).
- `server/`: REST + WebSocket API server (`@daedalus/server`).
- `daedalus-web/`: React 19 + Vite frontend.
- `docs/`: ADRs (`decisions/`) and research notes (`research/`).
- `scripts/`: `check.sh`, `dev.sh`.

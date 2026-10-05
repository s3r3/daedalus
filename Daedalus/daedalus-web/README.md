# Daedalus Web

React + Vite frontend for Daedalus. The Web UI is a thin client over `@daedalus/core` through the Node server in `../server/`; it renders workspaces, tasks, event timelines, plans, approvals, diffs, validation, reports, attachments, child tasks, and settings/providers.

## Development

From the repository root (`Daedalus/`):

```bash
npm install
bash scripts/dev.sh
```

That starts the Daedalus server on `http://127.0.0.1:3080` and Vite on `http://127.0.0.1:5173`. `vite.config.ts` proxies REST calls and the `/tasks` WebSocket to `http://127.0.0.1:3080`; set `DAEDALUS_SERVER` to proxy to another gateway.

Run only this package during frontend work:

```bash
npm run dev --workspace daedalus-web
```

## Build and test

```bash
npm run build --workspace daedalus-web
npm run test --workspace daedalus-web
```

After `npm run build --workspaces` from the root, the Node server can also serve this package's `dist/` output from `/` for non-API browser routes.

## Product surface

- Workspace selection/creation plus folder/file create, rename, edit, upload, folder upload, ZIP upload, and image attachment.
- Composer with the five shared agent modes, Shift+Tab cycling, provider/model picker, auto-approve state, attachments, and the same slash-command registry used by the CLI.
- Settings/Providers UI with masked API-key state; raw keys are write-only form values sent to the server API and never rendered back.
- Activity timeline, plan, diff, validation, recovery, final report, attachments, and orchestrator child-task panels derived from the server task/event model.

See the root [README](../README.md), [architecture](../docs/architecture.md), and [demo scenarios](../docs/demo-scenarios.md).

# Crush Research

## Observed Concepts
- `internal/agent/` defines session-scoped turns with cancellation, completion hooks, queueing, and loop detection.
- `internal/agent/tools/` provides scoped tools; `hooked_tool.go` wraps execution.
- `internal/permission/permission.go` provides approval decisions and persistent grants.
- `internal/pubsub/` brokers events; session data persists through database packages and migrations.
- `internal/workspace/` and `internal/shell/` isolate workspace and command concerns.

## Daedalus Implementation
Daedalus uses explicit task/turn objects, an append-only event log, an in-process event bus, declarative tool schemas, a workspace-confining execution harness, and an Approval Gate. Persistence uses JSON/NDJSON files rather than SQLite. The implementation is TypeScript and independent of Crush's Go stack, TUI, and naming.

## Evidence
`internal/agent/{coordinator,agent,hooked_tool,loop_detection,request_timeout,runid}.go`; `internal/agent/tools/`; `internal/permission/permission.go`; `internal/pubsub/`; `internal/session/`; `internal/workspace/`.

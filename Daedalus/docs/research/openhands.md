# OpenHands Agent Canvas Research

## Observed Concepts
- The local clone is the Agent Canvas frontend, not the Python execution backend.
- `src/api/agent-server-adapter.ts` and backend registry connect the control plane to agent servers.
- Conversation and event stores consume socket events; routes expose planner, files, commits, browser, settings, and automation surfaces.
- The frontend does not execute coding actions. Visible client tools drive UI state only.

## Daedalus Implementation
Daedalus keeps a thin React control plane and a self-contained Node execution backend. One typed event log feeds WebSocket clients and CLI output. Daedalus does not reproduce the backend registry, Zustand store structure, deployment ecosystem, or client-side tools.

## Boundary
The separate `OpenHands/software-agent-sdk` backend was not present and is not treated as inspected evidence.

## Evidence
`src/routes/`; `src/api/{agent-server-adapter,agent-server-compatibility,backend-registry,canvas-ui-client-tool}.ts`; `src/stores/{conversation-store,event-message-store,agent-store}.ts`; `README.md`; `AGENTS.md`.

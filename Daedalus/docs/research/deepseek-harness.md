# DeepSeek Harness Research

## Observed Concepts
- The session log is event-sourced and is the source for history, replay, and UI updates.
- System prompts are assembled from ordered sections; the agent loop is a replaceable seam.
- Tool definitions separate model schemas from host execution and canonical outputs.
- Guarded execution combines scope, approval, sandbox, timeout, and post-execution policy.

## Daedalus Implementation
Daedalus uses one append-only per-task event log for UI and evaluation, an ordered Context Manager, and a model-facing schema allowlist that excludes host fields. Tool dispatch follows policy, approval, execute, and event stages. Daedalus remains a small TypeScript workspace and does not adopt Cordis, its package ecosystem, or generated snapshots.

## Evidence
`packages/core/{agent,agent-loop,system-prompt,tools,session,scope}`; `packages/api/{gateway,session-controller,workspace-controller,terminal-controller,settings-controller,remotes}`; `packages/{guard,sandbox,compaction}`; `docs/{architecture,agent-lifecycle,api-gateway,capability-seams,event-producer-consumer,defensive-patterns}`.

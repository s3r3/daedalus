# Cline Research

## Observed Concepts
- `@cline/agents` owns a stateless agent loop; `@cline/core` owns stateful runtime composition and session lifecycle.
- `@cline/llms` isolates provider handlers and settings; `@cline/shared` supplies common contracts.
- Tools and lifecycle hooks are registered programmatically, enabling policy and audit plugins.
- Approval, task-spec parsing, headless CLI use, teams, and hub-backed runtime are explicit capabilities.

## Daedalus Implementation
Daedalus separates a stateless `AgentLoop` from durable task state and event persistence. A core tool registry and Approval Gate provide the policy seam. Task interpretation produces `TaskSpec`; planning produces amendable checklist steps. Teams, hub services, connectors, and scheduled agents remain out of MVP.

## Evidence
`sdk/packages/README.md`; `sdk/packages/{agents,core,llms,shared,sdk,ui}/package.json`; `apps/{cli,cline-hub,vscode,examples}`; `AGENTS.md`; `evals/`.

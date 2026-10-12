# SWE-agent Research

## Observed Concepts
- `Agent.forward()` prompts, parses actions, and executes them through an environment-backed shell.
- ACI tools are model-oriented and include bounded observations; history processors compress context.
- Action parsers are pluggable; retry loops sample, review, and choose outcomes.
- YAML configuration, explicit budgets, typed failures, and trajectories support reproducible evaluation.

## Daedalus Implementation
Daedalus defines independent JSON-schema tools with bounded structured results and truncation metadata. A Context Manager handles prompt history and budgets. The Validator runs build/test/lint inside the agent loop; Recovery handles retry/fix/replan under limits. Event logs become trajectories without adopting SWE-agent's Python, YAML, Docker, or prompt text.

## Evidence
`sweagent/agent/{agents,reviewer,history_processors,action_sampler,problem_statement,models}.py`; `sweagent/tools/`; `tools/`; `sweagent/run/`; `sweagent/environment/`; `config/`; `pyproject.toml`.

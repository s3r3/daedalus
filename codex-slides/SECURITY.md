# Security Policy

## Supported versions

Security fixes are applied to the latest version on the default branch.

## Report a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for
`nexu-io/codex-slides`. Include:

- the affected version or commit;
- reproduction steps or a proof of concept;
- expected security boundary;
- impact and realistic attacker capabilities;
- any suggested mitigation.

Do not include real credentials, private source documents, or personal project
data. Maintainers will acknowledge the report, investigate, and coordinate a
fix and disclosure when appropriate.

## Sensitive local files

Codex Slides can access Codex authentication, uploaded materials, project
files, and generated slide assets. Never commit or publish:

- `~/.codex/auth.json`;
- `.env` files or tokens;
- private files under `data/projects/`;
- uploaded customer documents;
- logs containing credentials or confidential prompts.

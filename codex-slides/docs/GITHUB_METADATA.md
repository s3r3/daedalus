# GitHub repository metadata

Use this copy when preparing the public GitHub repository.

## Identity

| Field | Recommended value |
|---|---|
| Repository name | `codex-slides` |
| Display title | **Codex Slides — the open-source AI slide studio inside Codex** |
| Owner | `nexu-io` |
| Primary category | **Productivity** |
| Secondary categories | AI, Design Tools, Developer Tools, Presentations |
| License | MIT |
| Default branch | `master` |

## GitHub description

Recommended short description (About box — leads with what users care about most: how many styles, how fast, and that the export is real):

> ⚡ 10+ high-quality slides in ~4–5 minutes — Fast mode renders every page in parallel. 🎨 Open-source AI slide studio inside your coding agent: 118 ready visual systems (45 deck templates + 73 community styles) across 24 guided scenarios → production-ready PPTX/PDF. 🖥️ Browser-first · zero API keys · durable local projects. 🤖 Runs in Codex.

Plain-text alternative:

> The fastest way to make slides with a coding agent — 10+ high-quality slides in ~4–5 minutes. 45 deck templates, 73 community styles, and 24 guided scenarios turn a prompt, a repo, or a pile of files into a production-ready PPTX/PDF — without leaving Codex.

Short alternative:

> 10+ high-quality slides in ~4–5 minutes — 118 visual systems, 24 scenarios, Fast-mode parallel render, and real PPTX/PDF export, image-native and without leaving Codex.

## Topics

GitHub supports up to 20 repository topics. Recommended set:

```text
codex
codex-slides
codex-plugin
agent-skills
coding-agents
mcp
slides
ai-slides
ai-ppt
ai-presentation
presentation-generator
powerpoint
pptx
image-generation
deep-research
design-system
generative-ai
nextjs
typescript
open-design
```

## Marketplace copy

**Display name**

> Codex Slides

**Short description**

> Build decks step by step in a live Codex Browser workspace.

**Long description**

> Codex Slides gives Codex a Browser-first slide workflow plus portable Agent Skills and 38 typed MCP tools. Choose from 45 curated deck templates, 73 community styles, and 24 guided scenarios; open the product before generation, create a durable project, track navigation-independent runs, and keep requirements, research, outline approval, visual direction, rendering, editing, verification, presenting, and export visible and steerable through exact Browser handoffs. Fast mode renders every page in parallel into a production-ready PPTX/PDF. Headless CLI and MCP automation remain available when explicitly requested.

**Category**

> Productivity

## Social preview

A ready-to-use 1280 × 640 social card is generated at
[`docs/assets/readme/social-preview.png`](assets/readme/social-preview.png). Upload it under
**Settings → General → Social preview** so shared links on X, LinkedIn, and Slack render with a
branded card (GitHub has no CLI/API for this, so it is a one-time manual upload).

If regenerating:

- Canvas: 1280 × 640 px.
- Headline: **Make slides with your coding agent.**
- Supporting line: **Codex Slides — the open-source AI slide studio inside Codex.**
- Show the **Codex desktop app driving its in-app Browser** on the Codex Slides workspace (an agent chat column beside a live browser panel rendering finished slides) — **not** a CLI/terminal. The product is operated visually in the browser inside Codex, not by typing commands.
- Optional proof pills: `45 templates`, `73 styles`, `24 scenarios`, `~5 min · 10+ slides`.
- Include `Open source` and `Runs in Codex` pills.
- Use the Codex Slides mark and the product's blue-violet accent (`#6D5EF8`).
- Avoid tiny UI screenshots or more than two lines of text.

## Release naming

Use semantic versions and outcome-oriented release titles:

```text
v0.4.0 — Visual Codex Workflow
v0.4.1 — Project Sync Fixes
v0.5.0 — Design Files and Brand Systems
```

Each release should include:

- user-visible changes;
- upgrade or plugin-cache steps;
- screenshots for visual changes;
- compatibility notes;
- commands used for verification;
- known limitations.

## Suggested repository settings

- Enable Issues and Discussions.
- Enable private vulnerability reporting.
- Require pull requests before merging to the default branch.
- Require typecheck, i18n, Skill, MCP, and production-build checks.
- Enable automatic deletion of merged branches.
- Add the social preview described above.

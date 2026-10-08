# Codex Slides command reference

The portable CLI is:

```bash
node <skill-dir>/scripts/codex-slides.mjs <command> --json '<object>'
```

Use `--json -` to read JSON from stdin, `--input-file input.json` for a file,
or flags such as `--project-id abc --index 2`. Every invocation prints one JSON
object. Success responses contain `"ok": true`; failures contain
`"ok": false` and exit non-zero.

## Command map

| CLI command | MCP tool | Important input |
|---|---|---|
| `capabilities` | `get_capabilities` | none |
| `open` | `open_codex_slides` | optional `projectId`, `view`, `filePath`, `scenarioId` |
| `start-project` | `start_project` | `topic`; optional deck configuration including `projectTemplateId`; creates only a durable project shell and Browser continuation URL |
| `run-start` | `start_project_run` | `projectId`, `kind` (`chat`, `outline`, `render`); non-render runs require `instruction`; optional slide, conversation, material, and Design File context |
| `run-status` | `get_project_run` | `projectId`; optional `runId` |
| `run-wait` | `wait_project_run` | `projectId`, `runId`; optional `timeoutSeconds`, `pollIntervalMs` |
| `run-cancel` | `cancel_project_run` | `projectId`; optional active `runId` |
| `onboard` | `get_onboarding_questions` | `topic`; optional `scenarioId`, `uiLocale` |
| `research` | `deep_research` | `topic`, optional `rounds`, `scenarioId` |
| `create` | `create_deck` | `topic`; optional `scenarioId`, `projectTemplateId`, `pages`, `aspect`, `language`, `style`, `template`, `resolution`, `materialIds`, `materialContexts`, `designSystem`, `fast`, `research`, `researchDoc`, `rounds` |
| `outline` | `create_outline` | same planning inputs as `create` |
| `revise-outline` | `revise_outline` | `projectId` plus `instruction` or `pages`; optional `designFilePaths` |
| `inspiration` | `rank_inspiration` | `topic` or `outlineTitles` |
| `render` | `render_deck` | `projectId` |
| `list` | `list_projects` | none |
| `get` | `get_project` | `projectId`, optional `includeChat` |
| `speaker-notes` | `get_speaker_notes` / `update_speaker_notes` / `generate_speaker_notes` | `projectId`, `action` (`get`, `set`, or `generate`); optional `index`, `note`, `notes`, `overwrite`, `instruction` |
| `templates` | `list_templates` | optional `categoryId`, `communityGroup`, `query`; returns curated templates, community styles, and source/license metadata |
| `project-templates` | `list_project_templates` / `save_project_as_template` / `delete_project_template` | `action` (`list`, `save`, or `delete`); save uses `projectId`, optional `name` / `description`; delete uses `templateId` |
| `scenarios` | `list_scenarios` | optional `group`, `query`, `featured`, `scenarioId` |
| `design-files` | `list_design_files` | `projectId`; optional focused `filePath`; results include `absolutePath` and `downloadUrl` |
| `read-design-file` | `read_design_file` | `projectId`, `filePath` |
| `write-design-file` | `write_design_file` | `projectId`, `filePath`, complete `content` |
| `upload-design-file` | `upload_design_file` | `projectId`, local `filePath` |
| `get-brand-system` | `get_brand_design_system` | `projectId` |
| `set-brand-system` | `update_brand_design_system` | `projectId`; partial `designSystem`, optional `template`, `materialIds`, `brandAssetMaterialIds`, `clear`, `redraw` |
| `edit` | `edit_deck` | `projectId`, `instruction`; optional `slideIndex`, `materialIds`, `designFilePaths` |
| `restyle` | `restyle_deck` | `projectId`; optional `template`, `style`, `materialIds`, `redraw` |
| `slide` | `manage_slide` | `projectId`, `action`; `move` uses `index` and `toIndex`; other index fields depend on action |
| `regenerate` | `regenerate_slide` | `projectId`, `index`, optional `instruction` |
| `upload-material` | `upload_material` | absolute or workspace-relative `filePath` |
| `upload-slide` | `upload_slide_image` | `projectId`, `index`, PNG `imagePath`, optional `title` |
| `mark-edit` | `mark_edit_slide` | `projectId`, `index`, annotated PNG `annotatedImagePath`, optional `note` |
| `export` | `export_deck` | `projectId`, `format` (`pdf` or `pptx`) |

## Examples

Open the product before starting a normal interactive workflow:

```bash
node <skill-dir>/scripts/codex-slides.mjs open
```

Navigate the returned URL in the Codex Browser, submit the request in the home
composer, and continue through clarification, outline confirmation, style
selection, and rendering there. If UI submission needs a deterministic
fallback, create only the project shell and immediately navigate its URL:

```bash
node <skill-dir>/scripts/codex-slides.mjs start-project --json '{
  "topic": "2026 humanoid robot market",
  "pages": 6,
  "language": "zh"
}'
```

The `create` command below is an explicit unattended/headless fast path, not the
default Codex user experience.

Start a durable render, leave or reopen the project, then wait on the same id:

```bash
node <skill-dir>/scripts/codex-slides.mjs run-start --json '{
  "projectId":"PROJECT_ID",
  "kind":"render"
}'

node <skill-dir>/scripts/codex-slides.mjs run-wait --json '{
  "projectId":"PROJECT_ID",
  "runId":"RUN_ID",
  "timeoutSeconds":120
}'
```

Every Browser-capable result includes `browserHandoff`. Navigate its exact URL;
do not drop focus parameters such as `slide`, `panel`, `version`, `mode`,
`checkpoint`, `conversation`, or `run`.

Discover scenarios, stage required files, and create with semantic roles:

```bash
node <skill-dir>/scripts/codex-slides.mjs scenarios \
  --json '{"query":"data insights"}'

node <skill-dir>/scripts/codex-slides.mjs upload-material \
  --json '{"filePath":"./metrics.xlsx"}'

node <skill-dir>/scripts/codex-slides.mjs outline --json '{
  "topic": "Explain this quarter performance",
  "scenarioId": "data-insights",
  "materialIds": ["MATERIAL_ID"],
  "materialContexts": [
    {"id":"MATERIAL_ID","name":"metrics.xlsx","role":"Dataset"}
  ]
}'
```

Create a researched six-slide deck without interactive checkpoints:

```bash
node <skill-dir>/scripts/codex-slides.mjs create --json '{
  "topic": "2026 humanoid robot market",
  "pages": 6,
  "research": true,
  "language": "zh-CN"
}'
```

Save a visual system and consume it in a new project:

```bash
node <skill-dir>/scripts/codex-slides.mjs project-templates --json '{
  "action":"save",
  "projectId":"SOURCE_PROJECT_ID",
  "name":"Executive launch system"
}'

node <skill-dir>/scripts/codex-slides.mjs start-project --json '{
  "topic":"Create the next launch deck",
  "projectTemplateId":"PROJECT_TEMPLATE_ID"
}'
```

Create and review an outline before rendering:

```bash
node <skill-dir>/scripts/codex-slides.mjs outline --json '{
  "topic": "Product launch plan",
  "pages": 8,
  "aspect": "16:9"
}'

node <skill-dir>/scripts/codex-slides.mjs revise-outline --json '{
  "projectId": "PROJECT_ID",
  "instruction": "Move the market proof before the product roadmap"
}'

node <skill-dir>/scripts/codex-slides.mjs render \
  --json '{"projectId":"PROJECT_ID"}'
```

Open the project in the in-editor Browser:

```bash
node <skill-dir>/scripts/codex-slides.mjs open \
  --json '{"projectId":"PROJECT_ID"}'
```

Use the returned `url` as the Browser navigation target. The `open` command
starts the app but intentionally does not control a particular browser client;
the Codex in-app Browser capability performs that final navigation.

Deep-link to new Browser surfaces:

```bash
node <skill-dir>/scripts/codex-slides.mjs open \
  --json '{"view":"scenarios","scenarioId":"market-research"}'

node <skill-dir>/scripts/codex-slides.mjs open \
  --json '{"projectId":"PROJECT_ID","view":"design-files","filePath":"generated/outline.md"}'

node <skill-dir>/scripts/codex-slides.mjs open \
  --json '{"projectId":"PROJECT_ID","view":"brand-system"}'
```

Read a Design File, use it in an edit, then merge brand rules:

```bash
node <skill-dir>/scripts/codex-slides.mjs read-design-file \
  --json '{"projectId":"PROJECT_ID","filePath":"uploaded/brief.md"}'

node <skill-dir>/scripts/codex-slides.mjs edit --json '{
  "projectId":"PROJECT_ID",
  "instruction":"Use the referenced brief to tighten the recommendation",
  "designFilePaths":["uploaded/brief.md"]
}'

node <skill-dir>/scripts/codex-slides.mjs set-brand-system --json '{
  "projectId":"PROJECT_ID",
  "designSystem":{
    "brand":{"name":"Acme","voice":"Direct, expert, optimistic"},
    "colors":{"primary":"#173B57","accent":"#FF6B35"}
  },
  "redraw":false
}'
```

Edit, mark-edit, then export:

```bash
node <skill-dir>/scripts/codex-slides.mjs edit --json '{
  "projectId": "PROJECT_ID",
  "instruction": "Make slide 2 warmer and simplify its comparison chart",
  "slideIndex": 2
}'

node <skill-dir>/scripts/codex-slides.mjs mark-edit --json '{
  "projectId": "PROJECT_ID",
  "index": 2,
  "annotatedImagePath": "/absolute/path/slide-2-marked.png",
  "note": "Follow the red annotations"
}'

node <skill-dir>/scripts/codex-slides.mjs export \
  --json '{"projectId":"PROJECT_ID","format":"pptx"}'
```

Read, author, or generate presenter notes without redrawing slides:

```bash
node <skill-dir>/scripts/codex-slides.mjs speaker-notes --json '{
  "projectId":"PROJECT_ID",
  "action":"get"
}'

node <skill-dir>/scripts/codex-slides.mjs speaker-notes --json '{
  "projectId":"PROJECT_ID",
  "action":"set",
  "index":2,
  "note":"Open with the customer problem, then connect it to the metric on screen."
}'

node <skill-dir>/scripts/codex-slides.mjs speaker-notes --json '{
  "projectId":"PROJECT_ID",
  "action":"generate",
  "instruction":"Write a concise 12-minute executive talk track"
}'
```

## Environment

- `CODEX_SLIDES_URL`: API and Browser base URL; default
  `http://127.0.0.1:4311`.
- `CODEX_SLIDES_HOME`: source checkout. Resolution also checks
  `~/plugins/codex-slides`, the skill's containing repo, and the current
  directory.
- `CODEX_SLIDES_LOG`: auto-start log; default is the operating system temp
  directory.

The CLI uses only Node built-ins plus platform `fetch`, `FormData`, and `Blob`.
It does not import the MCP SDK.

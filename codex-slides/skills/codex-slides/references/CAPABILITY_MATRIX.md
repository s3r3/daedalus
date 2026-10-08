# Codex Slides capability coverage

This is the release checklist for keeping the product UI, Codex in-editor
Browser, portable Agent Skill CLI, and typed MCP server aligned. A product
capability is not Codex-ready until its row has a Browser path and/or a direct
CLI + MCP operation.

| Product capability | Codex Browser entry | Skill CLI | MCP tool |
|---|---|---|---|
| Open create or project workspace | `open`, view `workspace` | `open` | `open_codex_slides` |
| Start durable project before clarification | Home composer or `?resume=<id>` | `start-project` | `start_project` |
| Start a navigation-independent Deck Agent, outline, or render job | Live project activity | `run-start` | `start_project_run` |
| Read or wait for a durable job after navigation/reconnect | Live project activity | `run-status` / `run-wait` | `get_project_run` / `wait_project_run` |
| Cancel an active durable job | Stop action in Deck Agent | `run-cancel` | `cancel_project_run` |
| Browse 24 scenarios in 6 groups | `open`, view `scenarios` | `scenarios` | `list_scenarios` |
| Preselect a scenario and apply its defaults | `scenarioId` deep link | `create` / `outline` with `scenarioId` | `create_deck` / `create_outline` with `scenarioId` |
| Generate scenario-aware onboarding | Scenario composer | `onboard` with `scenarioId` | `get_onboarding_questions` with `scenarioId` |
| Assign uploaded files to scenario slots | Scenario file-slot controls | `upload-material`, then `materialContexts` | `upload_material`, then `materialContexts` |
| Run scenario-aware sourced research | Research UI | `research` with `scenarioId` | `deep_research` with `scenarioId` |
| Create or revise an outline | Outline workspace | `outline`, `revise-outline` | `create_outline`, `revise_outline` |
| Rank and choose visual inspiration | Inspiration dialog | `inspiration` | `rank_inspiration` |
| Render a confirmed draft | Live project workspace | `render` | `render_deck` |
| Explicit unattended one-call deck | Open result after completion | `create` | `create_deck` |
| List and inspect projects | Home and project workspace | `list` / `get` | `list_projects` / `get_project` |
| Browse, search, and match 70+ attributed community styles | Home/project Community Browser | `templates` with `communityGroup` / `query`; `inspiration` for semantic ranking | `list_templates` with `communityGroup` / `query`; `rank_inspiration` |
| Browse saved project visual systems | Home Templates tab / composer picker | `project-templates`, `action:list` | `list_project_templates` |
| Save a project as a reusable template | Project header Save as template | `project-templates`, `action:save` | `save_project_as_template` |
| Delete a saved project template | Home Templates tab | `project-templates`, `action:delete` | `delete_project_template` |
| Create with a saved project template | Composer template picker | `start-project` / `create` / `outline` with `projectTemplateId` | `start_project` / `create_deck` / `create_outline` with `projectTemplateId` |
| Open project Design Files | `open`, view `design-files` | `design-files` | `list_design_files` |
| Copy a Design File path or download it | Design File viewer toolbar | `design-files` response `absolutePath` / `downloadUrl` | `list_design_files` response `absolutePath` / `downloadUrl` |
| Read a Design File | Focused `filePath` deep link | `read-design-file` | `read_design_file` |
| Edit an existing text Design File | Design Files editor | `write-design-file` | `write_design_file` |
| Upload into Design Files | Design Files upload | `upload-design-file` | `upload_design_file` |
| Reference Design Files in agent chat | Composer `@` picker | `designFilePaths` on `edit` / `revise-outline` | `designFilePaths` on `edit_deck` / `revise_outline` |
| Inspect structured tool/todo/file activity | Agent activity cards | `open` | `open_codex_slides` |
| Inspect the brand design system | `open`, view `brand-system` | `get-brand-system` | `get_brand_design_system` |
| Merge brand, color, type, effects, spacing, radii | Brand & Design panel | `set-brand-system` | `update_brand_design_system` |
| Attach persistent logo/product references | Brand assets tray | `upload-material`, then `set-brand-system` | `upload_material`, then `update_brand_design_system` |
| Save brand rules without replacing slides | Brand panel Save | `set-brand-system`, `redraw:false` | `update_brand_design_system`, `redraw:false` |
| Apply brand rules to existing slides | Brand panel Save & redraw | `set-brand-system`, `redraw:true` | `update_brand_design_system`, `redraw:true` |
| Natural-language deck editing | Deck Agent | `edit` | `edit_deck` |
| Queue project-chat turns; edit text/images/files, reorder, delete, or prioritize before serial execution | Deck Agent queue | — interactive Browser session control | — interactive Browser session control |
| Whole-deck template/style restyle | Brand/template UI | `restyle` | `restyle_deck` |
| Add, duplicate, move, delete, or transition slides | Slide controls | `slide` | `manage_slide` |
| Generate or regenerate one slide | Slide/agent controls | `regenerate` | `regenerate_slide` |
| Reopen the exact changed slide, panel, version, checkpoint, conversation, mode, or run | URL focus parameters | Every Browser-capable response returns `browserHandoff` | Every Browser-capable result returns `structuredContent.browserHandoff` |
| Read per-slide speaker notes | Notes strip / presenter view | `speaker-notes`, `action:get` | `get_speaker_notes` |
| Write or clear speaker notes | Inline notes editor | `speaker-notes`, `action:set` | `update_speaker_notes` |
| Generate speaker notes with the project agent | Notes AI action | `speaker-notes`, `action:generate` | `generate_speaker_notes` |
| Upload a reference or finished slide | Material/slide controls | `upload-material` / `upload-slide` | `upload_material` / `upload_slide_image` |
| Apply a marked-up slide edit | Mark canvas | `mark-edit` | `mark_edit_slide` |
| Automatically version every rendered-deck AI/manual change; browse immutable versions, inspect prompts, preview/play, restore as a new current version, and export that exact PDF/PPTX | Project Version history dialog | Mutating commands share the same version-aware project APIs | Mutating tools share the same version-aware project APIs |
| Play from current slide or the beginning | Project Play menu | `open` | `open_codex_slides` |
| Dual-window presenter mode with notes and timer | Project Play menu | `open` | `open_codex_slides` |
| Export PDF or PPTX | Export menu | `export` | `export_deck` |
| Run the same local-first product as a desktop app | Electron window | `electron:dev` / `electron:dist` from checkout | — packaged product transport |

Run `npm run check:skill`, `npm run check:mcp`, `npm run typecheck`,
`npm run check:i18n`, and `npm run build` after changing any row. When a live
Browser session is available, also open all four Browser views and verify their
visible state.

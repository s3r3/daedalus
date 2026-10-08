<p align="right">
  <strong>English</strong> | <a href="README_CN.md">中文</a>
</p>

# MK Present

Works on **Claude Code** · **Codex** · **Hermes Agent** · **OpenClaw**

> A complete presentation workflow: plan your storyline, generate beautiful HTML slides, and export to PowerPoint. Three AI skills, one seamless pipeline.

> **Forked from** [mk-present](https://github.com/textboy/mk-present) — split into 3 specialized skills covering the full presentation lifecycle.

---

## What It Does

MK Present is a **3-skill pipeline** covering the full presentation lifecycle:

1. **📋 [present-workflow](present-workflow/README.md)** — Plan your storyline. Clarify the brief, research, outline, review.
2. **🎨 [present-html](present-html/README.md)** — Generate a stunning HTML presentation. 50+ curated styles, support architecture & flow.
3. **📄 [present-ppt](present-ppt/README.md)** — Convert your HTML deck into an editable PowerPoint (.pptx) with native shapes and text.

```
You: "I need a 10-slide pitch deck about AI agents, with a strong tech vibe"

→ present-workflow drafts the storyline and gets your approval
→ present-html generates a beautiful HTML deck in your chosen style
→ present-ppt exports it as a PowerPoint file — ready to share
```

**Input:** natural language, markdown, or reference screenshots
**Output:** HTML presentation (.html) + optionally PowerPoint (.pptx)

---

## 3 Skills in This Repository

This repository contains three related skills, each handling a different stage of the presentation workflow:

| Skill | Directory | Forked From | Purpose |
|-------|-----------|-------------|---------|
| **[present-workflow](present-workflow/README.md)** | `present-workflow/` | [ppt-agent-workflow-san/ppt-workflow](https://github.com/mucsbr/ppt-agent-workflow-san/tree/main/ppt-workflow) | Complete the storyline / workflow of the deck |
| **[present-html](present-html/README.md)** | `present-html/` | [next-slide](https://github.com/codesstar/next-slide) | Generate HTML presentations with architecture & flow diagram support |
| **[present-ppt](present-ppt/README.md)** | `present-ppt/` | [ppt-agent-workflow-san/html-slide-to-pptx](https://github.com/mucsbr/ppt-agent-workflow-san/tree/main/html-slide-to-pptx) | Convert HTML to editable PowerPoint (.pptx) |

- **[present-workflow](present-workflow/README.md)** — Prepares the presentation storyline as the first stage: clarify brief, research, outline, plan, review.
- **[present-html](present-html/README.md)** — Generates animation-rich HTML presentations from natural language. 50+ curated styles, bilingual support. Also supports architecture and flow diagram generation (enterprise house-architecture, logical/system/physical architecture, flow charts, API sequence diagrams) via Drawio → PNG → embed or direct HTML.
- **[present-ppt](present-ppt/README.md)** — Converts structured single-slide or small deck HTML files into editable PPTX slides with native text boxes, shapes, chips, arrows, and panels. Preset-driven, not a generic browser renderer.

---

## Quick Start

```bash
# 1. Clone the repo anywhere
git clone https://github.com/textboy/mk-present

# 2. Install all 3 skills
bash install.sh           # Auto-detect all available platforms
bash install.sh claude    # Or specify: claude / codex / hermes / openclaw
```

```markdown
# 3. Call the skills in sequence

# Step 1 — Plan your storyline
/present-workflow, design 10 slides for presenting a centralized API platform

# Step 2 — Generate HTML slides (use the output from step 1 as input)
/present-html, [presentation content from step 1]

# Step 3 — Export to PowerPoint
/present-ppt, generate api.pptx by the output of present-html
```

### Also works with

| Platform | Install |
|----------|---------|
| **Claude Code** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh claude` |
| **OpenAI Codex** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh codex` |
| **Hermes Agent** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh hermes` |
| **OpenClaw** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh openclaw` |
| **Any AI tool** | Paste each `SKILL.md` as system prompt + reference the support files |

> Or run `bash install.sh` from a clone — it auto-detects all three and symlinks for you.

No runtime, no API keys, no vendor lock-in. Just markdown instructions + CSS/HTML references.

---

## 50+ Styles, 7 Categories

| Category | Count | Styles | Vibe |
|----------|-------|--------|------|
| **Dark** | 11 | Keynote Noir, Bold Signal, Neon Cyber, Terminal Green, Midnight Corporate, Cinema Scope, Dark Botanical, Starfield, Dark Premium, Dark Cinema, Futuristic Blue | Conferences, launches, tech talks |
| **Light** | 11 | Swiss Modern, Paper & Ink, Notebook Tabs, Pastel Geometry, Morning Brief, Campus White, Soft Landing, Watercolor Wash, Korean Soft, Claymorphism 3D, Wabi-Sabi Zen | Academic, business, teaching |
| **Editorial** | 4 | Editorial Serif, Fashion Editorial, Newsprint Broadsheet, Vintage Editorial | Magazine layouts, thought leadership |
| **Bold** | 7 | Electric Studio, Creative Voltage, Split Pastel, Pop Art, Bold Typography, Neon Brutalism, Memphis Pop | Startups, creative pitches |
| **Retro** | 5 | Grainy Retro, Art Deco Gatsby, Risograph Overprint, Vintage Poster, Retro Arcade | Nostalgic, stylized |
| **Artistic** | 7 | Surrealism Gallery, Scrapbook Portfolio, Blue Collage, Pink Handwritten, Art Nouveau Botanical, Soft Dreamy, Terracotta Earth | Art, design, portfolio |
| **Cultural** | 8 | Ink Wash, Wafu, Gradient Dreams, Blueprint, Bauhaus Primary, Swiss Grid, Aurora Mesh, Chinese Ink Wash | Cultural events, themed talks |

Each style is a complete design system: curated typography, color palette, layout patterns, signature animations, and responsive breakpoints.

**Browse all Scenarios/Styles/Diagrams:** <a href="present-html/gallery.html" target="_blank" style="font-weight: bold; font-size: 18px;">View Gallery</a>

### Gallery UI

![Gallery UI](sample/gallery.png)

### Scenarios Sample

| Scenario 01 | Scenario 02 |
|:-----------:|:-----------:|
| ![Scenario 01](sample/scenario01.png) | ![Scenario 02](sample/scenario02.png) |

### Styles Sample

| Style 01 | Style 02 |
|:--------:|:--------:|
| ![Style 01](sample/style01.png) | ![Style 02](sample/style02.png) |

### Diagrams Sample

| Diagram 01 | Diagram 02 |
|:----------:|:----------:|
| ![Diagram 01](sample/diagram01.png) | ![Diagram 02](sample/diagram02.png) |

---

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  1. CONTENT                                         │
│     Describe your topic, paste markdown,            │
│     or share a reference screenshot                 │
├─────────────────────────────────────────────────────┤
│  2. STYLE                                           │
│     Browse 50+ styles → pick a mood →               │
│     see 3 live previews → choose one                │
│     (or say "match this screenshot")                │
├─────────────────────────────────────────────────────┤
│  3. GENERATE                                        │
│     AI builds the full deck: proper layout,         │
│     animations, responsive CSS, navigation          │
├─────────────────────────────────────────────────────┤
│  4. DELIVER                                         │
│     Opens in browser. Press E to edit inline.       │
│     Deploy to Vercel with one command.              │
└─────────────────────────────────────────────────────┘
```

---

## Features

### present-workflow
- **Staged workflow** — brief → research → outline → planning draft → review → finalize
- **Pyramid Principle** — conclusion-first structure, top-down logic, grouped by category
- **Review gates** — pause for feedback on important decks before committing to full drafts
- **Source-driven** — accepts URLs, reports, PDFs, transcripts as input context

### present-html
- **50+ curated styles** — not just color swaps, each is a distinct design language with Layout DNA
- **Bilingual native** — English + Chinese with proper CJK font support
- **5 input modes** — new from scratch, markdown, enhancement, reference match, style comparison
- **Responsive** — fits any screen, from phone to 4K projector
- **Keyboard navigation** — arrows, space, home/end
- **Inline editing** — press `E` to edit text directly in the browser
- **One-click deploy** — `npx vercel --prod` and you have a live URL
- **Quality assurance** — auto-checks overflow, fonts, density after generation
- **Typography precision** — every style has exact clamp() values extracted from hand-crafted references
- **Architecture & flow diagrams** — generate from natural language: enterprise house-architecture, logical/system/physical architecture, flow charts, API sequence diagrams. Supports Drawio → PNG → embed in HTML, or direct HTML with CSS-positioned cards + SVG connectors.

### present-ppt
- **HTML to PPTX conversion** — export any HTML presentation to PowerPoint with native shapes (text boxes, rectangles, rounded rectangles, styled text, borders, background fills)
- **Preset-driven** — semantic block mapping, not a generic browser renderer
- **Editable output** — text remains editable in PowerPoint, structure is preserved
- **QA/preflight** — built-in checks for spacing, overflow, and arrow direction

---

## Input Formats

| Format | Example |
|--------|---------|
| Natural language | "Make a 10-slide pitch deck about AI agents" |
| Markdown | Provide a `.md` file — headings become slides |
| Reference image | Share a screenshot — AI matches the closest style |
| Enhancement | Point to an existing HTML deck — AI improves it |

---

## Design Philosophy

MK Present is a **3-skill pipeline** built on distinct principles at each stage:

### present-workflow
1. **Constrain the workflow, not the implementation** — Tell the agent what must happen and when, but leave how to execute to the environment.
2. **Staged over one-shot** — Research → outline → planning → review before any full generation. Avoid expensive misfires.
3. **Review gates for important decks** — External-facing, board-level, or high-stakes presentations pause for user feedback before scaling up.

### present-html
1. **No AI Slop** — Every style is hand-crafted with intentional typography, spacing, and motion. The AI follows exact specifications, not vibes.
2. **Layout DNA** — Each style defines its structural patterns: slide mechanism, title alignment, navigation style, background treatment, animation approach, and component structure.
3. **Typography Scale** — Precise `clamp()` values for every element ensure the AI reproduces exact font sizes, weights, line-heights, and letter-spacing.
4. **Viewport First** — Every slide fits exactly in 100vh. No scrolling. Content too long? Split into multiple slides automatically.

### present-ppt
1. **Semantic mapping over screenshot embedding** — Parse HTML into a small intermediate model, then rebuild as native PowerPoint shapes.
2. **Editability first** — Text remains editable in PowerPoint. Fidelity is iterated, not sacrificed for pixel-perfection.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` `↑` `↓` | Navigate slides |
| `Space` | Next slide |
| `Home` / `End` | First / Last |
| `E` | Toggle edit mode |

---

## Customize

Every presentation uses CSS custom properties. Override in `:root`:

```css
:root {
    --bg-primary: #0a0a0a;
    --accent: #ff6b35;
    --font-display: 'Your Font', sans-serif;
}
```

---

## File Structure

```
mk-present/
├── CLAUDE.md                    # Behavioral guidelines
├── LICENSE                      # MIT license
├── README.md                    # This file
│
├── present-workflow/            # Stage 1: storyline preparation
│   ├── SKILL.md
│   ├── README.md
│   └── references/
│       ├── agent-integration.md
│       ├── method.md
│       └── prompts.md
│
├── present-html/                # Stage 2: HTML presentation generation
│   ├── SKILL.md                 # AI instructions (the brain)
│   ├── STYLE_PRESETS.md         # 50+ style definitions with Layout DNA
│   ├── html-template.md         # HTML architecture reference
│   ├── animation-patterns.md    # Animation snippets
│   ├── viewport-base.css        # Responsive CSS base
│   ├── gallery.html             # Style gallery (English)
│   ├── gallery_cn.html          # Style gallery (Chinese)
│   ├── SCENARIO_TEMPLATES.md    # Content scenario templates
│   ├── PROJECT_CONTEXT.md       # Project context
│   ├── README.md / README_CN.md # Documentation
│   ├── openclaw.plugin.json     # OpenClaw plugin manifest
│   ├── install.sh               # Auto-detect & install
│   ├── package.json             # Dev metadata
│   ├── vercel.json              # Deploy config
│   │
│   ├── styles/                  # 56 reference presentations for each style
│   ├── scenarios/               # 114 scenario-based template decks
│   │   └── images/              # Scenario images
│   ├── diagram/                 # Diagram generation specs & samples
│   │   ├── *.md                 # Spec docs (cross-cutting, flow, shape, etc.)
│   │   └── samples/
│   │       ├── *.drawio.xml     # Drawio XML sample diagrams
│   │       └── *.html           # HTML sample diagrams
│   ├── scripts/
│   │   └── generate-drawio.py  # Drawio diagram → PNG generation
│   ├── spec/                   # 10 specification documents
│   └── landing/                # Landing page
│
├── present-ppt/                 # Stage 3: HTML → PPTX conversion
│   ├── SKILL.md
│   ├── README.md
│   ├── package.json / package-lock.json
│   ├── references/
│   │   ├── presets.md
│   │   ├── preset-template.md
│   │   ├── preset-decision-rules.md
│   │   ├── setup.md
│   │   ├── usage-principles.md
│   │   ├── qa-heuristics.md
│   │   └── roadmap.md
│   └── scripts/
│       ├── html_to_pptx.js / html_to_pptx_v9.js
│       ├── layout_v9.js / layout_template.js / layout_utils.js
│       ├── ai_runtime_preset.js / data_strategy_deck_preset.js
│       ├── preset_template.js / preflight_qa.js / check_env.js
│       └── layout_ai_runtime.js
│
├── test/                        # Test & sample outputs
│
├── .claude/
│   └── settings.local.json
└── .loci/
    └── memory.md
```

---

## License

MIT. Copyright 2026 Callum.

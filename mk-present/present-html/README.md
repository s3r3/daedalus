<p align="right">
  <strong>English</strong> | <a href="README_CN.md">中文</a>
</p>

# Present HTML

Works on **Claude Code** · **Codex** · **Hermes Agent** · **OpenClaw**

> Describe what you want. Pick a style. Get a beautiful HTML presentation. No PowerPoint, no build tools.

> **Forked & enhanced from** [next-slide](https://github.com/codesstar/next-slide) — extended with diagram generation.
>
> This is one of the skills in [mk-present](https://github.com/textboy/mk-present).

---

## What It Does

You talk to your AI assistant in natural language. Present HTML turns your words into a polished, animated HTML presentation — a single file you can open in any browser.

```
You: "Make me a 10-slide presentation about AI agents, with a strong tech vibe"

→ AI asks you to pick a style (50+ options with live preview)
→ Generates a complete HTML presentation
→ Opens in your browser, ready to present
```

**Input:** natural language, markdown, or reference screenshots
**Output:** one self-contained HTML file — animations, responsive layout, keyboard navigation, all built in

---

## Quick Start

```bash
# 1. Install as Claude Code skill
git clone https://github.com/textboy/mk-present ~/.claude/skills/present-html

# 2. Use — just talk naturally
# "Make me a presentation about..."
# "Make me a slide about XX" (in Chinese)
# or invoke directly:
/present-html

# 3. Present
open ./output/my-presentation.html    # One file.
```

### Also works with

| Platform | Install |
|----------|---------|
| **Claude Code** | `git clone https://github.com/textboy/mk-present ~/.claude/skills/present-html` |
| **Hermes Agent** | `git clone https://github.com/textboy/mk-present ~/.hermes/skills/present-html` |
| **OpenClaw** | `clawhub install present-html` |
| **Any AI tool** | Paste `SKILL.md` as system prompt + reference the support files |

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

**Browse all Scenarios/Styles/Diagrams:** <a href="gallery.html" target="_blank">View Gallery</a>

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

- **50+ curated styles** — not just color swaps, each is a distinct design language with Layout DNA
- **Bilingual native** — English + Chinese with proper CJK font support
- **5 input modes** — new from scratch, markdown, enhancement, reference match, style comparison
- **Responsive** — fits any screen, from phone to 4K projector
- **Keyboard navigation** — arrows, space, home/end
- **Inline editing** — press `E` to edit text directly in the browser
- **One-click deploy** — `npx vercel --prod` and you have a live URL
- **Quality assurance** — auto-checks overflow, fonts, density after generation
- **Typography precision** — every style has exact clamp() values extracted from hand-crafted references
- **Architecture & flow diagrams** — generate from natural language: enterprise house-architecture, logical/system/physical architecture, flow charts, API sequence diagrams. Supports Drawio → PNG → embed in HTML, or direct HTML with CSS-positioned cards + SVG connectors. See `diagram/` for specs and samples.

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

Present HTML isn't a template engine. It's an opinionated design system that teaches AI to think like a designer:

1. **No AI Slop** — Every style is hand-crafted with intentional typography, spacing, and motion. The AI follows exact specifications, not vibes.
2. **Layout DNA** — Each style defines its structural patterns: slide mechanism, title alignment, navigation style, background treatment, animation approach, and component structure.
3. **Typography Scale** — Precise `clamp()` values for every element ensure the AI reproduces exact font sizes, weights, line-heights, and letter-spacing.
4. **Viewport First** — Every slide fits exactly in 100vh. No scrolling. Content too long? Split into multiple slides automatically.

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
present-html/
├── SKILL.md               # AI instructions (the brain)
├── STYLE_PRESETS.md        # 50+ style definitions with Layout DNA
├── viewport-base.css       # Responsive CSS (included in every deck)
├── html-template.md        # HTML architecture reference
├── animation-patterns.md   # Animation snippets by mood
├── styles/                 # Reference presentations for each style
├── diagram/                # Diagram generation specs & samples
│   ├── samples/*.drawio.xml    # Drawio XML sample diagrams
│   └── samples/*.html          # HTML sample diagrams
├── scripts/
│   └── generate-drawio.py  # Drawio diagram → PNG generation
├── spec/                   # 10 specification documents
├── openclaw.plugin.json    # OpenClaw plugin manifest
└── install.sh              # Auto-detect & install
```

---

## License

MIT. Copyright 2026 Callum.

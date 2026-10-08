# Installation & Integration Specification

## 1. Supported Platforms

| Platform | Type | Trigger |
|----------|------|---------|
| Claude Code | AI CLI (terminal, desktop, VS Code, JetBrains) | `/present-html` or natural language |
| Hermes Agent | AI CLI | `/present-html` or natural language |
| OpenClaw | Plugin system | Plugin manifest triggers |
| Any AI tool | Manual setup | Paste `SKILL.md` as system prompt |

## 2. Installation Methods

### 2.1 Manual Git Clone (All Platforms)

```bash
git clone https://github.com/textboy/mk-present ~/.claude/skills/present-html
```

### 2.2 Automated Install Script

`install.sh` auto-detects all platforms:

```bash
bash install.sh
```

**Detection logic:**
1. Claude Code: checks `~/.claude/skills/` exists → creates symlink
2. OpenClaw: checks `clawhub` command → `clawhub install`
3. Hermes Agent: checks `~/.hermes/skills/` exists → copies directory

### 2.3 Platform-Specific Install

**Claude Code:**
```bash
git clone https://github.com/textboy/mk-present ~/.claude/skills/present-html
```

**Hermes Agent:**
```bash
git clone https://github.com/textboy/mk-present ~/.hermes/skills/present-html
```

**OpenClaw:**
```bash
clawhub install present-html
```

## 3. Install Script Behavior

### 3.1 Claude Code Integration

- Creates symlink from `~/.claude/skills/present-html` to clone location
- Removes existing symlink or directory before creating
- Symlink ensures updates to repo propagate automatically

### 3.2 Hermes Agent Integration

- Hermes does NOT follow symlinks
- Uses `cp -R` (real copy) instead of symlink
- Re-run `install.sh` after repo updates to refresh

### 3.3 OpenClaw Integration

- Uses `clawhub install` with plugin directory
- Plugin manifest: `openclaw.plugin.json`

### 3.4 Error State

If no platforms detected: prints manual install instructions for all three platforms.

## 4. Trigger Pattern

### 4.1 Claude Code Triggers

The skill triggers when user says:
- English: "make a presentation", "build slides", "create a deck", "pitch deck", "PPT", "PowerPoint", "presentation about", "talk slides", "slide deck", "present-html"
- Chinese trigger keywords

### 4.2 Slogan-Based Trigger

"Your next PPT, doesn't have to be PPT." → triggers skill description matching.

## 5. File Manifest

Packaged files (from `package.json` `files` field):
```
SKILL.md
STYLE_PRESETS.md
viewport-base.css
html-template.md
animation-patterns.md
scripts/
openclaw.plugin.json
```

## 6. OpenClaw Plugin Configuration

```json
{
    "name": "present-html",
    "version": "1.0.0",
    "description": "AI-powered HTML presentations. 50+ styles, bilingual.",
    "author": "Callum",
    "license": "MIT",
    "keywords": ["presentation", "slides", "html", "bilingual"]
}
```

## 7. Requirements

- **Runtime**: None (skill is markdown + file references)
- **Python (optional)**: `Pillow` for image processing
- **Node.js (optional)**: Vercel CLI for deployment
- **Playwright (optional)**: PDF export
- **Disk space**: ~10MB for skill files, variable for generated presentations

## 8. Testing Instructions

1. After install, test with: "make a 5-slide presentation about AI"
2. Should: detect trigger → ask questions → open gallery → generate HTML → open in browser
3. Verify: no overflow, all fonts load, navigation works, animations trigger

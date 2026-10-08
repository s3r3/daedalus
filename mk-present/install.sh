#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<HELP
Usage: install.sh [claude|codex|hermes|openclaw]

Install the 3 MK Present skills (present-workflow, present-html, present-ppt)
to the specified platform. Without an argument, auto-detects and installs to
all available platforms.

Platforms:
  claude    Claude Code     (~/.claude/skills/, symlink)
  codex     OpenAI Codex    (~/.codex/skills/, symlink)
  hermes    Hermes Agent    (~/.hermes/skills/, copy)
  openclaw  OpenClaw        (clawhub install)
HELP
  exit 1
}

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS=("present-workflow" "present-html" "present-ppt")

echo "MK Present Installer"
echo "===================="
echo ""

# --- install_claude ---
install_claude() {
  local skill_dir="$HOME/.claude/skills"
  if [ ! -d "$skill_dir" ]; then
    echo "Claude Code skills dir not found (no $skill_dir) — creating it."
    mkdir -p "$skill_dir"
  fi
  echo "Installing to Claude Code..."
  for skill in "${SKILLS[@]}"; do
    local target="$skill_dir/$skill"
    [ -L "$target" ] || [ -d "$target" ] && rm -rf "$target"
    ln -s "$REPO_DIR/$skill" "$target"
    echo "  Symlinked $skill -> $target"
  done
}

# --- install_codex ---
install_codex() {
  local skill_dir="$HOME/.codex/skills"
  if [ ! -d "$skill_dir" ]; then
    echo "Codex skills dir not found (no $skill_dir) — creating it."
    mkdir -p "$skill_dir"
  fi
  echo "Installing to OpenAI Codex..."
  for skill in "${SKILLS[@]}"; do
    local target="$skill_dir/$skill"
    [ -L "$target" ] || [ -d "$target" ] && rm -rf "$target"
    ln -s "$REPO_DIR/$skill" "$target"
    echo "  Symlinked $skill -> $target"
  done
}

# --- install_hermes ---
install_hermes() {
  local skill_dir="$HOME/.hermes/skills"
  if [ ! -d "$skill_dir" ]; then
    echo "Hermes Agent skills dir not found (no $skill_dir) — creating it."
    mkdir -p "$skill_dir"
  fi
  echo "Installing to Hermes Agent..."
  for skill in "${SKILLS[@]}"; do
    local target="$skill_dir/$skill"
    [ -L "$target" ] || [ -d "$target" ] && rm -rf "$target"
    # Hermes does NOT follow symlinks, so copy the directory
    cp -R "$REPO_DIR/$skill" "$target"
    echo "  Copied $skill -> $target"
  done
  echo "  Note: Hermes uses a real copy (re-run install.sh after repo updates)"
}

# --- install_openclaw ---
install_openclaw() {
  if ! command -v clawhub &>/dev/null; then
    echo "OpenClaw not found (clawhub CLI not available) — skipping."
    return 1
  fi
  echo "Installing to OpenClaw..."
  for skill in "${SKILLS[@]}"; do
    if [ -f "$REPO_DIR/$skill/openclaw.plugin.json" ]; then
      clawhub install "$REPO_DIR/$skill"
      echo "  Registered $skill"
    else
      echo "  Skipping $skill (no openclaw.plugin.json)"
    fi
  done
}

# --- Main ---

if [ $# -gt 0 ]; then
  case "$1" in
    claude)
      install_claude
      ;;
    codex)
      install_codex
      ;;
    hermes)
      install_hermes
      ;;
    openclaw)
      install_openclaw
      ;;
    *)
      usage
      ;;
  esac
  echo ""
  echo "Done! Installed to $1."
  exit 0
fi

# No argument — auto-detect all available platforms
installed=false

echo "[1/4] Claude Code"
if [ -d "$HOME/.claude" ]; then
  install_claude
  installed=true
else
  echo "  Skipping (no ~/.claude/)"
fi

echo ""
echo "[2/4] OpenAI Codex"
if [ -d "$HOME/.codex" ]; then
  install_codex
  installed=true
else
  echo "  Skipping (no ~/.codex/)"
fi

echo ""
echo "[3/4] Hermes Agent"
if [ -d "$HOME/.hermes" ]; then
  install_hermes
  installed=true
else
  echo "  Skipping (no ~/.hermes/)"
fi

echo ""
echo "[4/4] OpenClaw"
if command -v clawhub &>/dev/null; then
  install_openclaw
  installed=true
else
  echo "  Skipping (clawhub CLI not found)"
fi

echo ""

if [ "$installed" = true ]; then
  echo "Done! MK Present is ready."
  echo ""
  echo "Usage (3-skill pipeline):"
  echo "  1. /present-workflow  — plan your storyline"
  echo "  2. /present-html      — generate beautiful HTML slides"
  echo "  3. /present-ppt       — export to PowerPoint"
  echo ""
  echo "50+ styles, zero dependencies, bilingual. 你的下个 ppt，何必是 PPT"
else
  echo "No supported platform detected."
  echo ""
  echo "Install to a specific platform:"
  echo "  bash install.sh claude"
  echo "  bash install.sh codex"
  echo "  bash install.sh hermes"
  echo "  bash install.sh openclaw"
  echo ""
  echo "Or install manually — see README.md for instructions."
fi

#!/usr/bin/env bash
set -euo pipefail

echo "=== Typecheck / Build ==="
npm run build --workspaces

echo "=== Dependency check (CLI + Web depend on the same @daedalus/core) ==="
for p in cli server daedalus-web; do
  grep -q '"@daedalus/core"' "$p/package.json" || { echo "FAIL: $p missing @daedalus/core"; exit 1; }
done
test -L node_modules/@daedalus/core || test -d node_modules/@daedalus/core
echo "core workspace link: $(readlink -f node_modules/@daedalus/core)"
echo "core dependency: OK"

echo "=== Scope check (no agent / tool / LLM logic in interfaces) ==="
if grep -rEl "AgentLoop|OpenAICompatProvider|ToolRegistry" cli/src server/src daedalus-web/src; then
  echo "FAIL: agent logic found outside core"; exit 1
fi
echo "scope: OK (zero agent/tool/LLM logic in cli/server/web)"

echo "=== Unit Tests ==="
for p in core cli server daedalus-web; do
  echo "--- $p ---"
  (cd "$p" && ../node_modules/.bin/vitest run)
done

echo "✓ check passed: all 4 packages build, share one core, and pass tests"

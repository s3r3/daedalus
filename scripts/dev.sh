#!/usr/bin/env bash
set -euo pipefail

# Run server and web development servers concurrently
node --experimental-strip-types server/src/main.ts &
SERVER_PID=$!

npm run dev --workspace daedalus-web &
WEB_PID=$!

trap "kill $SERVER_PID $WEB_PID 2>/dev/null || true" EXIT INT TERM
wait

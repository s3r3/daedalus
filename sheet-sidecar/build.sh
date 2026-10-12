#!/usr/bin/env bash
# Build the daedalus-sheet-sidecar binary into ./bin (never committed).
#
# Bundled-at-install story (design: "sidecar dibundel per-platform
# seperti engine preview"): the install/packaging step runs this for
# the target platform (linux-x64, win32-x64) and puts the binary on
# PATH, or sets DAEDALUS_SHEET_SIDECAR to its path. `go build` needs
# module network access once (Excelize); the binary itself is static
# and needs nothing at runtime.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
GOOS="${GOOS:-$(go env GOOS)}" GOARCH="${GOARCH:-$(go env GOARCH)}" \
  go build -trimpath -o bin/daedalus-sheet-sidecar .
# Windows artifact gets its .exe suffix from the packaging step:
#   GOOS=windows ./build.sh && mv bin/daedalus-sheet-sidecar bin/daedalus-sheet-sidecar.exe
ls -l bin/

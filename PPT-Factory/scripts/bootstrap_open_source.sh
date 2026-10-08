#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"

echo "==> Setting up Python environment"
if [[ ! -d "${VENV_DIR}" ]]; then
  python3 -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
python -m pip install --upgrade pip
pip install -r "${ROOT_DIR}/requirements-open-source.txt"

echo "==> Installing frontend dependencies"
(cd "${ROOT_DIR}/frontend" && npm install)

echo "==> Installing PPT assembly dependencies"
(cd "${ROOT_DIR}/my_skills/assemble_pptx_file" && npm install && npx playwright install)

echo
echo "Setup complete."
echo "Next steps:"
echo "  1. cd \"${ROOT_DIR}/frontend\""
echo "  2. npm run dev"

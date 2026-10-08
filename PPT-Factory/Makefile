.PHONY: setup setup-python setup-frontend setup-assembly dev

setup:
	bash scripts/bootstrap_open_source.sh

setup-python:
	python3 -m venv .venv || true
	. .venv/bin/activate && python -m pip install --upgrade pip && pip install -r requirements-open-source.txt

setup-frontend:
	cd frontend && npm install

setup-assembly:
	cd my_skills/assemble_pptx_file && npm install && npx playwright install

dev:
	cd frontend && npm run dev

"""Filesystem artifact layout for generative editable PPTX jobs."""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import threading
from typing import Any

from .generative_editable_manifest import sanitize_persisted_payload

ASSET_CATEGORIES = {"assets", "backgrounds", "asset_sheets", "sources", "previews"}
PROVIDER_OUTPUT_STAGES = {"vlm", "ocr", "image_edit", "asset_sheet", "image_generation", "repair"}


class GenerativeEditableJobArtifacts:
    def __init__(self, *, root_dir: str | Path, job_id: str):
        self.root_dir = Path(root_dir)
        self.job_id = _safe_name(job_id, fallback="")
        if not self.job_id or set(self.job_id) == {"."}:
            raise ValueError("job_id is required")
        self.job_dir = self.root_dir / self.job_id
        root = self.root_dir.resolve()
        job = self.job_dir.resolve()
        if job == root or not job.is_relative_to(root):
            raise ValueError("job_id must resolve inside root_dir")
        self.deck_manifest_path = self.job_dir / "deck.json"
        self.stage_events_path = self.job_dir / "stage-events.jsonl"
        self._stage_events_lock = threading.Lock()
        self._ensure_layout()

    def _ensure_layout(self) -> None:
        for name in (
            "pages",
            "assets",
            "backgrounds",
            "asset_sheets",
            "sources",
            "previews",
            "provider_outputs",
        ):
            (self.job_dir / name).mkdir(parents=True, exist_ok=True)

    def page_manifest_path(self, slide_id: str, page_index: int) -> Path:
        return self.job_dir / "pages" / f"{page_index:04d}-{_safe_name(slide_id)}.json"

    def page_manifest_paths(self, slide_order: list[str]) -> list[Path]:
        return [
            self.page_manifest_path(slide_id, page_index)
            for page_index, slide_id in enumerate(slide_order)
        ]

    def asset_path(
        self,
        slide_id: str,
        page_index: int,
        category: str,
        filename: str,
    ) -> Path:
        if category not in ASSET_CATEGORIES:
            raise ValueError("category must be a known artifact category")
        _validate_plain_filename(filename)
        directory = self.job_dir / category / f"{page_index:04d}-{_safe_name(slide_id)}"
        directory.mkdir(parents=True, exist_ok=True)
        return directory / filename

    def provider_output_path(
        self,
        slide_id: str,
        page_index: int,
        provider_stage: str,
        filename: str,
    ) -> Path:
        if provider_stage not in PROVIDER_OUTPUT_STAGES:
            raise ValueError("provider_stage must be a known provider output stage")
        _validate_plain_filename(filename)
        directory = (
            self.job_dir
            / "provider_outputs"
            / provider_stage
            / f"{page_index:04d}-{_safe_name(slide_id)}"
        )
        directory.mkdir(parents=True, exist_ok=True)
        return directory / filename

    def write_provider_output(
        self,
        slide_id: str,
        page_index: int,
        provider_stage: str,
        filename: str,
        payload: dict[str, Any],
    ) -> Path:
        path = self.provider_output_path(slide_id, page_index, provider_stage, filename)
        path.write_text(
            json.dumps(
                sanitize_persisted_payload(payload),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        return path

    def read_provider_output(
        self,
        slide_id: str,
        page_index: int,
        provider_stage: str,
        filename: str,
    ) -> dict[str, Any]:
        path = self.provider_output_path(slide_id, page_index, provider_stage, filename)
        return json.loads(path.read_text(encoding="utf-8"))

    def append_stage_event(self, event: dict[str, Any]) -> Path:
        self.stage_events_path.parent.mkdir(parents=True, exist_ok=True)
        payload = sanitize_persisted_payload(event)
        record = json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
        with self._stage_events_lock:
            with self.stage_events_path.open("a", encoding="utf-8") as handle:
                handle.write(record)
        return self.stage_events_path

    def read_stage_events(self) -> list[dict[str, Any]]:
        if not self.stage_events_path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in self.stage_events_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                events.append(parsed)
        return events

    def cleanup(self) -> None:
        root = self.root_dir.resolve()
        job = self.job_dir.resolve()
        if job == root or not job.is_relative_to(root):
            raise ValueError("refusing to cleanup outside job directory")
        shutil.rmtree(job, ignore_errors=True)


def _safe_name(value: str, *, fallback: str = "item") -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-")
    return safe or fallback


def _validate_plain_filename(filename: str) -> None:
    file_path = Path(filename)
    if file_path.name != filename or filename in {"", ".", ".."}:
        raise ValueError("filename must be a plain file name")

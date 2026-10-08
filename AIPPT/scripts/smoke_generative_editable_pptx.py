#!/usr/bin/env python3
"""Smoke test generative editable PPTX export with fake or local live providers."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import api.routes.export as export_route  # noqa: E402
from src.generative_editable_config import load_generative_editable_config  # noqa: E402
from src.generative_editable_manifest import read_deck_manifest  # noqa: E402
from src.generative_editable_pipeline import (  # noqa: E402
    GenerativeEditableSlideInput,
    run_generative_editable_pipeline,
    with_provider_retries,
)
from src.generative_editable_providers import ImageEditRequest, ImageGenerationRequest  # noqa: E402
from tests.generative_editable_fixtures import write_deterministic_fixture_deck  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slides", choices=["one", "multi"], default="one")
    parser.add_argument("--aspect-ratio", choices=["16:9", "4:3"], default="16:9")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--use-fake", action="store_true")
    parser.add_argument("--config-check-only", action="store_true")
    parser.add_argument(
        "--provider-check",
        choices=["pipeline", "ocr", "image_generation", "image_edit"],
        default="pipeline",
    )
    args = parser.parse_args(argv)

    config = load_generative_editable_config(use_fake=args.use_fake)
    print(json.dumps({"config": _redacted_config_summary(config)}, ensure_ascii=False))
    if args.config_check_only:
        return 0

    if args.output_dir:
        output_root = Path(args.output_dir).resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        return _run_smoke_with_error_report(args, output_root)

    with tempfile.TemporaryDirectory() as tmp:
        return _run_smoke_with_error_report(args, Path(tmp))


def _run_smoke_with_error_report(args: argparse.Namespace, output_root: Path) -> int:
    try:
        return _run_smoke(args, output_root)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                    "output_dir": str(output_root),
                },
                ensure_ascii=False,
            )
        )
        return 1


def _run_smoke(args: argparse.Namespace, output_root: Path) -> int:
    fixture = write_deterministic_fixture_deck(output_root, aspect_ratio=args.aspect_ratio)
    slides = fixture.slides[:1] if args.slides == "one" else fixture.slides[:3]
    job_id = f"smoke-{args.slides}-{args.aspect_ratio.replace(':', '-')}"
    output_path = output_root / f"{job_id}.pptx"
    artifact_root = output_root / "artifacts"
    dependencies = (
        export_route._build_fake_generative_editable_pipeline_dependencies()
        if args.use_fake
        else export_route._build_generative_editable_pipeline_dependencies()
    )
    dependencies = with_provider_retries(dependencies)
    if args.provider_check == "image_generation":
        output_path = output_root / "provider-image-generation.png"
        result = dependencies.image_generation_provider.generate(
            ImageGenerationRequest(
                prompt_id="live_smoke_image_generation",
                prompt=(
                    "Using the attached source slide as visual reference, generate a small "
                    "transparent presentation icon with no text."
                ),
                output_asset_path=str(output_path),
                asset_root=str(output_root),
                visual_reference={"source_image_path": str(slides[0].image_path)},
                timeout_seconds=180,
            )
        )
        print(
            json.dumps(
                {
                    "status": "passed",
                    "provider_check": "image_generation",
                    "output_path": result.output_asset_path,
                    "provider_role": result.provider_role,
                    "provider_name": result.provider_name,
                },
                ensure_ascii=False,
            )
        )
        return 0
    if args.provider_check == "ocr":
        result = dependencies.ocr_provider.extract_text(str(slides[0].image_path))
        print(
            json.dumps(
                {
                    "status": "passed",
                    "provider_check": "ocr",
                    "provider_role": result.provider_role,
                    "provider_name": result.provider_name,
                    "item_count": len(result.items),
                    "image_size": list(result.image_size),
                },
                ensure_ascii=False,
            )
        )
        return 0
    if args.provider_check == "image_edit":
        source_path = output_root / "provider-image-edit-source.png"
        _write_tiny_edit_probe_image(source_path)
        provider_roles = [
            ("clean_base_model", dependencies.image_edit_provider),
            (
                "asset_sheet_model",
                dependencies.asset_sheet_image_edit_provider or dependencies.image_edit_provider,
            ),
            (
                "repair_model",
                dependencies.repair_image_edit_provider or dependencies.image_edit_provider,
            ),
        ]
        checked_providers = []
        for role, provider in provider_roles:
            output_path = output_root / f"provider-image-edit-{role}.png"
            result = provider.edit(
                ImageEditRequest(
                    source_image_path=str(source_path),
                    prompt_id=f"live_smoke_image_edit_{role}",
                    prompt=(
                        "Remove the black word TEST and keep the light background. "
                        "Return image only."
                    ),
                    output_asset_path=str(output_path),
                    asset_root=str(output_root),
                    timeout_seconds=180,
                )
            )
            checked_providers.append(
                {
                    "role": role,
                    "output_path": result.output_asset_path,
                    "provider_role": result.provider_role,
                    "provider_name": result.provider_name,
                }
            )
        print(
            json.dumps(
                {
                    "status": "passed",
                    "provider_check": "image_edit",
                    "checked_providers": checked_providers,
                },
                ensure_ascii=False,
            )
        )
        return 0

    result = run_generative_editable_pipeline(
        slides=[
            GenerativeEditableSlideInput(
                slide_id=slide.slide_id,
                image_path=str(slide.image_path),
                text_metadata=slide.text_metadata,
            )
            for slide in slides
        ],
        output_path=str(output_path),
        artifact_root=str(artifact_root),
        job_id=job_id,
        aspect_ratio=args.aspect_ratio,
        dependencies=dependencies,
        cleanup_artifacts=False,
        max_page_concurrency=1,
    )
    manifest = read_deck_manifest(artifact_root / job_id / "deck.json")
    print(
        json.dumps(
            {
                "status": result.status,
                "output_path": str(output_path),
                "artifact_root": str(artifact_root / job_id),
                "slide_count": len(slides),
                "validation_status": manifest.validation_status,
                "fallback_used": result.fallback_used,
            },
            ensure_ascii=False,
        )
    )
    return 0


def _write_tiny_edit_probe_image(path: Path) -> None:
    image = Image.new("RGB", (96, 54), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 10, 86, 44), fill="#eef2ff")
    draw.text((18, 20), "TEST", fill="black")
    image.save(path)


def _redacted_config_summary(config) -> dict:
    return {
        "ocr": _provider_summary(config.ocr),
        "clean_base_model": _provider_summary(config.clean_base_model),
        "asset_sheet_model": _provider_summary(config.asset_sheet_model),
        "repair_model": _provider_summary(config.repair_model),
        "generation_model": _provider_summary(config.generation_model),
        "quality": {
            "max_repair_attempts": config.quality.max_repair_attempts,
            "preview_similarity_threshold": config.quality.preview_similarity_threshold,
            "require_preview_validation": config.quality.require_preview_validation,
        },
        "timeouts": {
            "provider_call": config.timeouts.provider_call,
            "page": config.timeouts.page,
        },
    }


def _provider_summary(provider) -> dict:
    return {
        "role": provider.role,
        "provider": provider.provider or "openai_chat",
        "model": provider.model,
        "base_url": "SET" if provider.base_url else "EMPTY",
        "api_key": "SET" if provider.api_key else "EMPTY",
    }


if __name__ == "__main__":
    raise SystemExit(main())

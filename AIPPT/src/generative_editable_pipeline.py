"""Pipeline-level helpers for generative editable PPTX export."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
import inspect
from pathlib import Path
import re
import shutil
from statistics import mean
import time
from typing import Any, Literal

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

from .generative_editable_assets import (
    build_asset_sheet_request,
    repair_failed_assets,
    slice_asset_sheet_by_components,
    validate_sliced_asset,
)
from .generative_editable_backgrounds import (
    BackgroundResult,
    create_base_clean_background,
    create_source_raster_background,
    create_source_preserving_text_background,
    create_text_clean_background,
    update_page_manifest_backgrounds,
)
from .generative_editable_composer import compose_deck_from_manifests
from .generative_editable_foreground_planner import (
    ForegroundCandidate,
    classify_foreground_candidates,
    foreground_candidates_to_manifest_specs,
    plan_foreground_candidates,
)
from .generative_editable_job_artifacts import GenerativeEditableJobArtifacts
from .generative_editable_manifest import (
    BitmapAssetSpec,
    DeckManifest,
    FallbackPolicy,
    AssetSheetSpec,
    NativeShapeSpec,
    PageManifest,
    RepairAttempt,
    TextBoxSpec,
    write_manifest,
)
from .generative_editable_page_analysis import build_page_text_analysis
from .generative_editable_preview_validator import (
    ValidationIssue,
    ValidationReport,
    quality_threshold_to_preview_gates,
    render_manifest_preview_with_metadata,
    validate_composed_deck_structure,
    validate_preview_similarity,
)
from .generative_editable_providers import (
    ImageEditProvider,
    ImageGenerationProvider,
    ImageGenerationRequest,
    OCRResult,
    OCRTextItem,
    OCRProvider,
    RetryingImageEditProvider,
    RetryingImageGenerationProvider,
    RetryingOCRProvider,
)
from .generative_editable_providers import ProviderError, ProviderTimeoutError
from .generative_editable_shape_fitter import fit_native_shape_with_fallback
from .generative_editable_text_candidates import detect_text_candidate_bboxes
from .generative_editable_text import (
    _is_likely_repetitive_hallucinated_text,
    extract_text_with_validation,
)
from .generative_editable_text_masks import create_text_mask


FALLBACK_POLICIES = {"fail", "text_editable_background", "raster_pptx"}
MAX_ASSET_SHEET_CANDIDATES = 6


def _default_visual_text_candidate_detector(**kwargs) -> list[tuple[int, int, int, int]]:
    return detect_text_candidate_bboxes(kwargs["source_image_path"])


def _build_default_assets(**kwargs) -> "AssetBuildResult":
    candidates = [
        candidate
        for candidate in kwargs["candidates"]
        if candidate.classification
        in {"bitmap_asset_candidate", "complex_whole_visual", "uncertain"}
    ]
    if not candidates:
        return AssetBuildResult(bitmap_assets=[])

    asset_root = Path(kwargs["asset_root"])
    page_index = int(kwargs["page_index"])
    slide_id = str(kwargs["slide_id"])
    output_dir = Path(kwargs["output_dir"])
    asset_sheet_provider = kwargs.get(
        "asset_sheet_image_edit_provider", kwargs["image_edit_provider"]
    )
    asset_reference_image_path = (
        kwargs.get("asset_reference_image_path") or kwargs["source_image_path"]
    )
    background_reference_image_path = kwargs.get("background_reference_image_path")
    allow_source_crop_fallback = bool(kwargs.get("allow_source_crop_fallback", False))
    preserved_candidates = [
        candidate for candidate in candidates if candidate.classification == "complex_whole_visual"
    ]
    sheet_candidates = [
        candidate for candidate in candidates if candidate.classification != "complex_whole_visual"
    ]
    preserved_assets = _build_masked_source_element_assets(
        candidates=preserved_candidates,
        source_image_path=kwargs["source_image_path"],
        background_image_path=background_reference_image_path,
        text_mask_path=kwargs.get("text_mask_path"),
        output_dir=output_dir,
        asset_root=asset_root,
        start_z_order=1,
    )
    if not sheet_candidates:
        return AssetBuildResult(
            bitmap_assets=preserved_assets,
            provider_output_payload={
                "asset_strategy": "masked_source_elements",
                "asset_ids": [asset.asset_id for asset in preserved_assets],
            },
        )
    batches = _candidate_batches(
        sheet_candidates,
        max_batch_size=int(kwargs.get("asset_sheet_batch_size", MAX_ASSET_SHEET_CANDIDATES)),
    )
    bitmap_assets: list[BitmapAssetSpec] = list(preserved_assets)
    asset_sheets: list[AssetSheetSpec] = []
    sheet_results: list[Any] = []
    for batch_index, batch in enumerate(batches, start=1):
        sheet_filename = (
            "asset-sheet.png" if len(batches) == 1 else f"asset-sheet-{batch_index:03d}.png"
        )
        sheet_path = (
            asset_root
            / "asset_sheets"
            / f"{page_index:04d}-{_safe_name(slide_id)}"
            / sheet_filename
        )
        request_source_image_path, request_candidates = _asset_sheet_reference_image_for_batch(
            reference_image_path=asset_reference_image_path,
            batch=batch,
            sheet_path=sheet_path,
        )
        request = build_asset_sheet_request(
            source_image_path=request_source_image_path,
            candidates=request_candidates,
            output_asset_path=sheet_path,
            asset_root=asset_root,
            provider_role=asset_sheet_provider.config.role,
            timeout_seconds=int(kwargs.get("provider_timeout_seconds", 180)),
        )
        try:
            sheet_result, asset_sheet_provenance = _create_asset_sheet(
                request=request,
                candidates=request_candidates,
                image_edit_provider=asset_sheet_provider,
                image_generation_provider=kwargs["image_generation_provider"],
                source_image_path=request_source_image_path,
            )
        except ProviderError as exc:
            if not allow_source_crop_fallback:
                raise
            return _source_crop_asset_build_result(
                candidates=candidates,
                source_image_path=kwargs["source_image_path"],
                output_dir=output_dir,
                asset_root=asset_root,
                failure=str(exc),
            )
        try:
            sliced_assets = slice_asset_sheet_by_components(
                sheet_path=sheet_result.output_asset_path,
                candidates=batch,
                output_dir=output_dir,
                asset_root=asset_root,
            )
            bitmap_assets.extend(
                replace(asset, z_order=len(preserved_assets) + asset.z_order)
                for asset in sliced_assets
            )
        except Exception as exc:
            if not allow_source_crop_fallback:
                raise ProviderError(
                    provider_role=asset_sheet_provider.config.role,
                    operation="asset_sheet",
                    message=f"asset sheet cannot be sliced: {str(exc) or exc.__class__.__name__}",
                    retryable=False,
                ) from exc
            return _source_crop_asset_build_result(
                candidates=candidates,
                source_image_path=kwargs["source_image_path"],
                output_dir=output_dir,
                asset_root=asset_root,
                failure=str(exc) or exc.__class__.__name__,
            )
        sheet_id = (
            f"asset-sheet-{page_index:04d}"
            if len(batches) == 1
            else f"asset-sheet-{page_index:04d}-{batch_index:03d}"
        )
        asset_sheet = AssetSheetSpec(
            sheet_id=sheet_id,
            asset_path=_job_relative(sheet_result.output_asset_path, asset_root),
            prompt_id=request.prompt_id,
            candidate_ids=[candidate.candidate_id for candidate in batch],
            provider_role=sheet_result.provider_role,
            provenance={
                "provider": sheet_result.provider_name,
                "model": sheet_result.model,
                "prompt_id": sheet_result.prompt_id,
                **asset_sheet_provenance,
            },
        )
        asset_sheets.append(asset_sheet)
        sheet_results.append(sheet_result)
    bitmap_assets, repair_attempts = _repair_or_replace_provider_asset_mismatches(
        bitmap_assets,
        source_image_path=kwargs["source_image_path"],
        output_dir=output_dir,
        asset_root=asset_root,
        repair_provider=kwargs.get("repair_image_edit_provider", kwargs["image_edit_provider"]),
        max_repair_attempts=int(kwargs.get("max_repair_attempts", 0)),
        provider_timeout_seconds=int(kwargs.get("provider_timeout_seconds", 180)),
        allow_source_crop_fallback=allow_source_crop_fallback,
    )
    provider_output_payload: dict[str, Any] = {
        "asset_sheets": [asdict(sheet) for sheet in asset_sheets],
        "asset_sheet_batches": len(batches),
        "preserved_source_element_count": len(preserved_assets),
        "asset_reference_image_path": _job_relative(Path(asset_reference_image_path), asset_root),
        "repair_attempts": [asdict(attempt) for attempt in repair_attempts],
    }
    if len(sheet_results) == 1:
        provider_output_payload.update(
            {
                "provider": sheet_results[0].provider_name,
                "model": sheet_results[0].model,
                "prompt_id": sheet_results[0].prompt_id,
            }
        )
    return AssetBuildResult(
        bitmap_assets=bitmap_assets,
        asset_sheets=asset_sheets,
        repair_attempts=repair_attempts,
        provider_output_payload=provider_output_payload,
    )


def _asset_sheet_reference_image_for_batch(
    *,
    reference_image_path: str | Path,
    batch: list[ForegroundCandidate],
    sheet_path: Path,
) -> tuple[str, list[ForegroundCandidate]]:
    if len(batch) != 1 or batch[0].classification != "complex_whole_visual":
        return str(reference_image_path), batch
    candidate = batch[0]
    crop_path = sheet_path.with_suffix(".reference.png")
    crop_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(reference_image_path) as reference:
        crop = reference.convert("RGB").crop(candidate.source_pixel_bbox)
        crop.save(crop_path)
    crop_candidate = replace(
        candidate,
        source_pixel_bbox=(0, 0, crop.width, crop.height),
        provenance={
            **_as_dict(candidate.provenance),
            "reference_crop_origin": (
                candidate.source_pixel_bbox[0],
                candidate.source_pixel_bbox[1],
            ),
            "reference_source_pixel_bbox": candidate.source_pixel_bbox,
        },
    )
    return str(crop_path), [crop_candidate]


def _source_crop_asset_build_result(
    *,
    candidates: list[ForegroundCandidate],
    source_image_path: str,
    output_dir: Path,
    asset_root: Path,
    failure: str,
) -> "AssetBuildResult":
    bitmap_assets = _build_source_crop_assets(
        candidates=candidates,
        source_image_path=source_image_path,
        output_dir=output_dir,
        asset_root=asset_root,
        fallback_reason="source_crop_after_asset_sheet_failure",
        failure=failure,
    )
    return AssetBuildResult(
        bitmap_assets=bitmap_assets,
        asset_sheets=[],
        provider_output_payload={
            "asset_sheet_fallback": "source_crops",
            "asset_sheet_failure": failure,
            "asset_ids": [asset.asset_id for asset in bitmap_assets],
        },
    )


def _build_masked_source_element_assets(
    *,
    candidates: list[ForegroundCandidate],
    source_image_path: str,
    background_image_path: str | Path | None = None,
    text_mask_path: str | Path | None,
    output_dir: Path,
    asset_root: Path,
    start_z_order: int = 1,
) -> list[BitmapAssetSpec]:
    if not candidates:
        return []
    output_dir.mkdir(parents=True, exist_ok=True)
    assets: list[BitmapAssetSpec] = []
    with Image.open(source_image_path) as source:
        source_rgba = source.convert("RGBA")
        source_size = source_rgba.size
        mask = _load_optional_text_mask(text_mask_path, source_size)
        background = _load_optional_background_reference(background_image_path, source_size)
        for index, candidate in enumerate(candidates, start=start_z_order):
            bbox = _clamp_bbox_to_size(candidate.source_pixel_bbox, source_size)
            if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
                continue
            crop = source_rgba.crop(bbox)
            preserve_whole_visual = _should_preserve_whole_visual_source_crop(candidate)
            background_crop = (
                None if preserve_whole_visual or background is None else background.crop(bbox)
            )
            crop_mask = None if preserve_whole_visual or mask is None else mask.crop(bbox)
            if background_crop is not None or crop_mask is not None:
                _apply_source_element_alpha(crop, background_crop, crop_mask)
            smooth_difference_suppressed = False
            pre_suppression_crop = crop.copy()
            pre_suppression_visible_pixel_count = _alpha_visible_pixel_count(pre_suppression_crop)
            if background_crop is not None and _should_suppress_smooth_background_difference(
                candidate
            ):
                smooth_difference_suppressed = _suppress_smooth_background_difference_alpha(crop)
                if (
                    smooth_difference_suppressed
                    and _smooth_suppression_collapsed_to_fragment(
                        before_visible_pixel_count=pre_suppression_visible_pixel_count,
                        after_visible_pixel_count=_alpha_visible_pixel_count(crop),
                    )
                    or (
                        smooth_difference_suppressed
                        and _smooth_suppression_lost_domain_row_span(candidate, crop)
                    )
                ):
                    crop = pre_suppression_crop
                    smooth_difference_suppressed = False
            edge_alpha_feathered = False
            if background_crop is not None and _should_feather_source_preserved_asset_edges(
                crop, source_size
            ):
                edge_alpha_feathered = _feather_outer_alpha_edges(crop)
            crop, bbox, trimmed_transparent_bounds = _trim_crop_to_visible_alpha(crop, bbox)
            visible_pixel_count = _alpha_visible_pixel_count(crop)
            source_area = max(1, source_size[0] * source_size[1])
            output_path = output_dir / f"{_safe_name(candidate.candidate_id)}.preserved.png"
            crop.save(output_path)
            assets.append(
                BitmapAssetSpec(
                    asset_id=candidate.candidate_id,
                    source_pixel_bbox=bbox,
                    asset_path=_job_relative(output_path, asset_root),
                    z_order=index,
                    provenance={
                        "candidate_id": candidate.candidate_id,
                        "candidate_classification": candidate.classification,
                        "asset_strategy": "masked_source_element",
                        "text_mask_applied": crop_mask is not None,
                        "background_difference_alpha": background_crop is not None,
                        "smooth_background_difference_suppressed": smooth_difference_suppressed,
                        "edge_alpha_feathered": edge_alpha_feathered,
                        "trimmed_transparent_bounds": trimmed_transparent_bounds,
                        "alpha_visible_pixel_count": visible_pixel_count,
                        "alpha_visible_area_ratio": round(
                            visible_pixel_count / float(source_area), 6
                        ),
                        "candidate_provenance": _as_dict(candidate.provenance),
                    },
                )
            )
    return assets


def _should_preserve_whole_visual_source_crop(candidate: ForegroundCandidate) -> bool:
    if candidate.classification != "complex_whole_visual":
        return False
    provenance = _as_dict(candidate.provenance)
    if provenance.get("detection") in {
        "source_generic_visual_anchor",
        "split_edge_spanning_difference",
        "domain_row_visual_anchor",
    }:
        return False
    original_detection = provenance.get("original_detection")
    if provenance.get("detection") == "source_base_difference" or (
        isinstance(original_detection, dict)
        and original_detection.get("detection") == "source_base_difference"
    ):
        return False
    return (
        provenance.get("preserve_whole_visual") is True
        or provenance.get("reason") == "large_or_visually_complex"
    )


def _should_suppress_smooth_background_difference(candidate: ForegroundCandidate) -> bool:
    provenance = _as_dict(candidate.provenance)
    return provenance.get("detection") in {
        "source_generic_visual_anchor",
        "domain_row_visual_anchor",
    }


def _trim_crop_to_visible_alpha(
    crop: Image.Image,
    source_bbox: tuple[int, int, int, int],
) -> tuple[Image.Image, tuple[int, int, int, int], bool]:
    alpha_bbox = crop.convert("RGBA").getchannel("A").getbbox()
    if alpha_bbox is None:
        return crop, source_bbox, False
    if alpha_bbox == (0, 0, crop.width, crop.height):
        return crop, source_bbox, False
    left, top, right, bottom = source_bbox
    trim_left, trim_top, trim_right, trim_bottom = alpha_bbox
    return (
        crop.crop(alpha_bbox),
        (
            left + trim_left,
            top + trim_top,
            left + trim_right,
            top + trim_bottom,
        ),
        True,
    )


def _apply_source_element_alpha(
    crop: Image.Image,
    background_crop: Image.Image | None,
    crop_mask: Image.Image | None,
    *,
    background_delta_threshold: float = 16.0,
) -> None:
    crop_pixels = crop.load()
    background_pixels = background_crop.load() if background_crop is not None else None
    mask_pixels = crop_mask.load() if crop_mask is not None else None
    for y in range(crop.height):
        for x in range(crop.width):
            red, green, blue, alpha = crop_pixels[x, y]
            if mask_pixels is not None and mask_pixels[x, y] > 0:
                crop_pixels[x, y] = (red, green, blue, 0)
                continue
            if background_pixels is None:
                continue
            if (
                _color_distance((red, green, blue), background_pixels[x, y])
                <= background_delta_threshold
            ):
                crop_pixels[x, y] = (red, green, blue, 0)
            elif alpha != 255:
                crop_pixels[x, y] = (red, green, blue, 255)


def _alpha_visible_pixel_count(image: Image.Image) -> int:
    alpha = image.convert("RGBA").getchannel("A")
    histogram = alpha.histogram()
    return sum(histogram[1:])


def _smooth_suppression_collapsed_to_fragment(
    *,
    before_visible_pixel_count: int,
    after_visible_pixel_count: int,
    min_remaining_ratio: float = 0.08,
) -> bool:
    if before_visible_pixel_count <= 0:
        return False
    return after_visible_pixel_count / float(before_visible_pixel_count) < min_remaining_ratio


def _smooth_suppression_lost_domain_row_span(
    candidate: ForegroundCandidate,
    crop: Image.Image,
    *,
    min_width_ratio: float = 0.45,
) -> bool:
    provenance = _as_dict(candidate.provenance)
    if provenance.get("detection") != "domain_row_visual_anchor":
        return False
    alpha_bbox = crop.convert("RGBA").getchannel("A").getbbox()
    if alpha_bbox is None or crop.width <= 0:
        return True
    return (alpha_bbox[2] - alpha_bbox[0]) / float(crop.width) < min_width_ratio


def _should_feather_source_preserved_asset_edges(
    crop: Image.Image,
    source_size: tuple[int, int],
    *,
    min_area_ratio: float = 0.04,
) -> bool:
    page_area = max(1, source_size[0] * source_size[1])
    return (crop.width * crop.height) / float(page_area) >= min_area_ratio


def _feather_outer_alpha_edges(
    crop: Image.Image,
    *,
    edge_width: int = 10,
    min_edge_alpha: int = 96,
) -> bool:
    if crop.width <= edge_width * 2 or crop.height <= edge_width * 2:
        return False
    rgba = crop.convert("RGBA")
    alpha = rgba.getchannel("A")
    alpha_pixels = alpha.load()
    changed = False
    for y in range(alpha.height):
        for x in range(alpha.width):
            current = alpha_pixels[x, y]
            if current == 0:
                continue
            distance_to_edge = min(x, y, alpha.width - 1 - x, alpha.height - 1 - y)
            if distance_to_edge >= edge_width:
                continue
            edge_factor = min_edge_alpha + int(
                (255 - min_edge_alpha) * (distance_to_edge / float(edge_width))
            )
            new_alpha = max(1, min(current, (current * edge_factor) // 255))
            if new_alpha != current:
                alpha_pixels[x, y] = new_alpha
                changed = True
    if not changed:
        return False
    crop.putalpha(alpha)
    return True


def _suppress_smooth_background_difference_alpha(
    crop: Image.Image,
    *,
    edge_threshold: int = 24,
    bright_threshold: int = 62,
    max_component_area_ratio: float = 0.55,
) -> bool:
    rgba = crop.convert("RGBA")
    width, height = rgba.size
    if width < 8 or height < 8:
        return False
    salient = Image.new("L", rgba.size, 0)
    salient_pixels = salient.load()
    pixels = rgba.load()
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            red, green, blue, alpha = pixels[x, y]
            if alpha == 0:
                continue
            luminance = (red * 299 + green * 587 + blue * 114) // 1000
            right = pixels[x + 1, y]
            down = pixels[x, y + 1]
            gradient = max(
                abs(red - right[0]) + abs(green - right[1]) + abs(blue - right[2]),
                abs(red - down[0]) + abs(green - down[1]) + abs(blue - down[2]),
            )
            if luminance >= bright_threshold or (
                gradient >= edge_threshold and luminance >= bright_threshold - 16
            ):
                salient_pixels[x, y] = 255
    dilated = salient.filter(ImageFilter.MaxFilter(15))
    dilated_pixels = dilated.load()
    edge_points = {(x, y) for y in range(height) for x in range(width) if dilated_pixels[x, y] > 0}
    components = _source_connected_components(edge_points)
    if not components:
        return False
    crop_area = max(1, width * height)
    keep = Image.new("L", rgba.size, 0)
    keep_draw = ImageDraw.Draw(keep)
    kept_any = False
    for component in components:
        if len(component) < 18:
            continue
        xs = [point[0] for point in component]
        ys = [point[1] for point in component]
        bbox = (
            max(0, min(xs) - 3),
            max(0, min(ys) - 3),
            min(width, max(xs) + 4),
            min(height, max(ys) + 4),
        )
        bbox_area = max(1, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))
        if bbox_area / float(crop_area) >= max_component_area_ratio:
            continue
        touches_crop_edge = (
            bbox[0] <= 1 or bbox[1] <= 1 or bbox[2] >= width - 1 or bbox[3] >= height - 1
        )
        spans_crop_edge = (bbox[2] - bbox[0]) >= width * 0.72 or (
            bbox[3] - bbox[1]
        ) >= height * 0.72
        if touches_crop_edge and spans_crop_edge:
            continue
        keep_draw.rectangle(bbox, fill=255)
        kept_any = True
    if not kept_any:
        return False
    alpha = rgba.getchannel("A")
    new_alpha = ImageChops.multiply(alpha, keep)
    if new_alpha.getbbox() is None:
        return False
    crop.putalpha(new_alpha)
    return True


def _load_optional_background_reference(
    background_image_path: str | Path | None,
    source_size: tuple[int, int],
) -> Image.Image | None:
    if background_image_path is None:
        return None
    path = Path(background_image_path)
    if not path.is_file():
        return None
    return Image.open(path).convert("RGB").resize(source_size)


def _load_optional_text_mask(
    text_mask_path: str | Path | None, source_size: tuple[int, int]
) -> Image.Image | None:
    if text_mask_path is None:
        return None
    path = Path(text_mask_path)
    if not path.is_file():
        return None
    return Image.open(path).convert("L").resize(source_size)


def _candidate_batches(
    candidates: list[ForegroundCandidate],
    *,
    max_batch_size: int,
) -> list[list[ForegroundCandidate]]:
    batch_size = max(1, max_batch_size)
    batches: list[list[ForegroundCandidate]] = []
    current: list[ForegroundCandidate] = []
    for candidate in candidates:
        if candidate.classification == "complex_whole_visual":
            if current:
                batches.append(current)
                current = []
            batches.append([candidate])
            continue
        current.append(candidate)
        if len(current) >= batch_size:
            batches.append(current)
            current = []
    if current:
        batches.append(current)
    return batches


def _default_preview_validator(**kwargs) -> ValidationReport:
    if kwargs.get("require_preview_validation") is False:
        return ValidationReport(status="passed", checked_pages=1, issues=[])
    gates = quality_threshold_to_preview_gates(
        float(kwargs.get("preview_similarity_threshold", 0.92))
    )
    return validate_preview_similarity(
        source_image_path=kwargs["source_image_path"],
        preview=kwargs["preview"],
        slide_id=kwargs["slide_id"],
        page_index=kwargs["page_index"],
        max_mean_abs_delta=gates.max_mean_abs_delta,
        max_changed_pixel_ratio=gates.max_changed_pixel_ratio,
        page_manifest=kwargs.get("page_manifest"),
    )


@dataclass(frozen=True)
class GenerativeEditableExportResult:
    status: Literal["passed", "fallback_used"]
    output_path: str
    fallback_policy: FallbackPolicy
    validation_report: ValidationReport
    fallback_used: str = ""
    fallback_failure_reason: str = ""


@dataclass(frozen=True)
class GenerativeEditableSlideInput:
    slide_id: str
    image_path: str
    text_metadata: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class AssetBuildResult:
    bitmap_assets: list[BitmapAssetSpec]
    asset_sheets: list[AssetSheetSpec] = field(default_factory=list)
    repair_attempts: list[RepairAttempt] = field(default_factory=list)
    provider_output_payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class GenerativeEditablePipelineDependencies:
    ocr_provider: OCRProvider
    image_edit_provider: ImageEditProvider
    image_generation_provider: ImageGenerationProvider
    asset_sheet_image_edit_provider: ImageEditProvider | None = None
    repair_image_edit_provider: ImageEditProvider | None = None
    preview_similarity_threshold: float = 0.92
    require_preview_validation: bool = True
    max_repair_attempts: int = 0
    provider_timeout_seconds: int = 180
    provider_max_attempts: int = 1
    provider_retry_backoff_seconds: float = 0.0
    use_aippt_metadata_first: bool = True
    ocr_min_confidence: float = 0.75
    allow_metadata_ocr_fallback: bool = False
    allow_source_crop_asset_fallback: bool = False
    visual_text_candidate_detector: Callable[..., list[tuple[int, int, int, int]]] = (
        _default_visual_text_candidate_detector
    )
    foreground_planner: Callable[..., list[ForegroundCandidate]] = plan_foreground_candidates
    asset_builder: Callable[..., AssetBuildResult | list[BitmapAssetSpec]] = _build_default_assets
    composer: Callable[..., None] = compose_deck_from_manifests
    preview_renderer: Callable[..., Any] = render_manifest_preview_with_metadata
    structure_validator: Callable[..., ValidationReport] = validate_composed_deck_structure
    preview_validator: Callable[..., ValidationReport] = _default_preview_validator


class GenerativeEditableValidationError(RuntimeError):
    def __init__(self, *, validation_report: ValidationReport, fallback_policy: FallbackPolicy):
        self.validation_report = validation_report
        self.fallback_policy = fallback_policy
        issue_summary = _summarize_validation_issues(validation_report)
        super().__init__(
            "generative editable validation failed with "
            f"fallback_policy={fallback_policy}: {issue_summary}"
        )


class GenerativeEditableFallbackError(RuntimeError):
    def __init__(
        self,
        *,
        validation_report: ValidationReport,
        fallback_policy: FallbackPolicy,
        fallback_failure_reason: str,
    ):
        self.validation_report = validation_report
        self.fallback_policy = fallback_policy
        self.fallback_failure_reason = fallback_failure_reason
        issue_summary = _summarize_validation_issues(validation_report)
        super().__init__(
            "generative editable fallback failed with "
            f"fallback_policy={fallback_policy}: original={issue_summary}; "
            f"fallback={fallback_failure_reason}"
        )


class GenerativeEditableFallbackNotImplementedError(GenerativeEditableFallbackError):
    def __init__(self, *, validation_report: ValidationReport, fallback_policy: FallbackPolicy):
        super().__init__(
            validation_report=validation_report,
            fallback_policy=fallback_policy,
            fallback_failure_reason="fallback output factory is not configured",
        )


def apply_asset_repair_results(
    page_manifest: PageManifest,
    repaired_assets: list[BitmapAssetSpec],
    repair_attempts: list[RepairAttempt],
) -> PageManifest:
    existing_ids = {asset.asset_id for asset in page_manifest.bitmap_assets}
    unknown_ids = [
        asset.asset_id for asset in repaired_assets if asset.asset_id not in existing_ids
    ]
    if unknown_ids:
        raise ValueError(f"unknown repaired asset ids: {', '.join(sorted(unknown_ids))}")
    repaired_by_id = {asset.asset_id: asset for asset in repaired_assets}
    bitmap_assets = [
        repaired_by_id.get(asset.asset_id, asset) for asset in page_manifest.bitmap_assets
    ]
    provenance = dict(page_manifest.provenance)
    provenance["asset_repair"] = {
        "repaired_asset_ids": [asset.asset_id for asset in repaired_assets],
        "attempt_count": len(repair_attempts),
    }
    return replace(
        page_manifest,
        bitmap_assets=bitmap_assets,
        repair_attempts=[*page_manifest.repair_attempts, *repair_attempts],
        provenance=provenance,
    )


def finalize_validated_export(
    *,
    validation_report: ValidationReport,
    output_path: str,
    fallback_policy: FallbackPolicy | str | None = None,
    fallback_output_factory: Callable[[], str] | None = None,
) -> GenerativeEditableExportResult:
    policy = _normalize_fallback_policy(fallback_policy)
    if validation_report.status == "passed" and not validation_report.issues:
        return GenerativeEditableExportResult(
            status="passed",
            output_path=output_path,
            fallback_policy=policy,
            validation_report=validation_report,
        )
    if policy == "fail":
        raise GenerativeEditableValidationError(
            validation_report=validation_report,
            fallback_policy=policy,
        )
    if fallback_output_factory is None:
        raise GenerativeEditableFallbackError(
            validation_report=validation_report,
            fallback_policy=policy,
            fallback_failure_reason="fallback output factory is not configured",
        )
    try:
        fallback_output_path = fallback_output_factory()
    except Exception as exc:
        raise GenerativeEditableFallbackError(
            validation_report=validation_report,
            fallback_policy=policy,
            fallback_failure_reason=str(exc) or exc.__class__.__name__,
        ) from exc
    if not fallback_output_path:
        raise GenerativeEditableFallbackError(
            validation_report=validation_report,
            fallback_policy=policy,
            fallback_failure_reason="fallback output path is empty",
        )
    if not Path(fallback_output_path).is_file():
        raise GenerativeEditableFallbackError(
            validation_report=validation_report,
            fallback_policy=policy,
            fallback_failure_reason=f"fallback output path does not exist: {fallback_output_path}",
        )
    return GenerativeEditableExportResult(
        status="fallback_used",
        output_path=fallback_output_path,
        fallback_policy=policy,
        validation_report=validation_report,
        fallback_used=policy,
    )


def with_provider_retries(
    dependencies: GenerativeEditablePipelineDependencies,
) -> GenerativeEditablePipelineDependencies:
    def retry_image_edit(provider: ImageEditProvider | None) -> ImageEditProvider | None:
        if provider is None or isinstance(provider, RetryingImageEditProvider):
            return provider
        return RetryingImageEditProvider(
            provider,
            max_attempts=dependencies.provider_max_attempts,
            backoff_seconds=dependencies.provider_retry_backoff_seconds,
        )

    image_generation_provider = dependencies.image_generation_provider
    if not isinstance(image_generation_provider, RetryingImageGenerationProvider):
        image_generation_provider = RetryingImageGenerationProvider(
            image_generation_provider,
            max_attempts=dependencies.provider_max_attempts,
            backoff_seconds=dependencies.provider_retry_backoff_seconds,
        )

    ocr_provider = dependencies.ocr_provider
    if not isinstance(ocr_provider, RetryingOCRProvider):
        ocr_provider = RetryingOCRProvider(
            ocr_provider,
            max_attempts=dependencies.provider_max_attempts,
            backoff_seconds=dependencies.provider_retry_backoff_seconds,
        )

    return replace(
        dependencies,
        ocr_provider=ocr_provider,
        image_edit_provider=retry_image_edit(dependencies.image_edit_provider),
        asset_sheet_image_edit_provider=retry_image_edit(
            dependencies.asset_sheet_image_edit_provider
        ),
        repair_image_edit_provider=retry_image_edit(dependencies.repair_image_edit_provider),
        image_generation_provider=image_generation_provider,
    )


def run_generative_editable_pipeline(
    *,
    slides: list[GenerativeEditableSlideInput],
    output_path: str,
    artifact_root: str,
    job_id: str,
    dependencies: GenerativeEditablePipelineDependencies,
    aspect_ratio: str = "16:9",
    fallback_policy: FallbackPolicy | str | None = None,
    fallback_output_factory: Callable[[], str] | None = None,
    max_page_concurrency: int = 1,
    cleanup_artifacts: bool = False,
) -> GenerativeEditableExportResult:
    if not slides:
        raise ValueError("slides are required")
    if max_page_concurrency < 1:
        raise ValueError("max_page_concurrency must be positive")
    policy = _normalize_fallback_policy(fallback_policy)
    retry_dependencies = with_provider_retries(dependencies)
    effective_dependencies = replace(
        retry_dependencies,
        allow_metadata_ocr_fallback=retry_dependencies.allow_metadata_ocr_fallback
        and policy != "fail",
        allow_source_crop_asset_fallback=retry_dependencies.allow_source_crop_asset_fallback,
    )
    try:
        return _run_generative_editable_pipeline_impl(
            slides=slides,
            output_path=output_path,
            artifact_root=artifact_root,
            job_id=job_id,
            dependencies=effective_dependencies,
            aspect_ratio=aspect_ratio,
            policy=policy,
            fallback_output_factory=fallback_output_factory,
            max_page_concurrency=max_page_concurrency,
            cleanup_artifacts=cleanup_artifacts,
        )
    except (GenerativeEditableValidationError, GenerativeEditableFallbackError):
        raise
    except ValueError:
        raise
    except (ProviderTimeoutError, ProviderError) as exc:
        if policy == "fail":
            raise
        validation_report = ValidationReport(
            status="failed",
            checked_pages=len(slides),
            issues=[
                ValidationIssue(
                    code="provider_failure",
                    message=str(exc) or exc.__class__.__name__,
                )
            ],
        )
        return finalize_validated_export(
            validation_report=validation_report,
            output_path=output_path,
            fallback_policy=policy,
            fallback_output_factory=fallback_output_factory,
        )
    except Exception as exc:
        validation_report = ValidationReport(
            status="failed",
            checked_pages=len(slides),
            issues=[
                ValidationIssue(
                    code="pipeline_orchestration_failed",
                    message=str(exc) or exc.__class__.__name__,
                )
            ],
        )
        return finalize_validated_export(
            validation_report=validation_report,
            output_path=output_path,
            fallback_policy=policy,
            fallback_output_factory=fallback_output_factory,
        )


def _run_generative_editable_pipeline_impl(
    *,
    slides: list[GenerativeEditableSlideInput],
    output_path: str,
    artifact_root: str,
    job_id: str,
    dependencies: GenerativeEditablePipelineDependencies,
    aspect_ratio: str,
    policy: FallbackPolicy,
    fallback_output_factory: Callable[[], str] | None,
    max_page_concurrency: int,
    cleanup_artifacts: bool,
) -> GenerativeEditableExportResult:
    artifacts = GenerativeEditableJobArtifacts(root_dir=artifact_root, job_id=job_id)
    if cleanup_artifacts:
        _ensure_output_outside_job_dir(output_path, artifacts.job_dir)
    try:
        indexed_page_manifests = _build_page_manifests(
            slides=slides,
            aspect_ratio=aspect_ratio,
            artifacts=artifacts,
            dependencies=dependencies,
            max_page_concurrency=max_page_concurrency,
        )
        page_manifests = [page for _, page in indexed_page_manifests]
        page_manifest_refs: list[str] = []
        slide_order = [slide.slide_id for slide in slides]

        for page_index, page_manifest in indexed_page_manifests:
            with _record_stage(
                artifacts,
                stage="write_page_manifest",
                page_index=page_index,
                slide_id=page_manifest.slide_id,
            ):
                page_manifest_path = artifacts.page_manifest_path(
                    page_manifest.slide_id, page_index
                )
                write_manifest(page_manifest_path, page_manifest)
            page_manifest_refs.append(_job_relative(page_manifest_path, artifacts.job_dir))

        deck_manifest = DeckManifest(
            job_id=artifacts.job_id,
            slide_order=slide_order,
            aspect_ratio=aspect_ratio,
            provider_roles={
                "ocr": dependencies.ocr_provider.config.role,
                "image_edit": dependencies.image_edit_provider.config.role,
                "image_generation": dependencies.image_generation_provider.config.role,
            },
            quality_settings={
                "preview_similarity_threshold": dependencies.preview_similarity_threshold
            },
            fallback_policy=policy,
            page_manifest_paths=page_manifest_refs,
            validation_status="pending",
            provenance={"max_page_concurrency": max_page_concurrency},
        )
        write_manifest(artifacts.deck_manifest_path, deck_manifest)

        with _record_stage(artifacts, stage="compose_deck"):
            dependencies.composer(
                artifacts.deck_manifest_path,
                artifacts.job_dir,
                output_path,
            )
        validation_report, page_statuses = _validate_pipeline_output(
            deck_manifest_path=artifacts.deck_manifest_path,
            artifact_root=artifacts.job_dir,
            pptx_path=output_path,
            page_manifests=page_manifests,
            dependencies=dependencies,
        )
        final_status = "passed" if validation_report.status == "passed" else "failed"
        _rewrite_validation_statuses(
            artifacts=artifacts,
            deck_manifest=deck_manifest,
            page_manifests=page_manifests,
            deck_validation_status=final_status,
            page_validation_statuses=page_statuses,
        )
        return finalize_validated_export(
            validation_report=validation_report,
            output_path=output_path,
            fallback_policy=policy,
            fallback_output_factory=fallback_output_factory,
        )
    finally:
        if cleanup_artifacts:
            artifacts.cleanup()


def _build_page_manifests(
    *,
    slides: list[GenerativeEditableSlideInput],
    aspect_ratio: str,
    artifacts: GenerativeEditableJobArtifacts,
    dependencies: GenerativeEditablePipelineDependencies,
    max_page_concurrency: int,
) -> list[tuple[int, PageManifest]]:
    def build(indexed_slide: tuple[int, GenerativeEditableSlideInput]) -> tuple[int, PageManifest]:
        page_index, slide = indexed_slide
        return (
            page_index,
            _build_one_slide_manifest(
                slide=slide,
                page_index=page_index,
                aspect_ratio=aspect_ratio,
                artifacts=artifacts,
                dependencies=dependencies,
            ),
        )

    indexed_slides = list(enumerate(slides))
    if max_page_concurrency == 1 or len(indexed_slides) == 1:
        return [build(indexed_slide) for indexed_slide in indexed_slides]
    with ThreadPoolExecutor(max_workers=max_page_concurrency) as executor:
        built = list(executor.map(build, indexed_slides))
    return sorted(built, key=lambda item: item[0])


def _build_one_slide_manifest(
    *,
    slide: GenerativeEditableSlideInput,
    page_index: int,
    aspect_ratio: str,
    artifacts: GenerativeEditableJobArtifacts,
    dependencies: GenerativeEditablePipelineDependencies,
) -> PageManifest:
    source_path = artifacts.asset_path(slide.slide_id, page_index, "sources", "source.png")
    shutil.copyfile(slide.image_path, source_path)
    with Image.open(source_path) as image:
        source_image_size = image.size
    source_ref = _job_relative(source_path, artifacts.job_dir)

    with _record_stage(
        artifacts,
        stage="ocr",
        page_index=page_index,
        slide_id=slide.slide_id,
        provider_role=dependencies.ocr_provider.config.role,
        provider=dependencies.ocr_provider.config.model,
    ):
        try:
            ocr_result = dependencies.ocr_provider.extract_text(str(source_path))
        except (ProviderError, ProviderTimeoutError):
            if (
                not dependencies.allow_metadata_ocr_fallback
                or not dependencies.use_aippt_metadata_first
                or not slide.text_metadata
            ):
                raise
            ocr_result = _metadata_only_ocr_result(
                source_image_path=str(source_path),
                source_image_size=source_image_size,
                text_metadata=slide.text_metadata,
            )
    ocr_output_path = artifacts.write_provider_output(
        slide.slide_id,
        page_index,
        "ocr",
        "ocr.json",
        _ocr_result_payload(ocr_result),
    )
    text_metadata = slide.text_metadata if dependencies.use_aippt_metadata_first else []
    text_result = extract_text_with_validation(
        text_metadata,
        ocr_result,
        min_confidence=dependencies.ocr_min_confidence,
    )
    text_boxes = list(text_result.text_boxes)
    visual_text_candidates = dependencies.visual_text_candidate_detector(
        source_image_path=str(source_path),
        source_image_size=source_image_size,
        text_boxes=text_boxes,
    )
    quality_gate_candidates = _quality_gate_visual_text_candidates(
        visual_text_candidates,
        source_image_size,
    )
    page_text_analysis = build_page_text_analysis(
        text_boxes=text_boxes,
        visual_text_candidates=visual_text_candidates,
        source_image_size=source_image_size,
    )
    text_boxes = list(page_text_analysis.accepted_text_boxes)
    unanchored_approximate_issues = [
        {
            "code": hint.reason,
            "severity": "warning",
            "ocr_text": hint.text,
            "source_pixel_bbox": hint.source_pixel_bbox,
        }
        for hint in page_text_analysis.rejected_ocr_hints
    ]
    visual_text_issues = _visual_text_coverage_issues(
        text_boxes,
        visual_text_candidates=quality_gate_candidates,
    )
    ignored_visual_text_candidates: set[tuple[int, int, int, int]] = set()
    with _record_stage(
        artifacts,
        stage="focused_ocr_recovery",
        page_index=page_index,
        slide_id=slide.slide_id,
        provider_role=dependencies.ocr_provider.config.role,
        provider=dependencies.ocr_provider.config.model,
    ):
        recovered_text_boxes = _recover_visual_text_candidates(
            source_image_path=source_path,
            source_image_size=source_image_size,
            text_boxes=text_boxes,
            uncovered_candidates=_focused_recovery_candidate_bboxes(
                text_boxes=text_boxes,
                text_issues=text_result.issues,
                visual_text_candidates=visual_text_candidates,
                quality_gate_candidates=quality_gate_candidates,
                source_image_size=source_image_size,
            ),
            ocr_provider=dependencies.ocr_provider,
            crop_dir=(
                artifacts.job_dir
                / "provider_outputs"
                / "ocr"
                / f"{page_index:04d}-{_safe_name(slide.slide_id)}"
                / "focused-crops"
            ),
            ignored_noise_candidates=ignored_visual_text_candidates,
            min_confidence=dependencies.ocr_min_confidence,
        )
    if recovered_text_boxes:
        text_boxes = _remove_approximate_text_boxes_replaced_by_focused_recovery(
            text_boxes,
            recovered_text_boxes,
        )
        text_boxes.extend(recovered_text_boxes)
        visual_text_issues = _visual_text_coverage_issues(
            text_boxes,
            visual_text_candidates=quality_gate_candidates,
            non_blocking_visual_text_candidates=ignored_visual_text_candidates,
        )
    elif ignored_visual_text_candidates:
        visual_text_issues = _visual_text_coverage_issues(
            text_boxes,
            visual_text_candidates=quality_gate_candidates,
            non_blocking_visual_text_candidates=ignored_visual_text_candidates,
        )
    text_issues = [
        *text_result.issues,
        *unanchored_approximate_issues,
        *visual_text_issues,
    ]
    use_source_raster_guardrail = _should_use_source_raster_guardrail(
        text_boxes=text_boxes,
        text_issues=text_issues,
        source_image_size=source_image_size,
    )
    source_raster_anchor_text_boxes = list(text_boxes)
    if use_source_raster_guardrail:
        text_boxes = _source_raster_guardrail_text_boxes(
            text_boxes,
            source_image_size=source_image_size,
        )
    text_validation_status = "failed" if _has_blocking_text_issue(text_issues) else "passed"
    text_mask_path = artifacts.asset_path(slide.slide_id, page_index, "assets", "text-mask.png")
    with _record_stage(
        artifacts,
        stage="text_mask",
        page_index=page_index,
        slide_id=slide.slide_id,
    ):
        _create_text_exclusion_mask(
            source_image_path=source_path,
            source_image_size=source_image_size,
            text_boxes=text_boxes,
        ).save(text_mask_path)
    text_mask_ref = _job_relative(text_mask_path, artifacts.job_dir)

    if _should_use_text_editable_source_preserving_fast_path(
        text_boxes=text_boxes,
        visual_text_candidates=visual_text_candidates,
        text_issues=text_issues,
    ):
        low_opacity_text_boxes = _source_preserving_low_opacity_text_boxes(text_boxes)
        bitmap_assets: list[BitmapAssetSpec] = []
        fast_background = create_source_preserving_text_background(
            source_image_path=source_path,
            text_bboxes=[],
            output_asset_path=artifacts.asset_path(
                slide.slide_id,
                page_index,
                "backgrounds",
                "source-preserving-text-background.png",
            ),
            asset_root=artifacts.job_dir,
        )
        image_edit_output_path = artifacts.write_provider_output(
            slide.slide_id,
            page_index,
            "image_edit",
            "backgrounds.json",
            {
                "chosen_base_background": asdict(fast_background),
                "source_preserving_background": asdict(fast_background),
                "fast_path": "source_preserving_low_opacity_text_overlay",
            },
        )
        image_generation_output_path = artifacts.write_provider_output(
            slide.slide_id,
            page_index,
            "image_generation",
            "assets.json",
            {
                "candidate_ids": [],
                "asset_ids": [asset.asset_id for asset in bitmap_assets],
                "assets": [asdict(asset) for asset in bitmap_assets],
                "asset_sheets": [],
                "fast_path": "source_preserving_low_opacity_text_overlay",
            },
        )
        page = PageManifest(
            slide_id=slide.slide_id,
            page_index=page_index,
            source_image_path=source_ref,
            source_image_size=source_image_size,
            slide_size=_slide_size_inches(aspect_ratio),
            text_boxes=low_opacity_text_boxes,
            foreground_candidates=[],
            native_shapes=[],
            bitmap_assets=bitmap_assets,
            asset_sheets=[],
            repair_attempts=[],
            provider_output_paths={
                "ocr": _job_relative(ocr_output_path, artifacts.job_dir),
                "image_edit": _job_relative(image_edit_output_path, artifacts.job_dir),
                "image_generation": _job_relative(
                    image_generation_output_path,
                    artifacts.job_dir,
                ),
            },
            provenance={
                "text_validation_status": text_validation_status,
                "text_issues": text_issues,
                "text_mask_path": text_mask_ref,
                "recovered_text_count": len(recovered_text_boxes),
                "chosen_background_kind": "source_preserving_low_opacity_text_overlay",
                "fast_path_reason": "dense_or_unstable_text_layout",
                "text_overlay_opacity": 0.1,
            },
            validation_status="pending",
        )
        page = update_page_manifest_backgrounds(
            page,
            fast_background,
            fast_background,
            chosen_background=fast_background.artifact_path,
        )
        provenance = dict(page.provenance)
        backgrounds = dict(provenance.get("backgrounds", {}))
        backgrounds["source_preserving"] = _background_result_manifest_record(fast_background)
        provenance["backgrounds"] = backgrounds
        return replace(page, provenance=provenance)

    if use_source_raster_guardrail:
        source_raster_background = create_source_raster_background(
            source_image_path=source_path,
            output_asset_path=artifacts.asset_path(
                slide.slide_id,
                page_index,
                "backgrounds",
                "source-raster-background.png",
            ),
            asset_root=artifacts.job_dir,
        )
        bitmap_assets = _build_source_preserving_anchor_assets(
            source_image_path=str(source_path),
            text_boxes=source_raster_anchor_text_boxes,
            output_dir=(
                artifacts.job_dir / "assets" / f"{page_index:04d}-{_safe_name(slide.slide_id)}"
            ),
            asset_root=artifacts.job_dir,
            start_z_order=1,
        )
        image_edit_output_path = artifacts.write_provider_output(
            slide.slide_id,
            page_index,
            "image_edit",
            "backgrounds.json",
            {
                "text_clean_background": asdict(source_raster_background),
                "base_clean_background": asdict(source_raster_background),
                "chosen_base_background": asdict(source_raster_background),
                "source_raster_background": asdict(source_raster_background),
            },
        )
        image_generation_output_path = artifacts.write_provider_output(
            slide.slide_id,
            page_index,
            "image_generation",
            "assets.json",
            {
                "candidate_ids": [],
                "asset_ids": [asset.asset_id for asset in bitmap_assets],
                "assets": [asdict(asset) for asset in bitmap_assets],
                "asset_sheets": [],
                "guardrail": "source_raster",
            },
        )
        page = PageManifest(
            slide_id=slide.slide_id,
            page_index=page_index,
            source_image_path=source_ref,
            source_image_size=source_image_size,
            slide_size=_slide_size_inches(aspect_ratio),
            text_boxes=[],
            foreground_candidates=[],
            native_shapes=[],
            bitmap_assets=bitmap_assets,
            asset_sheets=[],
            repair_attempts=[],
            provider_output_paths={
                "ocr": _job_relative(ocr_output_path, artifacts.job_dir),
                "image_edit": _job_relative(image_edit_output_path, artifacts.job_dir),
                "image_generation": _job_relative(
                    image_generation_output_path,
                    artifacts.job_dir,
                ),
            },
            provenance={
                "text_validation_status": "degraded",
                "text_issues": text_issues,
                "text_mask_path": text_mask_ref,
                "recovered_text_count": len(recovered_text_boxes),
                "source_raster_guardrail": {
                    "reason": "unreliable_ocr_layout",
                    "dropped_text_box_count": len(source_raster_anchor_text_boxes),
                },
            },
            validation_status="pending",
        )
        page = update_page_manifest_backgrounds(
            page,
            source_raster_background,
            source_raster_background,
            chosen_background=source_raster_background.artifact_path,
        )
        provenance = dict(page.provenance)
        backgrounds = dict(provenance.get("backgrounds", {}))
        backgrounds["source_raster"] = _background_result_manifest_record(source_raster_background)
        provenance["backgrounds"] = backgrounds
        provenance["chosen_background_kind"] = "source_raster_guardrail"
        return replace(page, provenance=provenance)

    with _record_stage(
        artifacts,
        stage="text_clean_background",
        page_index=page_index,
        slide_id=slide.slide_id,
        provider_role=dependencies.image_edit_provider.config.role,
        provider=dependencies.image_edit_provider.config.model,
        timeout_seconds=dependencies.provider_timeout_seconds,
    ):
        text_clean = create_text_clean_background(
            source_image_path=source_path,
            text_mask_path=text_mask_path,
            output_asset_path=artifacts.asset_path(
                slide.slide_id,
                page_index,
                "backgrounds",
                "text-clean.png",
            ),
            asset_root=artifacts.job_dir,
            edit_provider=dependencies.image_edit_provider,
            timeout_seconds=dependencies.provider_timeout_seconds,
        )
    with _record_stage(
        artifacts,
        stage="base_clean_background",
        page_index=page_index,
        slide_id=slide.slide_id,
        provider_role=dependencies.image_edit_provider.config.role,
        provider=dependencies.image_edit_provider.config.model,
        timeout_seconds=dependencies.provider_timeout_seconds,
    ):
        base_clean = create_base_clean_background(
            source_image_path=source_path,
            output_asset_path=artifacts.asset_path(
                slide.slide_id,
                page_index,
                "backgrounds",
                "base-clean.png",
            ),
            asset_root=artifacts.job_dir,
            edit_provider=dependencies.image_edit_provider,
            text_mask_path=text_mask_path,
            removal_bboxes=[text_box.source_pixel_bbox for text_box in text_boxes],
            timeout_seconds=dependencies.provider_timeout_seconds,
        )
    original_base_clean = base_clean
    if _should_choose_text_clean_background(
        source_image_path=source_path,
        base_clean_image_path=base_clean.output_asset_path,
        text_clean_image_path=text_clean.output_asset_path,
        text_boxes=text_boxes,
    ):
        base_clean = text_clean

    candidates = dependencies.foreground_planner(
        source_image_path=str(source_path),
        base_clean_image_path=base_clean.output_asset_path,
        text_mask_path=str(text_mask_path),
    )
    candidates = [
        *candidates,
        *_detect_source_native_shape_candidates(
            source_image_path=str(source_path),
            text_mask_path=str(text_mask_path),
        ),
    ]
    native_shapes, bitmap_candidates = _plan_reconstruction_targets(
        candidates,
        source_image_path=str(source_path),
    )
    bitmap_candidates = _augment_bitmap_candidates_with_generic_visual_anchors(
        bitmap_candidates,
        source_image_path=str(source_path),
        text_boxes=text_boxes,
        native_shapes=native_shapes,
    )
    with _record_stage(
        artifacts,
        stage="asset_build",
        page_index=page_index,
        slide_id=slide.slide_id,
        provider_role=dependencies.image_generation_provider.config.role,
        provider=dependencies.image_generation_provider.config.model,
        timeout_seconds=dependencies.provider_timeout_seconds,
    ):
        asset_build_result = _coerce_asset_build_result(
            dependencies.asset_builder(
                source_image_path=str(source_path),
                text_mask_path=str(text_mask_path),
                asset_reference_image_path=_select_asset_reference_image(
                    source_image_path=source_path,
                    text_clean_image_path=text_clean.output_asset_path,
                    text_mask_path=text_mask_path,
                ),
                background_reference_image_path=base_clean.output_asset_path,
                candidates=bitmap_candidates,
                output_dir=str(
                    artifacts.job_dir / "assets" / f"{page_index:04d}-{_safe_name(slide.slide_id)}"
                ),
                asset_root=str(artifacts.job_dir),
                image_generation_provider=dependencies.image_generation_provider,
                image_edit_provider=dependencies.image_edit_provider,
                asset_sheet_image_edit_provider=dependencies.asset_sheet_image_edit_provider
                or dependencies.image_edit_provider,
                repair_image_edit_provider=dependencies.repair_image_edit_provider
                or dependencies.image_edit_provider,
                max_repair_attempts=dependencies.max_repair_attempts,
                provider_timeout_seconds=dependencies.provider_timeout_seconds,
                allow_source_crop_fallback=dependencies.allow_source_crop_asset_fallback,
                slide_id=slide.slide_id,
                page_index=page_index,
            )
        )
    bitmap_assets = asset_build_result.bitmap_assets
    repair_attempts = asset_build_result.repair_attempts
    bitmap_assets = _bitmap_assets_for_clean_background(bitmap_assets, source_image_size)
    native_shapes = _drop_native_shapes_covered_by_complex_bitmap_assets(
        native_shapes,
        bitmap_assets,
    )
    text_boxes, covered_text_issues = _drop_text_boxes_covered_by_complex_bitmap_assets(
        text_boxes,
        bitmap_assets,
    )
    text_issues = [*text_issues, *covered_text_issues]
    source_preserving_background = None
    chosen_background_kind = ""
    if _should_use_local_reconstruction_background(
        source_image_path=source_path,
        native_shapes=native_shapes,
        bitmap_assets=bitmap_assets,
        text_boxes=text_boxes,
    ):
        base_clean = _create_local_reconstruction_background(
            source_image_path=source_path,
            output_asset_path=artifacts.asset_path(
                slide.slide_id,
                page_index,
                "backgrounds",
                "local-reconstruction-background.png",
            ),
            asset_root=artifacts.job_dir,
            foreground_bboxes=[shape.source_pixel_bbox for shape in native_shapes]
            + [text_box.source_pixel_bbox for text_box in text_boxes],
        )
    elif _should_choose_source_preserving_background(
        source_image_path=source_path,
        chosen_background_image_path=base_clean.output_asset_path,
        text_clean_image_path=text_clean.output_asset_path,
        text_boxes=text_boxes,
        native_shapes=native_shapes,
        bitmap_assets=bitmap_assets,
        source_image_size=source_image_size,
    ):
        source_preserving_background = create_source_preserving_text_background(
            source_image_path=source_path,
            text_bboxes=[text_box.source_pixel_bbox for text_box in text_boxes],
            output_asset_path=artifacts.asset_path(
                slide.slide_id,
                page_index,
                "backgrounds",
                "source-preserving-text-background.png",
            ),
            asset_root=artifacts.job_dir,
        )
        base_clean = source_preserving_background
        chosen_background_kind = "source_preserving_text_clean"
        bitmap_assets = _bitmap_assets_for_source_preserving_background(
            bitmap_assets,
            source_image_size,
        )
        if not bitmap_assets:
            bitmap_assets = _build_source_preserving_anchor_assets(
                source_image_path=str(source_path),
                text_boxes=text_boxes,
                output_dir=(
                    artifacts.job_dir / "assets" / f"{page_index:04d}-{_safe_name(slide.slide_id)}"
                ),
                asset_root=artifacts.job_dir,
                start_z_order=1,
            )
        native_shapes = _native_shapes_for_source_preserving_background(native_shapes)
    image_edit_payload = {
        "text_clean_background": asdict(text_clean),
        "base_clean_background": asdict(original_base_clean),
        "chosen_base_background": asdict(base_clean),
    }
    if source_preserving_background is not None:
        image_edit_payload["source_preserving_background"] = asdict(source_preserving_background)
    image_edit_output_path = artifacts.write_provider_output(
        slide.slide_id,
        page_index,
        "image_edit",
        "backgrounds.json",
        image_edit_payload,
    )
    image_generation_output_path = artifacts.write_provider_output(
        slide.slide_id,
        page_index,
        "image_generation",
        "assets.json",
        {
            **asset_build_result.provider_output_payload,
            "candidate_ids": [candidate.candidate_id for candidate in candidates],
            "asset_ids": [asset.asset_id for asset in bitmap_assets],
            "assets": [asdict(asset) for asset in bitmap_assets],
            "asset_sheets": [asdict(sheet) for sheet in asset_build_result.asset_sheets],
        },
    )
    provider_output_paths = {
        "ocr": _job_relative(ocr_output_path, artifacts.job_dir),
        "image_edit": _job_relative(image_edit_output_path, artifacts.job_dir),
        "image_generation": _job_relative(image_generation_output_path, artifacts.job_dir),
    }
    if repair_attempts:
        repair_output_path = artifacts.write_provider_output(
            slide.slide_id,
            page_index,
            "repair",
            "repairs.json",
            {"repair_attempts": [asdict(attempt) for attempt in repair_attempts]},
        )
        provider_output_paths["repair"] = _job_relative(repair_output_path, artifacts.job_dir)
    page = PageManifest(
        slide_id=slide.slide_id,
        page_index=page_index,
        source_image_path=source_ref,
        source_image_size=source_image_size,
        slide_size=_slide_size_inches(aspect_ratio),
        text_boxes=text_boxes,
        foreground_candidates=foreground_candidates_to_manifest_specs(candidates),
        native_shapes=native_shapes,
        bitmap_assets=bitmap_assets,
        asset_sheets=asset_build_result.asset_sheets,
        repair_attempts=repair_attempts,
        provider_output_paths=provider_output_paths,
        provenance={
            "text_validation_status": text_validation_status,
            "text_issues": text_issues,
            "text_mask_path": text_mask_ref,
            "recovered_text_count": len(recovered_text_boxes),
            "page_text_analysis": {
                "accepted_text_count": len(page_text_analysis.accepted_text_boxes),
                "rejected_ocr_hint_count": len(page_text_analysis.rejected_ocr_hints),
                "visual_text_candidate_count": len(page_text_analysis.visual_text_candidates),
            },
        },
        validation_status="pending",
    )
    page = update_page_manifest_backgrounds(
        page,
        text_clean,
        base_clean,
        chosen_background=base_clean.artifact_path,
    )
    if source_preserving_background is None:
        return page
    provenance = dict(page.provenance)
    backgrounds = dict(provenance.get("backgrounds", {}))
    if source_preserving_background is not None:
        backgrounds["source_preserving"] = _background_result_manifest_record(
            source_preserving_background
        )
    provenance["backgrounds"] = backgrounds
    provenance["chosen_background_kind"] = chosen_background_kind
    return replace(page, provenance=provenance)


def _create_text_exclusion_mask(
    *,
    source_image_path: str | Path,
    source_image_size: tuple[int, int],
    text_boxes: list,
) -> Image.Image:
    mask = create_text_mask(source_image_size, text_boxes, padding=2)
    if not text_boxes:
        return mask
    try:
        from .generative_editable_providers import _estimate_text_line_layouts

        text_lines = [
            str(getattr(text_box, "text", "")).strip()
            for text_box in text_boxes
            if str(getattr(text_box, "text", "")).strip()
        ]
        if not text_lines:
            return mask
        estimates = _estimate_text_line_layouts(
            source_image_path,
            source_image_size,
            text_lines=text_lines,
            max_lines=len(text_lines),
        )
    except Exception:
        return mask
    if not estimates:
        return mask
    draw = ImageDraw.Draw(mask)
    for estimate in estimates:
        if estimate is None:
            continue
        bbox, _color_hex, _font_size = estimate
        left, top, right, bottom = _clamp_bbox_to_size(
            (
                bbox[0] - 4,
                bbox[1] - 4,
                bbox[2] + 4,
                bbox[3] + 4,
            ),
            source_image_size,
        )
        if right > left and bottom > top:
            draw.rectangle((left, top, right, bottom), fill=255)
    return mask


def _select_asset_reference_image(
    *,
    source_image_path: str | Path,
    text_clean_image_path: str | Path,
    text_mask_path: str | Path,
    max_unmasked_changed_ratio: float = 0.08,
    max_unmasked_mean_delta: float = 10.0,
) -> str:
    if not Path(text_clean_image_path).is_file():
        return str(source_image_path)
    try:
        changed_ratio, mean_delta = _unmasked_image_delta(
            source_image_path=source_image_path,
            candidate_image_path=text_clean_image_path,
            text_mask_path=text_mask_path,
        )
    except Exception:
        return str(source_image_path)
    if changed_ratio > max_unmasked_changed_ratio or mean_delta > max_unmasked_mean_delta:
        return str(source_image_path)
    return str(text_clean_image_path)


def _unmasked_image_delta(
    *,
    source_image_path: str | Path,
    candidate_image_path: str | Path,
    text_mask_path: str | Path,
    threshold: int = 18,
) -> tuple[float, float]:
    with Image.open(source_image_path) as source, Image.open(candidate_image_path) as candidate:
        source_rgb = source.convert("RGB")
        candidate_rgb = candidate.convert("RGB").resize(source_rgb.size)
        with Image.open(text_mask_path) as mask_image:
            mask = mask_image.convert("L").resize(source_rgb.size)
        changed = 0
        total = 0
        delta_sum = 0.0
        source_pixels = source_rgb.load()
        candidate_pixels = candidate_rgb.load()
        mask_pixels = mask.load()
        for y in range(source_rgb.height):
            for x in range(source_rgb.width):
                if mask_pixels[x, y] > 0:
                    continue
                total += 1
                delta = _color_distance(source_pixels[x, y], candidate_pixels[x, y])
                delta_sum += delta
                if delta >= threshold:
                    changed += 1
    if total == 0:
        return 0.0, 0.0
    return changed / float(total), delta_sum / float(total)


def _validate_pipeline_output(
    *,
    deck_manifest_path: Path,
    artifact_root: Path,
    pptx_path: str,
    page_manifests: list[PageManifest],
    dependencies: GenerativeEditablePipelineDependencies,
) -> tuple[ValidationReport, dict[str, Literal["passed", "failed"]]]:
    structure_report = dependencies.structure_validator(
        deck_manifest_path=deck_manifest_path,
        artifact_root=artifact_root,
        pptx_path=pptx_path,
    )
    reports = [structure_report]
    page_statuses: dict[str, Literal["passed", "failed"]] = {}
    structure_failed = structure_report.status != "passed" or bool(structure_report.issues)
    for page in page_manifests:
        page_reports = [
            _text_validation_report(page),
            _repair_validation_report(page),
            _bitmap_coverage_validation_report(page),
        ]
        preview = _render_preview(
            dependencies.preview_renderer,
            page,
            artifact_root,
            pptx_path=pptx_path,
        )
        page_reports.append(
            dependencies.preview_validator(
                source_image_path=artifact_root / page.source_image_path,
                preview=preview,
                slide_id=page.slide_id,
                page_index=page.page_index,
                preview_similarity_threshold=dependencies.preview_similarity_threshold,
                require_preview_validation=dependencies.require_preview_validation,
                page_manifest=page,
            )
        )
        reports.extend(page_reports)
        page_failed = any(report.status != "passed" or report.issues for report in page_reports)
        page_statuses[page.slide_id] = "failed" if structure_failed or page_failed else "passed"
    return _merge_validation_reports(reports, checked_pages=len(page_manifests)), page_statuses


def _render_preview(preview_renderer, page: PageManifest, artifact_root: Path, *, pptx_path: str):
    if "pptx_path" in inspect.signature(preview_renderer).parameters:
        return preview_renderer(page, artifact_root, pptx_path=pptx_path)
    return preview_renderer(page, artifact_root)


def _create_asset_sheet(
    *,
    request,
    candidates: list[ForegroundCandidate],
    image_edit_provider: ImageEditProvider,
    image_generation_provider: ImageGenerationProvider,
    source_image_path: str,
) -> tuple[Any, dict[str, Any]]:
    try:
        return image_edit_provider.edit(request), {}
    except ProviderError as exc:
        generation_result = image_generation_provider.generate(
            ImageGenerationRequest(
                prompt_id=request.prompt_id,
                prompt=_asset_sheet_generation_prompt(request.prompt, candidates),
                output_asset_path=request.output_asset_path,
                asset_root=request.asset_root,
                visual_reference={
                    "source_image_path": source_image_path,
                    "candidate_boxes": request.metadata.get("candidate_boxes", []),
                    "edit_failure": str(exc),
                },
                timeout_seconds=request.timeout_seconds,
                metadata={
                    "fallback_from": "image_edit",
                    "edit_provider_role": image_edit_provider.config.role,
                    "edit_failure": str(exc),
                },
            )
        )
        return generation_result, {
            "fallback_from": "image_edit",
            "edit_failure": str(exc),
        }


def _asset_sheet_generation_prompt(
    edit_prompt: str,
    candidates: list[ForegroundCandidate],
) -> str:
    candidate_lines = [
        f"- {candidate.candidate_id}: source bbox {candidate.source_pixel_bbox}"
        for candidate in candidates
    ]
    return (
        f"{edit_prompt}\n\n"
        "If source-image editing is unavailable, generate a transparent PNG asset sheet on a "
        "presentation-slide canvas. Preserve the listed candidate ids and approximate source "
        "bbox positions so deterministic slicing can extract each asset.\n"
        + "\n".join(candidate_lines)
    )


def _repair_or_replace_provider_asset_mismatches(
    bitmap_assets: list[BitmapAssetSpec],
    *,
    source_image_path: str,
    output_dir: Path,
    asset_root: Path,
    repair_provider: ImageEditProvider,
    max_repair_attempts: int,
    provider_timeout_seconds: int,
    allow_source_crop_fallback: bool = False,
) -> tuple[list[BitmapAssetSpec], list[RepairAttempt]]:
    replaced: list[BitmapAssetSpec] = []
    repair_attempts: list[RepairAttempt] = []
    failed_assets: list[BitmapAssetSpec] = []
    failure_reasons: dict[str, list[str]] = {}
    output_dir.mkdir(parents=True, exist_ok=True)
    for asset in bitmap_assets:
        asset_path = asset_root / asset.asset_path
        qa = validate_sliced_asset(
            asset_path=asset_path,
            expected_object_count=_expected_asset_object_count(asset),
            min_opaque_area_ratio=0.005,
            source_image_path=source_image_path,
            source_pixel_bbox=asset.source_pixel_bbox,
            min_source_color_similarity=0.55,
        )
        if qa.status == "passed":
            replaced.append(asset)
            continue
        failed_assets.append(asset)
        failure_reasons[asset.asset_id] = list(qa.reasons)
    if failed_assets:
        repairable_failed_assets = [
            asset
            for asset in failed_assets
            if max_repair_attempts > 0
            and _should_repair_asset(failure_reasons.get(asset.asset_id, []))
        ]
        try:
            if repairable_failed_assets:
                repaired, repair_attempts = repair_failed_assets(
                    source_image_path=source_image_path,
                    failed_assets=repairable_failed_assets,
                    failure_reasons=failure_reasons,
                    output_dir=output_dir / "repairs",
                    asset_root=asset_root,
                    edit_provider=repair_provider,
                    max_attempts=max_repair_attempts,
                    timeout_seconds=provider_timeout_seconds,
                )
            else:
                repaired, repair_attempts = [], []
        except ProviderError as exc:
            repaired = []
            repair_attempts = [
                RepairAttempt(
                    target_id=asset.asset_id,
                    attempt_index=1,
                    reason=f"repair_provider_failed:{exc}",
                    provider_role=repair_provider.config.role,
                    status="failed",
                )
                for asset in failed_assets
            ]
        repaired_by_id = {asset.asset_id: asset for asset in repaired}
        for asset in failed_assets:
            repaired_asset = repaired_by_id.get(asset.asset_id)
            if repaired_asset is not None:
                replaced.append(repaired_asset)
                continue
            qa_reasons = failure_reasons.get(asset.asset_id, ["asset_quality_failed"])
            if not allow_source_crop_fallback:
                raise ProviderError(
                    provider_role=repair_provider.config.role,
                    operation="asset_quality",
                    message=(f"asset quality failed for {asset.asset_id}: " + ",".join(qa_reasons)),
                    retryable=False,
                )
            replaced.append(
                _source_crop_replacement_asset(
                    asset,
                    source_image_path=source_image_path,
                    output_dir=output_dir,
                    asset_root=asset_root,
                    qa_reasons=qa_reasons,
                )
            )
    return replaced, repair_attempts


def _expected_asset_object_count(asset: BitmapAssetSpec) -> int | None:
    if asset.provenance.get("candidate_classification") == "complex_whole_visual":
        return None
    return 1


def _source_crop_replacement_asset(
    asset: BitmapAssetSpec,
    *,
    source_image_path: str,
    output_dir: Path,
    asset_root: Path,
    qa_reasons: list[str],
) -> BitmapAssetSpec:
    crop_path = output_dir / f"{_safe_name(asset.asset_id)}.source-crop.png"
    with Image.open(source_image_path) as source:
        source.convert("RGBA").crop(asset.source_pixel_bbox).save(crop_path)
    return replace(
        asset,
        asset_path=_job_relative(crop_path, asset_root),
        provenance={
            **asset.provenance,
            "fallback": "source_crop_after_provider_qa",
            "qa_reasons": qa_reasons,
        },
    )


def _should_repair_asset(reasons: list[str]) -> bool:
    return "baked_text_contamination" in reasons


def _build_source_crop_assets(
    *,
    candidates: list[ForegroundCandidate],
    source_image_path: str,
    output_dir: Path,
    asset_root: Path,
    fallback_reason: str,
    failure: str,
) -> list[BitmapAssetSpec]:
    output_dir.mkdir(parents=True, exist_ok=True)
    assets: list[BitmapAssetSpec] = []
    with Image.open(source_image_path) as source:
        source_rgba = source.convert("RGBA")
        for index, candidate in enumerate(candidates, start=1):
            crop_path = output_dir / f"{_safe_name(candidate.candidate_id)}.source-crop.png"
            source_rgba.crop(candidate.source_pixel_bbox).save(crop_path)
            assets.append(
                BitmapAssetSpec(
                    asset_id=candidate.candidate_id,
                    source_pixel_bbox=candidate.source_pixel_bbox,
                    asset_path=_job_relative(crop_path, asset_root),
                    z_order=index,
                    provenance={
                        "fallback": fallback_reason,
                        "failure": failure,
                    },
                )
            )
    return assets


def _plan_reconstruction_targets(
    candidates: list[ForegroundCandidate],
    *,
    source_image_path: str,
) -> tuple[list[NativeShapeSpec], list[ForegroundCandidate]]:
    native_shapes: list[NativeShapeSpec] = []
    bitmap_candidates: list[ForegroundCandidate] = []
    with Image.open(source_image_path) as source:
        source_size = source.size
        source_rgb = source.convert("RGB").copy()
    source_background = _estimate_background_color(source_rgb)
    for candidate in _reclassify_uncertain_candidates(
        candidates, source_image_path=source_image_path
    ):
        fit = fit_native_shape_with_fallback(
            candidate,
            source_image_path=source_image_path,
        )
        if fit.native_shape is not None:
            if not _should_drop_native_shape_candidate(
                candidate,
                fit.native_shape,
                source_size,
                source_image=source_rgb,
                source_background=source_background,
            ):
                native_shapes.append(fit.native_shape)
            continue
        if fit.bitmap_candidate is not None:
            bitmap_candidates.append(fit.bitmap_candidate)
            continue
        if candidate.classification in {
            "bitmap_asset_candidate",
            "complex_whole_visual",
            "uncertain",
        }:
            bitmap_candidates.append(candidate)
    native_shapes = _drop_source_diff_native_fill_residuals(
        _native_shapes_with_source_scan_priority(native_shapes),
        source_image=source_rgb,
    )
    native_shapes = _dedupe_native_shapes(native_shapes)
    native_shapes = _drop_oversized_native_shapes(native_shapes, source_size)
    bitmap_candidates = _expand_edge_spanning_bitmap_candidates(
        bitmap_candidates,
        source_size=source_size,
    )
    promoted_bands, bitmap_candidates = _promote_split_edge_spanning_bands_to_native_shapes(
        bitmap_candidates,
        source_image=source_rgb,
    )
    native_shapes.extend(promoted_bands)
    promoted_cards, bitmap_candidates = _promote_large_card_containers_to_native_shapes(
        bitmap_candidates,
        source_image=source_rgb,
        source_size=source_size,
        native_shapes=native_shapes,
    )
    native_shapes.extend(promoted_cards)
    bitmap_candidates = [
        candidate
        for candidate in bitmap_candidates
        if not _should_drop_bitmap_candidate(
            candidate,
            native_shapes=native_shapes,
            source_size=source_size,
            source_image=source_rgb,
            source_background=source_background,
        )
    ]
    bitmap_candidates = _drop_nested_bitmap_fragments(bitmap_candidates)
    bitmap_candidates = _merge_nearby_bitmap_fragments(bitmap_candidates, source_size=source_size)
    return native_shapes, bitmap_candidates


def _promote_large_card_containers_to_native_shapes(
    candidates: list[ForegroundCandidate],
    *,
    source_image: Image.Image,
    source_size: tuple[int, int],
    native_shapes: list[NativeShapeSpec],
) -> tuple[list[NativeShapeSpec], list[ForegroundCandidate]]:
    promoted: list[NativeShapeSpec] = []
    promoted_ids: set[str] = set()
    eligible = [
        candidate
        for candidate in candidates
        if _is_large_card_container_candidate(
            candidate,
            candidates,
            source_size,
            source_image=source_image,
            native_shapes=native_shapes,
        )
    ]
    selected: list[ForegroundCandidate] = []
    for candidate in sorted(
        eligible, key=lambda item: _bbox_area_pixels(item.source_pixel_bbox), reverse=True
    ):
        if any(
            _bbox_contains_ratio(parent.source_pixel_bbox, candidate.source_pixel_bbox) >= 0.85
            for parent in selected
        ):
            continue
        selected.append(candidate)
    selected_ids = {candidate.candidate_id for candidate in selected}
    for candidate in candidates:
        if candidate.candidate_id not in selected_ids:
            continue
        promoted.append(
            NativeShapeSpec(
                shape_type="rounded_rectangle",
                source_pixel_bbox=candidate.source_pixel_bbox,
                fill_color=_representative_region_hex(source_image, candidate.source_pixel_bbox),
                line_color="#1D4ED8",
                stroke_width=max(1.0, min(source_size) * 0.002),
                opacity=0.78,
                radius=max(
                    8.0,
                    min(
                        candidate.source_pixel_bbox[2] - candidate.source_pixel_bbox[0],
                        candidate.source_pixel_bbox[3] - candidate.source_pixel_bbox[1],
                    )
                    * 0.04,
                ),
                confidence=max(candidate.confidence, 0.72),
                provenance={
                    **_as_dict(candidate.provenance),
                    "parent_candidate_id": candidate.candidate_id,
                    "shape_hint": "rounded_rectangle",
                    "fitter": "large_card_container",
                },
            )
        )
        promoted_ids.add(candidate.candidate_id)
    if not promoted:
        return [], candidates
    return promoted, [
        candidate for candidate in candidates if candidate.candidate_id not in promoted_ids
    ]


def _is_large_card_container_candidate(
    candidate: ForegroundCandidate,
    candidates: list[ForegroundCandidate],
    source_size: tuple[int, int],
    *,
    source_image: Image.Image,
    native_shapes: list[NativeShapeSpec],
    min_child_count: int = 2,
) -> bool:
    if candidate.classification not in {
        "complex_whole_visual",
        "bitmap_asset_candidate",
        "uncertain",
    }:
        return False
    if not _is_source_base_difference_candidate(candidate):
        return False
    bbox = candidate.source_pixel_bbox
    page_area = max(1, source_size[0] * source_size[1])
    width_ratio = max(0, bbox[2] - bbox[0]) / float(max(1, source_size[0]))
    height_ratio = max(0, bbox[3] - bbox[1]) / float(max(1, source_size[1]))
    area_ratio = _bbox_area_pixels(bbox) / float(page_area)
    if not (0.16 <= area_ratio <= 0.50):
        return False
    if not (0.25 <= width_ratio <= 0.78 and 0.35 <= height_ratio <= 0.78):
        return False
    if bbox[0] <= round(source_size[0] * 0.015) or bbox[2] >= source_size[0] - round(
        source_size[0] * 0.015
    ):
        return False
    if not _large_card_container_has_outline_signal(source_image, bbox):
        return False
    if _large_card_container_has_high_texture_interior(source_image, bbox):
        return False
    contained_children = [
        other
        for other in candidates
        if other.candidate_id != candidate.candidate_id
        and other.classification in {"complex_whole_visual", "bitmap_asset_candidate", "uncertain"}
        and _bbox_contains_ratio(candidate.source_pixel_bbox, other.source_pixel_bbox) >= 0.85
        and _bbox_area_pixels(other.source_pixel_bbox)
        <= _bbox_area_pixels(candidate.source_pixel_bbox) * 0.45
    ]
    contained_native_shapes = [
        shape
        for shape in native_shapes
        if _bbox_contains_ratio(candidate.source_pixel_bbox, shape.source_pixel_bbox) >= 0.85
        and _bbox_area_pixels(shape.source_pixel_bbox)
        <= _bbox_area_pixels(candidate.source_pixel_bbox) * 0.45
    ]
    return len(contained_children) + len(contained_native_shapes) >= min_child_count


def _large_card_container_has_outline_signal(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
) -> bool:
    left, top, right, bottom = _clamp_bbox_to_size(bbox, image.size)
    width = right - left
    height = bottom - top
    if width <= 20 or height <= 20:
        return False
    search = max(4, min(width, height) // 12)
    strip = max(2, min(6, min(width, height) // 30))
    horizontal_left = max(0, left - search)
    horizontal_right = min(image.width, right + search)
    vertical_top = max(0, top - search)
    vertical_bottom = min(image.height, bottom + search)
    edge_found = [
        _scan_horizontal_card_outline(image, horizontal_left, horizontal_right, top, search, strip),
        _scan_horizontal_card_outline(
            image, horizontal_left, horizontal_right, bottom, search, strip
        ),
        _scan_vertical_card_outline(image, vertical_top, vertical_bottom, left, search, strip),
        _scan_vertical_card_outline(image, vertical_top, vertical_bottom, right, search, strip),
    ]
    return sum(edge_found) >= 2


def _scan_horizontal_card_outline(
    image: Image.Image,
    left: int,
    right: int,
    center_y: int,
    search: int,
    strip: int,
) -> bool:
    for y in range(max(0, center_y - search), min(image.height - strip + 1, center_y + search + 1)):
        if _edge_region_has_coherent_card_outline(image, (left, y, right, y + strip)):
            return True
    return False


def _scan_vertical_card_outline(
    image: Image.Image,
    top: int,
    bottom: int,
    center_x: int,
    search: int,
    strip: int,
) -> bool:
    for x in range(max(0, center_x - search), min(image.width - strip + 1, center_x + search + 1)):
        if _edge_region_has_coherent_card_outline(image, (x, top, x + strip, bottom)):
            return True
    return False


def _bbox_has_card_outline_signal(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
) -> bool:
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    if width <= 20 or height <= 20:
        return False
    strip = max(2, min(6, min(width, height) // 30))
    edge_regions = [
        (left, top, right, top + strip),
        (left, bottom - strip, right, bottom),
        (left, top, left + strip, bottom),
        (right - strip, top, right, bottom),
    ]
    return (
        sum(_edge_region_has_coherent_card_outline(image, region) for region in edge_regions) >= 2
    )


def _edge_region_has_coherent_card_outline(
    image: Image.Image,
    region: tuple[int, int, int, int],
) -> bool:
    left, top, right, bottom = region
    total = max(1, (right - left) * (bottom - top))
    buckets: dict[tuple[int, int, int], int] = {}
    pixels = image.load()
    outline_pixels = 0
    for y in range(top, bottom):
        for x in range(left, right):
            color = pixels[x, y][:3]
            if not _is_card_outline_pixel(color):
                continue
            outline_pixels += 1
            bucket = tuple(int(channel) // 32 for channel in color)
            buckets[bucket] = buckets.get(bucket, 0) + 1
    if outline_pixels / float(total) < 0.08:
        return False
    return max(buckets.values(), default=0) / float(total) >= 0.05


def _is_card_outline_pixel(color: tuple[int, int, int]) -> bool:
    red, green, blue = (int(channel) for channel in color[:3])
    if min(red, green, blue) >= 180:
        return True
    saturation = max(red, green, blue) - min(red, green, blue)
    return blue >= 80 and blue >= red + 20 and blue >= green - 10 and saturation >= 45


def _large_card_container_has_high_texture_interior(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    *,
    max_mean_adjacent_delta: float = 24.0,
) -> bool:
    left, top, right, bottom = _clamp_bbox_to_size(bbox, image.size)
    width = right - left
    height = bottom - top
    if width <= 24 or height <= 24:
        return False
    inset = max(4, min(width, height) // 20)
    if left + inset >= right - inset or top + inset >= bottom - inset:
        return False
    crop = image.crop((left + inset, top + inset, right - inset, bottom - inset)).convert("L")
    crop = crop.resize((96, 64))
    pixels = crop.load()
    total_delta = 0
    comparisons = 0
    for y in range(crop.height):
        for x in range(crop.width):
            current = pixels[x, y]
            if x + 1 < crop.width:
                total_delta += abs(current - pixels[x + 1, y])
                comparisons += 1
            if y + 1 < crop.height:
                total_delta += abs(current - pixels[x, y + 1])
                comparisons += 1
    if comparisons == 0:
        return False
    return total_delta / float(comparisons) > max_mean_adjacent_delta


def _promote_split_edge_spanning_bands_to_native_shapes(
    candidates: list[ForegroundCandidate],
    *,
    source_image: Image.Image,
) -> tuple[list[NativeShapeSpec], list[ForegroundCandidate]]:
    promoted: list[NativeShapeSpec] = []
    remaining: list[ForegroundCandidate] = []
    for candidate in candidates:
        provenance = _as_dict(candidate.provenance)
        if provenance.get("detection") != "split_edge_spanning_difference":
            remaining.append(candidate)
            continue
        promoted.append(
            NativeShapeSpec(
                shape_type="rounded_rectangle",
                source_pixel_bbox=candidate.source_pixel_bbox,
                fill_color=_representative_region_hex(source_image, candidate.source_pixel_bbox),
                line_color=None,
                opacity=0.15,
                confidence=max(candidate.confidence, 0.72),
                provenance={
                    **provenance,
                    "candidate_id": candidate.candidate_id,
                    "shape_hint": "rounded_rectangle",
                    "fitter": "structural_edge_band",
                },
            )
        )
    return promoted, remaining


def _representative_region_hex(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
) -> str:
    crop = image.crop(_clamp_bbox_to_size(bbox, image.size)).resize((1, 1))
    red, green, blue = crop.getpixel((0, 0))[:3]
    return f"#{red:02X}{green:02X}{blue:02X}"


def _expand_edge_spanning_bitmap_candidates(
    candidates: list[ForegroundCandidate],
    *,
    source_size: tuple[int, int],
) -> list[ForegroundCandidate]:
    expanded: list[ForegroundCandidate] = []
    for candidate in candidates:
        split_detection = _bitmap_candidate_split_detection(candidate, source_size)
        if not split_detection:
            expanded.append(candidate)
            continue
        left, top, right, bottom = candidate.source_pixel_bbox
        height = max(1, bottom - top)
        band_count = 3 if height / float(max(1, source_size[1])) >= 0.45 else 2
        for band_index in range(band_count):
            band_top = top + round(height * band_index / band_count)
            band_bottom = top + round(height * (band_index + 1) / band_count)
            band_bbox = _clamp_bbox_to_size((left, band_top, right, band_bottom), source_size)
            if band_bbox[2] <= band_bbox[0] or band_bbox[3] <= band_bbox[1]:
                continue
            expanded.append(
                replace(
                    candidate,
                    candidate_id=f"{candidate.candidate_id}-band-{band_index + 1}",
                    source_pixel_bbox=band_bbox,
                    area=_bbox_area_pixels(band_bbox),
                    classification="complex_whole_visual",
                    provenance={
                        **_as_dict(candidate.provenance),
                        "detection": split_detection,
                        "parent_candidate_id": candidate.candidate_id,
                        "band_index": band_index + 1,
                        "band_count": band_count,
                    },
                )
            )
    return expanded


def _bitmap_candidate_split_detection(
    candidate: ForegroundCandidate,
    source_size: tuple[int, int],
) -> str:
    if _should_split_edge_spanning_bitmap_candidate(candidate, source_size):
        return "split_edge_spanning_difference"
    if _should_split_large_layered_bitmap_candidate(candidate, source_size):
        return "split_large_layered_difference"
    return ""


def _should_split_edge_spanning_bitmap_candidate(
    candidate: ForegroundCandidate,
    source_size: tuple[int, int],
) -> bool:
    if candidate.classification not in {
        "complex_whole_visual",
        "bitmap_asset_candidate",
        "uncertain",
    }:
        return False
    if not _is_source_base_difference_candidate(candidate):
        return False
    bbox = candidate.source_pixel_bbox
    width_ratio = max(0, bbox[2] - bbox[0]) / float(max(1, source_size[0]))
    height_ratio = max(0, bbox[3] - bbox[1]) / float(max(1, source_size[1]))
    area_ratio = _bbox_area_pixels(bbox) / float(max(1, source_size[0] * source_size[1]))
    edge_margin = max(4, round(min(source_size) * 0.01))
    spans_horizontal_edges = bbox[0] <= edge_margin and bbox[2] >= source_size[0] - edge_margin
    return (
        spans_horizontal_edges
        and width_ratio >= 0.90
        and height_ratio >= 0.35
        and area_ratio >= 0.18
    )


def _should_split_large_layered_bitmap_candidate(
    candidate: ForegroundCandidate,
    source_size: tuple[int, int],
) -> bool:
    if candidate.classification not in {
        "complex_whole_visual",
        "bitmap_asset_candidate",
        "uncertain",
    }:
        return False
    if not _is_source_base_difference_candidate(candidate):
        return False
    bbox = candidate.source_pixel_bbox
    width_ratio = max(0, bbox[2] - bbox[0]) / float(max(1, source_size[0]))
    height_ratio = max(0, bbox[3] - bbox[1]) / float(max(1, source_size[1]))
    area_ratio = _bbox_area_pixels(bbox) / float(max(1, source_size[0] * source_size[1]))
    top_ratio = bbox[1] / float(max(1, source_size[1]))
    bottom_ratio = bbox[3] / float(max(1, source_size[1]))
    return (
        width_ratio >= 0.72
        and height_ratio >= 0.70
        and area_ratio >= 0.65
        and top_ratio >= 0.10
        and bottom_ratio <= 0.97
    )


def _drop_nested_bitmap_fragments(
    candidates: list[ForegroundCandidate],
) -> list[ForegroundCandidate]:
    kept: list[ForegroundCandidate] = []
    for candidate in candidates:
        if any(
            _bitmap_candidate_contains_fragment(container, candidate) for container in candidates
        ):
            continue
        kept.append(candidate)
    return kept


def _drop_oversized_native_shapes(
    native_shapes: list[NativeShapeSpec],
    source_size: tuple[int, int],
    max_area_ratio: float = 0.35,
    max_line_bbox_area_ratio: float = 0.08,
) -> list[NativeShapeSpec]:
    page_area = max(1, source_size[0] * source_size[1])
    kept: list[NativeShapeSpec] = []
    for shape in native_shapes:
        area_ratio = _bbox_area_pixels(shape.source_pixel_bbox) / float(page_area)
        if shape.shape_type == "line" and area_ratio > max_line_bbox_area_ratio:
            continue
        if shape.shape_type != "line" and area_ratio > max_area_ratio:
            continue
        kept.append(shape)
    return kept


def _bitmap_candidate_contains_fragment(
    container: ForegroundCandidate,
    fragment: ForegroundCandidate,
) -> bool:
    if container.candidate_id == fragment.candidate_id:
        return False
    if container.classification not in {"complex_whole_visual", "bitmap_asset_candidate"}:
        return False
    if fragment.classification not in {
        "complex_whole_visual",
        "bitmap_asset_candidate",
        "uncertain",
    }:
        return False
    container_area = _bbox_area_pixels(container.source_pixel_bbox)
    fragment_area = _bbox_area_pixels(fragment.source_pixel_bbox)
    if container_area < fragment_area * 4:
        return False
    return _bbox_contains_ratio(container.source_pixel_bbox, fragment.source_pixel_bbox) >= 0.90


def _merge_nearby_bitmap_fragments(
    candidates: list[ForegroundCandidate],
    *,
    source_size: tuple[int, int],
    max_gap: int = 24,
    max_union_growth: float = 2.6,
    max_merged_page_area_ratio: float = 0.22,
) -> list[ForegroundCandidate]:
    merged = list(candidates)
    changed = True
    while changed:
        changed = False
        for left_index in range(len(merged)):
            if changed:
                break
            for right_index in range(left_index + 1, len(merged)):
                left = merged[left_index]
                right = merged[right_index]
                if not _bitmap_fragments_should_merge(
                    left,
                    right,
                    max_gap=max_gap,
                    max_union_growth=max_union_growth,
                    source_size=source_size,
                    max_merged_page_area_ratio=max_merged_page_area_ratio,
                ):
                    continue
                merged[left_index] = _merged_bitmap_candidate(left, right)
                del merged[right_index]
                changed = True
                break
    return merged


def _bitmap_fragments_should_merge(
    left: ForegroundCandidate,
    right: ForegroundCandidate,
    *,
    max_gap: int,
    max_union_growth: float,
    source_size: tuple[int, int],
    max_merged_page_area_ratio: float,
) -> bool:
    if left.classification not in {"complex_whole_visual", "bitmap_asset_candidate", "uncertain"}:
        return False
    if right.classification not in {"complex_whole_visual", "bitmap_asset_candidate", "uncertain"}:
        return False
    if _box_distance_pixels(left.source_pixel_bbox, right.source_pixel_bbox) > max_gap:
        return False
    union = _union_bbox(left.source_pixel_bbox, right.source_pixel_bbox)
    if (
        _bbox_area_pixels(union) / float(max(1, source_size[0] * source_size[1]))
        > max_merged_page_area_ratio
    ):
        return False
    separate_area = _bbox_area_pixels(left.source_pixel_bbox) + _bbox_area_pixels(
        right.source_pixel_bbox
    )
    return _bbox_area_pixels(union) / float(max(1, separate_area)) <= max_union_growth


def _merged_bitmap_candidate(
    left: ForegroundCandidate, right: ForegroundCandidate
) -> ForegroundCandidate:
    merged_ids = [
        *_as_dict(left.provenance).get("merged_candidate_ids", [left.candidate_id]),
        *_as_dict(right.provenance).get("merged_candidate_ids", [right.candidate_id]),
    ]
    bbox = _union_bbox(left.source_pixel_bbox, right.source_pixel_bbox)
    return replace(
        left,
        candidate_id=left.candidate_id,
        source_pixel_bbox=bbox,
        area=_bbox_area_pixels(bbox),
        classification="complex_whole_visual",
        provenance={
            **_as_dict(left.provenance),
            "merged_candidate_ids": merged_ids,
            "merge_strategy": "nearby_bitmap_fragments",
        },
    )


def _reclassify_uncertain_candidates(
    candidates: list[ForegroundCandidate],
    *,
    source_image_path: str,
) -> list[ForegroundCandidate]:
    reclassified: list[ForegroundCandidate] = []
    for candidate in candidates:
        if candidate.classification != "uncertain":
            reclassified.append(candidate)
            continue
        try:
            refined = classify_foreground_candidates(
                source_image_path=source_image_path,
                candidate_boxes=[candidate.source_pixel_bbox],
            )[0]
        except Exception:
            reclassified.append(candidate)
            continue
        reclassified.append(
            replace(
                refined,
                candidate_id=candidate.candidate_id,
                component_key=candidate.component_key or refined.component_key,
                provenance={
                    **_as_dict(refined.provenance),
                    "reclassified_from": "uncertain",
                    "original_detection": _as_dict(candidate.provenance),
                },
            )
        )
    return reclassified


def _detect_source_native_shape_candidates(
    *,
    source_image_path: str,
    text_mask_path: str | None,
    min_area: int = 80,
) -> list[ForegroundCandidate]:
    with Image.open(source_image_path) as source:
        source_rgb = source.convert("RGB")
        text_mask = _load_text_mask_for_source_detection(text_mask_path, source_rgb.size)
        background = _estimate_background_color(source_rgb)
        pixels = _source_foreground_pixels(source_rgb, text_mask, background)
    components = _source_connected_components(pixels)
    candidates: list[ForegroundCandidate] = []
    for component in components:
        if len(component) < min_area:
            continue
        xs = [point[0] for point in component]
        ys = [point[1] for point in component]
        bbox = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
        if _source_detection_bbox_is_noise(bbox, source_rgb.size):
            continue
        candidate = _source_component_native_candidate(
            component=component,
            bbox=bbox,
            candidate_id=f"source-native-{len(candidates) + 1:03d}",
        )
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def _source_component_native_candidate(
    *,
    component: list[tuple[int, int]],
    bbox: tuple[int, int, int, int],
    candidate_id: str,
) -> ForegroundCandidate | None:
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    bbox_area = max(1, width * height)
    fill_ratio = len(component) / float(bbox_area)
    points = set(component)
    provenance: dict[str, Any] = {"detection": "source_native_shape_scan"}

    is_box_outline = _source_component_is_box_outline(points, bbox)
    sparse_corners = _source_component_sparse_corner_count(points, bbox)
    if is_box_outline or fill_ratio >= 0.68:
        if not is_box_outline and sparse_corners == 4 and fill_ratio < 0.86:
            return None
        if _source_component_has_rounded_corners(points, bbox):
            provenance.update(
                {
                    "shape_hint": "rounded_rectangle",
                    "radius": max(4, round(min(width, height) * 0.18)),
                }
            )
        else:
            provenance["shape_hint"] = "rectangle"
        return ForegroundCandidate(
            candidate_id=candidate_id,
            source_pixel_bbox=bbox,
            area=len(component),
            classification="native_shape_candidate",
            confidence=0.94,
            provenance=provenance,
        )

    if _source_component_is_line(width, height, fill_ratio):
        start, end = _source_line_endpoints(component)
        provenance.update(
            {
                "shape_hint": "line",
                "line_start": start,
                "line_end": end,
                "stroke_width": max(1, round(min(width, height) * max(fill_ratio, 0.12))),
            }
        )
        return ForegroundCandidate(
            candidate_id=candidate_id,
            source_pixel_bbox=bbox,
            area=len(component),
            classification="native_shape_candidate",
            confidence=0.93,
            provenance=provenance,
        )

    return None


def _load_text_mask_for_source_detection(
    text_mask_path: str | None,
    size: tuple[int, int],
) -> Image.Image | None:
    if not text_mask_path:
        return None
    with Image.open(text_mask_path) as mask:
        return mask.convert("L").resize(size)


def _estimate_background_color(image: Image.Image) -> tuple[int, int, int]:
    step_x = max(1, image.width // 40)
    step_y = max(1, image.height // 24)
    footer_top = max(0, image.height - min(24, max(0, round(image.height * 0.08))))
    counts: dict[tuple[int, int, int], int] = {}
    for y in range(0, footer_top, step_y):
        for x in range(0, image.width, step_x):
            pixel = image.getpixel((x, y))
            counts[pixel] = counts.get(pixel, 0) + 1
    if counts:
        return max(counts.items(), key=lambda item: item[1])[0]
    return image.getpixel((0, 0))


def _source_foreground_pixels(
    image: Image.Image,
    text_mask: Image.Image | None,
    background: tuple[int, int, int],
    *,
    threshold: int = 28,
) -> set[tuple[int, int]]:
    pixels: set[tuple[int, int]] = set()
    footer_top = max(0, image.height - min(24, max(0, round(image.height * 0.08))))
    for y in range(image.height):
        if y >= footer_top:
            continue
        for x in range(image.width):
            if text_mask is not None and text_mask.getpixel((x, y)) > 0:
                continue
            red, green, blue = image.getpixel((x, y))
            if (
                max(abs(red - background[0]), abs(green - background[1]), abs(blue - background[2]))
                > threshold
            ):
                pixels.add((x, y))
    return pixels


def _source_connected_components(pixels: set[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    remaining = set(pixels)
    components: list[list[tuple[int, int]]] = []
    while remaining:
        seed = remaining.pop()
        stack = [seed]
        component = [seed]
        while stack:
            x, y = stack.pop()
            for neighbor in (
                (x - 1, y - 1),
                (x, y - 1),
                (x + 1, y - 1),
                (x - 1, y),
                (x + 1, y),
                (x - 1, y + 1),
                (x, y + 1),
                (x + 1, y + 1),
            ):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    stack.append(neighbor)
                    component.append(neighbor)
        components.append(component)
    components.sort(
        key=lambda item: (min(point[1] for point in item), min(point[0] for point in item))
    )
    return components


def _source_detection_bbox_is_noise(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
) -> bool:
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    if width <= 2 or height <= 2:
        return True
    if width > size[0] * 0.95 and height > size[1] * 0.40:
        return True
    return False


def _should_use_local_reconstruction_background(
    *,
    source_image_path: str | Path,
    native_shapes: list[NativeShapeSpec],
    bitmap_assets: list[BitmapAssetSpec],
    text_boxes: list,
) -> bool:
    if bitmap_assets or not native_shapes:
        return False
    return _source_background_is_flat_for_local_reconstruction(
        source_image_path,
        [shape.source_pixel_bbox for shape in native_shapes]
        + [text_box.source_pixel_bbox for text_box in text_boxes],
    )


def _should_choose_text_clean_background(
    *,
    source_image_path: str | Path,
    base_clean_image_path: str | Path,
    text_clean_image_path: str | Path,
    text_boxes: list,
) -> bool:
    base_delta = _mean_background_delta_outside_text(
        source_image_path,
        base_clean_image_path,
        text_boxes,
    )
    text_delta = _mean_background_delta_outside_text(
        source_image_path,
        text_clean_image_path,
        text_boxes,
    )
    return base_delta > 8.0 and text_delta + 3.0 < base_delta


def _should_choose_source_preserving_background(
    *,
    source_image_path: str | Path,
    chosen_background_image_path: str | Path,
    text_clean_image_path: str | Path,
    text_boxes: list,
    native_shapes: list[NativeShapeSpec],
    bitmap_assets: list[BitmapAssetSpec],
    source_image_size: tuple[int, int],
) -> bool:
    # A source-preserving full-slide background keeps the slide looking close by
    # baking most visual elements into one picture. That is not the editable PPTX
    # contract we want for the normal reconstruction path. Let validation fail
    # when generated backgrounds or assets are insufficient; explicit fallback
    # policies can still produce non-editable/raster outputs outside this path.
    return False


def _native_only_complex_page_should_preserve(
    *,
    native_shapes: list[NativeShapeSpec],
    bitmap_assets: list[BitmapAssetSpec],
    text_boxes: list,
    source_image_size: tuple[int, int],
) -> bool:
    if len(text_boxes) < 8 or len(native_shapes) < 8:
        return False
    if len(native_shapes) >= 20:
        return True
    if len(native_shapes) >= 12 and len(bitmap_assets) <= 2:
        return True
    native_coverage = _bbox_coverage_ratio(
        [shape.source_pixel_bbox for shape in native_shapes],
        source_image_size,
    )
    bitmap_coverage = _bbox_coverage_ratio(
        [asset.source_pixel_bbox for asset in bitmap_assets],
        source_image_size,
    )
    return native_coverage <= 0.12 and bitmap_coverage <= 0.04


def _drop_oversized_source_preserved_assets(
    bitmap_assets: list[BitmapAssetSpec],
    source_image_size: tuple[int, int],
) -> list[BitmapAssetSpec]:
    return [
        asset
        for asset in bitmap_assets
        if not _is_oversized_source_preserved_asset(asset, source_image_size)
    ]


def _bitmap_assets_for_source_preserving_background(
    bitmap_assets: list[BitmapAssetSpec],
    source_image_size: tuple[int, int],
    max_area_ratio: float = 0.05,
) -> list[BitmapAssetSpec]:
    page_area = max(1, source_image_size[0] * source_image_size[1])
    return [
        asset
        for asset in bitmap_assets
        if _bbox_area_pixels(asset.source_pixel_bbox) / float(page_area) <= max_area_ratio
    ]


def _bitmap_assets_for_clean_background(
    bitmap_assets: list[BitmapAssetSpec],
    source_image_size: tuple[int, int],
    max_diff_alpha_area_ratio: float = 0.08,
) -> list[BitmapAssetSpec]:
    page_area = max(1, source_image_size[0] * source_image_size[1])
    kept: list[BitmapAssetSpec] = []
    for asset in bitmap_assets:
        area_ratio = _bbox_area_pixels(asset.source_pixel_bbox) / float(page_area)
        if (
            asset.provenance.get("asset_strategy") == "masked_source_element"
            and asset.provenance.get("background_difference_alpha") is True
            and asset.provenance.get("candidate_classification") != "complex_whole_visual"
            and area_ratio > max_diff_alpha_area_ratio
        ):
            continue
        kept.append(asset)
    return kept


def _drop_text_boxes_covered_by_complex_bitmap_assets(
    text_boxes: list[TextBoxSpec],
    bitmap_assets: list[BitmapAssetSpec],
    *,
    min_cover_ratio: float = 0.85,
) -> tuple[list[TextBoxSpec], list[dict[str, Any]]]:
    complex_assets = [
        asset
        for asset in bitmap_assets
        if asset.provenance.get("asset_strategy") == "masked_source_element"
        and asset.provenance.get("candidate_classification") == "complex_whole_visual"
        and not _is_text_masked_complex_bitmap_asset(asset)
    ]
    if not complex_assets:
        return text_boxes, []
    kept: list[TextBoxSpec] = []
    issues: list[dict[str, Any]] = []
    for text_box in text_boxes:
        covering_bbox = next(
            (
                asset.source_pixel_bbox
                for asset in complex_assets
                if _bbox_contains_ratio(asset.source_pixel_bbox, text_box.source_pixel_bbox)
                >= min_cover_ratio
                and (
                    _text_box_has_approximate_ocr_layout(text_box)
                    or _is_opaque_complex_bitmap_asset(asset)
                )
            ),
            None,
        )
        if covering_bbox is None:
            kept.append(text_box)
            continue
        issues.append(
            {
                "severity": "warning",
                "ocr_text": text_box.text,
                "source_pixel_bbox": text_box.source_pixel_bbox,
                "covering_asset_bbox": covering_bbox,
                "code": (
                    "text_covered_by_complex_bitmap_asset"
                    if _text_box_has_approximate_ocr_layout(text_box)
                    else "text_covered_by_opaque_complex_bitmap_asset"
                ),
            }
        )
    return kept, issues


def _is_opaque_complex_bitmap_asset(asset: BitmapAssetSpec) -> bool:
    return (
        asset.provenance.get("asset_strategy") == "masked_source_element"
        and asset.provenance.get("candidate_classification") == "complex_whole_visual"
        and asset.provenance.get("text_mask_applied") is not True
        and asset.provenance.get("background_difference_alpha") is not True
    )


def _is_text_masked_complex_bitmap_asset(asset: BitmapAssetSpec) -> bool:
    return (
        asset.provenance.get("asset_strategy") == "masked_source_element"
        and asset.provenance.get("candidate_classification") == "complex_whole_visual"
        and asset.provenance.get("text_mask_applied") is True
        and asset.provenance.get("background_difference_alpha") is True
    )


def _drop_native_shapes_covered_by_complex_bitmap_assets(
    native_shapes: list[NativeShapeSpec],
    bitmap_assets: list[BitmapAssetSpec],
    *,
    min_cover_ratio: float = 0.85,
) -> list[NativeShapeSpec]:
    complex_asset_bboxes = [
        asset.source_pixel_bbox for asset in bitmap_assets if _is_opaque_complex_bitmap_asset(asset)
    ]
    if not complex_asset_bboxes:
        return native_shapes
    return [
        shape
        for shape in native_shapes
        if not any(
            _bbox_contains_ratio(asset_bbox, shape.source_pixel_bbox) >= min_cover_ratio
            for asset_bbox in complex_asset_bboxes
        )
    ]


def _native_shapes_for_source_preserving_background(
    native_shapes: list[NativeShapeSpec],
) -> list[NativeShapeSpec]:
    return []


def _build_source_preserving_anchor_assets(
    *,
    source_image_path: str | Path,
    text_boxes: list[TextBoxSpec],
    output_dir: str | Path,
    asset_root: str | Path,
    start_z_order: int = 1,
    max_assets: int = 3,
) -> list[BitmapAssetSpec]:
    anchor_boxes = _source_preserving_anchor_bboxes(text_boxes)
    anchor_source = "left_label_icon_region"
    if not anchor_boxes:
        anchor_boxes = _source_preserving_generic_visual_anchor_bboxes(
            source_image_path=source_image_path,
            text_boxes=text_boxes,
            max_assets=max_assets,
        )
        anchor_source = "visual_saliency_region"
    if not anchor_boxes:
        return []
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    asset_root_path = Path(asset_root)
    assets: list[BitmapAssetSpec] = []
    with Image.open(source_image_path) as source:
        source_rgba = source.convert("RGBA")
        for index, bbox in enumerate(anchor_boxes[:max_assets], start=start_z_order):
            clamped = _clamp_bbox_to_size(bbox, source_rgba.size)
            if clamped[2] <= clamped[0] or clamped[3] <= clamped[1]:
                continue
            asset_id = f"anchor-{index:03d}"
            path = output_path / f"{asset_id}.png"
            source_rgba.crop(clamped).save(path)
            assets.append(
                BitmapAssetSpec(
                    asset_id=asset_id,
                    source_pixel_bbox=clamped,
                    asset_path=_job_relative(path, asset_root_path),
                    z_order=index,
                    provenance={
                        "asset_strategy": "source_preserving_anchor",
                        "source": anchor_source,
                    },
                )
            )
    return assets


def _source_preserving_anchor_bboxes(
    text_boxes: list[TextBoxSpec],
) -> list[tuple[int, int, int, int]]:
    bboxes: list[tuple[int, int, int, int]] = []
    for text_box in text_boxes:
        text = str(text_box.text).strip()
        if not (_contains_cjk_text(text) and text.endswith("域")):
            continue
        x1, y1, _x2, y2 = text_box.source_pixel_bbox
        height = max(1, y2 - y1)
        center_y = (y1 + y2) // 2
        crop_height = max(28, round(height * 2.4))
        crop_width = max(28, round(height * 2.8))
        right = max(0, x1 - max(6, round(height * 0.35)))
        left = max(0, right - crop_width)
        top = max(0, center_y - crop_height // 2)
        bottom = top + crop_height
        if right > left and bottom > top:
            bboxes.append((left, top, right, bottom))
    return bboxes


def _source_preserving_generic_visual_anchor_bboxes(
    *,
    source_image_path: str | Path,
    text_boxes: list[TextBoxSpec],
    max_assets: int = 3,
    max_area_ratio: float = 0.08,
) -> list[tuple[int, int, int, int]]:
    with Image.open(source_image_path) as source:
        source_rgb = source.convert("RGB")
        text_mask = Image.new("L", source_rgb.size, 0)
        draw = ImageDraw.Draw(text_mask)
        for text_box in text_boxes:
            left, top, right, bottom = text_box.source_pixel_bbox
            pad = max(3, round((bottom - top) * 0.45))
            draw.rectangle(
                (
                    max(0, left - pad),
                    max(0, top - pad),
                    min(source_rgb.width, right + pad),
                    min(source_rgb.height, bottom + pad),
                ),
                fill=255,
            )
        background = _estimate_background_color(source_rgb)
        foreground_pixels = _source_foreground_pixels(
            source_rgb,
            text_mask,
            background,
            threshold=34,
        )
        components = _source_connected_components(foreground_pixels)
        page_area = max(1, source_rgb.width * source_rgb.height)
        text_bboxes = [text_box.source_pixel_bbox for text_box in text_boxes]
        candidates: list[tuple[int, tuple[int, int, int, int]]] = []
        for component in components:
            if len(component) < 120:
                continue
            xs = [point[0] for point in component]
            ys = [point[1] for point in component]
            bbox = _expand_bbox_to_size(
                (min(xs), min(ys), max(xs) + 1, max(ys) + 1),
                source_rgb.size,
                padding=8,
            )
            bbox = _limit_bbox_area_ratio(
                bbox,
                source_rgb.size,
                max_area_ratio=max_area_ratio,
            )
            if _bbox_area_pixels(bbox) < page_area * 0.002:
                continue
            if any(_bbox_iou(bbox, text_bbox) > 0.10 for text_bbox in text_bboxes):
                continue
            candidates.append((len(component), bbox))
        candidates.sort(key=lambda item: item[0], reverse=True)
        selected: list[tuple[int, int, int, int]] = []
        for _score, bbox in candidates:
            if any(_bbox_iou(bbox, existing) > 0.35 for existing in selected):
                continue
            selected.append(bbox)
            if len(selected) >= max_assets:
                break
        return selected


def _augment_bitmap_candidates_with_generic_visual_anchors(
    bitmap_candidates: list[ForegroundCandidate],
    *,
    source_image_path: str | Path,
    text_boxes: list[TextBoxSpec],
    native_shapes: list[NativeShapeSpec] | None = None,
    max_assets: int = 8,
    max_area_ratio: float = 0.08,
) -> list[ForegroundCandidate]:
    if not any(_contains_cjk_text(str(text_box.text)) for text_box in text_boxes):
        return bitmap_candidates
    with Image.open(source_image_path) as source:
        source_size = source.size
    is_cover_title_layout = _is_cover_title_slide_text_layout(text_boxes, source_size=source_size)
    effective_max_area_ratio = (
        max(max_area_ratio, 0.16)
        if _has_split_edge_spanning_native_band(native_shapes or [])
        else max_area_ratio
    )
    generic_bboxes = _source_preserving_generic_visual_anchor_bboxes(
        source_image_path=source_image_path,
        text_boxes=text_boxes,
        max_assets=max_assets,
        max_area_ratio=effective_max_area_ratio,
    )
    cover_lower_bboxes = (
        _cover_title_lower_visual_anchor_bboxes(text_boxes, source_size=source_size)
        if is_cover_title_layout
        else []
    )
    if is_cover_title_layout and not (
        _has_lower_cover_title_visual_anchor(generic_bboxes, source_size=source_size)
        or cover_lower_bboxes
    ):
        return bitmap_candidates
    row_bboxes = _domain_row_visual_anchor_bboxes(text_boxes, source_size=source_size)
    anchor_bboxes = [
        *cover_lower_bboxes,
        *generic_bboxes,
        *[
            bbox
            for bbox in row_bboxes
            if not any(
                _bbox_iou(bbox, generic) >= 0.55
                for generic in [*cover_lower_bboxes, *generic_bboxes]
            )
        ],
    ]
    if not anchor_bboxes:
        return bitmap_candidates
    augmented = list(bitmap_candidates)
    for index, bbox in enumerate(anchor_bboxes, start=1):
        if any(_bbox_iou(bbox, candidate.source_pixel_bbox) >= 0.55 for candidate in augmented):
            continue
        if any(
            _bbox_contains_ratio(candidate.source_pixel_bbox, bbox) >= 0.85
            for candidate in augmented
        ):
            continue
        augmented.append(
            ForegroundCandidate(
                candidate_id=f"generic-visual-{index:03d}",
                source_pixel_bbox=bbox,
                area=_bbox_area_pixels(bbox),
                classification="complex_whole_visual",
                confidence=0.78,
                provenance={
                    "detection": (
                        "cover_title_lower_visual_anchor"
                        if bbox in cover_lower_bboxes
                        else "source_generic_visual_anchor"
                        if bbox in generic_bboxes
                        else "domain_row_visual_anchor"
                    ),
                    "reason": "preserve_visual_region_missing_from_clean_background",
                },
            )
        )
    return _drop_nested_bitmap_fragments(augmented)


def _cover_title_lower_visual_anchor_bboxes(
    text_boxes: list[TextBoxSpec],
    *,
    source_size: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    source_width, source_height = source_size
    if source_width <= 0 or source_height <= 0:
        return []
    has_bottom_helper_text = any(
        text_box.source_pixel_bbox[1] >= source_height * 0.72
        and any(marker in str(text_box.text) for marker in ("官方", "帮助", "OTA", "二维码"))
        for text_box in text_boxes
    )
    if not has_bottom_helper_text:
        return []
    return [(0, round(source_height * 0.54), source_width, source_height)]


def _has_lower_cover_title_visual_anchor(
    bboxes: list[tuple[int, int, int, int]],
    *,
    source_size: tuple[int, int],
) -> bool:
    source_width, source_height = source_size
    page_area = max(1, source_width * source_height)
    return any(
        bbox[1] >= source_height * 0.48
        and _bbox_area_pixels(bbox) >= page_area * 0.025
        and (
            (bbox[2] - bbox[0]) / float(max(1, bbox[3] - bbox[1])) <= 4.8
            or (bbox[3] - bbox[1]) >= source_height * 0.25
        )
        for bbox in bboxes
    )


def _is_cover_title_slide_text_layout(
    text_boxes: list[TextBoxSpec],
    *,
    source_size: tuple[int, int],
) -> bool:
    if not text_boxes:
        return False
    source_width, source_height = source_size
    if any(str(text_box.text).strip().endswith("域") for text_box in text_boxes):
        return False
    upper_large_title_boxes = [
        text_box
        for text_box in text_boxes
        if text_box.source_pixel_bbox[1] <= source_height * 0.45
        and (text_box.source_pixel_bbox[2] - text_box.source_pixel_bbox[0]) >= source_width * 0.18
        and (text_box.source_pixel_bbox[3] - text_box.source_pixel_bbox[1]) >= source_height * 0.06
        and _contains_cjk_text(str(text_box.text))
    ]
    if len(upper_large_title_boxes) >= 2:
        return True
    if len(upper_large_title_boxes) == 1:
        text = str(upper_large_title_boxes[0].text)
        return any(marker in text for marker in ("L9", "实验", "总结", "建议"))
    return False


def _has_split_edge_spanning_native_band(native_shapes: list[NativeShapeSpec]) -> bool:
    return any(
        _as_dict(shape.provenance).get("detection") == "split_edge_spanning_difference"
        for shape in native_shapes
    )


def _domain_row_visual_anchor_bboxes(
    text_boxes: list[TextBoxSpec],
    *,
    source_size: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    source_width, source_height = source_size
    labels = [
        text_box
        for text_box in text_boxes
        if str(text_box.text).strip().endswith("域")
        and text_box.source_pixel_bbox[0] <= source_width * 0.35
    ]
    if not labels:
        return []
    spec_boxes = [
        text_box.source_pixel_bbox
        for text_box in text_boxes
        if text_box.source_pixel_bbox[0] >= source_width * 0.60
    ]
    bboxes: list[tuple[int, int, int, int]] = []
    for label in labels:
        left_label, top_label, right_label, bottom_label = label.source_pixel_bbox
        center_y = (top_label + bottom_label) // 2
        nearby_specs = [
            bbox
            for bbox in spec_boxes
            if abs(((bbox[1] + bbox[3]) // 2) - center_y) <= max(80, round(source_height * 0.16))
        ]
        if not nearby_specs:
            continue
        spec_left = min(bbox[0] for bbox in nearby_specs)
        left = max(right_label + round(source_width * 0.05), round(source_width * 0.30))
        right = min(spec_left - round(source_width * 0.05), round(source_width * 0.76))
        half_height = max(72, round(source_height * 0.15))
        top = center_y - half_height
        bottom = center_y + half_height
        bbox = _clamp_bbox_to_size((left, top, right, bottom), source_size)
        if bbox[2] - bbox[0] < source_width * 0.10 or bbox[3] - bbox[1] < source_height * 0.08:
            continue
        bboxes.append(bbox)
    return bboxes


def _expand_bbox_to_size(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
    *,
    padding: int,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    return _clamp_bbox_to_size(
        (left - padding, top - padding, right + padding, bottom + padding),
        size,
    )


def _limit_bbox_area_ratio(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
    *,
    max_area_ratio: float,
) -> tuple[int, int, int, int]:
    page_area = max(1, size[0] * size[1])
    max_area = max(1, int(page_area * max_area_ratio))
    left, top, right, bottom = _clamp_bbox_to_size(bbox, size)
    width = max(1, right - left)
    height = max(1, bottom - top)
    if width * height <= max_area:
        return (left, top, right, bottom)
    scale = (max_area / float(width * height)) ** 0.5
    limited_width = max(1, int(width * scale))
    limited_height = max(1, int(height * scale))
    center_x = (left + right) // 2
    center_y = (top + bottom) // 2
    new_left = center_x - limited_width // 2
    new_top = center_y - limited_height // 2
    return _clamp_bbox_to_size(
        (new_left, new_top, new_left + limited_width, new_top + limited_height),
        size,
    )


def _is_oversized_source_preserved_asset(
    asset: BitmapAssetSpec,
    source_image_size: tuple[int, int],
) -> bool:
    if asset.provenance.get("asset_strategy") != "masked_source_element":
        return False
    if asset.provenance.get("background_difference_alpha") is True:
        return False
    source_width, source_height = source_image_size
    if source_width <= 0 or source_height <= 0:
        return False
    left, top, right, bottom = _clamp_bbox_to_size(asset.source_pixel_bbox, source_image_size)
    width_ratio = (right - left) / float(source_width)
    height_ratio = (bottom - top) / float(source_height)
    area_ratio = _bbox_area_pixels((left, top, right, bottom)) / float(source_width * source_height)
    return area_ratio >= 0.35 or (width_ratio >= 0.85 and height_ratio >= 0.35)


def _bbox_coverage_ratio(
    bboxes: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> float:
    total_area = max(1, source_image_size[0] * source_image_size[1])
    covered = Image.new("L", source_image_size, 0)
    draw = ImageDraw.Draw(covered)
    for bbox in bboxes:
        left, top, right, bottom = _clamp_bbox_to_size(bbox, source_image_size)
        if right > left and bottom > top:
            draw.rectangle((left, top, right, bottom), fill=255)
    histogram = covered.histogram()
    covered_pixels = total_area - histogram[0]
    return covered_pixels / float(total_area)


def _mean_background_delta_outside_text(
    source_image_path: str | Path,
    candidate_image_path: str | Path,
    text_boxes: list,
) -> float:
    with Image.open(source_image_path) as source, Image.open(candidate_image_path) as candidate:
        source_rgb = source.convert("RGB")
        candidate_rgb = candidate.convert("RGB").resize(source_rgb.size)
        diff = ImageChops.difference(source_rgb, candidate_rgb)
        mask = Image.new("L", source_rgb.size, 255)
        draw = ImageDraw.Draw(mask)
        for text_box in text_boxes:
            x1, y1, x2, y2 = text_box.source_pixel_bbox
            pad = max(4, round((y2 - y1) * 0.35))
            draw.rectangle(
                (
                    max(0, x1 - pad),
                    max(0, y1 - pad),
                    min(source_rgb.width, x2 + pad),
                    min(source_rgb.height, y2 + pad),
                ),
                fill=0,
            )
        stat = ImageStat.Stat(diff.convert("L"), mask)
        return float(stat.mean[0]) if stat.count[0] else 0.0


def _create_local_reconstruction_background(
    *,
    source_image_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
    foreground_bboxes: list[tuple[int, int, int, int]],
) -> BackgroundResult:
    source_path = Path(source_image_path)
    output_path = Path(output_asset_path)
    asset_root_path = Path(asset_root)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source_path) as source:
        source_rgb = source.convert("RGB")
        background = Image.new(
            "RGB",
            source_rgb.size,
            _estimate_flat_background_color(source_rgb, foreground_bboxes),
        )
        footer_top = _footer_top(source_rgb.size)
        if footer_top < source_rgb.height:
            background.paste(
                source_rgb.crop((0, footer_top, source_rgb.width, source_rgb.height)),
                (0, footer_top),
            )
        background.save(output_path)
    return BackgroundResult(
        output_asset_path=str(output_path),
        artifact_path=_job_relative(output_path, asset_root_path),
        strategy="local_fill",
        provider_role="local",
        prompt_id="local_reconstruction_background",
        input_asset_refs=[_job_relative(source_path, asset_root_path)],
        validation_status="passed",
        provenance={"decision": "flat native-only local reconstruction background"},
    )


def _background_result_manifest_record(result: BackgroundResult) -> dict:
    return {
        "strategy": result.strategy,
        "provider_role": result.provider_role,
        "prompt_id": result.prompt_id,
        "input_asset_refs": list(result.input_asset_refs),
        "output_asset_ref": result.artifact_path,
        "validation_status": result.validation_status,
        "provenance": result.provenance,
    }


def _source_background_is_flat_for_local_reconstruction(
    source_image_path: str | Path,
    foreground_bboxes: list[tuple[int, int, int, int]],
) -> bool:
    with Image.open(source_image_path) as source:
        rgb = source.convert("RGB")
        samples = _sample_flat_background_pixels(rgb, foreground_bboxes)
    if len(samples) < 12:
        return False
    avg = tuple(round(mean(pixel[index] for pixel in samples)) for index in range(3))
    return mean(_color_distance(pixel, avg) for pixel in samples) <= 6


def _estimate_flat_background_color(
    image: Image.Image,
    foreground_bboxes: list[tuple[int, int, int, int]],
) -> tuple[int, int, int]:
    samples = _sample_flat_background_pixels(image, foreground_bboxes)
    if not samples:
        return _estimate_background_color(image)
    return tuple(round(mean(pixel[index] for pixel in samples)) for index in range(3))


def _sample_flat_background_pixels(
    image: Image.Image,
    foreground_bboxes: list[tuple[int, int, int, int]],
) -> list[tuple[int, int, int]]:
    footer_top = _footer_top(image.size)
    step_x = max(1, image.width // 24)
    step_y = max(1, max(1, footer_top) // 16)
    inset = max(2, round(min(image.size) * 0.01))
    samples: list[tuple[int, int, int]] = []
    pixels = image.load()
    for y in range(inset, max(inset, footer_top - inset), step_y):
        for x in range(inset, max(inset, image.width - inset), step_x):
            if any(
                _point_inside_padded_bbox((x, y), bbox, padding=4) for bbox in foreground_bboxes
            ):
                continue
            samples.append(pixels[x, y])
    return samples


def _footer_top(size: tuple[int, int]) -> int:
    _, height = size
    return max(0, height - min(24, max(0, round(height * 0.08))))


def _point_inside_padded_bbox(
    point: tuple[int, int],
    bbox: tuple[int, int, int, int],
    *,
    padding: int,
) -> bool:
    x, y = point
    left, top, right, bottom = bbox
    return left - padding <= x < right + padding and top - padding <= y < bottom + padding


def _dedupe_native_shapes(shapes: list[NativeShapeSpec]) -> list[NativeShapeSpec]:
    deduped: list[NativeShapeSpec] = []
    for shape in shapes:
        if _bbox_overlaps_any_shape(shape.source_pixel_bbox, deduped, threshold=0.90):
            continue
        deduped.append(shape)
    return deduped


def _bbox_overlaps_any_shape(
    bbox: tuple[int, int, int, int],
    shapes: list[NativeShapeSpec],
    *,
    threshold: float = 0.72,
) -> bool:
    return any(_bbox_iou(bbox, shape.source_pixel_bbox) >= threshold for shape in shapes)


def _should_drop_bitmap_candidate(
    candidate: ForegroundCandidate,
    *,
    native_shapes: list[NativeShapeSpec],
    source_size: tuple[int, int],
    source_image: Image.Image,
    source_background: tuple[int, int, int],
) -> bool:
    bbox = candidate.source_pixel_bbox
    if _as_dict(candidate.provenance).get("detection") == "split_edge_spanning_difference":
        return False
    if _is_structural_container_bitmap_candidate(
        candidate,
        native_shapes=native_shapes,
    ):
        return True
    if native_shapes and _bbox_area_pixels(bbox) / float(source_size[0] * source_size[1]) >= 0.80:
        return True
    if _bbox_overlaps_any_shape(bbox, native_shapes):
        return True
    if _is_source_base_difference_candidate(candidate) and not _source_region_has_foreground_signal(
        source_image, bbox, source_background
    ):
        return True
    if _tiny_diff_fragment(candidate):
        return True
    if _line_like_bitmap_residual(candidate):
        return True
    if native_shapes and _edge_spanning_diff_band(bbox, source_size):
        return True
    if _edge_touching_source_diff_residual(candidate, source_size):
        return True
    if native_shapes and _bottom_source_diff_background_residual(candidate, source_size):
        return True
    return any(
        _tiny_bbox_inside_shape(bbox, shape.source_pixel_bbox)
        for shape in native_shapes
        if shape.provenance.get("fitter") != "large_card_container"
    )


def _is_structural_container_bitmap_candidate(
    candidate: ForegroundCandidate,
    *,
    native_shapes: list[NativeShapeSpec],
    min_child_count: int = 3,
    min_child_coverage_ratio: float = 0.25,
) -> bool:
    if not native_shapes:
        return False
    if candidate.classification not in {
        "complex_whole_visual",
        "bitmap_asset_candidate",
        "uncertain",
    }:
        return False
    if not _is_source_base_difference_candidate(candidate):
        return False
    candidate_area = _bbox_area_pixels(candidate.source_pixel_bbox)
    if candidate_area <= 0:
        return False
    child_shapes = [
        shape
        for shape in native_shapes
        if _bbox_contains_ratio(candidate.source_pixel_bbox, shape.source_pixel_bbox) >= 0.85
    ]
    if len(child_shapes) < min_child_count:
        return False
    child_coverage = _bbox_coverage_ratio(
        [shape.source_pixel_bbox for shape in child_shapes],
        (
            max(1, candidate.source_pixel_bbox[2]),
            max(1, candidate.source_pixel_bbox[3]),
        ),
    )
    # _bbox_coverage_ratio measures against page-like dimensions. Convert it back
    # to coverage within the candidate's own bbox.
    candidate_page_area = max(1, candidate.source_pixel_bbox[2] * candidate.source_pixel_bbox[3])
    child_area_in_page = child_coverage * candidate_page_area
    return child_area_in_page / float(candidate_area) >= min_child_coverage_ratio


def _native_shapes_with_source_scan_priority(
    shapes: list[NativeShapeSpec],
) -> list[NativeShapeSpec]:
    return sorted(
        shapes,
        key=lambda shape: (0 if _is_source_native_shape(shape) else 1,),
    )


def _drop_source_diff_native_fill_residuals(
    shapes: list[NativeShapeSpec],
    *,
    source_image: Image.Image,
) -> list[NativeShapeSpec]:
    source_scan_shapes = [shape for shape in shapes if _is_source_native_shape(shape)]
    if not source_scan_shapes:
        return shapes
    filtered: list[NativeShapeSpec] = []
    for shape in shapes:
        if _is_source_diff_native_fill_residual(shape, source_scan_shapes, source_image):
            continue
        filtered.append(shape)
    return filtered


def _is_source_diff_native_fill_residual(
    shape: NativeShapeSpec,
    source_scan_shapes: list[NativeShapeSpec],
    source_image: Image.Image,
) -> bool:
    if _is_source_native_shape(shape):
        return False
    for container in source_scan_shapes:
        if not container.fill_color:
            continue
        if not _bbox_contains(container.source_pixel_bbox, shape.source_pixel_bbox):
            continue
        if (
            _bbox_area_pixels(shape.source_pixel_bbox)
            / float(max(1, _bbox_area_pixels(container.source_pixel_bbox)))
            > 0.10
        ):
            continue
        fill_rgb = _hex_color_to_rgb(container.fill_color)
        if fill_rgb is None:
            continue
        if not _source_region_has_foreground_signal(
            source_image,
            shape.source_pixel_bbox,
            fill_rgb,
            threshold=24,
            min_fraction=0.02,
        ):
            return True
    return False


def _is_source_native_shape(shape: NativeShapeSpec) -> bool:
    candidate_id = str(shape.provenance.get("candidate_id", ""))
    return candidate_id.startswith("source-native-") or candidate_id.startswith("source-")


def _should_drop_native_shape_candidate(
    candidate: ForegroundCandidate,
    shape: NativeShapeSpec,
    source_size: tuple[int, int],
    *,
    source_image: Image.Image,
    source_background: tuple[int, int, int],
) -> bool:
    if not _is_source_base_difference_candidate(candidate):
        return False
    if not _source_region_has_foreground_signal(
        source_image,
        shape.source_pixel_bbox,
        source_background,
    ):
        return True
    if _bottom_source_diff_background_residual(candidate, source_size):
        return True
    if not _bbox_touches_page_edge(shape.source_pixel_bbox, source_size):
        return False
    bbox = shape.source_pixel_bbox
    width = max(0, bbox[2] - bbox[0])
    height = max(0, bbox[3] - bbox[1])
    if min(width, height) <= 2:
        return True
    return _bbox_area_pixels(bbox) <= 500


def _tiny_diff_fragment(candidate: ForegroundCandidate) -> bool:
    bbox = candidate.source_pixel_bbox
    width = max(0, bbox[2] - bbox[0])
    height = max(0, bbox[3] - bbox[1])
    if candidate.classification not in {
        "uncertain",
        "complex_whole_visual",
        "bitmap_asset_candidate",
    }:
        return False
    return _bbox_area_pixels(bbox) <= 500 or max(width, height) <= 24


def _line_like_bitmap_residual(candidate: ForegroundCandidate) -> bool:
    if not _is_source_base_difference_candidate(candidate):
        return False
    if candidate.classification not in {
        "complex_whole_visual",
        "bitmap_asset_candidate",
        "uncertain",
    }:
        return False
    bbox = candidate.source_pixel_bbox
    width = max(1, bbox[2] - bbox[0])
    height = max(1, bbox[3] - bbox[1])
    long_side = max(width, height)
    short_side = min(width, height)
    return short_side <= 16 and long_side / float(short_side) >= 12


def _edge_spanning_diff_band(
    bbox: tuple[int, int, int, int],
    source_size: tuple[int, int],
) -> bool:
    source_width, source_height = source_size
    left, top, right, bottom = bbox
    width_ratio = max(0, right - left) / float(max(1, source_width))
    height_ratio = max(0, bottom - top) / float(max(1, source_height))
    edge_margin = max(4, round(min(source_width, source_height) * 0.01))
    touches_vertical_edge = top <= edge_margin or bottom >= source_height - edge_margin
    return width_ratio >= 0.90 and height_ratio >= 0.15 and touches_vertical_edge


def _edge_touching_source_diff_residual(
    candidate: ForegroundCandidate,
    source_size: tuple[int, int],
) -> bool:
    if not _is_source_base_difference_candidate(candidate):
        return False
    if candidate.classification == "complex_whole_visual":
        return False
    area_ratio = _bbox_area_pixels(candidate.source_pixel_bbox) / float(
        max(1, source_size[0] * source_size[1])
    )
    return area_ratio <= 0.03 and _bbox_touches_page_edge(
        candidate.source_pixel_bbox,
        source_size,
    )


def _bottom_source_diff_background_residual(
    candidate: ForegroundCandidate,
    source_size: tuple[int, int],
) -> bool:
    if not _is_source_base_difference_candidate(candidate):
        return False
    _, source_height = source_size
    bbox = candidate.source_pixel_bbox
    height = max(0, bbox[3] - bbox[1])
    top_ratio = bbox[1] / float(max(1, source_height))
    height_ratio = height / float(max(1, source_height))
    return top_ratio >= 0.90 and height_ratio <= 0.08


def _source_region_has_foreground_signal(
    image: Image.Image,
    bbox: tuple[int, int, int, int],
    background: tuple[int, int, int],
    *,
    threshold: int = 28,
    min_fraction: float = 0.015,
) -> bool:
    left, top, right, bottom = _clamp_bbox_to_size(bbox, image.size)
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        return False
    signal = 0
    total = width * height
    pixels = image.load()
    for y in range(top, bottom):
        for x in range(left, right):
            if _color_distance(pixels[x, y], background) >= threshold:
                signal += 1
    return signal / float(total) >= min_fraction


def _clamp_bbox_to_size(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
) -> tuple[int, int, int, int]:
    width, height = size
    left, top, right, bottom = bbox
    return (
        max(0, min(width, left)),
        max(0, min(height, top)),
        max(0, min(width, right)),
        max(0, min(height, bottom)),
    )


def _color_distance(first: tuple[int, int, int], second: tuple[int, int, int]) -> int:
    return sum(abs(int(a) - int(b)) for a, b in zip(first[:3], second[:3]))


def _hex_color_to_rgb(value: str) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    color = value.strip().lstrip("#")
    if len(color) != 6:
        return None
    try:
        return int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)
    except ValueError:
        return None


def _is_source_base_difference_candidate(candidate: ForegroundCandidate) -> bool:
    provenance = candidate.provenance
    original_detection = provenance.get("original_detection")
    return provenance.get("detection") == "source_base_difference" or (
        isinstance(original_detection, dict)
        and original_detection.get("detection") == "source_base_difference"
    )


def _bbox_touches_page_edge(
    bbox: tuple[int, int, int, int],
    source_size: tuple[int, int],
) -> bool:
    source_width, source_height = source_size
    left, top, right, bottom = bbox
    edge_margin = max(4, round(min(source_width, source_height) * 0.01))
    return (
        left <= edge_margin
        or top <= edge_margin
        or right >= source_width - edge_margin
        or bottom >= source_height - edge_margin
    )


def _tiny_bbox_inside_shape(
    bbox: tuple[int, int, int, int],
    shape_bbox: tuple[int, int, int, int],
) -> bool:
    if not _bbox_contains(shape_bbox, bbox):
        return False
    return _bbox_area_pixels(bbox) / float(max(1, _bbox_area_pixels(shape_bbox))) <= 0.05


def _bbox_contains(
    outer: tuple[int, int, int, int],
    inner: tuple[int, int, int, int],
) -> bool:
    return (
        outer[0] <= inner[0]
        and outer[1] <= inner[1]
        and outer[2] >= inner[2]
        and outer[3] >= inner[3]
    )


def _bbox_area_pixels(bbox: tuple[int, int, int, int]) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _bbox_iou(
    first: tuple[int, int, int, int],
    second: tuple[int, int, int, int],
) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    first_area = max(0, first[2] - first[0]) * max(0, first[3] - first[1])
    second_area = max(0, second[2] - second[0]) * max(0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / float(union) if union else 0.0


def _bbox_contains_ratio(
    outer: tuple[int, int, int, int],
    inner: tuple[int, int, int, int],
) -> float:
    left = max(outer[0], inner[0])
    top = max(outer[1], inner[1])
    right = min(outer[2], inner[2])
    bottom = min(outer[3], inner[3])
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    return intersection / float(max(1, _bbox_area_pixels(inner)))


def _union_bbox(
    left: tuple[int, int, int, int],
    right: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    return (
        min(left[0], right[0]),
        min(left[1], right[1]),
        max(left[2], right[2]),
        max(left[3], right[3]),
    )


def _box_distance_pixels(
    left: tuple[int, int, int, int],
    right: tuple[int, int, int, int],
) -> int:
    horizontal_gap = max(0, max(left[0], right[0]) - min(left[2], right[2]))
    vertical_gap = max(0, max(left[1], right[1]) - min(left[3], right[3]))
    return max(horizontal_gap, vertical_gap)


def _source_component_is_line(width: int, height: int, fill_ratio: float) -> bool:
    long_side = max(width, height)
    short_side = max(1, min(width, height))
    return (long_side / short_side >= 1.8 and fill_ratio <= 0.30) or (
        long_side >= 30 and fill_ratio <= 0.18
    )


def _source_component_is_box_outline(
    points: set[tuple[int, int]],
    bbox: tuple[int, int, int, int],
) -> bool:
    left, top, right, bottom = bbox
    width = max(1, right - left)
    height = max(1, bottom - top)
    band = max(2, round(min(width, height) * 0.12))
    top_hits = len({x for x, y in points if top <= y < min(bottom, top + band)})
    bottom_hits = len({x for x, y in points if max(top, bottom - band) <= y < bottom})
    left_hits = len({y for x, y in points if left <= x < min(right, left + band)})
    right_hits = len({y for x, y in points if max(left, right - band) <= x < right})
    return (
        top_hits / float(width) >= 0.65
        and bottom_hits / float(width) >= 0.65
        and left_hits / float(height) >= 0.55
        and right_hits / float(height) >= 0.55
    )


def _source_line_endpoints(
    component: list[tuple[int, int]],
) -> tuple[tuple[int, int], tuple[int, int]]:
    points = sorted(component)
    first = min(points, key=lambda point: point[0] + point[1])
    second = max(points, key=lambda point: point[0] + point[1])
    if abs(first[0] - second[0]) < abs(first[1] - second[1]):
        first = min(points, key=lambda point: point[1])
        second = max(points, key=lambda point: point[1])
    else:
        first = min(points, key=lambda point: point[0])
        second = max(points, key=lambda point: point[0])
    return first, second


def _source_component_has_rounded_corners(
    points: set[tuple[int, int]],
    bbox: tuple[int, int, int, int],
) -> bool:
    return _source_component_sparse_corner_count(points, bbox) >= 1


def _source_component_sparse_corner_count(
    points: set[tuple[int, int]],
    bbox: tuple[int, int, int, int],
) -> int:
    left, top, right, bottom = bbox
    width = right - left
    height = bottom - top
    corner = max(3, round(min(width, height) * 0.18))
    corner_regions = (
        (range(left, min(right, left + corner)), range(top, min(bottom, top + corner))),
        (range(max(left, right - corner), right), range(top, min(bottom, top + corner))),
        (range(left, min(right, left + corner)), range(max(top, bottom - corner), bottom)),
        (range(max(left, right - corner), right), range(max(top, bottom - corner), bottom)),
    )
    sparse_corners = 0
    for xs, ys in corner_regions:
        total = 0
        present = 0
        for x in xs:
            for y in ys:
                total += 1
                if (x, y) in points:
                    present += 1
        if total and present / float(total) < 0.75:
            sparse_corners += 1
    return sparse_corners


def _repair_validation_report(page: PageManifest) -> ValidationReport:
    issues = []
    fallback_asset_ids = {
        asset.asset_id
        for asset in page.bitmap_assets
        if asset.provenance.get("fallback") == "source_crop_after_provider_qa"
    }
    for attempt in page.repair_attempts:
        if attempt.status != "failed":
            continue
        if attempt.target_id in fallback_asset_ids:
            continue
        code = (
            "repair_limit_exceeded"
            if attempt.reason.startswith("repair_limit_exceeded")
            else "repair_failed"
        )
        issues.append(
            ValidationIssue(
                code=code,
                message=f"asset repair failed: {attempt.reason}",
                slide_id=page.slide_id,
                details={
                    "target_id": attempt.target_id,
                    "attempt_index": attempt.attempt_index,
                    "reason": attempt.reason,
                    "provider_role": attempt.provider_role,
                },
            )
        )
    return ValidationReport(
        status="failed" if issues else "passed",
        checked_pages=1,
        issues=issues,
    )


def _text_validation_report(page: PageManifest) -> ValidationReport:
    issues = []
    if page.provenance.get("chosen_background_kind") == "source_raster_guardrail":
        issues.append(
            ValidationIssue(
                code="source_raster_guardrail_degraded",
                message="text editability was dropped because OCR/layout was unreliable",
                slide_id=page.slide_id,
                details={
                    "chosen_background_kind": "source_raster_guardrail",
                    "text_validation_status": page.provenance.get("text_validation_status"),
                    "source_raster_guardrail": page.provenance.get("source_raster_guardrail", {}),
                    "warning_count": len(page.provenance.get("text_issues", [])),
                },
            )
        )
    for raw_issue in page.provenance.get("text_issues", []):
        if not isinstance(raw_issue, dict):
            continue
        if raw_issue.get("severity") == "warning":
            continue
        code = str(raw_issue.get("code") or "text_validation_failed")
        issues.append(
            ValidationIssue(
                code=code,
                message=f"text extraction validation failed: {code}",
                slide_id=page.slide_id,
                details=dict(raw_issue),
            )
        )
    if page.provenance.get("text_validation_status") == "failed" and not issues:
        issues.append(
            ValidationIssue(
                code="text_validation_failed",
                message="text extraction validation failed",
                slide_id=page.slide_id,
            )
        )
    return ValidationReport(
        status="failed" if issues else "passed",
        checked_pages=1,
        issues=issues,
    )


def _bitmap_coverage_validation_report(page: PageManifest) -> ValidationReport:
    source_preserved_assets = [
        asset
        for asset in page.bitmap_assets
        if asset.provenance.get("asset_strategy") == "masked_source_element"
    ]
    if not source_preserved_assets:
        return ValidationReport(status="passed", checked_pages=1, issues=[])

    page_area = max(1, page.source_image_size[0] * page.source_image_size[1])
    largest_asset = max(
        source_preserved_assets,
        key=lambda asset: _source_preserved_asset_effective_area_ratio(
            asset, page.source_image_size
        ),
    )
    largest_bbox = _clamp_bbox_to_size(largest_asset.source_pixel_bbox, page.source_image_size)
    largest_bbox_ratio = _bbox_area_pixels(largest_bbox) / float(page_area)
    largest_ratio = _source_preserved_asset_effective_area_ratio(
        largest_asset, page.source_image_size
    )
    combined_bbox_ratio = _bbox_coverage_ratio(
        [asset.source_pixel_bbox for asset in source_preserved_assets],
        page.source_image_size,
    )
    combined_visible_ratio = min(
        1.0,
        sum(
            _source_preserved_asset_effective_area_ratio(asset, page.source_image_size)
            for asset in source_preserved_assets
        ),
    )
    combined_ratio = min(combined_bbox_ratio, combined_visible_ratio)
    structure_count = len(page.native_shapes) + len(page.text_boxes)

    details = {
        "bitmap_asset_count": len(page.bitmap_assets),
        "source_preserved_bitmap_asset_count": len(source_preserved_assets),
        "combined_bitmap_asset_coverage_ratio": round(combined_ratio, 4),
        "combined_bitmap_asset_bbox_coverage_ratio": round(combined_bbox_ratio, 4),
        "combined_bitmap_asset_visible_area_ratio": round(combined_visible_ratio, 4),
        "largest_asset_area_ratio": round(largest_ratio, 4),
        "largest_asset_bbox_area_ratio": round(largest_bbox_ratio, 4),
        "largest_asset_id": largest_asset.asset_id,
        "native_shape_count": len(page.native_shapes),
        "text_box_count": len(page.text_boxes),
    }
    issues: list[ValidationIssue] = []
    if largest_ratio >= 0.80:
        issues.append(
            ValidationIssue(
                code="oversized_bitmap_asset_coverage",
                message="a source-preserved bitmap asset covers most of the slide",
                slide_id=page.slide_id,
                details=details,
            )
        )
    elif combined_ratio >= 0.85 and structure_count < 3:
        issues.append(
            ValidationIssue(
                code="excessive_bitmap_asset_coverage",
                message="source-preserved bitmap assets dominate the slide without enough editable structure",
                slide_id=page.slide_id,
                details=details,
            )
        )
    elif combined_ratio >= 0.65 and not _has_split_row_level_bitmap_structure(
        source_preserved_assets,
        largest_ratio=largest_ratio,
        structure_count=structure_count,
    ):
        issues.append(
            ValidationIssue(
                code="high_bitmap_asset_coverage",
                message="source-preserved bitmap assets cover a large part of the slide",
                slide_id=page.slide_id,
                severity="warning",
                details=details,
            )
        )
    return ValidationReport(
        status="failed" if issues else "passed",
        checked_pages=1,
        issues=issues,
    )


def _source_preserved_asset_effective_area_ratio(
    asset: BitmapAssetSpec,
    source_image_size: tuple[int, int],
) -> float:
    visible_ratio = asset.provenance.get("alpha_visible_area_ratio")
    if (
        asset.provenance.get("background_difference_alpha") is True
        and isinstance(visible_ratio, (int, float))
        and 0.0 <= float(visible_ratio) <= 1.0
    ):
        return float(visible_ratio)
    page_area = max(1, source_image_size[0] * source_image_size[1])
    bbox = _clamp_bbox_to_size(asset.source_pixel_bbox, source_image_size)
    return _bbox_area_pixels(bbox) / float(page_area)


def _has_split_row_level_bitmap_structure(
    source_preserved_assets: list[BitmapAssetSpec],
    *,
    largest_ratio: float,
    structure_count: int,
) -> bool:
    split_row_structure = (
        len(source_preserved_assets) >= 3 and largest_ratio <= 0.35 and structure_count >= 3
    )
    dense_infographic_structure = (
        len(source_preserved_assets) >= 3 and largest_ratio <= 0.60 and structure_count >= 12
    )
    return split_row_structure or dense_infographic_structure


def _visual_text_coverage_issues(
    text_boxes: list,
    *,
    visual_text_candidates: list[tuple[int, int, int, int]],
    non_blocking_visual_text_candidates: set[tuple[int, int, int, int]] | None = None,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    covered_boxes = [text_box.source_pixel_bbox for text_box in text_boxes]
    non_blocking = non_blocking_visual_text_candidates or set()
    for candidate_bbox in visual_text_candidates:
        if candidate_bbox in non_blocking:
            continue
        if any(
            _text_box_covers_visual_candidate(text_bbox, candidate_bbox)
            for text_bbox in covered_boxes
        ):
            continue
        issues.append(
            {
                "code": "visual_text_candidate_missing_ocr_text",
                "source_pixel_bbox": candidate_bbox,
            }
        )
    return issues


def _focused_recovery_candidate_bboxes(
    *,
    text_boxes: list,
    text_issues: list[dict[str, Any]],
    visual_text_candidates: list[tuple[int, int, int, int]],
    quality_gate_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    if not text_boxes and visual_text_candidates and _ocr_issues_are_only_spurious(text_issues):
        visual_candidates = _focused_recovery_visual_text_candidates(
            visual_text_candidates,
            source_image_size,
        )
        summary_candidates = (
            _summary_slide_recovery_bboxes(source_image_size)
            if _should_use_summary_slide_recovery_bboxes(
                visual_text_candidates,
                source_image_size,
            )
            else []
        )
        return _dedupe_bboxes_preserve_order(
            [
                *summary_candidates,
                *visual_candidates,
            ]
        )
    covered_boxes = [
        text_box.source_pixel_bbox
        for text_box in text_boxes
        if not _text_box_has_approximate_ocr_layout(text_box)
    ]
    return [
        candidate_bbox
        for candidate_bbox in quality_gate_candidates
        if not any(
            _text_box_covers_visual_candidate(text_bbox, candidate_bbox)
            for text_bbox in covered_boxes
        )
    ]


def _focused_recovery_visual_text_candidates(
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    page_area = max(1, source_image_size[0] * source_image_size[1])
    image_height = max(1, source_image_size[1])
    return [
        bbox
        for bbox in visual_text_candidates
        if _bbox_area_pixels(bbox) / float(page_area) <= 0.12
        and (bbox[3] - bbox[1]) / float(image_height) <= 0.18
    ]


def _should_use_summary_slide_recovery_bboxes(
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> bool:
    page_area = max(1, source_image_size[0] * source_image_size[1])
    if any(_bbox_area_pixels(bbox) / float(page_area) > 0.20 for bbox in visual_text_candidates):
        return False
    return _has_summary_like_visual_text_candidate_pattern(
        visual_text_candidates,
        source_image_size,
    )


def _has_summary_like_visual_text_candidate_pattern(
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> bool:
    width, height = source_image_size
    if len(visual_text_candidates) < 3 or width <= 0 or height <= 0:
        return False
    has_upper_summary_line = any(
        width * 0.24 <= bbox[0]
        and bbox[2] <= width * 0.78
        and height * 0.18 <= bbox[1] <= height * 0.36
        for bbox in visual_text_candidates
    )
    has_body_line = any(
        width * 0.20 <= bbox[0]
        and bbox[2] <= width * 0.82
        and height * 0.42 <= bbox[1] <= height * 0.62
        for bbox in visual_text_candidates
    )
    has_bottom_helper_or_qr_line = any(
        bbox[0] >= width * 0.72 and bbox[1] >= height * 0.72 for bbox in visual_text_candidates
    )
    return has_upper_summary_line and has_body_line and has_bottom_helper_or_qr_line


def _summary_slide_recovery_bboxes(
    source_image_size: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    width, height = source_image_size
    return [
        (round(width * 0.28), round(height * 0.22), round(width * 0.72), round(height * 0.29)),
        (round(width * 0.27), round(height * 0.32), round(width * 0.76), round(height * 0.46)),
        (round(width * 0.25), round(height * 0.48), round(width * 0.80), round(height * 0.532)),
        (round(width * 0.30), round(height * 0.53), round(width * 0.75), round(height * 0.60)),
        (round(width * 0.81), round(height * 0.92), round(width * 0.97), round(height * 0.98)),
    ]


def _dedupe_bboxes_preserve_order(
    bboxes: list[tuple[int, int, int, int]],
    *,
    iou_threshold: float = 0.70,
) -> list[tuple[int, int, int, int]]:
    deduped: list[tuple[int, int, int, int]] = []
    for bbox in bboxes:
        if any(_bbox_iou(bbox, existing) >= iou_threshold for existing in deduped):
            continue
        deduped.append(bbox)
    return deduped


def _ocr_issues_are_only_spurious(issues: list[dict[str, Any]]) -> bool:
    if not issues:
        return False
    codes = {str(issue.get("code", "")) for issue in issues}
    return bool(codes) and codes <= {"ignored_spurious_ocr", "no_ocr_text_detected"}


def _filter_unanchored_approximate_text_boxes(
    text_boxes: list[TextBoxSpec],
    *,
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> tuple[list[TextBoxSpec], list[dict[str, Any]]]:
    if len(visual_text_candidates) < 3:
        return text_boxes, []
    kept: list[TextBoxSpec] = []
    issues: list[dict[str, Any]] = []
    for text_box in text_boxes:
        if not _text_box_has_approximate_ocr_layout(text_box):
            kept.append(text_box)
            continue
        if _approximate_text_box_is_anchored(
            text_box.source_pixel_bbox,
            visual_text_candidates,
            source_image_size,
            text=text_box.text,
        ):
            kept.append(text_box)
            continue
        if _is_right_side_spec_stack_text_box(
            text_box,
            text_boxes,
            source_image_size,
            visual_text_candidates=visual_text_candidates,
        ):
            kept.append(text_box)
            continue
        issues.append(
            {
                "code": "unanchored_approximate_ocr",
                "severity": "warning",
                "ocr_text": text_box.text,
                "source_pixel_bbox": text_box.source_pixel_bbox,
            }
        )
    return kept, issues


def _is_right_side_spec_stack_text_box(
    text_box: TextBoxSpec,
    text_boxes: list[TextBoxSpec],
    source_image_size: tuple[int, int],
    *,
    visual_text_candidates: list[tuple[int, int, int, int]],
) -> bool:
    width, height = source_image_size
    if width <= 0 or height <= 0:
        return False
    left, top, right, bottom = text_box.source_pixel_bbox
    center_x = (left + right) / 2.0
    box_height = bottom - top
    if center_x < width * 0.68 or box_height > height * 0.06:
        return False
    stack_boxes = [
        other
        for other in text_boxes
        if _text_box_has_approximate_ocr_layout(other)
        and _right_side_spec_stack_candidate(other.source_pixel_bbox, source_image_size)
    ]
    if len(stack_boxes) < 3:
        return False
    same_column = [
        other
        for other in stack_boxes
        if abs(((other.source_pixel_bbox[0] + other.source_pixel_bbox[2]) / 2.0) - center_x)
        <= width * 0.095
    ]
    if text_box not in same_column:
        return False
    if not _right_side_spec_stack_has_visual_column_anchors(
        same_column,
        visual_text_candidates,
        source_image_size,
    ):
        return False
    if len(same_column) >= 4:
        return True
    ordered = sorted(same_column, key=lambda item: item.source_pixel_bbox[1])
    neighbor_centers = [
        (item.source_pixel_bbox[1] + item.source_pixel_bbox[3]) / 2.0 for item in ordered
    ]
    return (
        len(neighbor_centers) >= 3
        and max(neighbor_centers) - min(neighbor_centers) <= height * 0.22
    )


def _right_side_spec_stack_has_visual_column_anchors(
    stack_boxes: list[TextBoxSpec],
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> bool:
    width, height = source_image_size
    if len(visual_text_candidates) < 3 or width <= 0 or height <= 0:
        return False
    anchored_count = 0
    for text_box in stack_boxes:
        if _approximate_text_box_is_anchored(
            text_box.source_pixel_bbox,
            visual_text_candidates,
            source_image_size,
            text=text_box.text,
        ):
            anchored_count += 1
    return anchored_count >= min(2, len(stack_boxes))


def _right_side_spec_stack_candidate(
    bbox: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
) -> bool:
    width, height = source_image_size
    left, top, right, bottom = bbox
    box_width = right - left
    box_height = bottom - top
    center_x = (left + right) / 2.0
    return (
        center_x >= width * 0.68
        and width * 0.02 <= box_width <= width * 0.22
        and height * 0.015 <= box_height <= height * 0.06
        and height * 0.12 <= top <= height * 0.88
    )


def _approximate_text_box_is_anchored(
    bbox: tuple[int, int, int, int],
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
    *,
    text: str = "",
) -> bool:
    width, height = source_image_size
    if _is_large_top_text_box(bbox, width, height):
        return True
    if _is_small_top_approximate_text_box(bbox, width, height):
        return False
    return any(
        _visual_candidate_can_anchor_text(text, candidate, source_image_size)
        and _visual_candidate_size_matches_text_bbox(bbox, candidate, source_image_size)
        and (_bbox_iou(bbox, candidate) >= 0.05 or _bbox_center_inside(bbox, candidate))
        for candidate in visual_text_candidates
    )


def _visual_candidate_size_matches_text_bbox(
    bbox: tuple[int, int, int, int],
    candidate: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
) -> bool:
    image_width, image_height = source_image_size
    bbox_width = max(1, bbox[2] - bbox[0])
    bbox_height = max(1, bbox[3] - bbox[1])
    candidate_width = max(1, candidate[2] - candidate[0])
    candidate_height = max(1, candidate[3] - candidate[1])
    if _is_large_top_text_box(bbox, image_width, image_height):
        return True
    max_width = max(bbox_width * 3.0, bbox_width + image_width * 0.08)
    max_height = max(bbox_height * 2.5, bbox_height + image_height * 0.04)
    return candidate_width <= max_width and candidate_height <= max_height


def _visual_candidate_can_anchor_text(
    text: str,
    candidate: tuple[int, int, int, int],
    source_image_size: tuple[int, int],
) -> bool:
    image_width, image_height = source_image_size
    if image_width <= 0 or image_height <= 0:
        return False
    left, top, right, bottom = candidate
    width = max(0, right - left)
    height = max(0, bottom - top)
    if width <= 0 or height <= 0:
        return False
    aspect = width / float(height)
    meaningful_len = len([char for char in text if char.isalnum() or "\u3400" <= char <= "\u9fff"])
    if _is_large_top_text_box(candidate, image_width, image_height):
        return meaningful_len >= 6
    if _is_short_section_label_text(text):
        return width >= image_width * 0.04 and aspect >= 1.35 and height <= image_height * 0.10
    if aspect < 1.6:
        return False
    if meaningful_len >= 6:
        return width >= image_width * 0.06 and height <= image_height * 0.12
    return width >= image_width * 0.05 and aspect >= 2.0 and height <= image_height * 0.09


def _is_short_section_label_text(text: str) -> bool:
    stripped = str(text).strip()
    meaningful = "".join(
        char for char in stripped if char.isalnum() or "\u3400" <= char <= "\u9fff"
    )
    cjk_count = sum(1 for char in meaningful if "\u3400" <= char <= "\u9fff")
    return 2 <= cjk_count <= 5 and meaningful.endswith(("域", "区", "层", "类", "项", "栏"))


def _is_large_top_text_box(
    bbox: tuple[int, int, int, int],
    image_width: int,
    image_height: int,
) -> bool:
    left, top, right, bottom = bbox
    return (
        top <= image_height * 0.12 and (right - left) >= image_width * 0.25 and (bottom - top) >= 20
    )


def _is_small_top_approximate_text_box(
    bbox: tuple[int, int, int, int],
    image_width: int,
    image_height: int,
) -> bool:
    left, top, right, bottom = bbox
    return (
        top <= image_height * 0.12
        and (bottom - top) <= max(18, image_height * 0.025)
        and (right - left) <= image_width * 0.18
    )


def _is_substantial_unanchored_approximate_text_box(
    text_box: TextBoxSpec,
    source_image_size: tuple[int, int],
) -> bool:
    image_width, image_height = source_image_size
    if image_width <= 0 or image_height <= 0:
        return False
    left, top, right, bottom = text_box.source_pixel_bbox
    box_width = max(0, right - left)
    box_height = max(0, bottom - top)
    if _is_small_top_approximate_text_box(text_box.source_pixel_bbox, image_width, image_height):
        return False
    if box_width < max(72, image_width * 0.04) or box_height < max(18, image_height * 0.018):
        return False
    meaningful_len = len("".join(char for char in text_box.text if char.isalnum()))
    if meaningful_len >= 8 and box_width >= image_width * 0.05:
        return True
    return box_width >= image_width * 0.08 and box_height >= image_height * 0.025


def _bbox_center_inside(
    bbox: tuple[int, int, int, int],
    candidate: tuple[int, int, int, int],
) -> bool:
    center_x = (bbox[0] + bbox[2]) / 2.0
    center_y = (bbox[1] + bbox[3]) / 2.0
    horizontal_padding = max(6, round((candidate[2] - candidate[0]) * 0.08))
    vertical_padding = max(6, round((candidate[3] - candidate[1]) * 0.18))
    return (
        candidate[0] - horizontal_padding <= center_x <= candidate[2] + horizontal_padding
        and candidate[1] - vertical_padding <= center_y <= candidate[3] + vertical_padding
    )


def _recover_visual_text_candidates(
    *,
    source_image_path: str | Path,
    source_image_size: tuple[int, int],
    text_boxes: list,
    uncovered_candidates: list[tuple[int, int, int, int]],
    ocr_provider: OCRProvider,
    crop_dir: str | Path,
    ignored_noise_candidates: set[tuple[int, int, int, int]] | None = None,
    min_confidence: float = 0.75,
) -> list[TextBoxSpec]:
    crop_root = Path(crop_dir)
    crop_root.mkdir(parents=True, exist_ok=True)
    recovered: list[TextBoxSpec] = []
    with Image.open(source_image_path) as source:
        source_rgb = source.convert("RGB")
        for index, candidate_bbox in enumerate(uncovered_candidates, start=1):
            crop_path = crop_root / f"visual-text-candidate-{index:03d}.png"
            source_rgb.crop(candidate_bbox).save(crop_path)
            try:
                crop_ocr = ocr_provider.extract_text(str(crop_path))
            except (ProviderError, ProviderTimeoutError):
                continue
            ocr_item = _best_recovered_ocr_item(crop_ocr.items, min_confidence=min_confidence)
            if ocr_item is None:
                if crop_ocr.items and all(
                    _is_recovered_ocr_noise_text(item.text)
                    for item in crop_ocr.items
                    if item.text.strip()
                ):
                    if ignored_noise_candidates is not None:
                        ignored_noise_candidates.add(candidate_bbox)
                continue
            if _recovered_ocr_duplicates_existing_text(
                ocr_item.text,
                candidate_bbox,
                [*text_boxes, *recovered],
            ):
                if ignored_noise_candidates is not None:
                    ignored_noise_candidates.add(candidate_bbox)
                continue
            recovered.append(
                _recovered_text_box_from_candidate(
                    candidate_bbox,
                    ocr_item,
                    source_image_size=source_image_size,
                    text_boxes=text_boxes,
                )
            )
    return recovered


def _remove_approximate_text_boxes_replaced_by_focused_recovery(
    text_boxes: list[TextBoxSpec],
    recovered_text_boxes: list[TextBoxSpec],
) -> list[TextBoxSpec]:
    if not recovered_text_boxes:
        return text_boxes
    filtered: list[TextBoxSpec] = []
    for text_box in text_boxes:
        if not _text_box_has_approximate_ocr_layout(text_box):
            filtered.append(text_box)
            continue
        if _is_replaced_by_focused_recovery(text_box, recovered_text_boxes):
            continue
        filtered.append(text_box)
    return filtered


def _is_replaced_by_focused_recovery(
    text_box: TextBoxSpec,
    recovered_text_boxes: list[TextBoxSpec],
) -> bool:
    original_text = _normalize_text_for_duplicate_check(text_box.text)
    for recovered in recovered_text_boxes:
        recovered_text = _normalize_text_for_duplicate_check(recovered.text)
        if not recovered_text:
            continue
        if original_text and (
            original_text == recovered_text
            or original_text in recovered_text
            or recovered_text in original_text
        ):
            continue
        if _text_box_covers_visual_candidate(
            text_box.source_pixel_bbox, recovered.source_pixel_bbox
        ):
            return True
        if _approximate_text_box_is_near_focused_recovery(
            text_box.source_pixel_bbox,
            recovered.source_pixel_bbox,
        ):
            return True
    return False


def _approximate_text_box_is_near_focused_recovery(
    text_bbox: tuple[int, int, int, int],
    recovered_bbox: tuple[int, int, int, int],
) -> bool:
    text_width = max(1, text_bbox[2] - text_bbox[0])
    recovered_width = max(1, recovered_bbox[2] - recovered_bbox[0])
    text_height = max(1, text_bbox[3] - text_bbox[1])
    recovered_height = max(1, recovered_bbox[3] - recovered_bbox[1])
    horizontal_overlap = _horizontal_overlap_ratio(text_bbox, recovered_bbox)
    text_center_x = (text_bbox[0] + text_bbox[2]) / 2.0
    recovered_center_x = (recovered_bbox[0] + recovered_bbox[2]) / 2.0
    text_center_y = (text_bbox[1] + text_bbox[3]) / 2.0
    recovered_center_y = (recovered_bbox[1] + recovered_bbox[3]) / 2.0
    return (
        horizontal_overlap >= 0.65
        and abs(text_center_x - recovered_center_x) <= max(text_width, recovered_width) * 0.18
        and abs(text_center_y - recovered_center_y) <= max(text_height, recovered_height) * 1.25
    )


def _horizontal_overlap_ratio(
    first: tuple[int, int, int, int],
    second: tuple[int, int, int, int],
) -> float:
    overlap = min(first[2], second[2]) - max(first[0], second[0])
    if overlap <= 0:
        return 0.0
    first_width = max(1, first[2] - first[0])
    second_width = max(1, second[2] - second[0])
    return overlap / float(min(first_width, second_width))


def _best_recovered_ocr_item(
    items: list[OCRTextItem],
    *,
    min_confidence: float = 0.75,
) -> OCRTextItem | None:
    text_items = [
        item
        for item in items
        if item.text.strip()
        and item.confidence >= min_confidence
        and not _is_recovered_ocr_noise_text(item.text)
    ]
    if not text_items:
        return None
    return max(text_items, key=lambda item: (item.confidence, len(item.text.strip())))


def _is_recovered_ocr_noise_text(text: str) -> bool:
    stripped = text.strip()
    if not stripped:
        return True
    meaningful = [
        char
        for char in stripped
        if not char.isspace() and char not in ".,;:!?，。；：！？、·-—_()（）[]【】{}<>《》/\\|"
    ]
    if not meaningful:
        return True
    unique_meaningful = set(meaningful)
    digit_count = sum(1 for char in meaningful if char.isdigit())
    cjk_count = sum(1 for char in meaningful if "\u3400" <= char <= "\u9fff")
    alpha_count = sum(
        1 for char in meaningful if char.isalpha() and not ("\u3400" <= char <= "\u9fff")
    )
    if cjk_count >= 3 and len(unique_meaningful) <= 2:
        return True
    if "输入文本" in stripped:
        return True
    if "文本内容" in stripped:
        return True
    if re.search(r"用户需求", stripped) and re.search(r"^\s*\d+[.、]", stripped):
        return True
    if len(stripped) >= 20 and len(unique_meaningful) <= 2:
        return True
    if len(stripped) >= 20 and digit_count / float(len(meaningful)) >= 0.85 and cjk_count == 0:
        return True
    if cjk_count == 0 and alpha_count == 0 and digit_count > 0 and len(unique_meaningful) <= 2:
        return True
    if _is_likely_repetitive_hallucinated_text(stripped):
        return True
    return False


def _recovered_ocr_duplicates_existing_text(
    text: str,
    candidate_bbox: tuple[int, int, int, int],
    text_boxes: list,
) -> bool:
    normalized = _normalize_text_for_duplicate_check(text)
    if not normalized:
        return True
    for text_box in text_boxes:
        existing_text = _normalize_text_for_duplicate_check(getattr(text_box, "text", ""))
        if not existing_text:
            continue
        if (
            normalized != existing_text
            and normalized not in existing_text
            and existing_text not in normalized
        ):
            continue
        existing_bbox = text_box.source_pixel_bbox
        if (
            _bbox_iou(candidate_bbox, existing_bbox) >= 0.05
            or _bbox_contains_ratio(candidate_bbox, existing_bbox) >= 0.35
            or _bbox_contains_ratio(existing_bbox, candidate_bbox) >= 0.35
        ):
            return True
    return False


def _normalize_text_for_duplicate_check(text: str) -> str:
    return "".join(
        char for char in str(text).lower() if char.isalnum() or "\u3400" <= char <= "\u9fff"
    )


def _recovered_text_box_from_candidate(
    candidate_bbox: tuple[int, int, int, int],
    ocr_item: OCRTextItem,
    *,
    source_image_size: tuple[int, int],
    text_boxes: list,
) -> TextBoxSpec:
    x1, y1, x2, y2 = candidate_bbox
    style_reference = _matching_recovered_text_style(
        ocr_item.text.strip(),
        candidate_bbox,
        text_boxes,
    )
    font_size = style_reference.get("font_size") or _font_size_points_from_source_pixel_height(
        y2 - y1,
        source_image_size[1],
    )
    font_size = _cap_recovered_text_font_size(
        ocr_item.text.strip(),
        candidate_bbox,
        source_image_size=source_image_size,
        font_size=font_size,
    )
    return TextBoxSpec(
        text=ocr_item.text.strip(),
        source_pixel_bbox=candidate_bbox,
        source_pixel_polygon=((x1, y1), (x2, y1), (x2, y2), (x1, y2)),
        font_family=style_reference.get("font_family")
        or ("Microsoft YaHei" if _contains_cjk_text(ocr_item.text) else "Arial"),
        font_size=font_size,
        color_hex=style_reference.get("color_hex") or ocr_item.color_hex or "#000000",
        alignment=ocr_item.alignment,
        style_hints={
            **dict(ocr_item.style_hints),
            "recovered_from_visual_candidate": True,
        },
        provenance={
            "content_source": "focused_crop_ocr",
            "layout_source": "visual_text_candidate",
            "ocr_confidence": ocr_item.confidence,
        },
    )


def _cap_recovered_text_font_size(
    text: str,
    candidate_bbox: tuple[int, int, int, int],
    *,
    source_image_size: tuple[int, int],
    font_size: float,
) -> float:
    _x1, y1, _x2, y2 = candidate_bbox
    _source_width, source_height = source_image_size
    meaningful_len = len([char for char in text if char.isalnum() or "\u3400" <= char <= "\u9fff"])
    box_height_ratio = (y2 - y1) / float(max(1, source_height))
    if meaningful_len >= 24 and box_height_ratio >= 0.08:
        return min(font_size, 22.0)
    return font_size


def _should_use_source_raster_guardrail(
    *,
    text_boxes: list[TextBoxSpec],
    text_issues: list[dict[str, Any]],
    source_image_size: tuple[int, int] | None = None,
) -> bool:
    if not text_boxes:
        return False
    if any(issue.get("code") == "unreliable_ocr_layout" for issue in text_issues):
        return True
    return False


def _should_use_text_editable_source_preserving_fast_path(
    *,
    text_boxes: list[TextBoxSpec],
    visual_text_candidates: list[tuple[int, int, int, int]],
    text_issues: list[dict[str, Any]],
) -> bool:
    # This legacy fast path preserves visual fidelity by keeping the source slide
    # as a full-slide image and adding low-opacity OCR text. That is useful as a
    # degraded diagnostic artifact, but it is not an editable reconstruction.
    # The normal pipeline must try clean backgrounds, foreground planning, native
    # shapes, and asset sheets first.
    return False


def _source_preserving_low_opacity_text_boxes(
    text_boxes: list[TextBoxSpec],
    *,
    opacity: float = 0.1,
) -> list[TextBoxSpec]:
    return [
        replace(
            text_box,
            opacity=opacity,
            style_hints={
                **dict(text_box.style_hints),
                "source_preserving_overlay": True,
            },
            provenance={
                **dict(text_box.provenance),
                "rendering_strategy": "source_preserving_low_opacity_overlay",
            },
        )
        for text_box in text_boxes
    ]


def _suspicious_tall_short_approximate_text_count(text_boxes: list[TextBoxSpec]) -> int:
    count = 0
    for text_box in text_boxes:
        if not _text_box_has_approximate_ocr_layout(text_box):
            continue
        left, top, right, bottom = text_box.source_pixel_bbox
        height = bottom - top
        meaningful_len = len("".join(char for char in text_box.text if char.isalnum()))
        if height >= 55 and meaningful_len <= 12:
            count += 1
    return count


def _has_fragmented_top_approximate_ocr_layout(
    text_boxes: list[TextBoxSpec],
    source_image_size: tuple[int, int],
) -> bool:
    width, height = source_image_size
    if width <= 0 or height <= 0:
        return False
    top_fragment_count = 0
    for text_box in text_boxes:
        if not _text_box_has_approximate_ocr_layout(text_box):
            continue
        left, top, right, bottom = text_box.source_pixel_bbox
        box_width = max(0, right - left)
        box_height = max(0, bottom - top)
        if top > height * 0.25:
            continue
        if box_width > width * 0.16:
            continue
        if box_height > height * 0.08:
            continue
        top_fragment_count += 1
    return top_fragment_count >= 3


def _source_raster_guardrail_text_boxes(
    text_boxes: list[TextBoxSpec],
    *,
    source_image_size: tuple[int, int],
) -> list[TextBoxSpec]:
    return []


def _text_box_has_approximate_ocr_layout(text_box: TextBoxSpec) -> bool:
    provenance = text_box.provenance.get("ocr_provenance")
    return isinstance(provenance, dict) and bool(provenance.get("approximate_layout"))


def _matching_recovered_text_style(
    text: str,
    candidate_bbox: tuple[int, int, int, int],
    text_boxes: list,
) -> dict[str, Any]:
    if not text_boxes:
        return {}
    candidate_center_x = (candidate_bbox[0] + candidate_bbox[2]) / 2.0
    comparable = []
    for text_box in text_boxes:
        box_text = getattr(text_box, "text", "")
        if _contains_cjk_text(text) and text.endswith("域") and not str(box_text).endswith("域"):
            continue
        bbox = text_box.source_pixel_bbox
        center_x = (bbox[0] + bbox[2]) / 2.0
        comparable.append((abs(center_x - candidate_center_x), text_box))
    if not comparable:
        return {}
    _distance, reference = min(comparable, key=lambda item: item[0])
    return {
        "font_family": reference.font_family,
        "font_size": reference.font_size,
        "color_hex": reference.color_hex,
    }


def _font_size_points_from_source_pixel_height(pixel_height: int, image_height: int) -> float:
    if image_height <= 0:
        return 18.0
    points = pixel_height * 72.0 * 5.625 / image_height * 0.8
    return round(max(8.0, min(44.0, points)), 2)


def _contains_cjk_text(text: str) -> bool:
    return any("\u3400" <= char <= "\u9fff" for char in text)


def _quality_gate_visual_text_candidates(
    visual_text_candidates: list[tuple[int, int, int, int]],
    source_image_size: tuple[int, int],
) -> list[tuple[int, int, int, int]]:
    width, height = source_image_size
    return [
        bbox
        for bbox in visual_text_candidates
        if _is_left_label_quality_gate_candidate(bbox, width, height)
        or _is_top_card_heading_quality_gate_candidate(bbox, width, height)
        or _is_general_text_like_quality_gate_candidate(bbox, width, height)
    ]


def _is_left_label_quality_gate_candidate(
    bbox: tuple[int, int, int, int],
    image_width: int,
    image_height: int,
) -> bool:
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    center_x = (x1 + x2) / 2.0
    return (
        image_width * 0.12 <= center_x <= image_width * 0.30
        and y1 >= image_height * 0.08
        and 35 <= width <= image_width * 0.20
        and 12 <= height <= max(80, image_height * 0.09)
        and width >= height * 1.15
    )


def _is_top_card_heading_quality_gate_candidate(
    bbox: tuple[int, int, int, int],
    image_width: int,
    image_height: int,
) -> bool:
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    center_x = (x1 + x2) / 2.0
    return (
        image_height * 0.09 <= y1 <= image_height * 0.22
        and image_width * 0.04 <= center_x <= image_width * 0.72
        and 70 <= width <= image_width * 0.18
        and 22 <= height <= max(80, image_height * 0.09)
        and width >= height * 2.0
    )


def _is_general_text_like_quality_gate_candidate(
    bbox: tuple[int, int, int, int],
    image_width: int,
    image_height: int,
) -> bool:
    x1, y1, x2, y2 = bbox
    width = x2 - x1
    height = y2 - y1
    if image_width <= 0 or image_height <= 0 or width <= 0 or height <= 0:
        return False
    return (
        y1 >= image_height * 0.10
        and 45 <= width <= image_width * 0.28
        and 14 <= height <= max(94, image_height * 0.10)
        and width >= height * 1.55
    )


def _text_box_covers_visual_candidate(
    text_bbox: tuple[int, int, int, int],
    candidate_bbox: tuple[int, int, int, int],
) -> bool:
    return (
        _bbox_iou(text_bbox, candidate_bbox) >= 0.45
        or _bbox_contains_ratio(text_bbox, candidate_bbox) >= 0.72
        or _bbox_contains_ratio(candidate_bbox, text_bbox) >= 0.72
    )


def _has_blocking_text_issue(issues: list[dict[str, Any]]) -> bool:
    return any(issue.get("severity") != "warning" for issue in issues)


def _rewrite_validation_statuses(
    *,
    artifacts: GenerativeEditableJobArtifacts,
    deck_manifest: DeckManifest,
    page_manifests: list[PageManifest],
    deck_validation_status: Literal["passed", "failed"],
    page_validation_statuses: dict[str, Literal["passed", "failed"]],
) -> None:
    updated_deck = replace(deck_manifest, validation_status=deck_validation_status)
    write_manifest(artifacts.deck_manifest_path, updated_deck)
    for page in page_manifests:
        write_manifest(
            artifacts.page_manifest_path(page.slide_id, page.page_index),
            replace(page, validation_status=page_validation_statuses.get(page.slide_id, "failed")),
        )


def _merge_validation_reports(
    reports: list[ValidationReport],
    *,
    checked_pages: int | None = None,
) -> ValidationReport:
    issues: list[ValidationIssue] = []
    checked_pages_from_reports = 0
    has_failed_status = False
    for report in reports:
        checked_pages_from_reports = max(checked_pages_from_reports, report.checked_pages)
        issues.extend(report.issues)
        has_failed_status = has_failed_status or report.status != "passed"
    if has_failed_status and not issues:
        issues.append(
            ValidationIssue(
                code="validation_failed",
                message="validation failed without a specific issue",
            )
        )
    return ValidationReport(
        status="failed" if issues or has_failed_status else "passed",
        checked_pages=checked_pages if checked_pages is not None else checked_pages_from_reports,
        issues=issues,
    )


def _coerce_asset_build_result(value: AssetBuildResult | list[BitmapAssetSpec]) -> AssetBuildResult:
    if isinstance(value, AssetBuildResult):
        return value
    return AssetBuildResult(bitmap_assets=list(value))


def _padded_bbox(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
    *,
    padding: int,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = bbox
    width, height = size
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def _ensure_output_outside_job_dir(output_path: str | Path, job_dir: str | Path) -> None:
    output = Path(output_path)
    if not output.is_absolute():
        output = output.resolve()
    job = Path(job_dir).resolve()
    try:
        is_inside = output.resolve().is_relative_to(job)
    except FileNotFoundError:
        is_inside = output.parent.resolve().is_relative_to(job)
    if is_inside:
        raise ValueError("output_path must not be inside cleanup artifact job directory")


def _ocr_result_payload(ocr_result) -> dict[str, Any]:
    return {
        "source_image_path": ocr_result.source_image_path,
        "image_size": ocr_result.image_size,
        "provider_role": ocr_result.provider_role,
        "provider_name": ocr_result.provider_name,
        "model": ocr_result.model,
        "items": [
            {
                "text": item.text,
                "bbox": item.bbox,
                "polygon": item.polygon,
                "confidence": item.confidence,
                "font_family_hint": item.font_family_hint,
                "font_size_hint": item.font_size_hint,
                "style_hints": item.style_hints,
                "color_hex": item.color_hex,
                "alignment": item.alignment,
                "provenance": item.provenance,
            }
            for item in ocr_result.items
        ],
    }


def _metadata_only_ocr_result(
    *,
    source_image_path: str,
    source_image_size: tuple[int, int],
    text_metadata: list[dict[str, Any]],
) -> OCRResult:
    width, height = source_image_size
    ordered = sorted(text_metadata, key=lambda item: int(item.get("order", 0)))
    items: list[OCRTextItem] = []
    default_font_size = max(18.0, round(height * 0.07))
    box_height = max(24, round(default_font_size * 1.6))
    y_step = max(box_height + 8, round(height * 0.14))
    for index, metadata in enumerate(ordered):
        text = str(metadata.get("text", ""))
        font_size = _metadata_font_size(metadata) or default_font_size
        top = min(max(0, round(height * 0.12) + index * y_step), max(0, height - box_height))
        left = max(0, round(width * 0.10))
        estimated_width = max(round(font_size * 0.68 * max(len(text), 1)), round(width * 0.12))
        right = min(width, left + estimated_width + round(font_size * 1.5))
        bottom = min(height, top + box_height)
        bbox = (left, top, right, bottom)
        items.append(
            OCRTextItem(
                text=text,
                bbox=bbox,
                polygon=((left, top), (right, top), (right, bottom), (left, bottom)),
                confidence=0.75,
                font_size_hint=font_size,
                style_hints={"source": "aippt_metadata_layout_fallback"},
                color_hex="#000000",
                alignment="left",
                provenance={
                    "provider_role": "metadata",
                    "provider": "aippt_metadata",
                    "model": "metadata_only_layout_fallback",
                    "fallback": "ocr_provider_failed",
                    "metadata_order": metadata.get("order"),
                },
            )
        )
    return OCRResult(
        source_image_path=source_image_path,
        image_size=source_image_size,
        provider_role="metadata",
        provider_name="aippt_metadata",
        model="metadata_only_layout_fallback",
        items=items,
    )


def _metadata_font_size(metadata: dict[str, Any]) -> float | None:
    style_hint = metadata.get("style_hint")
    if not isinstance(style_hint, dict):
        return None
    value = style_hint.get("font_size")
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _job_relative(path: str | Path, job_dir: str | Path) -> str:
    return str(Path(path).resolve().relative_to(Path(job_dir).resolve()))


def _slide_size_inches(aspect_ratio: str) -> tuple[float, float]:
    if aspect_ratio == "4:3":
        return (10.0, 7.5)
    return (10.0, 5.625)


def _safe_name(value: str) -> str:
    safe = "".join(char if char.isalnum() or char in "._-" else "-" for char in str(value))
    return safe.strip("-") or "item"


@contextmanager
def _record_stage(
    artifacts: GenerativeEditableJobArtifacts,
    *,
    stage: str,
    page_index: int | None = None,
    slide_id: str | None = None,
    provider_role: str | None = None,
    provider: str | None = None,
    timeout_seconds: int | None = None,
):
    started = time.perf_counter()
    event: dict[str, Any] = {
        "stage": stage,
        "status": "started",
    }
    if page_index is not None:
        event["page_index"] = page_index
    if slide_id is not None:
        event["slide_id"] = slide_id
    if provider_role:
        event["provider_role"] = provider_role
    if provider:
        event["provider"] = provider
    if timeout_seconds:
        event["timeout_seconds"] = timeout_seconds
    artifacts.append_stage_event(event)
    try:
        yield
    except Exception as exc:
        artifacts.append_stage_event(
            {
                **event,
                "status": "failed",
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
                "error_type": exc.__class__.__name__,
                "error": str(exc) or exc.__class__.__name__,
            }
        )
        raise
    artifacts.append_stage_event(
        {
            **event,
            "status": "finished",
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        }
    )


def _as_dict(value: object) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _normalize_fallback_policy(value: FallbackPolicy | str | None) -> FallbackPolicy:
    if value is None:
        return "fail"
    if value not in FALLBACK_POLICIES:
        raise ValueError(f"unsupported fallback policy: {value}")
    return value  # type: ignore[return-value]


def _summarize_validation_issues(validation_report: ValidationReport) -> str:
    summaries = [
        f"{issue.code}: {issue.message}" if issue.message else issue.code
        for issue in validation_report.issues
    ]
    return "; ".join(summaries) or "unknown_validation_failure"

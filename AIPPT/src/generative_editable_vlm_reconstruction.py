"""VLM-first editable PPTX reconstruction helpers.

This module turns a structured VLM page analysis into the same manifest
primitives used by the deterministic PPTX composer. Provider calls remain
outside this module so unit tests never spend real model budget.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, replace
import base64
from difflib import SequenceMatcher
import inspect
import io
from pathlib import Path
import re
import time
import unicodedata
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageStat

from .generative_editable_config import ProviderConfig
from .generative_editable_assets import build_asset_sheet_request, slice_asset_sheet_by_components
from .generative_editable_backgrounds import (
    BackgroundResult,
    create_source_preserving_text_background,
)
from .generative_editable_composer import compose_deck_from_manifests
from .generative_editable_foreground_planner import ForegroundCandidate
from .generative_editable_job_artifacts import GenerativeEditableJobArtifacts
from .generative_editable_manifest import (
    AssetSheetSpec,
    BitmapAssetSpec,
    DeckManifest,
    NativeShapeSpec,
    PageManifest,
    TextBoxSpec,
    read_page_manifest,
    write_manifest,
)
from .generative_editable_providers import (
    ImageEditProvider,
    ImageEditRequest,
    OCRProvider,
    ProviderError,
    ProviderTimeoutError,
    RetryingImageEditProvider,
    RetryingOCRProvider,
    _ProviderDeadlineTimeout,
    _extract_message_content,
    _call_with_provider_retries,
    _elapsed_seconds_since,
    _parse_json_object,
    _post_openai_chat,
    _provider_attempt_error_payload,
    _provider_hard_deadline,
    safe_provider_error_message,
)
from .generative_editable_pipeline import (
    GenerativeEditableExportResult,
    GenerativeEditableSlideInput,
    GenerativeEditableValidationError,
)
from .generative_editable_preview_validator import (
    ValidationIssue,
    ValidationReport,
    quality_threshold_to_preview_gates,
    render_manifest_preview_with_metadata,
    validate_composed_deck_structure,
    validate_preview_similarity,
)
from .generative_editable_text import extract_text_with_validation

PixelBBox = tuple[int, int, int, int]
MIN_BITMAP_REGION_AREA_RATIO = 0.0004
MAX_BITMAP_ELEMENT_AREA_RATIO = 0.72
MAX_BITMAP_ELEMENT_WIDTH_RATIO = 0.92
MAX_BITMAP_ELEMENT_HEIGHT_RATIO = 0.72
CLEAN_FALLBACK_LOCAL_ICON_KINDS = frozenset({"icon", "ui_icon", "small_icon"})
MAX_CLEAN_FALLBACK_LOCAL_ICON_AREA_RATIO = 0.03
MAX_CLEAN_FALLBACK_LOCAL_ICON_DIMENSION_RATIO = 0.22
ASSET_SHEET_PROVIDER_TIMEOUT_SECONDS = 120
COMPLEX_BITMAP_MASK_KINDS = frozenset({"photo", "product", "component", "complex"})
CONDITIONAL_COMPLEX_BITMAP_MASK_KINDS = frozenset({"other", "qr"})
MIN_COMPLEX_BITMAP_MASK_PADDING = 16
MAX_COMPLEX_BITMAP_MASK_PADDING = 48
COMPLEX_BITMAP_MASK_PADDING_RATIO = 0.08


@dataclass(frozen=True)
class VLMCoordinateSpace:
    width: int
    height: int
    unit: str = "px"


@dataclass(frozen=True)
class VLMTextRegion:
    region_id: str
    text: str
    bbox: PixelBBox
    role: str = "body"
    color_hex: str = ""
    confidence: float = 0.0
    group_id: str = ""


@dataclass(frozen=True)
class VLMBitmapRegion:
    region_id: str
    kind: str
    bbox: PixelBBox
    importance: str = ""
    group_id: str = ""


@dataclass(frozen=True)
class VLMShapeRegion:
    region_id: str
    kind: str
    bbox: PixelBBox
    importance: str = ""
    group_id: str = ""


@dataclass(frozen=True)
class VLMPageAnalysis:
    coordinate_space: VLMCoordinateSpace
    text_regions: list[VLMTextRegion] = field(default_factory=list)
    bitmap_regions: list[VLMBitmapRegion] = field(default_factory=list)
    shape_regions: list[VLMShapeRegion] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MaskBox:
    kind: str
    region_id: str
    bbox: PixelBBox


@dataclass(frozen=True)
class VLMCoordinateMapper:
    analysis_space: VLMCoordinateSpace
    source_image_size: tuple[int, int]

    def to_source_bbox(self, bbox: PixelBBox, *, padding: int = 0) -> PixelBBox:
        source_width, source_height = self.source_image_size
        left, top, right, bottom = bbox
        mapped = (
            round(left / self.analysis_space.width * source_width) - padding,
            round(top / self.analysis_space.height * source_height) - padding,
            round(right / self.analysis_space.width * source_width) + padding,
            round(bottom / self.analysis_space.height * source_height) + padding,
        )
        return _clamp_bbox(mapped, self.source_image_size)


class VLMPageAnalysisProvider:
    def analyze_page(self, image_path: str, *, timeout_seconds: int = 180) -> VLMPageAnalysis:
        raise NotImplementedError


class RetryingVLMPageAnalysisProvider(VLMPageAnalysisProvider):
    def __init__(
        self,
        provider: VLMPageAnalysisProvider,
        *,
        max_attempts: int,
        backoff_seconds: float,
    ):
        self.provider = provider
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.last_attempts: list[dict[str, Any]] = []

    def analyze_page(self, image_path: str, *, timeout_seconds: int = 180) -> VLMPageAnalysis:
        attempts: list[dict[str, Any]] = []
        try:
            return _call_with_provider_retries(
                lambda: self.provider.analyze_page(
                    image_path,
                    timeout_seconds=timeout_seconds,
                ),
                max_attempts=self.max_attempts,
                backoff_seconds=self.backoff_seconds,
                attempt_log=attempts,
            )
        finally:
            self.last_attempts = _attach_vlm_payload_attempts(attempts, self.provider)


def _attach_vlm_payload_attempts(
    attempts: list[dict[str, Any]],
    provider: VLMPageAnalysisProvider,
) -> list[dict[str, Any]]:
    copied = [dict(item) for item in attempts]
    payload_attempts = getattr(provider, "last_payload_attempts", None)
    if copied and payload_attempts:
        copied[-1]["payload_attempts"] = [
            dict(item) for item in payload_attempts if isinstance(item, dict)
        ]
    return copied


class OpenAIChatVLMPageAnalysisProvider(VLMPageAnalysisProvider):
    def __init__(
        self,
        config: ProviderConfig,
        *,
        analysis_size: tuple[int, int] = (768, 432),
        max_tokens: int = 2600,
    ):
        self.config = config
        self.analysis_size = analysis_size
        self.max_tokens = max_tokens
        self.last_payload_attempts: list[dict[str, Any]] = []

    def analyze_page(self, image_path: str, *, timeout_seconds: int = 180) -> VLMPageAnalysis:
        self.last_payload_attempts = []
        last_retryable_error: ProviderError | None = None
        last_payload_compatibility_error: ProviderError | None = None
        payloads = _vlm_analysis_payload_variants(
            image_path,
            analysis_size=self.analysis_size,
            model=self.config.model,
            max_tokens=self.max_tokens,
        )
        for attempt_index, payload in enumerate(payloads, start=1):
            started_at = time.monotonic()
            try:
                response = _post_openai_chat(
                    self.config,
                    payload,
                    operation="vlm_page_analysis",
                    timeout_seconds=timeout_seconds,
                )
                analysis = self._analysis_from_response(response)
                self.last_payload_attempts.append(
                    {
                        "attempt": attempt_index,
                        "status": "passed",
                        "elapsed_seconds": _elapsed_seconds_since(started_at),
                    }
                )
                return analysis
            except ProviderError as exc:
                compatibility_error = _is_vlm_payload_shape_compatibility_error(exc)
                retrying = bool(
                    attempt_index < len(payloads) and (exc.retryable or compatibility_error)
                )
                self.last_payload_attempts.append(
                    _provider_attempt_error_payload(
                        exc,
                        attempt=attempt_index,
                        retrying=retrying,
                        elapsed_seconds=_elapsed_seconds_since(started_at),
                    )
                )
                if exc.retryable:
                    last_retryable_error = exc
                    continue
                if compatibility_error:
                    last_payload_compatibility_error = exc
                    continue
                raise
        if last_retryable_error is not None:
            raise last_retryable_error
        if last_payload_compatibility_error is not None:
            raise last_payload_compatibility_error
        raise ProviderError(
            provider_role=self.config.role,
            operation="vlm_page_analysis",
            message="VLM provider did not produce a response",
            retryable=True,
            secret_values=[self.config.api_key, self.config.base_url],
        )

    def _analysis_from_response(self, response: dict[str, Any]) -> VLMPageAnalysis:
        content = _extract_message_content(response)
        try:
            parsed = _parse_json_object(content)
        except ProviderError as exc:
            raise ProviderError(
                provider_role=self.config.role,
                operation="vlm_page_analysis",
                message=str(exc),
                retryable=False,
                secret_values=[self.config.api_key, self.config.base_url],
            ) from exc
        if not isinstance(parsed, dict):
            raise ProviderError(
                provider_role=self.config.role,
                operation="vlm_page_analysis",
                message="VLM provider response JSON must be an object",
                retryable=False,
                secret_values=[self.config.api_key, self.config.base_url],
            )
        return coerce_vlm_analysis(parsed)


class FakeVLMPageAnalysisProvider(VLMPageAnalysisProvider):
    def analyze_page(self, image_path: str, *, timeout_seconds: int = 180) -> VLMPageAnalysis:
        with Image.open(image_path) as image:
            width, height = image.size
        return coerce_vlm_analysis(
            {
                "coordinate_space": {"width": width, "height": height, "unit": "px"},
                "text_regions": [
                    {
                        "id": "fake-title",
                        "text": "Editable Title",
                        "bbox": [
                            round(width * 0.08),
                            round(height * 0.08),
                            round(width * 0.48),
                            round(height * 0.18),
                        ],
                        "role": "title",
                        "color": "#FFFFFF",
                        "confidence": 1.0,
                    }
                ],
                "bitmap_regions": [
                    {
                        "id": "fake-asset",
                        "type": "icon",
                        "bbox": [
                            round(width * 0.58),
                            round(height * 0.25),
                            round(width * 0.78),
                            round(height * 0.52),
                        ],
                    }
                ],
                "shape_regions": [
                    {
                        "id": "fake-divider",
                        "type": "divider",
                        "bbox": [
                            round(width * 0.08),
                            round(height * 0.64),
                            round(width * 0.88),
                            round(height * 0.65),
                        ],
                    }
                ],
            }
        )


def _default_vlm_preview_validator(**kwargs) -> ValidationReport:
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
class VLMEditablePipelineDependencies:
    vlm_provider: VLMPageAnalysisProvider
    image_edit_provider: ImageEditProvider
    asset_sheet_image_edit_provider: ImageEditProvider | None = None
    ocr_provider: OCRProvider | None = None
    composer: Any = compose_deck_from_manifests
    provider_timeout_seconds: int = 180
    page_timeout_seconds: float = 600
    provider_max_attempts: int = 1
    provider_retry_backoff_seconds: float = 0.0
    mask_padding: int = 10
    ocr_min_confidence: float = 0.75
    preview_similarity_threshold: float = 0.92
    require_preview_validation: bool = True
    preview_renderer: Callable[..., Any] = render_manifest_preview_with_metadata
    structure_validator: Callable[..., ValidationReport] = validate_composed_deck_structure
    preview_validator: Callable[..., ValidationReport] = _default_vlm_preview_validator


def run_vlm_editable_pptx_pipeline(
    *,
    slides: list[GenerativeEditableSlideInput | dict[str, Any]],
    output_path: str,
    artifact_root: str,
    job_id: str,
    dependencies: VLMEditablePipelineDependencies,
    aspect_ratio: str = "16:9",
    cleanup_artifacts: bool = False,
) -> GenerativeEditableExportResult:
    if not slides:
        raise ValueError("slides are required")
    dependencies = with_vlm_provider_retries(dependencies)
    artifacts = GenerativeEditableJobArtifacts(root_dir=artifact_root, job_id=job_id)
    try:
        page_manifest_refs: list[str] = []
        slide_order: list[str] = []
        page_manifests: list[PageManifest] = []
        for page_index, slide in enumerate(slides):
            with _vlm_page_deadline(dependencies.page_timeout_seconds) as page_deadline:
                page_manifest = _build_vlm_page_manifest(
                    slide=slide,
                    page_index=page_index,
                    aspect_ratio=aspect_ratio,
                    artifacts=artifacts,
                    dependencies=dependencies,
                    page_deadline=page_deadline,
                )
            page_manifest_path = artifacts.page_manifest_path(page_manifest.slide_id, page_index)
            write_manifest(page_manifest_path, page_manifest)
            page_manifest_refs.append(_job_relative(page_manifest_path, artifacts.job_dir))
            slide_order.append(page_manifest.slide_id)
            page_manifests.append(page_manifest)
        clean_background_local_fallback_used = _clean_background_local_fallback_used(page_manifests)
        deck_manifest = DeckManifest(
            job_id=artifacts.job_id,
            slide_order=slide_order,
            aspect_ratio=aspect_ratio,
            provider_roles={
                "vlm": "VLM",
                "image_edit": dependencies.image_edit_provider.config.role,
                "asset_sheet": (
                    dependencies.asset_sheet_image_edit_provider or dependencies.image_edit_provider
                ).config.role,
            },
            quality_settings={},
            fallback_policy="fail",
            page_manifest_paths=page_manifest_refs,
            validation_status="pending",
            provenance={
                "reconstruction_strategy": "vlm_first",
                "clean_background_local_fallback_used": clean_background_local_fallback_used,
            },
        )
        write_manifest(artifacts.deck_manifest_path, deck_manifest)
        with _record_vlm_stage(artifacts, "compose_deck"):
            dependencies.composer(artifacts.deck_manifest_path, artifacts.job_dir, output_path)
        validation_report = _validate_vlm_pipeline_output(
            deck_manifest_path=artifacts.deck_manifest_path,
            artifact_root=artifacts.job_dir,
            pptx_path=output_path,
            page_manifests=page_manifests,
            dependencies=dependencies,
        )
        _record_vlm_validation_status(
            artifacts=artifacts,
            deck_manifest=deck_manifest,
            page_manifest_refs=page_manifest_refs,
            validation_report=validation_report,
        )
        if validation_report.status != "passed" or validation_report.issues:
            raise GenerativeEditableValidationError(
                validation_report=validation_report,
                fallback_policy="fail",
            )
        return GenerativeEditableExportResult(
            status="passed",
            output_path=output_path,
            fallback_policy="fail",
            validation_report=validation_report,
            fallback_used="clean_background_local" if clean_background_local_fallback_used else "",
        )
    finally:
        if cleanup_artifacts:
            artifacts.cleanup()


def _validate_vlm_pipeline_output(
    *,
    deck_manifest_path: Path,
    artifact_root: Path,
    pptx_path: str,
    page_manifests: list[PageManifest],
    dependencies: VLMEditablePipelineDependencies,
) -> ValidationReport:
    reports = [
        _validate_vlm_minimum_editable_structure(page_manifests),
        _validate_vlm_source_preserved_bitmap_coverage(page_manifests),
        dependencies.structure_validator(
            deck_manifest_path=deck_manifest_path,
            artifact_root=artifact_root,
            pptx_path=pptx_path,
        ),
    ]
    for page in page_manifests:
        preview = _render_vlm_preview(
            dependencies.preview_renderer,
            page,
            artifact_root,
            pptx_path=pptx_path,
        )
        reports.append(
            dependencies.preview_validator(
                source_image_path=artifact_root / page.source_image_path,
                preview=preview,
                slide_id=page.slide_id,
                page_index=page.page_index,
                pptx_path=pptx_path,
                preview_similarity_threshold=dependencies.preview_similarity_threshold,
                require_preview_validation=dependencies.require_preview_validation,
                page_manifest=page,
            )
        )
    return _merge_validation_reports(reports, checked_pages=len(page_manifests))


def _validate_vlm_source_preserved_bitmap_coverage(
    page_manifests: list[PageManifest],
) -> ValidationReport:
    issues: list[ValidationIssue] = []
    for page in page_manifests:
        issues.extend(_vlm_source_preserved_bitmap_coverage_issues(page))
    return ValidationReport(
        status="failed" if any(issue.severity == "error" for issue in issues) else "passed",
        checked_pages=len(page_manifests),
        issues=issues,
    )


def _vlm_source_preserved_bitmap_coverage_issues(page: PageManifest) -> list[ValidationIssue]:
    source_width, source_height = page.source_image_size
    page_area = max(1, int(source_width) * int(source_height))
    if page_area <= 1:
        return []
    source_preserved_assets = [
        asset for asset in page.bitmap_assets if _is_vlm_source_preserved_bitmap_asset(asset)
    ]
    if not source_preserved_assets:
        return []
    largest_asset = max(
        source_preserved_assets,
        key=lambda asset: _vlm_source_preserved_asset_effective_area_ratio(
            asset,
            (int(source_width), int(source_height)),
        ),
    )
    largest_ratio = _vlm_source_preserved_asset_effective_area_ratio(
        largest_asset,
        (int(source_width), int(source_height)),
    )
    largest_bbox_ratio = _bbox_area(largest_asset.source_pixel_bbox) / float(page_area)
    combined_bbox_ratio = _combined_bbox_coverage_ratio(
        [asset.source_pixel_bbox for asset in source_preserved_assets],
        (int(source_width), int(source_height)),
    )
    combined_visible_ratio = min(
        1.0,
        sum(
            _vlm_source_preserved_asset_effective_area_ratio(
                asset,
                (int(source_width), int(source_height)),
            )
            for asset in source_preserved_assets
        ),
    )
    combined_ratio = min(combined_bbox_ratio, combined_visible_ratio)
    structure_count = len(page.text_boxes) + len(page.native_shapes)
    details = {
        "largest_asset_id": largest_asset.asset_id,
        "largest_asset_area_ratio": round(largest_ratio, 4),
        "largest_asset_bbox_area_ratio": round(largest_bbox_ratio, 4),
        "combined_bitmap_asset_coverage_ratio": round(combined_ratio, 4),
        "combined_bitmap_asset_bbox_coverage_ratio": round(combined_bbox_ratio, 4),
        "combined_bitmap_asset_visible_area_ratio": round(combined_visible_ratio, 4),
        "bitmap_asset_count": len(page.bitmap_assets),
        "source_preserved_bitmap_asset_count": len(source_preserved_assets),
        "native_shape_count": len(page.native_shapes),
        "text_box_count": len(page.text_boxes),
        "page_index": page.page_index,
    }
    if largest_ratio >= 0.80:
        return [
            ValidationIssue(
                code="oversized_bitmap_asset_coverage",
                message="A single source-preserved bitmap asset covers most of the slide",
                slide_id=page.slide_id,
                severity="error",
                details=details,
            )
        ]
    if combined_ratio >= 0.85 and structure_count < 3:
        return [
            ValidationIssue(
                code="excessive_bitmap_asset_coverage",
                message="Source-preserved bitmap assets cover most of the slide without enough editable structure",
                slide_id=page.slide_id,
                severity="error",
                details=details,
            )
        ]
    if combined_ratio >= 0.65 and not _has_vlm_split_bitmap_structure(
        source_preserved_assets,
        largest_ratio=largest_ratio,
        structure_count=structure_count,
    ):
        return [
            ValidationIssue(
                code="high_bitmap_asset_coverage",
                message="Source-preserved bitmap assets cover a large part of the slide",
                slide_id=page.slide_id,
                severity="error",
                details=details,
            )
        ]
    return []


def _is_vlm_source_preserved_bitmap_asset(asset: BitmapAssetSpec) -> bool:
    return (
        asset.provenance.get("asset_strategy")
        in {
            "masked_source_element",
            "source_preserved_crop",
            "source_preserving_anchor",
        }
        or asset.provenance.get("source_type") == "vlm_source_crop"
    )


def _vlm_source_preserved_asset_effective_area_ratio(
    asset: BitmapAssetSpec,
    source_size: tuple[int, int],
) -> float:
    visible_ratio = asset.provenance.get("alpha_visible_area_ratio")
    if (
        asset.provenance.get("background_difference_alpha") is True
        and isinstance(visible_ratio, (int, float))
        and 0.0 <= float(visible_ratio) <= 1.0
    ):
        return float(visible_ratio)
    page_area = max(1, source_size[0] * source_size[1])
    return _bbox_area(asset.source_pixel_bbox) / float(page_area)


def _has_vlm_split_bitmap_structure(
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


def _combined_bbox_coverage_ratio(
    bboxes: list[PixelBBox],
    source_size: tuple[int, int],
) -> float:
    width, height = source_size
    if width <= 0 or height <= 0:
        return 0.0
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for bbox in bboxes:
        left, top, right, bottom = _clamp_bbox(bbox, source_size)
        if right > left and bottom > top:
            draw.rectangle((left, top, right, bottom), fill=255)
    histogram = mask.histogram()
    covered = width * height - histogram[0]
    return covered / float(width * height)


def _validate_vlm_minimum_editable_structure(
    page_manifests: list[PageManifest],
) -> ValidationReport:
    issues: list[ValidationIssue] = []
    for page in page_manifests:
        editable_count = len(page.text_boxes) + len(page.native_shapes) + len(page.bitmap_assets)
        if editable_count > 0:
            continue
        issues.append(
            ValidationIssue(
                code="vlm_no_editable_or_decomposed_objects",
                message="VLM-first reconstruction produced only a background with no editable or decomposed page objects",
                slide_id=page.slide_id,
                details={
                    "page_index": page.page_index,
                    "text_box_count": len(page.text_boxes),
                    "native_shape_count": len(page.native_shapes),
                    "bitmap_asset_count": len(page.bitmap_assets),
                    "chosen_background": page.chosen_background,
                },
            )
        )
    return ValidationReport(
        status="failed" if issues else "passed",
        checked_pages=len(page_manifests),
        issues=issues,
    )


def _clean_background_local_fallback_used(page_manifests: list[PageManifest]) -> bool:
    return any(
        bool(page.provenance.get("clean_background_provider_failed")) for page in page_manifests
    )


def _asset_sheet_timeout_seconds(provider_timeout_seconds: int) -> int:
    if provider_timeout_seconds <= 0:
        return ASSET_SHEET_PROVIDER_TIMEOUT_SECONDS
    return min(provider_timeout_seconds, ASSET_SHEET_PROVIDER_TIMEOUT_SECONDS)


@contextmanager
def _vlm_page_deadline(timeout_seconds: float):
    deadline = _VLMPageDeadline(timeout_seconds)
    try:
        with _provider_hard_deadline(timeout_seconds):
            yield deadline
    except _ProviderDeadlineTimeout as exc:
        raise deadline.timeout_error(str(exc)) from exc


class _VLMPageDeadline:
    def __init__(self, timeout_seconds: float):
        self.timeout_seconds = float(timeout_seconds)
        self.started_at = time.monotonic()

    def check(self, stage: str) -> None:
        if self.timeout_seconds <= 0:
            return
        if time.monotonic() - self.started_at >= self.timeout_seconds:
            raise self.timeout_error(
                f"VLM-first page exceeded {self.timeout_seconds}s during {stage}"
            )

    def provider_timeout(self, configured_timeout_seconds: int | float, stage: str) -> float:
        self.check(stage)
        if self.timeout_seconds <= 0:
            return configured_timeout_seconds
        remaining = self.timeout_seconds - (time.monotonic() - self.started_at)
        if remaining <= 0:
            raise self.timeout_error(
                f"VLM-first page exceeded {self.timeout_seconds}s before {stage}"
            )
        return max(0.001, min(float(configured_timeout_seconds), remaining))

    def timeout_error(self, message: str) -> ProviderTimeoutError:
        return ProviderTimeoutError(
            provider_role="vlm_first",
            operation="build_page_manifest",
            message=message,
            timeout_seconds=self.timeout_seconds,
        )


@contextmanager
def _temporary_provider_timeout(provider: Any, timeout_seconds: float):
    targets = []
    current = provider
    while current is not None:
        if hasattr(current, "timeout_seconds"):
            targets.append(current)
        current = getattr(current, "provider", None)
    originals = [(target, target.timeout_seconds) for target in targets]
    try:
        for target, original in originals:
            target.timeout_seconds = min(float(original), float(timeout_seconds))
        yield
    finally:
        for target, original in originals:
            target.timeout_seconds = original


def _raise_page_timeout_if_page_limited_provider_timeout(
    *,
    page_deadline: _VLMPageDeadline,
    provider_error: ProviderTimeoutError,
    configured_timeout_seconds: int | float,
    actual_timeout_seconds: int | float,
    stage: str,
) -> None:
    if (
        page_deadline.timeout_seconds > 0
        and float(actual_timeout_seconds) < float(configured_timeout_seconds)
        and provider_error.timeout_seconds <= float(actual_timeout_seconds) + 0.001
    ):
        raise page_deadline.timeout_error(
            f"VLM-first page exceeded {page_deadline.timeout_seconds}s during {stage}"
        ) from provider_error


def _render_vlm_preview(
    preview_renderer, page: PageManifest, artifact_root: Path, *, pptx_path: str
):
    if "pptx_path" in inspect.signature(preview_renderer).parameters:
        return preview_renderer(page, artifact_root, pptx_path=pptx_path)
    return preview_renderer(page, artifact_root)


def _merge_validation_reports(
    reports: list[ValidationReport],
    *,
    checked_pages: int,
) -> ValidationReport:
    issues = [issue for report in reports for issue in report.issues]
    failed = any(report.status != "passed" for report in reports) or bool(issues)
    return ValidationReport(
        status="failed" if failed else "passed",
        checked_pages=checked_pages,
        issues=issues,
    )


def _record_vlm_validation_status(
    *,
    artifacts: GenerativeEditableJobArtifacts,
    deck_manifest: DeckManifest,
    page_manifest_refs: list[str],
    validation_report: ValidationReport,
) -> None:
    status = (
        "failed" if validation_report.status != "passed" or validation_report.issues else "passed"
    )
    issue_slide_ids = {issue.slide_id for issue in validation_report.issues if issue.slide_id}
    rewritten_refs: list[str] = []
    for page_ref in page_manifest_refs:
        page_path = artifacts.job_dir / page_ref
        page = read_page_manifest(page_path)
        page_status = (
            "failed"
            if status == "failed" and (not issue_slide_ids or page.slide_id in issue_slide_ids)
            else "passed"
        )
        write_manifest(page_path, replace(page, validation_status=page_status))
        rewritten_refs.append(page_ref)
    write_manifest(
        artifacts.deck_manifest_path,
        replace(
            deck_manifest,
            page_manifest_paths=rewritten_refs,
            validation_status=status,
            quality_settings={
                **dict(deck_manifest.quality_settings),
                "validation_issue_count": len(validation_report.issues),
            },
        ),
    )


def with_vlm_provider_retries(
    dependencies: VLMEditablePipelineDependencies,
) -> VLMEditablePipelineDependencies:
    vlm_provider = dependencies.vlm_provider
    if not isinstance(vlm_provider, RetryingVLMPageAnalysisProvider):
        vlm_provider = RetryingVLMPageAnalysisProvider(
            vlm_provider,
            max_attempts=dependencies.provider_max_attempts,
            backoff_seconds=dependencies.provider_retry_backoff_seconds,
        )

    def retry_image_edit(provider: ImageEditProvider | None) -> ImageEditProvider | None:
        if provider is None or isinstance(provider, RetryingImageEditProvider):
            return provider
        return RetryingImageEditProvider(
            provider,
            max_attempts=dependencies.provider_max_attempts,
            backoff_seconds=dependencies.provider_retry_backoff_seconds,
        )

    ocr_provider = dependencies.ocr_provider
    if ocr_provider is not None and not isinstance(ocr_provider, RetryingOCRProvider):
        ocr_provider = RetryingOCRProvider(
            ocr_provider,
            max_attempts=dependencies.provider_max_attempts,
            backoff_seconds=dependencies.provider_retry_backoff_seconds,
        )

    return replace(
        dependencies,
        vlm_provider=vlm_provider,
        image_edit_provider=retry_image_edit(dependencies.image_edit_provider),
        asset_sheet_image_edit_provider=retry_image_edit(
            dependencies.asset_sheet_image_edit_provider
        ),
        ocr_provider=ocr_provider,
    )


def _build_vlm_page_manifest(
    *,
    slide: GenerativeEditableSlideInput | dict[str, Any],
    page_index: int,
    aspect_ratio: str,
    artifacts: GenerativeEditableJobArtifacts,
    dependencies: VLMEditablePipelineDependencies,
    page_deadline: _VLMPageDeadline,
) -> PageManifest:
    slide_id = _slide_value(slide, "slide_id") or f"slide-{page_index + 1}"
    image_path = _slide_value(slide, "image_path")
    if not image_path:
        raise ValueError("slide image_path is required")
    source_path = artifacts.asset_path(slide_id, page_index, "sources", "source.png")
    source_path.write_bytes(Path(image_path).read_bytes())
    analysis_timeout = page_deadline.provider_timeout(
        dependencies.provider_timeout_seconds,
        "vlm_page_analysis",
    )
    with _record_vlm_stage(
        artifacts,
        "vlm_page_analysis",
        page_index=page_index,
        slide_id=slide_id,
        provider_role="VLM",
        timeout_seconds=analysis_timeout,
    ):
        try:
            analysis = dependencies.vlm_provider.analyze_page(
                str(source_path),
                timeout_seconds=analysis_timeout,
            )
        except ProviderTimeoutError as exc:
            _raise_page_timeout_if_page_limited_provider_timeout(
                page_deadline=page_deadline,
                provider_error=exc,
                configured_timeout_seconds=dependencies.provider_timeout_seconds,
                actual_timeout_seconds=analysis_timeout,
                stage="vlm_page_analysis",
            )
            raise
        page_deadline.check("vlm_page_analysis")
    ocr_result = None
    text_result = None
    if dependencies.ocr_provider is not None:
        ocr_timeout = page_deadline.provider_timeout(
            dependencies.provider_timeout_seconds,
            "ocr_extract_text",
        )
        with _record_vlm_stage(
            artifacts,
            "ocr_extract_text",
            page_index=page_index,
            slide_id=slide_id,
            provider_role=dependencies.ocr_provider.config.role,
            provider=dependencies.ocr_provider.config.model,
            timeout_seconds=ocr_timeout,
        ):
            try:
                with _temporary_provider_timeout(dependencies.ocr_provider, ocr_timeout):
                    ocr_result = dependencies.ocr_provider.extract_text(str(source_path))
            except ProviderTimeoutError as exc:
                _raise_page_timeout_if_page_limited_provider_timeout(
                    page_deadline=page_deadline,
                    provider_error=exc,
                    configured_timeout_seconds=dependencies.provider_timeout_seconds,
                    actual_timeout_seconds=ocr_timeout,
                    stage="ocr_extract_text",
                )
                raise
            page_deadline.check("ocr_extract_text")
            text_result = extract_text_with_validation(
                _slide_value(slide, "text_metadata") or [],
                ocr_result,
                min_confidence=dependencies.ocr_min_confidence,
            )
    with Image.open(source_path) as source:
        source_image_size = source.size
    mapper = VLMCoordinateMapper(
        analysis_space=analysis.coordinate_space,
        source_image_size=source_image_size,
    )
    protected_text_bboxes = [
        text_box.source_pixel_bbox for text_box in (text_result.text_boxes if text_result else [])
    ]
    page_deadline.check("vlm_build_mask")
    with _record_vlm_stage(artifacts, "vlm_build_mask", page_index=page_index, slide_id=slide_id):
        mask, mask_boxes = build_text_bitmap_mask(
            analysis,
            mapper,
            padding=dependencies.mask_padding,
            additional_text_bboxes=protected_text_bboxes,
        )
        page_deadline.check("vlm_build_mask")
    mask_path = artifacts.asset_path(slide_id, page_index, "assets", "vlm-text-bitmap-mask.png")
    mask.save(mask_path)
    clean_timeout = page_deadline.provider_timeout(
        dependencies.provider_timeout_seconds,
        "vlm_clean_background",
    )
    with _record_vlm_stage(
        artifacts,
        "vlm_clean_background",
        page_index=page_index,
        slide_id=slide_id,
        provider_role=dependencies.image_edit_provider.config.role,
        provider=dependencies.image_edit_provider.config.model,
        timeout_seconds=clean_timeout,
    ):
        clean_background = _create_vlm_clean_background(
            source_image_path=source_path,
            mask_path=mask_path,
            output_asset_path=artifacts.asset_path(
                slide_id, page_index, "backgrounds", "vlm-clean.png"
            ),
            asset_root=artifacts.job_dir,
            edit_provider=dependencies.image_edit_provider,
            timeout_seconds=clean_timeout,
            cleanup_bboxes=_local_clean_background_bboxes(
                mask_boxes,
                analysis,
                mapper,
            ),
        )
        page_deadline.check("vlm_clean_background")
    asset_sheet_provider = (
        dependencies.asset_sheet_image_edit_provider or dependencies.image_edit_provider
    )
    asset_sheet_timeout_seconds = page_deadline.provider_timeout(
        _asset_sheet_timeout_seconds(dependencies.provider_timeout_seconds),
        "vlm_asset_sheet",
    )
    with _record_vlm_stage(
        artifacts,
        "vlm_asset_sheet",
        page_index=page_index,
        slide_id=slide_id,
        provider_role=asset_sheet_provider.config.role,
        provider=asset_sheet_provider.config.model,
        timeout_seconds=asset_sheet_timeout_seconds,
    ):
        bitmap_assets, asset_sheets, asset_sheet_output_path = _create_vlm_asset_sheet_assets(
            analysis=analysis,
            mapper=mapper,
            source_image_path=source_path,
            artifacts=artifacts,
            slide_id=slide_id,
            page_index=page_index,
            edit_provider=asset_sheet_provider,
            timeout_seconds=asset_sheet_timeout_seconds,
            additional_text_bboxes=protected_text_bboxes,
            force_opaque_source_crops=bool(clean_background.provenance.get("provider_failed")),
        )
        page_deadline.check("vlm_asset_sheet")
    vlm_output_path = artifacts.write_provider_output(
        slide_id,
        page_index,
        "vlm",
        "analysis.json",
        {
            "analysis": _analysis_payload(analysis),
            "mask_boxes": [asdict(box) for box in mask_boxes],
        },
    )
    image_edit_output_path = artifacts.write_provider_output(
        slide_id,
        page_index,
        "image_edit",
        "backgrounds.json",
        {"chosen_background": asdict(clean_background)},
    )
    ocr_output_path = None
    if ocr_result is not None:
        ocr_output_path = artifacts.write_provider_output(
            slide_id,
            page_index,
            "ocr",
            "ocr.json",
            {
                "provider_role": ocr_result.provider_role,
                "provider_name": ocr_result.provider_name,
                "model": ocr_result.model,
                "image_size": list(ocr_result.image_size),
                "items": [asdict(item) for item in ocr_result.items],
                "issues": text_result.issues if text_result else [],
            },
        )
    with _record_vlm_stage(
        artifacts, "vlm_build_manifest", page_index=page_index, slide_id=slide_id
    ):
        page = build_page_manifest_from_vlm_analysis(
            analysis=analysis,
            slide_id=slide_id,
            page_index=page_index,
            source_image_path=source_path,
            clean_background_path=clean_background.output_asset_path,
            artifact_root=artifacts.job_dir,
            aspect_ratio=aspect_ratio,
            text_boxes=text_result.text_boxes if text_result else None,
            bitmap_assets=bitmap_assets,
            asset_sheets=asset_sheets,
        )
        page = replace(
            page,
            provenance={
                **page.provenance,
                "clean_background_strategy": clean_background.strategy,
                "clean_background_provider_failed": bool(
                    clean_background.provenance.get("provider_failed")
                ),
                "text_mask_path": _job_relative(mask_path, artifacts.job_dir),
            },
        )
    provider_output_paths = {
        "vlm": _job_relative(vlm_output_path, artifacts.job_dir),
        "image_edit": _job_relative(image_edit_output_path, artifacts.job_dir),
    }
    if asset_sheet_output_path is not None:
        provider_output_paths["asset_sheet"] = _job_relative(
            asset_sheet_output_path, artifacts.job_dir
        )
    if ocr_output_path is not None:
        provider_output_paths["ocr"] = _job_relative(ocr_output_path, artifacts.job_dir)
    return replace(
        page,
        provider_output_paths=provider_output_paths,
    )


@contextmanager
def _record_vlm_stage(
    artifacts: GenerativeEditableJobArtifacts,
    stage: str,
    *,
    page_index: int | None = None,
    slide_id: str | None = None,
    provider_role: str | None = None,
    provider: str | None = None,
    timeout_seconds: int | None = None,
):
    started = time.perf_counter()
    event: dict[str, Any] = {"stage": stage, "status": "started"}
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


def coerce_vlm_analysis(payload: dict[str, Any]) -> VLMPageAnalysis:
    coordinate_payload = payload.get("coordinate_space") or {}
    width = int(coordinate_payload.get("width") or _max_bbox_x(payload) or 1000)
    height = int(coordinate_payload.get("height") or _max_bbox_y(payload) or 1000)
    if width <= 0 or height <= 0:
        raise ValueError("VLM coordinate_space must be positive")
    coordinate_space = VLMCoordinateSpace(
        width=width,
        height=height,
        unit=str(coordinate_payload.get("unit") or "px"),
    )
    return VLMPageAnalysis(
        coordinate_space=coordinate_space,
        text_regions=[
            VLMTextRegion(
                region_id=_region_id(item, "t", index),
                text=str(item.get("text", "")).strip(),
                bbox=_coerce_bbox(item.get("bbox"), coordinate_space),
                role=str(item.get("role") or "body"),
                color_hex=_clean_hex_color(item.get("color")),
                confidence=_coerce_confidence(item.get("confidence")),
                group_id=str(item.get("group_id") or ""),
            )
            for index, item in enumerate(_items(payload, "text_regions"), start=1)
            if str(item.get("text", "")).strip()
        ],
        bitmap_regions=[
            VLMBitmapRegion(
                region_id=_region_id(item, "b", index),
                kind=str(item.get("type") or item.get("kind") or "other"),
                bbox=_coerce_bbox(item.get("bbox"), coordinate_space),
                importance=str(item.get("importance") or ""),
                group_id=str(item.get("group_id") or ""),
            )
            for index, item in enumerate(_items(payload, "bitmap_regions"), start=1)
        ],
        shape_regions=[
            VLMShapeRegion(
                region_id=_region_id(item, "s", index),
                kind=str(item.get("type") or item.get("kind") or "other"),
                bbox=_coerce_bbox(item.get("bbox"), coordinate_space),
                importance=str(item.get("importance") or ""),
                group_id=str(item.get("group_id") or ""),
            )
            for index, item in enumerate(_items(payload, "shape_regions"), start=1)
        ],
        raw=dict(payload),
    )


def build_text_bitmap_mask(
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
    *,
    padding: int = 4,
    additional_text_bboxes: list[PixelBBox] | None = None,
) -> tuple[Image.Image, list[MaskBox]]:
    mask = Image.new("L", mapper.source_image_size, 0)
    draw = ImageDraw.Draw(mask)
    boxes: list[MaskBox] = []
    protected_bboxes = _protected_mask_bboxes(
        analysis,
        mapper,
        additional_text_bboxes=additional_text_bboxes,
    )
    for region in analysis.text_regions:
        bbox = mapper.to_source_bbox(region.bbox, padding=padding)
        draw.rectangle(bbox, fill=255)
        boxes.append(MaskBox(kind="text", region_id=region.region_id, bbox=bbox))
    for region in analysis.bitmap_regions:
        unpadded_bbox = mapper.to_source_bbox(region.bbox, padding=0)
        if _bitmap_region_should_be_ignored_as_element(unpadded_bbox, mapper.source_image_size):
            continue
        region_padding = _mask_padding_for_bitmap_region(
            region,
            unpadded_bbox,
            mapper.source_image_size,
            padding,
        )
        bbox = _expand_bbox_avoiding_protected(
            unpadded_bbox,
            padding=region_padding,
            source_image_size=mapper.source_image_size,
            protected_bboxes=protected_bboxes,
        )
        draw.rectangle(bbox, fill=255)
        boxes.append(MaskBox(kind="bitmap", region_id=region.region_id, bbox=bbox))
    for index, bbox in enumerate(additional_text_bboxes or [], start=1):
        clamped = _clamp_bbox(_pad_bbox(bbox, padding), mapper.source_image_size)
        draw.rectangle(clamped, fill=255)
        boxes.append(MaskBox(kind="ocr_text", region_id=f"ocr-{index}", bbox=clamped))
    return mask, boxes


def _local_clean_background_bboxes(
    mask_boxes: list[MaskBox],
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
) -> list[PixelBBox]:
    bitmap_regions = {region.region_id: region for region in analysis.bitmap_regions}
    cleanup_bboxes: list[PixelBBox] = []
    for box in mask_boxes:
        if box.kind in {"text", "ocr_text"}:
            cleanup_bboxes.append(box.bbox)
            continue
        if box.kind != "bitmap":
            continue
        region = bitmap_regions.get(box.region_id)
        if region is None:
            continue
        unpadded_bbox = mapper.to_source_bbox(region.bbox, padding=0)
        if _is_local_cleanable_fallback_icon(region, unpadded_bbox, mapper.source_image_size):
            cleanup_bboxes.append(unpadded_bbox)
    return cleanup_bboxes


def _is_local_cleanable_fallback_icon(
    region: VLMBitmapRegion,
    bbox: PixelBBox,
    source_image_size: tuple[int, int],
) -> bool:
    if region.kind.lower() not in CLEAN_FALLBACK_LOCAL_ICON_KINDS:
        return False
    width = max(0, bbox[2] - bbox[0])
    height = max(0, bbox[3] - bbox[1])
    source_width = max(1, source_image_size[0])
    source_height = max(1, source_image_size[1])
    area_ratio = (width * height) / float(source_width * source_height)
    dimension_ratio = max(width / source_width, height / source_height)
    return (
        area_ratio <= MAX_CLEAN_FALLBACK_LOCAL_ICON_AREA_RATIO
        and dimension_ratio <= MAX_CLEAN_FALLBACK_LOCAL_ICON_DIMENSION_RATIO
    )


def _protected_mask_bboxes(
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
    *,
    additional_text_bboxes: list[PixelBBox] | None = None,
) -> list[PixelBBox]:
    protected = [mapper.to_source_bbox(region.bbox, padding=0) for region in analysis.text_regions]
    protected.extend(
        mapper.to_source_bbox(region.bbox, padding=0) for region in analysis.shape_regions
    )
    protected.extend(additional_text_bboxes or [])
    return protected


def _expand_bbox_avoiding_protected(
    bbox: PixelBBox,
    *,
    padding: int,
    source_image_size: tuple[int, int],
    protected_bboxes: list[PixelBBox],
) -> PixelBBox:
    left, top, right, bottom = bbox
    expanded_left = left - padding
    expanded_top = top - padding
    expanded_right = right + padding
    expanded_bottom = bottom + padding
    for protected in protected_bboxes:
        protected_left, protected_top, protected_right, protected_bottom = protected
        if _ranges_overlap(top, bottom, protected_top, protected_bottom):
            if protected_right <= left:
                expanded_left = min(left, max(expanded_left, protected_right + 1))
            elif protected_left >= right:
                expanded_right = max(right, min(expanded_right, protected_left - 1))
        if _ranges_overlap(left, right, protected_left, protected_right):
            if protected_bottom <= top:
                expanded_top = min(top, max(expanded_top, protected_bottom + 1))
            elif protected_top >= bottom:
                expanded_bottom = max(bottom, min(expanded_bottom, protected_top - 1))
    return _clamp_bbox(
        (expanded_left, expanded_top, expanded_right, expanded_bottom),
        source_image_size,
    )


def build_page_manifest_from_vlm_analysis(
    *,
    analysis: VLMPageAnalysis,
    slide_id: str,
    page_index: int,
    source_image_path: str | Path,
    clean_background_path: str | Path,
    artifact_root: str | Path,
    aspect_ratio: str = "16:9",
    text_boxes: list[TextBoxSpec] | None = None,
    bitmap_assets: list[BitmapAssetSpec] | None = None,
    asset_sheets: list[AssetSheetSpec] | None = None,
) -> PageManifest:
    root = Path(artifact_root).resolve()
    source_path = Path(source_image_path).resolve()
    background_path = Path(clean_background_path).resolve()
    _require_inside(root, source_path, "source_image_path")
    _require_inside(root, background_path, "clean_background_path")
    with Image.open(source_path) as source, Image.open(background_path) as background:
        source_image_size = source.size
        source_rgb = source.convert("RGB")
        background_rgb = background.convert("RGB")
        mapper = VLMCoordinateMapper(
            analysis_space=analysis.coordinate_space,
            source_image_size=source_image_size,
        )
        resolved_bitmap_assets = (
            bitmap_assets
            if bitmap_assets is not None
            else _bitmap_assets_from_vlm(
                analysis,
                mapper,
                source_rgb,
                background_rgb,
                root=root,
                slide_id=slide_id,
                page_index=page_index,
            )
        )
        vlm_text_boxes = [
            _text_box_from_vlm(region, mapper, source_rgb) for region in analysis.text_regions
        ]
        resolved_text_boxes = _resolve_text_boxes_with_vlm_gate(
            analysis=analysis,
            mapper=mapper,
            vlm_text_boxes=vlm_text_boxes,
            ocr_text_boxes=text_boxes,
            bitmap_assets=resolved_bitmap_assets,
            source_image_size=source_image_size,
        )
        native_shapes = [
            shape
            for region in analysis.shape_regions
            for shape in _native_shapes_from_vlm(region, mapper, source_image_size)
        ]
    background_ref = _artifact_ref(background_path, root)
    return PageManifest(
        slide_id=slide_id,
        page_index=page_index,
        source_image_path=_artifact_ref(source_path, root),
        source_image_size=source_image_size,
        slide_size=_slide_size_inches(aspect_ratio),
        text_clean_background=background_ref,
        base_clean_background=background_ref,
        chosen_background=background_ref,
        text_boxes=resolved_text_boxes,
        native_shapes=native_shapes,
        bitmap_assets=resolved_bitmap_assets,
        asset_sheets=asset_sheets or [],
        provider_output_paths={},
        provenance={
            "reconstruction_strategy": "vlm_first",
            "chosen_background_kind": "source_preserving_text_clean",
            "vlm_counts": {
                "text_regions": len(analysis.text_regions),
                "bitmap_regions": len(analysis.bitmap_regions),
                "shape_regions": len(analysis.shape_regions),
            },
        },
    )


def _resolve_text_boxes_with_vlm_gate(
    *,
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
    vlm_text_boxes: list[TextBoxSpec],
    ocr_text_boxes: list[TextBoxSpec] | None,
    bitmap_assets: list[BitmapAssetSpec],
    source_image_size: tuple[int, int],
) -> list[TextBoxSpec]:
    if ocr_text_boxes is None:
        return _dedupe_overlapping_text_boxes(
            _avoid_bitmap_text_overlap(
                [
                    box
                    for box in vlm_text_boxes
                    if not _vlm_text_should_stay_baked_into_bitmap(box, bitmap_assets)
                ],
                bitmap_assets,
                source_image_size,
            )
        )
    if not analysis.text_regions:
        reliable_ocr_boxes = [
            _ocr_text_with_ocr_layout(box)
            for box in ocr_text_boxes
            if _ocr_box_is_reliable_without_vlm_text_region(box)
        ]
        if not _ocr_only_text_fallback_is_sane(reliable_ocr_boxes, source_image_size):
            return []
        return _dedupe_overlapping_text_boxes(
            _avoid_bitmap_text_overlap(
                reliable_ocr_boxes,
                bitmap_assets,
                source_image_size,
            )
        )

    resolved: list[TextBoxSpec] = []
    used_indexes: set[int] = set()
    for region_index, region in enumerate(analysis.text_regions):
        region_bbox = mapper.to_source_bbox(region.bbox, padding=8)
        candidates = [
            (index, box, _ocr_match_score(region, region_bbox, box))
            for index, box in enumerate(ocr_text_boxes)
            if index not in used_indexes
        ]
        matches = [(index, box, score) for index, box, score in candidates if score >= 0.35]
        if not matches:
            if region_index < len(vlm_text_boxes):
                vlm_box = vlm_text_boxes[region_index]
                duplicate_ocr = _nearby_ocr_duplicate_for_vlm_fallback(
                    vlm_box,
                    [
                        (index, box)
                        for index, box in enumerate(ocr_text_boxes)
                        if index not in used_indexes
                    ],
                )
                if duplicate_ocr is not None:
                    duplicate_index, duplicate_box = duplicate_ocr
                    used_indexes.add(duplicate_index)
                    resolved.append(_ocr_text_with_ocr_layout(duplicate_box))
                    continue
                if _vlm_text_should_stay_baked_into_bitmap(vlm_box, bitmap_assets):
                    continue
                if not _vlm_fallback_is_already_represented(vlm_box, resolved):
                    resolved.append(vlm_box)
            continue
        matches.sort(
            key=lambda item: (
                item[1].source_pixel_bbox[1],
                item[1].source_pixel_bbox[0],
                -item[2],
            )
        )
        region_matches = matches[:4]
        for index, _box, _score in region_matches:
            used_indexes.add(index)
        if len(region_matches) > 1 and region_index < len(vlm_text_boxes):
            vlm_box = vlm_text_boxes[region_index]
            merged_ocr_box = _merged_ocr_text_box_for_guard(
                [box for _index, box, _score in region_matches]
            )
            if _should_keep_high_confidence_vlm_text_over_ocr(region, merged_ocr_box, vlm_box):
                resolved.append(vlm_box)
                continue
        if len(region_matches) == 1 and region_index < len(vlm_text_boxes):
            _index, box, _score = region_matches[0]
            vlm_box = vlm_text_boxes[region_index]
            if _should_keep_high_confidence_vlm_text_over_ocr(region, box, vlm_box):
                resolved.append(vlm_box)
                continue
            if _is_short_text(box.text) or _should_keep_ocr_layout_for_exact_text(box, vlm_box):
                resolved.append(_ocr_text_with_ocr_layout(box))
            else:
                resolved.append(_ocr_text_with_vlm_layout(box, vlm_box))
            continue
        for _index, box, _score in region_matches:
            resolved.append(_ocr_text_with_ocr_layout(box))
    return _dedupe_overlapping_text_boxes(
        _avoid_bitmap_text_overlap(resolved, bitmap_assets, source_image_size)
    )


def _vlm_fallback_is_already_represented(
    vlm_box: TextBoxSpec,
    existing_boxes: list[TextBoxSpec],
) -> bool:
    normalized = _normalize_text_for_match(vlm_box.text)
    if not normalized:
        return False
    for existing in existing_boxes:
        if _normalize_text_for_match(existing.text) != normalized:
            continue
        overlap = _bbox_intersection_area(vlm_box.source_pixel_bbox, existing.source_pixel_bbox)
        smaller_area = min(
            _bbox_area(vlm_box.source_pixel_bbox), _bbox_area(existing.source_pixel_bbox)
        )
        if overlap / max(1, smaller_area) >= 0.45:
            return True
        if _text_boxes_are_nearby_ocr_vlm_duplicates(existing, vlm_box):
            return True
    return False


def _ocr_box_is_reliable_without_vlm_text_region(box: TextBoxSpec) -> bool:
    text = _normalize_text_for_match(box.text)
    if not text:
        return False
    confidence = float(box.provenance.get("ocr_confidence", 0.0) or 0.0)
    if confidence >= 0.85:
        return True
    return confidence >= 0.75 and len(text) >= 4


def _ocr_only_text_fallback_is_sane(
    boxes: list[TextBoxSpec],
    source_image_size: tuple[int, int],
) -> bool:
    if not boxes:
        return True
    if len(boxes) > 40:
        return False
    normalized_lengths = [len(_normalize_text_for_match(box.text)) for box in boxes]
    if (
        len(boxes) > 20
        and sum(1 for length in normalized_lengths if length <= 1) / len(boxes) >= 0.65
    ):
        return False
    page_area = max(1, int(source_image_size[0]) * int(source_image_size[1]))
    combined_bbox_ratio = _combined_bbox_coverage_ratio(
        [box.source_pixel_bbox for box in boxes],
        source_image_size,
    )
    summed_text_area_ratio = min(
        1.0,
        sum(_bbox_area(box.source_pixel_bbox) for box in boxes) / float(page_area),
    )
    return combined_bbox_ratio <= 0.55 and summed_text_area_ratio <= 0.35


def _vlm_text_should_stay_baked_into_bitmap(
    text_box: TextBoxSpec,
    bitmap_assets: list[BitmapAssetSpec],
) -> bool:
    if float(text_box.provenance.get("confidence", 1.0) or 0.0) >= 0.80:
        return False
    if text_box.style_hints.get("vlm_role") not in {"label", "body"}:
        return False
    if len(_normalize_text_for_match(text_box.text)) > 8:
        return False
    return any(
        _bitmap_asset_is_major_visual(asset)
        and _text_box_is_inside_or_near_bitmap(text_box.source_pixel_bbox, asset.source_pixel_bbox)
        for asset in bitmap_assets
    )


def _bitmap_asset_is_major_visual(asset: BitmapAssetSpec) -> bool:
    provenance = dict(asset.provenance)
    kind = str(
        provenance.get("vlm_type")
        or (provenance.get("candidate_provenance") or {}).get("vlm_type")
        or ""
    ).lower()
    return kind in {"product", "photo", "component"}


def _text_box_is_inside_or_near_bitmap(text_bbox: PixelBBox, asset_bbox: PixelBBox) -> bool:
    text_center_y = (text_bbox[1] + text_bbox[3]) / 2.0
    asset_height = max(1, asset_bbox[3] - asset_bbox[1])
    if not (
        asset_bbox[1] - asset_height * 0.10 <= text_center_y <= asset_bbox[3] + asset_height * 0.10
    ):
        return False
    horizontal_overlap = min(text_bbox[2], asset_bbox[2]) - max(text_bbox[0], asset_bbox[0])
    if horizontal_overlap > 0:
        return True
    horizontal_gap = max(asset_bbox[0] - text_bbox[2], text_bbox[0] - asset_bbox[2])
    return horizontal_gap <= max(32, round((asset_bbox[2] - asset_bbox[0]) * 0.08))


def _nearby_ocr_duplicate_for_vlm_fallback(
    vlm_box: TextBoxSpec,
    ocr_candidates: list[tuple[int, TextBoxSpec]],
) -> tuple[int, TextBoxSpec] | None:
    matches = [
        (index, box)
        for index, box in ocr_candidates
        if _text_boxes_are_nearby_ocr_vlm_duplicates(box, vlm_box)
    ]
    if not matches:
        return None
    matches.sort(key=lambda item: _text_box_quality_score(item[1]), reverse=True)
    return matches[0]


def _text_boxes_are_nearby_ocr_vlm_duplicates(
    ocr_box: TextBoxSpec,
    vlm_box: TextBoxSpec,
) -> bool:
    if not _normalized_texts_are_exact_duplicate(ocr_box.text, vlm_box.text):
        return False
    if ocr_box.provenance.get("content_source") != "ocr":
        return False
    ocr_bbox = ocr_box.source_pixel_bbox
    vlm_bbox = vlm_box.source_pixel_bbox
    horizontal_overlap = min(ocr_bbox[2], vlm_bbox[2]) - max(ocr_bbox[0], vlm_bbox[0])
    if horizontal_overlap <= 0:
        return False
    smaller_width = min(max(1, ocr_bbox[2] - ocr_bbox[0]), max(1, vlm_bbox[2] - vlm_bbox[0]))
    if horizontal_overlap / smaller_width < 0.55:
        return False
    if _bbox_intersection_area(ocr_bbox, vlm_bbox) > 0:
        return True
    ocr_width = max(1, ocr_bbox[2] - ocr_bbox[0])
    ocr_height = max(1, ocr_bbox[3] - ocr_bbox[1])
    vlm_width = max(1, vlm_bbox[2] - vlm_bbox[0])
    vlm_height = max(1, vlm_bbox[3] - vlm_bbox[1])
    if vlm_width / ocr_width < 1.45 and vlm_height / ocr_height < 1.8:
        return False
    vertical_gap = max(ocr_bbox[1], vlm_bbox[1]) - min(ocr_bbox[3], vlm_bbox[3])
    max_height = max(ocr_height, vlm_height)
    return 0 <= vertical_gap <= max_height * 1.25


def _ocr_text_with_vlm_layout(ocr_box: TextBoxSpec, vlm_box: TextBoxSpec) -> TextBoxSpec:
    provenance = dict(ocr_box.provenance)
    provenance["content_source"] = provenance.get("content_source") or "ocr"
    provenance["layout_source"] = "vlm"
    provenance["ocr_layout_bbox"] = list(ocr_box.source_pixel_bbox)
    style_hints = dict(vlm_box.style_hints)
    style_hints.update(ocr_box.style_hints)
    style_hints["approximate_layout"] = True
    return replace(
        ocr_box,
        source_pixel_bbox=vlm_box.source_pixel_bbox,
        source_pixel_polygon=vlm_box.source_pixel_polygon,
        font_size=vlm_box.font_size,
        alignment=vlm_box.alignment,
        style_hints=style_hints,
        provenance=provenance,
    )


def _should_keep_high_confidence_vlm_text_over_ocr(
    region: VLMTextRegion,
    ocr_box: TextBoxSpec,
    vlm_box: TextBoxSpec,
) -> bool:
    if _should_keep_medium_confidence_vlm_text_over_fragmentary_ocr(region, ocr_box, vlm_box):
        return True
    if region.confidence < 0.90:
        return False
    if float(ocr_box.provenance.get("ocr_confidence", 0.0) or 0.0) >= 0.90:
        return False
    if _low_confidence_ocr_text_is_safe_for_high_confidence_vlm(region.text, ocr_box.text):
        return False
    return bool(_normalize_text_for_match(vlm_box.text))


def _should_keep_medium_confidence_vlm_text_over_fragmentary_ocr(
    region: VLMTextRegion,
    ocr_box: TextBoxSpec,
    vlm_box: TextBoxSpec,
) -> bool:
    if region.confidence < 0.80:
        return False
    if float(ocr_box.provenance.get("ocr_confidence", 0.0) or 0.0) >= 0.90:
        return False
    normalized_vlm = _normalize_text_for_match(vlm_box.text)
    normalized_ocr = _normalize_text_for_match(ocr_box.text)
    if len(normalized_vlm) < 6 or not normalized_ocr:
        return False
    if normalized_vlm == normalized_ocr:
        return False
    coverage = len(normalized_ocr) / max(1, len(normalized_vlm))
    if normalized_ocr in normalized_vlm:
        return coverage < 0.92
    if coverage <= 0.55:
        return True
    return _text_similarity(vlm_box.text, ocr_box.text) < 0.55


def _merged_ocr_text_box_for_guard(ocr_boxes: list[TextBoxSpec]) -> TextBoxSpec:
    if not ocr_boxes:
        raise ValueError("ocr_boxes are required")
    ordered = sorted(
        ocr_boxes, key=lambda box: (box.source_pixel_bbox[1], box.source_pixel_bbox[0])
    )
    left = min(box.source_pixel_bbox[0] for box in ordered)
    top = min(box.source_pixel_bbox[1] for box in ordered)
    right = max(box.source_pixel_bbox[2] for box in ordered)
    bottom = max(box.source_pixel_bbox[3] for box in ordered)
    confidences = [float(box.provenance.get("ocr_confidence", 0.0) or 0.0) for box in ordered]
    provenance = dict(ordered[0].provenance)
    provenance["ocr_confidence"] = max(confidences) if confidences else 0.0
    provenance["merged_ocr_fragment_count"] = len(ordered)
    return replace(
        ordered[0],
        text="".join(box.text for box in ordered),
        source_pixel_bbox=(left, top, right, bottom),
        source_pixel_polygon=_bbox_polygon((left, top, right, bottom)),
        provenance=provenance,
    )


def _low_confidence_ocr_text_is_safe_for_high_confidence_vlm(vlm_text: str, ocr_text: str) -> bool:
    normalized_vlm = _normalize_text_for_match(vlm_text)
    normalized_ocr = _normalize_text_for_match(ocr_text)
    if not normalized_vlm or not normalized_ocr:
        return False
    if normalized_vlm == normalized_ocr:
        return True
    if normalized_vlm in normalized_ocr:
        return len(normalized_vlm) / max(1, len(normalized_ocr)) >= 0.92
    if normalized_ocr in normalized_vlm:
        return len(normalized_ocr) / max(1, len(normalized_vlm)) >= 0.92
    return _text_similarity(vlm_text, ocr_text) >= 0.82


def _ocr_text_with_ocr_layout(ocr_box: TextBoxSpec) -> TextBoxSpec:
    provenance = dict(ocr_box.provenance)
    provenance["content_source"] = provenance.get("content_source") or "ocr"
    provenance["layout_source"] = "ocr"
    return replace(ocr_box, provenance=provenance)


def _is_short_text(text: str) -> bool:
    return 0 < len(_normalize_text_for_match(text)) <= 3


def _should_keep_ocr_layout_for_exact_text(ocr_box: TextBoxSpec, vlm_box: TextBoxSpec) -> bool:
    if not _normalized_texts_are_exact_duplicate(ocr_box.text, vlm_box.text):
        return False
    vertical_center_close = _vertical_center_distance(
        ocr_box.source_pixel_bbox, vlm_box.source_pixel_bbox
    ) <= max(
        ocr_box.source_pixel_bbox[3] - ocr_box.source_pixel_bbox[1],
        vlm_box.source_pixel_bbox[3] - vlm_box.source_pixel_bbox[1],
    )
    ocr_width = ocr_box.source_pixel_bbox[2] - ocr_box.source_pixel_bbox[0]
    vlm_width = vlm_box.source_pixel_bbox[2] - vlm_box.source_pixel_bbox[0]
    if (
        vertical_center_close
        and ocr_width >= vlm_width * 1.15
        and ocr_box.source_pixel_bbox[0] < vlm_box.source_pixel_bbox[0]
    ):
        return True
    if (
        vertical_center_close
        and len(_normalize_text_for_match(ocr_box.text)) >= 8
        and ocr_box.source_pixel_bbox[0]
        <= vlm_box.source_pixel_bbox[0] - max(24, int(vlm_width * 0.05))
        and ocr_width >= vlm_width * 0.90
    ):
        return True
    overlap = _bbox_intersection_area(ocr_box.source_pixel_bbox, vlm_box.source_pixel_bbox)
    smaller_area = min(_bbox_area(ocr_box.source_pixel_bbox), _bbox_area(vlm_box.source_pixel_bbox))
    if overlap / max(1, smaller_area) >= 0.45:
        return False
    return vertical_center_close


def _vertical_center_distance(left: PixelBBox, right: PixelBBox) -> float:
    return abs(((left[1] + left[3]) / 2.0) - ((right[1] + right[3]) / 2.0))


def _avoid_bitmap_text_overlap(
    text_boxes: list[TextBoxSpec],
    bitmap_assets: list[BitmapAssetSpec],
    source_image_size: tuple[int, int],
) -> list[TextBoxSpec]:
    if not text_boxes or not bitmap_assets:
        return text_boxes
    margin = max(8, round(source_image_size[0] * 0.01))
    adjusted: list[TextBoxSpec] = []
    for text_box in text_boxes:
        if text_box.provenance.get("layout_source") == "ocr" and _is_short_text(text_box.text):
            adjusted.append(text_box)
            continue
        bbox = text_box.source_pixel_bbox
        width = bbox[2] - bbox[0]
        shifted_left = bbox[0]
        for asset in bitmap_assets:
            asset_bbox = asset.source_pixel_bbox
            if not _same_horizontal_band(bbox, asset_bbox):
                continue
            if _horizontal_overlap_ratio(bbox, asset_bbox) < 0.25:
                continue
            if asset_bbox[0] > (bbox[0] + bbox[2]) / 2:
                continue
            if asset_bbox[2] + margin <= shifted_left:
                continue
            shifted_left = max(shifted_left, asset_bbox[2] + margin)
        if shifted_left == bbox[0]:
            adjusted.append(text_box)
            continue
        shifted_right = min(source_image_size[0], shifted_left + width)
        shifted_left = max(0, shifted_right - width)
        shifted_bbox = (shifted_left, bbox[1], shifted_right, bbox[3])
        adjusted.append(
            replace(
                text_box,
                source_pixel_bbox=shifted_bbox,
                source_pixel_polygon=_bbox_polygon(shifted_bbox),
            )
        )
    return adjusted


def _horizontal_overlap_ratio(left: PixelBBox, right: PixelBBox) -> float:
    overlap = min(left[2], right[2]) - max(left[0], right[0])
    if overlap <= 0:
        return 0.0
    return overlap / max(1, left[2] - left[0])


def _dedupe_overlapping_text_boxes(text_boxes: list[TextBoxSpec]) -> list[TextBoxSpec]:
    kept: list[TextBoxSpec] = []
    for candidate in text_boxes:
        duplicate_index = next(
            (
                index
                for index, existing in enumerate(kept)
                if _text_boxes_are_overlapping_duplicates(existing, candidate)
            ),
            None,
        )
        if duplicate_index is None:
            kept.append(candidate)
            continue
        if _text_box_quality_score(candidate) > _text_box_quality_score(kept[duplicate_index]):
            kept[duplicate_index] = candidate
    return kept


def _text_boxes_are_overlapping_duplicates(left: TextBoxSpec, right: TextBoxSpec) -> bool:
    if not _normalized_texts_are_exact_duplicate(left.text, right.text):
        return False
    overlap = _bbox_intersection_area(left.source_pixel_bbox, right.source_pixel_bbox)
    if overlap <= 0:
        return False
    smaller_area = min(_bbox_area(left.source_pixel_bbox), _bbox_area(right.source_pixel_bbox))
    larger_area = max(_bbox_area(left.source_pixel_bbox), _bbox_area(right.source_pixel_bbox))
    return overlap / max(1, smaller_area) >= 0.70 and overlap / max(1, larger_area) >= 0.45


def _normalized_texts_are_exact_duplicate(left: str, right: str) -> bool:
    normalized_left = _normalize_text_for_match(left)
    normalized_right = _normalize_text_for_match(right)
    if normalized_left != normalized_right:
        return False
    return len(normalized_left) >= 4


def _text_box_quality_score(text_box: TextBoxSpec) -> float:
    provenance = text_box.provenance
    score = float(provenance.get("ocr_confidence", 0.0) or 0.0)
    if provenance.get("content_source") == "ocr":
        score += 100.0
    if provenance.get("layout_source") == "ocr":
        score += 5.0
    if provenance.get("layout_source") == "vlm":
        score += 3.0
    return score


def _same_horizontal_band(left: PixelBBox, right: PixelBBox) -> bool:
    top = max(left[1], right[1])
    bottom = min(left[3], right[3])
    if bottom <= top:
        return False
    text_height = max(1, left[3] - left[1])
    return (bottom - top) / text_height >= 0.45


def _foreground_rgba_crop(
    source_rgb: Image.Image,
    background_rgb: Image.Image,
    bbox: PixelBBox,
    *,
    tolerance: int = 36,
    transparent_bboxes: list[PixelBBox] | None = None,
) -> Image.Image:
    source_crop = source_rgb.crop(bbox).convert("RGBA")
    background_crop = background_rgb.crop(bbox).convert("RGB")
    source_pixels = source_crop.load()
    background_pixels = background_crop.load()
    width, height = source_crop.size
    visited: set[tuple[int, int]] = set()
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if (x, y) in visited or not (0 <= x < width and 0 <= y < height):
            continue
        visited.add((x, y))
        if not _pixel_matches_background(source_pixels[x, y], background_pixels[x, y], tolerance):
            continue
        source_pixel = source_pixels[x, y]
        source_pixels[x, y] = (source_pixel[0], source_pixel[1], source_pixel[2], 0)
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    _clear_crop_regions(source_crop, bbox, transparent_bboxes or [])
    return source_crop


def _clear_crop_regions(
    crop: Image.Image, crop_bbox: PixelBBox, transparent_bboxes: list[PixelBBox]
) -> None:
    if not transparent_bboxes:
        return
    pixels = crop.load()
    width, height = crop.size
    for box in transparent_bboxes:
        left = max(0, int(box[0]) - crop_bbox[0])
        top = max(0, int(box[1]) - crop_bbox[1])
        right = min(width, int(box[2]) - crop_bbox[0])
        bottom = min(height, int(box[3]) - crop_bbox[1])
        if right <= left or bottom <= top:
            continue
        for y in range(top, bottom):
            for x in range(left, right):
                pixel = pixels[x, y]
                pixels[x, y] = (pixel[0], pixel[1], pixel[2], 0)


def _pixel_matches_background(
    source_pixel: tuple[int, ...], background_pixel: tuple[int, ...], tolerance: int
) -> bool:
    delta = (
        abs(source_pixel[0] - background_pixel[0])
        + abs(source_pixel[1] - background_pixel[1])
        + abs(source_pixel[2] - background_pixel[2])
    )
    return delta <= tolerance


def _create_vlm_asset_sheet_assets(
    *,
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
    source_image_path: str | Path,
    artifacts: GenerativeEditableJobArtifacts,
    slide_id: str,
    page_index: int,
    edit_provider: ImageEditProvider,
    timeout_seconds: int,
    additional_text_bboxes: list[PixelBBox] | None = None,
    force_opaque_source_crops: bool = False,
) -> tuple[list[BitmapAssetSpec], list[AssetSheetSpec], Path | None]:
    text_bboxes = [
        mapper.to_source_bbox(region.bbox, padding=8) for region in analysis.text_regions
    ]
    text_bboxes.extend(_pad_bbox(bbox, 8) for bbox in additional_text_bboxes or [])
    candidates = _foreground_candidates_from_vlm_bitmap_regions(analysis, mapper)
    candidates = _refine_candidates_with_clean_background_difference(
        candidates=candidates,
        source_image_path=source_image_path,
        clean_background_path=artifacts.asset_path(
            slide_id, page_index, "backgrounds", "vlm-clean.png"
        ),
    )
    candidates = _bridge_narrow_same_group_complex_candidates(candidates)
    if not candidates:
        return [], [], None
    source_preserved_candidates = [
        candidate for candidate in candidates if not _candidate_should_use_asset_sheet(candidate)
    ]
    asset_sheet_candidates = [
        candidate for candidate in candidates if _candidate_should_use_asset_sheet(candidate)
    ]
    source_preserved_assets = _source_preserved_bitmap_assets_from_candidates(
        candidates=source_preserved_candidates,
        source_image_path=source_image_path,
        clean_background_path=artifacts.asset_path(
            slide_id, page_index, "backgrounds", "vlm-clean.png"
        ),
        artifact_root=artifacts.job_dir,
        slide_id=slide_id,
        page_index=page_index,
        reason="source_preserved_bitmap_region",
        transparent_bboxes=text_bboxes,
        force_opaque_source_crops=force_opaque_source_crops,
    )
    if not asset_sheet_candidates:
        return _with_candidate_z_order(source_preserved_assets, candidates), [], None
    sheet_path = artifacts.asset_path(slide_id, page_index, "asset_sheets", "vlm-asset-sheet.png")
    request = build_asset_sheet_request(
        source_image_path=source_image_path,
        candidates=asset_sheet_candidates,
        output_asset_path=sheet_path,
        asset_root=artifacts.job_dir,
        provider_role=edit_provider.config.role,
        timeout_seconds=timeout_seconds,
    )
    try:
        result = edit_provider.edit(request)
    except ProviderError as exc:
        assets = _source_preserved_bitmap_assets_from_candidates(
            candidates=asset_sheet_candidates,
            source_image_path=source_image_path,
            clean_background_path=artifacts.asset_path(
                slide_id, page_index, "backgrounds", "vlm-clean.png"
            ),
            artifact_root=artifacts.job_dir,
            slide_id=slide_id,
            page_index=page_index,
            reason=str(exc),
            asset_sheet_provider_failed=True,
            transparent_bboxes=text_bboxes,
            force_opaque_source_crops=force_opaque_source_crops,
        )
        provider_output_path = artifacts.write_provider_output(
            slide_id,
            page_index,
            "asset_sheet",
            "asset-sheet.json",
            {
                "status": "source_preserved_fallback",
                "error_type": type(exc).__name__,
                "error": str(exc),
                "bitmap_assets": [asdict(asset) for asset in assets],
                "candidate_ids": [candidate.candidate_id for candidate in asset_sheet_candidates],
            },
        )
        combined_assets = _with_candidate_z_order(source_preserved_assets + assets, candidates)
        return combined_assets, [], provider_output_path
    try:
        assets = slice_asset_sheet_by_components(
            sheet_path=result.output_asset_path,
            candidates=asset_sheet_candidates,
            output_dir=artifacts.job_dir / "assets" / f"{page_index:04d}-{_safe_name(slide_id)}",
            asset_root=artifacts.job_dir,
            allow_extra_components=True,
        )
    except ValueError as exc:
        assets = _source_preserved_bitmap_assets_from_candidates(
            candidates=asset_sheet_candidates,
            source_image_path=source_image_path,
            clean_background_path=artifacts.asset_path(
                slide_id, page_index, "backgrounds", "vlm-clean.png"
            ),
            artifact_root=artifacts.job_dir,
            slide_id=slide_id,
            page_index=page_index,
            reason=str(exc),
            asset_sheet_slicing_failed=True,
            transparent_bboxes=text_bboxes,
            force_opaque_source_crops=force_opaque_source_crops,
        )
        provider_output_path = artifacts.write_provider_output(
            slide_id,
            page_index,
            "asset_sheet",
            "asset-sheet.json",
            {
                "status": "source_preserved_fallback",
                "error_type": type(exc).__name__,
                "error": str(exc),
                "sheet_path": _artifact_ref(Path(result.output_asset_path), artifacts.job_dir),
                "bitmap_assets": [
                    asdict(asset)
                    for asset in _with_candidate_z_order(
                        source_preserved_assets + assets, candidates
                    )
                ],
                "candidate_ids": [candidate.candidate_id for candidate in asset_sheet_candidates],
                "provider_role": result.provider_role,
                "provider_name": result.provider_name,
                "model": result.model,
                "prompt_id": result.prompt_id,
            },
        )
        combined_assets = _with_candidate_z_order(source_preserved_assets + assets, candidates)
        return combined_assets, [], provider_output_path
    assets = _select_source_faithful_bitmap_assets(
        generated_assets=assets,
        source_image_path=source_image_path,
        clean_background_path=artifacts.asset_path(
            slide_id, page_index, "backgrounds", "vlm-clean.png"
        ),
        artifact_root=artifacts.job_dir,
        slide_id=slide_id,
        page_index=page_index,
        transparent_bboxes=text_bboxes,
    )
    combined_assets = _with_candidate_z_order(source_preserved_assets + assets, candidates)
    asset_sheet = AssetSheetSpec(
        sheet_id=f"vlm-asset-sheet-{page_index:04d}",
        asset_path=_artifact_ref(Path(result.output_asset_path), artifacts.job_dir),
        prompt_id=result.prompt_id,
        candidate_ids=[candidate.candidate_id for candidate in asset_sheet_candidates],
        provider_role=result.provider_role,
        provenance={
            "provider": result.provider_name,
            "model": result.model,
            "source": "vlm_bitmap_regions",
            "candidate_count": len(asset_sheet_candidates),
            "source_preserved_candidate_count": len(source_preserved_candidates),
        },
    )
    provider_output_path = artifacts.write_provider_output(
        slide_id,
        page_index,
        "asset_sheet",
        "asset-sheet.json",
        {
            "sheet": asdict(asset_sheet),
            "bitmap_assets": [asdict(asset) for asset in combined_assets],
            "candidate_ids": [candidate.candidate_id for candidate in asset_sheet_candidates],
            "provider_role": result.provider_role,
            "provider_name": result.provider_name,
            "model": result.model,
            "prompt_id": result.prompt_id,
        },
    )
    return combined_assets, [asset_sheet], provider_output_path


def _candidate_should_use_asset_sheet(candidate: ForegroundCandidate) -> bool:
    return candidate.classification == "bitmap_asset_candidate" and not _candidate_is_vlm_icon(
        candidate
    )


def _candidate_is_vlm_icon(candidate: ForegroundCandidate) -> bool:
    provenance = candidate.provenance or {}
    return str(provenance.get("vlm_type") or "").lower() in {"icon", "ui_icon", "small_icon"}


def _source_preserved_skip_reason_for_candidate(candidate: ForegroundCandidate) -> str:
    if _candidate_is_vlm_icon(candidate):
        return "icon_source_preserved"
    if candidate.classification == "complex_whole_visual":
        return "complex_bitmap_region"
    return ""


def _with_candidate_z_order(
    assets: list[BitmapAssetSpec],
    candidates: list[ForegroundCandidate],
) -> list[BitmapAssetSpec]:
    order = {candidate.candidate_id: index for index, candidate in enumerate(candidates, start=1)}
    return [
        replace(asset, z_order=order.get(asset.asset_id, asset.z_order))
        for asset in sorted(assets, key=lambda item: order.get(item.asset_id, item.z_order))
    ]


def _provenance_with_optional_asset_sheet_status(
    *,
    base: dict[str, Any],
    provider_failed: bool,
    slicing_failed: bool,
    skipped_reason: str,
    reason: str,
) -> dict[str, Any]:
    provenance = dict(base)
    if provider_failed:
        provenance["asset_sheet_provider_failed"] = True
        provenance["asset_sheet_error"] = reason
    if slicing_failed:
        provenance["asset_sheet_slicing_failed"] = True
        provenance["asset_sheet_error"] = reason
    if skipped_reason:
        provenance["asset_sheet_skipped_reason"] = skipped_reason
    return provenance


def _source_preserved_bitmap_assets_from_candidates(
    *,
    candidates: list[ForegroundCandidate],
    source_image_path: str | Path,
    clean_background_path: str | Path,
    artifact_root: str | Path,
    slide_id: str,
    page_index: int,
    reason: str,
    asset_sheet_provider_failed: bool = False,
    asset_sheet_slicing_failed: bool = False,
    asset_sheet_skipped_reason: str = "",
    fallback_padding: int = 8,
    transparent_bboxes: list[PixelBBox] | None = None,
    force_opaque_source_crops: bool = False,
) -> list[BitmapAssetSpec]:
    if not candidates:
        return []
    root = Path(artifact_root).resolve()
    output_dir = root / "assets" / f"{page_index:04d}-{_safe_name(slide_id)}"
    output_dir.mkdir(parents=True, exist_ok=True)
    assets: list[BitmapAssetSpec] = []
    with (
        Image.open(source_image_path) as source_image,
        Image.open(clean_background_path) as background_image,
    ):
        source_rgb = source_image.convert("RGB")
        background_rgb = background_image.convert("RGB").resize(source_rgb.size)
        for index, candidate in enumerate(candidates, start=1):
            candidate_skipped_reason = asset_sheet_skipped_reason
            if (
                not candidate_skipped_reason
                and not asset_sheet_provider_failed
                and not asset_sheet_slicing_failed
            ):
                candidate_skipped_reason = _source_preserved_skip_reason_for_candidate(candidate)
            bbox = _clamp_bbox(
                _pad_bbox(candidate.source_pixel_bbox, fallback_padding),
                source_rgb.size,
            )
            use_opaque_crop = (
                force_opaque_source_crops or candidate.classification == "complex_whole_visual"
            )
            if use_opaque_crop:
                crop = source_rgb.crop(bbox).convert("RGBA")
                _clear_crop_regions(crop, bbox, transparent_bboxes or [])
            else:
                crop = _foreground_rgba_crop(
                    source_rgb,
                    background_rgb,
                    bbox,
                    transparent_bboxes=transparent_bboxes or [],
                )
            visible_pixel_count = _alpha_visible_pixel_count(crop)
            source_area = max(1, source_rgb.size[0] * source_rgb.size[1])
            alpha_provenance = (
                {
                    "alpha_strategy": "opaque_source_crop",
                    "alpha_visible_pixel_count": visible_pixel_count,
                    "alpha_visible_area_ratio": round(visible_pixel_count / float(source_area), 6),
                }
                if use_opaque_crop
                else {
                    "background_difference_alpha": True,
                    "alpha_visible_pixel_count": visible_pixel_count,
                    "alpha_visible_area_ratio": round(visible_pixel_count / float(source_area), 6),
                }
            )
            output_path = output_dir / f"{_safe_name(candidate.candidate_id)}.source-preserved.png"
            crop.save(output_path)
            assets.append(
                BitmapAssetSpec(
                    asset_id=candidate.candidate_id,
                    source_pixel_bbox=bbox,
                    asset_path=_artifact_ref(output_path, root),
                    z_order=index,
                    provenance=_provenance_with_optional_asset_sheet_status(
                        base={
                            "candidate_id": candidate.candidate_id,
                            "candidate_classification": candidate.classification,
                            "candidate_provenance": dict(candidate.provenance),
                            "asset_strategy": "source_preserved_crop",
                            "original_source_pixel_bbox": list(candidate.source_pixel_bbox),
                            **alpha_provenance,
                        },
                        provider_failed=asset_sheet_provider_failed,
                        slicing_failed=asset_sheet_slicing_failed,
                        skipped_reason=candidate_skipped_reason,
                        reason=reason,
                    ),
                )
            )
    return assets


def _alpha_visible_pixel_count(image: Image.Image) -> int:
    alpha = image.convert("RGBA").getchannel("A")
    histogram = alpha.histogram()
    return sum(histogram[1:])


def _select_source_faithful_bitmap_assets(
    *,
    generated_assets: list[BitmapAssetSpec],
    source_image_path: str | Path,
    clean_background_path: str | Path,
    artifact_root: str | Path,
    slide_id: str,
    page_index: int,
    generated_headroom: float = 0.9,
    fallback_padding: int = 8,
    transparent_bboxes: list[PixelBBox] | None = None,
) -> list[BitmapAssetSpec]:
    if not generated_assets:
        return []
    root = Path(artifact_root).resolve()
    source_path = Path(source_image_path).resolve()
    background_path = Path(clean_background_path).resolve()
    output_dir = root / "assets" / f"{page_index:04d}-{_safe_name(slide_id)}"
    output_dir.mkdir(parents=True, exist_ok=True)
    selected: list[BitmapAssetSpec] = []
    with Image.open(source_path) as source_image, Image.open(background_path) as background_image:
        source_rgb = source_image.convert("RGB")
        background_rgb = background_image.convert("RGB").resize(source_rgb.size)
        for asset in generated_assets:
            generated_path = root / asset.asset_path
            source_crop = _foreground_rgba_crop(
                source_rgb,
                background_rgb,
                asset.source_pixel_bbox,
                transparent_bboxes=transparent_bboxes or [],
            )
            source_score = _asset_reconstruction_delta(
                source_crop, source_rgb, background_rgb, asset.source_pixel_bbox
            )
            with Image.open(generated_path) as generated_image:
                generated_rgba = generated_image.convert("RGBA")
            generated_score = _asset_reconstruction_delta(
                generated_rgba,
                source_rgb,
                background_rgb,
                asset.source_pixel_bbox,
            )
            if generated_score <= source_score * generated_headroom:
                selected.append(
                    replace(
                        asset,
                        provenance={
                            **asset.provenance,
                            "asset_strategy": "asset_sheet",
                            "asset_sheet_score": round(generated_score, 4),
                            "source_preserved_score": round(source_score, 4),
                        },
                    )
                )
                continue
            fallback_bbox = _clamp_bbox(
                _pad_bbox(asset.source_pixel_bbox, fallback_padding),
                source_rgb.size,
            )
            fallback_crop = _foreground_rgba_crop(
                source_rgb,
                background_rgb,
                fallback_bbox,
                transparent_bboxes=transparent_bboxes or [],
            )
            output_path = output_dir / f"{_safe_name(asset.asset_id)}.source-preserved.png"
            fallback_crop.save(output_path)
            selected.append(
                replace(
                    asset,
                    source_pixel_bbox=fallback_bbox,
                    asset_path=_artifact_ref(output_path, root),
                    provenance={
                        **asset.provenance,
                        "asset_strategy": "source_preserved_crop",
                        "asset_sheet_qa_failed": True,
                        "original_source_pixel_bbox": list(asset.source_pixel_bbox),
                        "asset_sheet_score": round(generated_score, 4),
                        "source_preserved_score": round(source_score, 4),
                    },
                )
            )
    return selected


def _asset_reconstruction_delta(
    asset_rgba: Image.Image,
    source_rgb: Image.Image,
    background_rgb: Image.Image,
    bbox: PixelBBox,
) -> float:
    left, top, right, bottom = bbox
    width = max(1, right - left)
    height = max(1, bottom - top)
    target = source_rgb.crop(bbox).convert("RGB")
    base = background_rgb.crop(bbox).convert("RGBA")
    asset = asset_rgba.convert("RGBA")
    if asset.size != (width, height):
        asset = asset.resize((width, height), Image.Resampling.LANCZOS)
    base.alpha_composite(asset, (0, 0))
    diff = ImageChops.difference(target, base.convert("RGB"))
    return sum(ImageStat.Stat(diff).mean) / 3.0


def _foreground_candidates_from_vlm_bitmap_regions(
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
) -> list[ForegroundCandidate]:
    candidates: list[ForegroundCandidate] = []
    for region in analysis.bitmap_regions:
        bbox = mapper.to_source_bbox(region.bbox, padding=0)
        if _bitmap_region_should_be_ignored_as_element(bbox, mapper.source_image_size):
            continue
        classification = (
            "complex_whole_visual"
            if region.kind.lower() in {"photo", "product", "component", "qr", "complex", "other"}
            else "bitmap_asset_candidate"
        )
        candidates.append(
            ForegroundCandidate(
                candidate_id=region.region_id,
                source_pixel_bbox=bbox,
                area=(bbox[2] - bbox[0]) * (bbox[3] - bbox[1]),
                classification=classification,
                confidence=0.8,
                provenance={
                    "provider_role": "VLM",
                    "vlm_type": region.kind,
                    "importance": region.importance,
                    "group_id": region.group_id,
                    "source": "vlm_bitmap_region",
                },
            )
        )
    return candidates


def _refine_candidates_with_clean_background_difference(
    *,
    candidates: list[ForegroundCandidate],
    source_image_path: str | Path,
    clean_background_path: str | Path,
    search_padding: int = 24,
    diff_threshold: int = 18,
    min_pixels: int = 16,
) -> list[ForegroundCandidate]:
    if not candidates:
        return []
    refined: list[ForegroundCandidate] = []
    with (
        Image.open(source_image_path) as source_image,
        Image.open(clean_background_path) as background_image,
    ):
        source_rgb = source_image.convert("RGB")
        background_rgb = background_image.convert("RGB").resize(source_rgb.size)
        image_size = source_rgb.size
        for candidate in candidates:
            search_bbox = _clamp_bbox(
                _pad_bbox(candidate.source_pixel_bbox, search_padding),
                image_size,
            )
            diff_bbox = _foreground_difference_bbox(
                source_rgb.crop(search_bbox),
                background_rgb.crop(search_bbox),
                offset=(search_bbox[0], search_bbox[1]),
                threshold=diff_threshold,
                min_pixels=min_pixels,
            )
            if diff_bbox is None:
                refined.append(candidate)
                continue
            provenance = dict(candidate.provenance or {})
            provenance["original_vlm_bbox"] = list(candidate.source_pixel_bbox)
            provenance["bbox_refinement"] = "source_clean_background_difference"
            refined.append(
                replace(
                    candidate,
                    source_pixel_bbox=diff_bbox,
                    area=(diff_bbox[2] - diff_bbox[0]) * (diff_bbox[3] - diff_bbox[1]),
                    provenance=provenance,
                )
            )
    return refined


def _bridge_narrow_same_group_complex_candidates(
    candidates: list[ForegroundCandidate],
    *,
    max_gap_ratio: float = 0.35,
    narrow_width_ratio: float = 0.65,
) -> list[ForegroundCandidate]:
    if len(candidates) < 2:
        return candidates
    bridged = list(candidates)
    indexed = list(enumerate(candidates))
    for current_position, current in indexed:
        if current.classification != "complex_whole_visual":
            continue
        current_group = str((current.provenance or {}).get("group_id") or "")
        if not current_group:
            continue
        current_bbox = current.source_pixel_bbox
        current_width = current_bbox[2] - current_bbox[0]
        current_height = current_bbox[3] - current_bbox[1]
        same_row_left_neighbors = [
            (position, candidate)
            for position, candidate in indexed
            if position != current_position
            and candidate.classification == "complex_whole_visual"
            and str((candidate.provenance or {}).get("group_id") or "") == current_group
            and candidate.source_pixel_bbox[2] <= current_bbox[0]
            and _same_horizontal_band(current_bbox, candidate.source_pixel_bbox)
        ]
        if not same_row_left_neighbors:
            continue
        _neighbor_position, neighbor = max(
            same_row_left_neighbors,
            key=lambda item: item[1].source_pixel_bbox[2],
        )
        neighbor_bbox = neighbor.source_pixel_bbox
        neighbor_width = neighbor_bbox[2] - neighbor_bbox[0]
        gap = current_bbox[0] - neighbor_bbox[2]
        if gap <= 0:
            continue
        if current_width >= neighbor_width * narrow_width_ratio:
            continue
        if gap > neighbor_width * max_gap_ratio:
            continue
        bridge_overlap = max(
            16, min(48, round(max(current_height, neighbor_bbox[3] - neighbor_bbox[1]) * 0.15))
        )
        bridged_left = max(neighbor_bbox[2] - bridge_overlap, 0)
        if bridged_left >= current_bbox[0]:
            continue
        provenance = dict(current.provenance or {})
        provenance["bbox_refinement"] = "same_group_row_bridge"
        provenance["pre_bridge_bbox"] = list(current_bbox)
        provenance["bridge_neighbor_id"] = neighbor.candidate_id
        bridged_bbox = (bridged_left, current_bbox[1], current_bbox[2], current_bbox[3])
        bridged[current_position] = replace(
            current,
            source_pixel_bbox=bridged_bbox,
            area=(bridged_bbox[2] - bridged_bbox[0]) * (bridged_bbox[3] - bridged_bbox[1]),
            provenance=provenance,
        )
    return bridged


def _foreground_difference_bbox(
    source_crop: Image.Image,
    background_crop: Image.Image,
    *,
    offset: tuple[int, int],
    threshold: int,
    min_pixels: int,
) -> PixelBBox | None:
    diff = ImageChops.difference(source_crop.convert("RGB"), background_crop.convert("RGB"))
    points: list[tuple[int, int]] = []
    pixels = diff.load()
    for y in range(diff.height):
        for x in range(diff.width):
            if max(pixels[x, y]) > threshold:
                points.append((x + offset[0], y + offset[1]))
    if len(points) < min_pixels:
        return None
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def _bitmap_assets_from_vlm(
    analysis: VLMPageAnalysis,
    mapper: VLMCoordinateMapper,
    source_rgb: Image.Image,
    background_rgb: Image.Image,
    *,
    root: Path,
    slide_id: str,
    page_index: int,
) -> list[BitmapAssetSpec]:
    output_dir = root / "assets" / f"{page_index:04d}-{_safe_name(slide_id)}"
    output_dir.mkdir(parents=True, exist_ok=True)
    assets: list[BitmapAssetSpec] = []
    for z_order, region in enumerate(analysis.bitmap_regions, start=1):
        bbox = mapper.to_source_bbox(region.bbox, padding=0)
        if _area_ratio(bbox, mapper.source_image_size) < 0.0004:
            continue
        output_path = output_dir / f"{_safe_name(region.region_id)}.png"
        _foreground_rgba_crop(source_rgb, background_rgb, bbox).save(output_path)
        assets.append(
            BitmapAssetSpec(
                asset_id=region.region_id,
                source_pixel_bbox=bbox,
                asset_path=_artifact_ref(output_path, root),
                z_order=z_order,
                provenance={
                    "source_type": "vlm_source_crop",
                    "vlm_type": region.kind,
                    "group_id": region.group_id,
                },
            )
        )
    return assets


def _create_vlm_clean_background(
    *,
    source_image_path: str | Path,
    mask_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
    edit_provider: ImageEditProvider,
    timeout_seconds: int,
    cleanup_bboxes: list[PixelBBox] | None = None,
) -> BackgroundResult:
    source_path = Path(source_image_path)
    output_path = Path(output_asset_path)
    root = Path(asset_root).resolve()
    request = ImageEditRequest(
        source_image_path=str(source_path),
        prompt_id="vlm_clean_background",
        prompt=(
            "Remove only the masked text, icons, products, QR codes, and foreground bitmap "
            "objects from this presentation slide. Reconstruct the underlying presentation "
            "background, panel surfaces, grid lines, dividers, shadows, and glow. "
            "Masked text regions must contain no readable residual glyphs, strokes, halos, "
            "or duplicate letters after editing. "
            "Preserve every unmasked pixel as much as possible. Do not add words, icons, "
            "products, QR codes, labels, people, logos, or new decorations. Return the "
            "edited image only, with the same size and composition."
        ),
        output_asset_path=str(output_path),
        asset_root=str(root),
        mask_path=str(mask_path),
        timeout_seconds=timeout_seconds,
        metadata={
            "source_image_ref": _artifact_ref(source_path.resolve(), root),
            "mask_ref": _artifact_ref(Path(mask_path).resolve(), root),
            "stage": "vlm_clean_background",
        },
    )
    try:
        result = edit_provider.edit(request)
    except ProviderError as exc:
        return _create_local_vlm_clean_background_fallback(
            source_image_path=source_path,
            output_asset_path=output_path,
            asset_root=root,
            cleanup_bboxes=cleanup_bboxes or [],
            provider_error=exc,
        )
    _normalize_image_to_source_size(result.output_asset_path, source_path)
    return BackgroundResult(
        output_asset_path=result.output_asset_path,
        artifact_path=_artifact_ref(output_path.resolve(), root),
        strategy="image_edit",
        provider_role=result.provider_role,
        prompt_id=result.prompt_id,
        input_asset_refs=[
            _artifact_ref(source_path.resolve(), root),
            _artifact_ref(Path(mask_path).resolve(), root),
        ],
        validation_status="passed",
        provenance={
            "decision": "vlm mask cleanup for text and foreground bitmap removal",
            "provider": result.provider_name,
            "model": result.model,
            "prompt_id": result.prompt_id,
        },
    )


def _create_local_vlm_clean_background_fallback(
    *,
    source_image_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
    cleanup_bboxes: list[PixelBBox],
    provider_error: ProviderError,
) -> BackgroundResult:
    result = create_source_preserving_text_background(
        source_image_path=source_image_path,
        text_bboxes=cleanup_bboxes,
        output_asset_path=output_asset_path,
        asset_root=asset_root,
        prefer_inpaint=True,
    )
    return replace(
        result,
        prompt_id="vlm_clean_background_local_fallback",
        provenance={
            **result.provenance,
            "decision": "local bbox cleanup after vlm clean background provider failed",
            "provider_failed": True,
            "provider_error_type": provider_error.__class__.__name__,
            "provider_error": safe_provider_error_message(str(provider_error)),
            "cleanup_bbox_count": len(cleanup_bboxes),
        },
    )


def _normalize_image_to_source_size(image_path: str | Path, source_image_path: str | Path) -> None:
    with Image.open(source_image_path) as source, Image.open(image_path) as image:
        source_size = source.size
        if image.size == source_size:
            return
        normalized = image.convert("RGB").resize(source_size, Image.Resampling.LANCZOS)
    normalized.save(image_path)


def _text_box_from_vlm(
    region: VLMTextRegion,
    mapper: VLMCoordinateMapper,
    source_rgb: Image.Image,
) -> TextBoxSpec:
    bbox = mapper.to_source_bbox(region.bbox, padding=0)
    return TextBoxSpec(
        text=region.text,
        source_pixel_bbox=bbox,
        source_pixel_polygon=_bbox_polygon(bbox),
        font_family="Microsoft YaHei",
        font_size=_estimate_font_size(
            bbox,
            mapper.source_image_size,
            role=region.role,
            text=region.text,
        ),
        color_hex=region.color_hex or _infer_text_color(source_rgb, bbox),
        alignment="left",
        style_hints={
            "vlm_role": region.role,
            "approximate_layout": True,
            "bold": region.role in {"title", "heading", "label", "button"},
        },
        provenance={
            "provider_role": "VLM",
            "region_id": region.region_id,
            "confidence": region.confidence,
            "group_id": region.group_id,
        },
    )


def _native_shapes_from_vlm(
    region: VLMShapeRegion,
    mapper: VLMCoordinateMapper,
    source_image_size: tuple[int, int],
) -> list[NativeShapeSpec]:
    bbox = mapper.to_source_bbox(region.bbox, padding=0)
    kind = region.kind.lower()
    if kind in {"divider", "line", "connector", "arrow"}:
        left, top, right, bottom = bbox
        if max(right - left, bottom - top) < 8:
            return []
        if right - left >= bottom - top:
            start = (left, (top + bottom) // 2)
            end = (right, (top + bottom) // 2)
        else:
            start = ((left + right) // 2, top)
            end = ((left + right) // 2, bottom)
        return [
            NativeShapeSpec(
                shape_type="line",
                source_pixel_bbox=bbox,
                line_color="#5A8EB5",
                line_start=start,
                line_end=end,
                stroke_width=1.0,
                opacity=0.75,
                provenance={
                    "provider_role": "VLM",
                    "region_id": region.region_id,
                    "vlm_type": kind,
                },
            )
        ]
    if kind in {"rounded_rect", "rounded_rectangle", "rect", "rectangle"}:
        if _area_ratio(bbox, source_image_size) > 0.06:
            return []
        return [
            NativeShapeSpec(
                shape_type="rounded_rectangle" if "round" in kind else "rectangle",
                source_pixel_bbox=bbox,
                fill_color="",
                line_color="#E0EEFF",
                stroke_width=1.0,
                opacity=0.95,
                radius=0.12,
                provenance={
                    "provider_role": "VLM",
                    "region_id": region.region_id,
                    "vlm_type": kind,
                },
            )
        ]
    return []


def _coerce_bbox(value: Any, coordinate_space: VLMCoordinateSpace) -> PixelBBox:
    if not isinstance(value, list | tuple) or len(value) != 4:
        raise ValueError("VLM region bbox must be [left, top, right, bottom]")
    bbox = tuple(round(float(item)) for item in value)
    return _clamp_bbox(bbox, (coordinate_space.width, coordinate_space.height))


def _resized_jpeg_base64(image_path: str | Path, size: tuple[int, int]) -> str:
    with Image.open(image_path) as image:
        rgb = image.convert("RGB")
        resized = rgb.resize(size, Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    resized.save(buffer, format="JPEG", quality=90)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _vlm_analysis_payload_variants(
    image_path: str | Path,
    *,
    analysis_size: tuple[int, int],
    model: str,
    max_tokens: int,
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    for size, detail, image_first in (
        (analysis_size, "low", False),
        (analysis_size, "", False),
        (analysis_size, "", True),
        ((960, 540), "", False),
    ):
        image_base64 = _resized_jpeg_base64(image_path, size)
        text_part = {"type": "text", "text": _vlm_compact_analysis_prompt(size)}
        image_url: dict[str, Any] = {"url": f"data:image/jpeg;base64,{image_base64}"}
        if detail:
            image_url["detail"] = detail
        image_part = {"type": "image_url", "image_url": image_url}
        content = [image_part, text_part] if image_first else [text_part, image_part]
        variants.append(
            {
                "model": model,
                "messages": [{"role": "user", "content": content}],
                "response_format": {"type": "json_object"},
                "temperature": 0,
                "max_tokens": max_tokens,
            }
        )
    return variants


def _is_vlm_payload_shape_compatibility_error(exc: ProviderError) -> bool:
    message = str(exc).lower()
    if "400" not in message and "bad request" not in message:
        return False
    return any(
        marker in message
        for marker in (
            "unsupported",
            "unknown field",
            "extra field",
            "unrecognized",
            "not supported",
            "invalid parameter",
            "invalid field",
            "image_url.detail",
            "response_format",
            "detail",
        )
    )


def _vlm_compact_analysis_prompt(size: tuple[int, int]) -> str:
    width, height = size
    return (
        "你是 PPT 页面重建的视觉分析器。只输出 JSON，不要 Markdown。\n"
        f"图片已经缩放为 {width}x{height}。所有 bbox 必须使用这张缩放图片的像素坐标 "
        "[left,top,right,bottom]，不要归一化。\n"
        "目标是给后续 PPTX 重建提供元素清单，而不是描述图片。\n"
        "输出 schema: {"
        '"coordinate_space":{"width":%d,"height":%d,"unit":"px"},'
        '"text_regions":[{"id":"t1","text":"原文","bbox":[0,0,1,1],"role":"title|heading|body|label|button","color":"#RRGGBB","confidence":0.9,"group_id":"g1"}],'
        '"bitmap_regions":[{"id":"b1","type":"photo|icon|logo|qr|product|component|other","bbox":[0,0,1,1],"importance":"major|minor","group_id":"g1"}],'
        '"shape_regions":[{"id":"s1","type":"rounded_rect|rect|line|divider|connector|arrow|circle|other","bbox":[0,0,1,1],"importance":"major|minor","group_id":"g1"}]'
        "}。\n"
        "规则：文字逐项列出，中文照抄，不合并跨区域文字；大背景不要放入 bitmap_regions；"
        "面板、分割线、按钮边框放 shape_regions；忽略纯装饰噪声。"
    ) % (width, height)


def _clamp_bbox(bbox: tuple[int, int, int, int], size: tuple[int, int]) -> PixelBBox:
    width, height = size
    left, top, right, bottom = bbox
    left = max(0, min(width - 1, left))
    top = max(0, min(height - 1, top))
    right = max(left + 1, min(width, right))
    bottom = max(top + 1, min(height, bottom))
    return (left, top, right, bottom)


def _pad_bbox(bbox: PixelBBox, padding: int) -> PixelBBox:
    left, top, right, bottom = bbox
    return (left - padding, top - padding, right + padding, bottom + padding)


def _bbox_polygon(bbox: PixelBBox) -> tuple[tuple[int, int], ...]:
    left, top, right, bottom = bbox
    return ((left, top), (right, top), (right, bottom), (left, bottom))


def _area_ratio(bbox: PixelBBox, size: tuple[int, int]) -> float:
    left, top, right, bottom = bbox
    return ((right - left) * (bottom - top)) / max(1, size[0] * size[1])


def _bitmap_region_should_be_ignored_as_element(bbox: PixelBBox, size: tuple[int, int]) -> bool:
    if _area_ratio(bbox, size) < MIN_BITMAP_REGION_AREA_RATIO:
        return True
    return _is_near_full_slide_region(bbox, size)


def _mask_padding_for_bitmap_region(
    region: VLMBitmapRegion,
    bbox: PixelBBox,
    source_image_size: tuple[int, int],
    base_padding: int,
) -> int:
    if not _bitmap_region_needs_broad_clean_mask(region, bbox, source_image_size):
        return base_padding
    width = max(1, bbox[2] - bbox[0])
    height = max(1, bbox[3] - bbox[1])
    adaptive_padding = round(max(width, height) * COMPLEX_BITMAP_MASK_PADDING_RATIO)
    broad_padding = max(MIN_COMPLEX_BITMAP_MASK_PADDING, adaptive_padding)
    broad_padding = min(MAX_COMPLEX_BITMAP_MASK_PADDING, broad_padding)
    return max(base_padding, broad_padding)


def _bitmap_region_needs_broad_clean_mask(
    region: VLMBitmapRegion,
    bbox: PixelBBox,
    source_image_size: tuple[int, int],
) -> bool:
    kind = region.kind.lower()
    if kind in COMPLEX_BITMAP_MASK_KINDS:
        return True
    if kind not in CONDITIONAL_COMPLEX_BITMAP_MASK_KINDS:
        return False
    return region.importance.lower() == "major" or _area_ratio(bbox, source_image_size) >= 0.01


def _is_near_full_slide_region(bbox: PixelBBox, size: tuple[int, int]) -> bool:
    width = max(1, size[0])
    height = max(1, size[1])
    bbox_width = max(0, bbox[2] - bbox[0])
    bbox_height = max(0, bbox[3] - bbox[1])
    if _area_ratio(bbox, size) >= MAX_BITMAP_ELEMENT_AREA_RATIO:
        return True
    return (
        bbox_width / width >= MAX_BITMAP_ELEMENT_WIDTH_RATIO
        and bbox_height / height >= MAX_BITMAP_ELEMENT_HEIGHT_RATIO
    )


def _ocr_match_score(region: VLMTextRegion, region_bbox: PixelBBox, box: TextBoxSpec) -> float:
    overlap = _bbox_overlap_ratio(region_bbox, box.source_pixel_bbox)
    if overlap <= 0 and not _bbox_center_inside(box.source_pixel_bbox, region_bbox):
        return 0.0
    text_score = _text_similarity(region.text, box.text)
    confidence = float(box.provenance.get("ocr_confidence", 0.0) or 0.0)
    if text_score < 0.2 and region.text:
        return 0.0
    return (
        max(overlap, 0.35 if _bbox_center_inside(box.source_pixel_bbox, region_bbox) else 0.0)
        * 0.65
        + text_score * 0.25
        + confidence * 0.1
    )


def _bbox_overlap_ratio(outer: PixelBBox, inner: PixelBBox) -> float:
    intersection = _bbox_intersection_area(outer, inner)
    return intersection / max(1, _bbox_area(inner))


def _bbox_intersection_area(left_bbox: PixelBBox, right_bbox: PixelBBox) -> int:
    left = max(left_bbox[0], right_bbox[0])
    top = max(left_bbox[1], right_bbox[1])
    right = min(left_bbox[2], right_bbox[2])
    bottom = min(left_bbox[3], right_bbox[3])
    if right <= left or bottom <= top:
        return 0
    return (right - left) * (bottom - top)


def _ranges_overlap(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return min(left_end, right_end) > max(left_start, right_start)


def _bbox_area(bbox: PixelBBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _bbox_center_inside(bbox: PixelBBox, container: PixelBBox) -> bool:
    center_x = (bbox[0] + bbox[2]) / 2
    center_y = (bbox[1] + bbox[3]) / 2
    return container[0] <= center_x <= container[2] and container[1] <= center_y <= container[3]


def _text_similarity(left: str, right: str) -> float:
    normalized_left = _normalize_text_for_match(left)
    normalized_right = _normalize_text_for_match(right)
    if not normalized_left or not normalized_right:
        return 0.0
    if normalized_left in normalized_right or normalized_right in normalized_left:
        return 1.0
    return SequenceMatcher(None, normalized_left, normalized_right).ratio()


def _normalize_text_for_match(value: str) -> str:
    return re.sub(r"\s+", "", str(value)).lower()


def _estimate_font_size(
    bbox: PixelBBox,
    source_image_size: tuple[int, int],
    *,
    role: str,
    text: str = "",
) -> float:
    left, top, right, bottom = bbox
    height_px = max(1, bottom - top)
    slide_height_inches = 5.625
    # VLM bboxes describe the visible glyph envelope, while PPT renderers need
    # extra line-height headroom. A conservative factor avoids dense pages
    # drifting from source renders because text clips or expands vertically.
    if role in {"title", "heading"}:
        font_size = height_px / source_image_size[1] * slide_height_inches * 72 * 0.9
        font_size = min(font_size, 44.0)
        min_font_size = 12.0
    else:
        font_size = height_px / source_image_size[1] * slide_height_inches * 72 * 0.65
        font_size = min(font_size, 22.0)
        min_font_size = 7.0
    width_capped = _cap_font_size_by_text_width(
        font_size,
        bbox_width_px=max(1, right - left),
        source_width_px=max(1, source_image_size[0]),
        role=role,
        text=text,
    )
    return max(min_font_size, width_capped)


def _cap_font_size_by_text_width(
    font_size: float,
    *,
    bbox_width_px: int,
    source_width_px: int,
    role: str,
    text: str,
) -> float:
    line_units = [
        _estimate_text_line_units(line) for line in str(text).splitlines() if line.strip()
    ]
    if not line_units:
        return font_size
    longest_line_units = max(line_units)
    if longest_line_units <= 0:
        return font_size
    slide_width_points = 10.0 * 72.0
    bbox_width_points = bbox_width_px / source_width_px * slide_width_points
    width_factor = 0.9 if role in {"title", "heading"} else 1.05
    width_based_font_size = bbox_width_points / (longest_line_units * width_factor)
    return min(font_size, width_based_font_size)


def _estimate_text_line_units(line: str) -> float:
    units = 0.0
    for char in line:
        if char.isspace():
            units += 0.35
        elif char.isascii():
            units += 0.55 if char.isalnum() else 0.35
        elif unicodedata.category(char).startswith("P"):
            units += 0.5
        else:
            units += 1.0
    return units


def _infer_text_color(image: Image.Image, bbox: PixelBBox) -> str:
    crop = image.crop(bbox)
    if crop.width <= 0 or crop.height <= 0:
        return "#FFFFFF"
    sample = crop.resize((max(1, min(80, crop.width)), max(1, min(40, crop.height))))
    candidates = [
        pixel
        for pixel in sample.getdata()
        if max(pixel) > 135 and (max(pixel) - min(pixel) > 18 or sum(pixel) / 3 > 170)
    ]
    if not candidates:
        return "#FFFFFF"
    blues = [pixel for pixel in candidates if pixel[2] > pixel[0] + 25 and pixel[1] > pixel[0] - 20]
    values = blues if len(blues) >= max(3, len(candidates) * 0.2) else candidates
    rgb = tuple(sorted(pixel[index] for pixel in values)[len(values) // 2] for index in range(3))
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


def _clean_hex_color(value: Any) -> str:
    if isinstance(value, str) and re.match(r"^#[0-9a-fA-F]{6}$", value):
        return value.upper()
    return ""


def _coerce_confidence(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, number))


def _items(payload: dict[str, Any], key: str) -> list[dict[str, Any]]:
    value = payload.get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _region_id(item: dict[str, Any], prefix: str, index: int) -> str:
    return _safe_name(str(item.get("id") or f"{prefix}{index}"), fallback=f"{prefix}{index}")


def _max_bbox_x(payload: dict[str, Any]) -> int:
    return max((bbox[2] for bbox in _all_bboxes(payload)), default=0)


def _max_bbox_y(payload: dict[str, Any]) -> int:
    return max((bbox[3] for bbox in _all_bboxes(payload)), default=0)


def _all_bboxes(payload: dict[str, Any]) -> list[list[int]]:
    bboxes: list[list[int]] = []
    for key in ("text_regions", "bitmap_regions", "shape_regions"):
        for item in _items(payload, key):
            bbox = item.get("bbox")
            if isinstance(bbox, list) and len(bbox) == 4:
                bboxes.append([round(float(value)) for value in bbox])
    return bboxes


def _require_inside(root: Path, path: Path, field_name: str) -> None:
    if not path.is_relative_to(root):
        raise ValueError(f"{field_name} must be inside artifact_root")


def _artifact_ref(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _slide_size_inches(aspect_ratio: str) -> tuple[float, float]:
    if aspect_ratio == "4:3":
        return (10.0, 7.5)
    return (10.0, 5.625)


def _safe_name(value: str, *, fallback: str = "item") -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-")
    return safe or fallback


def _slide_value(slide: GenerativeEditableSlideInput | dict[str, Any], key: str) -> Any:
    if isinstance(slide, dict):
        return slide.get(key)
    return getattr(slide, key)


def _job_relative(path: Path, job_dir: Path) -> str:
    return path.resolve().relative_to(job_dir.resolve()).as_posix()


def _analysis_payload(analysis: VLMPageAnalysis) -> dict[str, Any]:
    return {
        "coordinate_space": asdict(analysis.coordinate_space),
        "text_regions": [asdict(region) for region in analysis.text_regions],
        "bitmap_regions": [asdict(region) for region in analysis.bitmap_regions],
        "shape_regions": [asdict(region) for region in analysis.shape_regions],
    }

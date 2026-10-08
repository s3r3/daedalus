"""Manifest models for generative editable PPTX export jobs."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
import re
from typing import Any, Literal

from .generative_editable_providers import safe_provider_error_message

Point = tuple[int, int]
PixelBBox = tuple[int, int, int, int]
ValidationStatus = Literal["pending", "passed", "failed"]
FallbackPolicy = Literal["fail", "text_editable_background", "raster_pptx"]
RepairStatus = Literal["pending", "passed", "failed"]

VALIDATION_STATUSES = {"pending", "passed", "failed"}
FALLBACK_POLICIES = {"fail", "text_editable_background", "raster_pptx"}
REPAIR_STATUSES = {"pending", "passed", "failed"}
NATIVE_SHAPE_TYPES = {"rectangle", "rounded_rectangle", "ellipse", "line"}
ARTIFACT_PREFIXES = {
    "assets",
    "asset_sheets",
    "backgrounds",
    "pages",
    "previews",
    "provider_outputs",
    "slides",
    "sources",
}
SOURCE_PREFIXES = {"slides", "sources"}
BACKGROUND_PREFIXES = {"backgrounds"}
PAGE_PREFIXES = {"pages"}
ASSET_PREFIXES = {"assets", "asset_sheets", "backgrounds", "previews"}
PROVIDER_OUTPUT_PREFIXES = {"provider_outputs"}
SENSITIVE_KEYS = {
    "apikey",
    "xapikey",
    "token",
    "apitoken",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "secret",
    "clientsecret",
    "baseurl",
    "authorization",
    "password",
    "cookie",
    "setcookie",
    "credential",
    "session",
    "sessionid",
    "privatekey",
    "secretkey",
    "accesskey",
}
SENSITIVE_KEY_PARTS = {
    "apikey",
    "xapikey",
    "token",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "secret",
    "clientsecret",
    "authorization",
    "password",
    "cookie",
    "setcookie",
    "credential",
    "session",
    "sessionid",
    "privatekey",
    "secretkey",
    "accesskey",
}
TRUSTED_SAFE_KEYS = {"keyline", "assetkey", "chromakeymode"}
STRING_REDACTION_KEY_PARTS = {
    "authorization",
    "error",
    "exception",
    "header",
    "message",
    "payload",
    "raw",
    "request",
    "response",
}
PROVIDER_OUTPUT_STAGES = {"vlm", "ocr", "image_edit", "asset_sheet", "image_generation", "repair"}


def _validate_bbox(name: str, bbox: PixelBBox) -> None:
    if len(bbox) != 4 or not all(isinstance(value, int) for value in bbox):
        raise ValueError(f"{name} must contain integer source-pixel coordinates")
    x1, y1, x2, y2 = bbox
    if min(x1, y1, x2, y2) < 0:
        raise ValueError(f"{name} must contain non-negative source-pixel coordinates")
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"{name} must be ordered as (left, top, right, bottom)")


def _validate_polygon(name: str, polygon: tuple[Point, ...]) -> None:
    if len(polygon) < 4:
        raise ValueError(f"{name} must contain at least four points")
    for point in polygon:
        if len(point) != 2 or not all(isinstance(value, int) for value in point):
            raise ValueError(f"{name} must contain integer source-pixel coordinates")
        if min(point) < 0:
            raise ValueError(f"{name} must contain non-negative source-pixel coordinates")


def _validate_point(name: str, point: Point) -> None:
    if len(point) != 2 or not all(isinstance(value, int) for value in point):
        raise ValueError(f"{name} must contain integer source-pixel coordinates")
    if min(point) < 0:
        raise ValueError(f"{name} must contain non-negative source-pixel coordinates")


def _validate_status(name: str, value: str, allowed: set[str]) -> None:
    if value not in allowed:
        raise ValueError(f"{name} must be one of: {', '.join(sorted(allowed))}")


def _validate_relative_artifact_path(name: str, value: str, allowed_prefixes: set[str]) -> None:
    if not value:
        return
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"{name} must be a job-relative artifact path")
    if path.parts and path.parts[0] not in allowed_prefixes:
        raise ValueError(f"{name} must start with one of: {', '.join(sorted(allowed_prefixes))}")


def _validate_bbox_in_bounds(name: str, bbox: PixelBBox, image_size: tuple[int, int]) -> None:
    _validate_bbox(name, bbox)
    _, _, x2, y2 = bbox
    width, height = image_size
    if x2 > width or y2 > height:
        raise ValueError(f"{name} must be inside source_image_size")


def _validate_polygon_in_bounds(
    name: str, polygon: tuple[Point, ...], image_size: tuple[int, int]
) -> None:
    _validate_polygon(name, polygon)
    width, height = image_size
    for x, y in polygon:
        if x > width or y > height:
            raise ValueError(f"{name} must be inside source_image_size")


def _validate_point_in_bounds(name: str, point: Point, image_size: tuple[int, int]) -> None:
    _validate_point(name, point)
    width, height = image_size
    x, y = point
    if x > width or y > height:
        raise ValueError(f"{name} must be inside source_image_size")


@dataclass(frozen=True)
class TextBoxSpec:
    text: str
    source_pixel_bbox: PixelBBox
    source_pixel_polygon: tuple[Point, ...]
    font_family: str = ""
    font_size: float | None = None
    color_hex: str = "#000000"
    alignment: str = "left"
    opacity: float = 1.0
    style_hints: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_bbox("source_pixel_bbox", self.source_pixel_bbox)
        _validate_polygon("source_pixel_polygon", self.source_pixel_polygon)
        if not 0 <= self.opacity <= 1:
            raise ValueError("opacity must be between 0 and 1")


@dataclass(frozen=True)
class NativeShapeSpec:
    shape_type: str
    source_pixel_bbox: PixelBBox
    fill_color: str = ""
    line_color: str = ""
    line_start: Point | None = None
    line_end: Point | None = None
    stroke_width: float | None = None
    opacity: float = 1.0
    radius: float | None = None
    confidence: float = 1.0
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.shape_type not in NATIVE_SHAPE_TYPES:
            raise ValueError("shape_type must be a supported native shape")
        _validate_bbox("source_pixel_bbox", self.source_pixel_bbox)
        if not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        if not 0 <= self.opacity <= 1:
            raise ValueError("opacity must be between 0 and 1")
        if self.line_start is not None:
            _validate_point("line_start", self.line_start)
        if self.line_end is not None:
            _validate_point("line_end", self.line_end)
        if self.stroke_width is not None and self.stroke_width <= 0:
            raise ValueError("stroke_width must be positive")
        if self.radius is not None and (
            not isinstance(self.radius, int | float) or self.radius < 0
        ):
            raise ValueError("radius must be a non-negative number")


@dataclass(frozen=True)
class ForegroundCandidateSpec:
    candidate_id: str
    source_pixel_bbox: PixelBBox
    area: int
    classification: str
    confidence: float = 0.0
    component_key: str = ""
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_bbox("source_pixel_bbox", self.source_pixel_bbox)
        if self.area < 0:
            raise ValueError("area must be non-negative")
        if not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")


@dataclass(frozen=True)
class BitmapAssetSpec:
    asset_id: str
    source_pixel_bbox: PixelBBox
    asset_path: str
    z_order: int
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_bbox("source_pixel_bbox", self.source_pixel_bbox)
        _validate_relative_artifact_path("asset_path", self.asset_path, ASSET_PREFIXES)


@dataclass(frozen=True)
class AssetSheetSpec:
    sheet_id: str
    asset_path: str
    prompt_id: str
    candidate_ids: list[str]
    provider_role: str
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_relative_artifact_path("asset_path", self.asset_path, ASSET_PREFIXES)


@dataclass(frozen=True)
class RepairAttempt:
    target_id: str
    attempt_index: int
    reason: str
    provider_role: str
    status: RepairStatus
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.attempt_index < 1:
            raise ValueError("attempt_index must be positive")
        _validate_status("repair status", self.status, REPAIR_STATUSES)


@dataclass(frozen=True)
class PageManifest:
    slide_id: str
    page_index: int
    source_image_path: str
    source_image_size: tuple[int, int]
    slide_size: tuple[float, float]
    text_clean_background: str = ""
    base_clean_background: str = ""
    chosen_background: str = ""
    text_boxes: list[TextBoxSpec] = field(default_factory=list)
    foreground_candidates: list[ForegroundCandidateSpec] = field(default_factory=list)
    native_shapes: list[NativeShapeSpec] = field(default_factory=list)
    bitmap_assets: list[BitmapAssetSpec] = field(default_factory=list)
    asset_sheets: list[AssetSheetSpec] = field(default_factory=list)
    repair_attempts: list[RepairAttempt] = field(default_factory=list)
    provider_output_paths: dict[str, str] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)
    validation_status: ValidationStatus = "pending"

    def __post_init__(self) -> None:
        _validate_status("validation_status", self.validation_status, VALIDATION_STATUSES)
        if self.page_index < 0:
            raise ValueError("page_index must be non-negative")
        if self.source_image_size[0] <= 0 or self.source_image_size[1] <= 0:
            raise ValueError("source_image_size must be positive")
        if self.slide_size[0] <= 0 or self.slide_size[1] <= 0:
            raise ValueError("slide_size must be positive")
        _validate_relative_artifact_path(
            "source_image_path", self.source_image_path, SOURCE_PREFIXES
        )
        _validate_relative_artifact_path(
            "text_clean_background", self.text_clean_background, BACKGROUND_PREFIXES
        )
        _validate_relative_artifact_path(
            "base_clean_background", self.base_clean_background, BACKGROUND_PREFIXES
        )
        _validate_relative_artifact_path(
            "chosen_background", self.chosen_background, BACKGROUND_PREFIXES
        )
        for value in self.provider_output_paths.values():
            _validate_relative_artifact_path(
                "provider_output_paths", value, PROVIDER_OUTPUT_PREFIXES
            )
        expected_slide_dir = f"{self.page_index:04d}-{_safe_name(self.slide_id)}"
        for stage, value in self.provider_output_paths.items():
            if stage not in PROVIDER_OUTPUT_STAGES:
                raise ValueError("provider_output_paths must use known provider stages")
            parts = Path(value).parts
            if len(parts) < 4 or parts[1] != stage or parts[2] != expected_slide_dir:
                raise ValueError("provider_output_paths must match stage and slide/page")
        for text_box in self.text_boxes:
            _validate_bbox_in_bounds(
                "source_pixel_bbox", text_box.source_pixel_bbox, self.source_image_size
            )
            _validate_polygon_in_bounds(
                "source_pixel_polygon", text_box.source_pixel_polygon, self.source_image_size
            )
        for shape in self.native_shapes:
            _validate_bbox_in_bounds(
                "source_pixel_bbox", shape.source_pixel_bbox, self.source_image_size
            )
            if shape.line_start is not None:
                _validate_point_in_bounds("line_start", shape.line_start, self.source_image_size)
            if shape.line_end is not None:
                _validate_point_in_bounds("line_end", shape.line_end, self.source_image_size)
        for candidate in self.foreground_candidates:
            _validate_bbox_in_bounds(
                "source_pixel_bbox", candidate.source_pixel_bbox, self.source_image_size
            )
        for asset in self.bitmap_assets:
            _validate_bbox_in_bounds(
                "source_pixel_bbox", asset.source_pixel_bbox, self.source_image_size
            )


@dataclass(frozen=True)
class DeckManifest:
    job_id: str
    slide_order: list[str]
    aspect_ratio: str
    provider_roles: dict[str, str]
    quality_settings: dict[str, Any]
    fallback_policy: FallbackPolicy
    page_manifest_paths: list[str]
    validation_status: ValidationStatus = "pending"
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.aspect_ratio not in {"16:9", "4:3"}:
            raise ValueError("aspect_ratio must be 16:9 or 4:3")
        _validate_status("fallback_policy", self.fallback_policy, FALLBACK_POLICIES)
        _validate_status("validation_status", self.validation_status, VALIDATION_STATUSES)
        if len(self.slide_order) != len(self.page_manifest_paths):
            raise ValueError("page_manifest_paths must match slide_order length")
        for page_index, (slide_id, path) in enumerate(
            zip(self.slide_order, self.page_manifest_paths)
        ):
            _validate_relative_artifact_path("page_manifest_paths", path, PAGE_PREFIXES)
            expected = f"{page_index:04d}-{_safe_name(slide_id)}.json"
            if Path(path).name != expected:
                raise ValueError("page_manifest_paths must follow slide_order")


def manifest_to_dict(manifest: DeckManifest | PageManifest) -> dict[str, Any]:
    return sanitize_persisted_payload(asdict(manifest))


def write_manifest(path: str | Path, manifest: DeckManifest | PageManifest) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest_to_dict(manifest), ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def read_page_manifest(path: str | Path) -> PageManifest:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return page_manifest_from_dict(data)


def read_deck_manifest(path: str | Path) -> DeckManifest:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return deck_manifest_from_dict(data)


def deck_manifest_from_dict(data: dict[str, Any]) -> DeckManifest:
    return DeckManifest(**data)


def page_manifest_from_dict(data: dict[str, Any]) -> PageManifest:
    payload = dict(data)
    payload["source_image_size"] = tuple(payload["source_image_size"])
    payload["slide_size"] = tuple(payload["slide_size"])
    payload["text_boxes"] = [_text_box_from_dict(item) for item in payload.get("text_boxes", [])]
    payload["native_shapes"] = [
        _native_shape_from_dict(item) for item in payload.get("native_shapes", [])
    ]
    payload["foreground_candidates"] = [
        _foreground_candidate_from_dict(item) for item in payload.get("foreground_candidates", [])
    ]
    payload["bitmap_assets"] = [
        _bitmap_asset_from_dict(item) for item in payload.get("bitmap_assets", [])
    ]
    payload["asset_sheets"] = [AssetSheetSpec(**item) for item in payload.get("asset_sheets", [])]
    payload["repair_attempts"] = [
        RepairAttempt(**item) for item in payload.get("repair_attempts", [])
    ]
    return PageManifest(**payload)


def _text_box_from_dict(data: dict[str, Any]) -> TextBoxSpec:
    payload = dict(data)
    payload["source_pixel_bbox"] = tuple(payload["source_pixel_bbox"])
    payload["source_pixel_polygon"] = _polygon_from_json(payload["source_pixel_polygon"])
    return TextBoxSpec(**payload)


def _native_shape_from_dict(data: dict[str, Any]) -> NativeShapeSpec:
    payload = dict(data)
    payload["source_pixel_bbox"] = tuple(payload["source_pixel_bbox"])
    if payload.get("line_start") is not None:
        payload["line_start"] = tuple(payload["line_start"])
    if payload.get("line_end") is not None:
        payload["line_end"] = tuple(payload["line_end"])
    return NativeShapeSpec(**payload)


def _foreground_candidate_from_dict(data: dict[str, Any]) -> ForegroundCandidateSpec:
    payload = dict(data)
    payload["source_pixel_bbox"] = tuple(payload["source_pixel_bbox"])
    return ForegroundCandidateSpec(**payload)


def _bitmap_asset_from_dict(data: dict[str, Any]) -> BitmapAssetSpec:
    payload = dict(data)
    payload["source_pixel_bbox"] = tuple(payload["source_pixel_bbox"])
    return BitmapAssetSpec(**payload)


def _polygon_from_json(value: list[list[int]] | tuple[Point, ...]) -> tuple[Point, ...]:
    return tuple(tuple(point) for point in value)


def sanitize_persisted_payload(value: Any, *, _key: str = "", _redact_strings: bool = False) -> Any:
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        redact_nested = _redact_strings or _should_redact_string_value(_key)
        for key, nested in value.items():
            if _is_sensitive_key(str(key)):
                continue
            safe[key] = sanitize_persisted_payload(
                nested,
                _key=str(key),
                _redact_strings=redact_nested,
            )
        return safe
    if isinstance(value, list):
        return [
            sanitize_persisted_payload(item, _key=_key, _redact_strings=_redact_strings)
            for item in value
        ]
    if isinstance(value, tuple):
        return [
            sanitize_persisted_payload(item, _key=_key, _redact_strings=_redact_strings)
            for item in value
        ]
    if isinstance(value, str):
        if _redact_strings or _should_redact_string_value(_key):
            return safe_provider_error_message(value)
        return value
    return value


def _is_sensitive_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    if normalized in TRUSTED_SAFE_KEYS:
        return False
    return normalized in SENSITIVE_KEYS or any(part in normalized for part in SENSITIVE_KEY_PARTS)


def _should_redact_string_value(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return any(part in normalized for part in STRING_REDACTION_KEY_PARTS)


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-") or "item"

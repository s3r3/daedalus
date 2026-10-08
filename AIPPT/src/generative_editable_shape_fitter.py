"""Conservative native shape fitting for foreground candidates."""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from PIL import Image

from .generative_editable_foreground_planner import ForegroundCandidate
from .generative_editable_manifest import NativeShapeSpec


@dataclass(frozen=True)
class ShapeFitResult:
    native_shape: NativeShapeSpec | None
    bitmap_candidate: ForegroundCandidate | None = None


def fit_native_shape(
    candidate: ForegroundCandidate,
    *,
    source_image_path: str | Path,
    min_confidence: float = 0.9,
    enable_ellipses: bool = False,
) -> NativeShapeSpec | None:
    if candidate.classification != "native_shape_candidate":
        return None
    if candidate.confidence < min_confidence:
        return None

    provenance = _provenance_dict(candidate.provenance)
    shape_hint = provenance.get("shape_hint")
    if shape_hint not in {"rectangle", "rounded_rectangle", "ellipse", "line"}:
        return None
    if shape_hint == "ellipse" and not enable_ellipses:
        return None

    with Image.open(source_image_path) as source:
        source_rgb = source.convert("RGB")
        _validate_candidate_bounds(candidate.source_pixel_bbox, source_rgb.size)
        crop = source_rgb.crop(candidate.source_pixel_bbox)
        dominant = _dominant_non_white_color(crop)

    if shape_hint == "line":
        return NativeShapeSpec(
            shape_type="line",
            source_pixel_bbox=candidate.source_pixel_bbox,
            line_color=dominant,
            line_start=_line_endpoint(provenance.get("line_start"))
            or _line_start(candidate.source_pixel_bbox),
            line_end=_line_endpoint(provenance.get("line_end"))
            or _line_end(candidate.source_pixel_bbox),
            stroke_width=float(
                provenance.get("stroke_width") or _line_stroke_width(candidate.source_pixel_bbox)
            ),
            opacity=1.0,
            confidence=candidate.confidence,
            provenance={
                "candidate_id": candidate.candidate_id,
                "shape_hint": shape_hint,
                "fitter": "conservative_geometry",
            },
        )

    return NativeShapeSpec(
        shape_type=shape_hint,
        source_pixel_bbox=candidate.source_pixel_bbox,
        fill_color=dominant,
        radius=provenance.get("radius") if shape_hint == "rounded_rectangle" else None,
        confidence=candidate.confidence,
        provenance={
            "candidate_id": candidate.candidate_id,
            "shape_hint": shape_hint,
            "fitter": "conservative_geometry",
        },
    )


def fit_native_shape_with_fallback(
    candidate: ForegroundCandidate,
    *,
    source_image_path: str | Path,
    min_confidence: float = 0.9,
    enable_ellipses: bool = False,
) -> ShapeFitResult:
    shape = fit_native_shape(
        candidate,
        source_image_path=source_image_path,
        min_confidence=min_confidence,
        enable_ellipses=enable_ellipses,
    )
    if shape is not None:
        return ShapeFitResult(native_shape=shape)
    provenance = _provenance_dict(candidate.provenance)
    if (
        candidate.classification == "native_shape_candidate"
        and candidate.confidence < min_confidence
    ):
        reason = "below_native_shape_confidence_threshold"
    elif candidate.classification == "native_shape_candidate":
        reason = "unsupported_or_disabled_native_shape"
    else:
        return ShapeFitResult(native_shape=None)
    provenance["shape_fit_fallback_reason"] = reason
    return ShapeFitResult(
        native_shape=None,
        bitmap_candidate=replace(
            candidate,
            classification="bitmap_asset_candidate",
            provenance=provenance,
        ),
    )


def _dominant_non_white_color(crop: Image.Image) -> str:
    colors = crop.getcolors(maxcolors=crop.width * crop.height + 1) or []
    colors.sort(reverse=True)
    for _, color in colors:
        if max(color) < 245 or min(color) < 245:
            return "#%02X%02X%02X" % color
    return "#FFFFFF"


def _provenance_dict(value: object) -> dict:
    return dict(value) if isinstance(value, dict) else {}


def _line_endpoint(value: object) -> tuple[int, int] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    try:
        return (int(value[0]), int(value[1]))
    except (TypeError, ValueError):
        return None


def _validate_candidate_bounds(
    bbox: tuple[int, int, int, int], image_size: tuple[int, int]
) -> None:
    left, top, right, bottom = bbox
    width, height = image_size
    if min(bbox) < 0 or right <= left or bottom <= top or right > width or bottom > height:
        raise ValueError("source_pixel_bbox must be inside source image bounds")


def _line_start(bbox: tuple[int, int, int, int]) -> tuple[int, int]:
    left, top, right, bottom = bbox
    if _is_vertical_line(bbox):
        return (round((left + right) / 2), top)
    return (left, round((top + bottom) / 2))


def _line_end(bbox: tuple[int, int, int, int]) -> tuple[int, int]:
    left, top, right, bottom = bbox
    if _is_vertical_line(bbox):
        return (round((left + right) / 2), bottom)
    return (right, round((top + bottom) / 2))


def _line_stroke_width(bbox: tuple[int, int, int, int]) -> float:
    return min(bbox[2] - bbox[0], bbox[3] - bbox[1])


def _is_vertical_line(bbox: tuple[int, int, int, int]) -> bool:
    return (bbox[3] - bbox[1]) > (bbox[2] - bbox[0])

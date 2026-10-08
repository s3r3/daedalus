"""Foreground candidate planning for generative editable PPTX export."""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
from pathlib import Path
from typing import Literal

from PIL import Image, ImageChops

from .generative_editable_manifest import ForegroundCandidateSpec

CandidateClassification = Literal[
    "native_shape_candidate",
    "bitmap_asset_candidate",
    "complex_whole_visual",
    "duplicate",
    "rejected_text_like_region",
    "uncertain",
]
PixelBBox = tuple[int, int, int, int]


@dataclass(frozen=True)
class ForegroundCandidate:
    candidate_id: str
    source_pixel_bbox: PixelBBox
    area: int
    classification: CandidateClassification
    confidence: float = 0.0
    component_key: str = ""
    provenance: dict | None = None

    def __post_init__(self) -> None:
        if self.provenance is None:
            object.__setattr__(self, "provenance", {})
        left, top, right, bottom = self.source_pixel_bbox
        if right <= left or bottom <= top:
            raise ValueError("source_pixel_bbox must be ordered")
        if min(self.source_pixel_bbox) < 0:
            raise ValueError("source_pixel_bbox must be non-negative")
        if self.area < 0:
            raise ValueError("area must be non-negative")


def plan_foreground_candidates(
    *,
    source_image_path: str | Path,
    base_clean_image_path: str | Path,
    text_mask_path: str | Path | None = None,
    diff_threshold: int = 16,
    min_area: int = 16,
) -> list[ForegroundCandidate]:
    with Image.open(source_image_path) as source, Image.open(base_clean_image_path) as base:
        source_rgb = source.convert("RGB")
        base_rgb = base.convert("RGB").resize(source_rgb.size)
        difference = ImageChops.difference(source_rgb, base_rgb)
        text_mask = _load_text_mask(text_mask_path, source_rgb.size)
        diff_pixels = _difference_pixels(difference, text_mask, diff_threshold)

    components = _connected_components(diff_pixels)
    candidates: list[ForegroundCandidate] = []
    for index, component in enumerate(components, start=1):
        if len(component) < min_area:
            continue
        xs = [point[0] for point in component]
        ys = [point[1] for point in component]
        bbox = (min(xs), min(ys), max(xs) + 1, max(ys) + 1)
        candidates.append(
            ForegroundCandidate(
                candidate_id=f"fg-{index:03d}",
                source_pixel_bbox=bbox,
                area=len(component),
                classification="uncertain",
                confidence=0.0,
                provenance={
                    "detection": "source_base_difference",
                    "diff_threshold": diff_threshold,
                },
            )
        )
    return candidates


def classify_foreground_candidates(
    *,
    source_image_path: str | Path,
    candidate_boxes: list[PixelBBox],
    rejected_text_regions: list[PixelBBox] | None = None,
    min_area: int = 20,
) -> list[ForegroundCandidate]:
    rejected_text_regions = rejected_text_regions or []
    with Image.open(source_image_path) as source:
        source_rgb = source.convert("RGB")
        candidates = []
        for index, bbox in enumerate(candidate_boxes, start=1):
            _validate_bbox_in_image("candidate_boxes", bbox, source_rgb.size)
            crop = source_rgb.crop(bbox)
            classification, confidence, provenance = _classify_crop(
                crop,
                bbox,
                source_rgb.size,
                rejected_text_regions,
                min_area,
            )
            candidates.append(
                ForegroundCandidate(
                    candidate_id=f"fg-{index:03d}",
                    source_pixel_bbox=bbox,
                    area=_bbox_area(bbox),
                    classification=classification,
                    confidence=confidence,
                    component_key=_component_key(crop),
                    provenance=provenance,
                )
            )
    return candidates


def foreground_candidates_to_manifest_specs(
    candidates: list[ForegroundCandidate],
) -> list[ForegroundCandidateSpec]:
    return [
        ForegroundCandidateSpec(
            candidate_id=candidate.candidate_id,
            source_pixel_bbox=candidate.source_pixel_bbox,
            area=candidate.area,
            classification=candidate.classification,
            confidence=candidate.confidence,
            component_key=candidate.component_key,
            provenance=_as_dict(candidate.provenance),
        )
        for candidate in candidates
    ]


def record_component_reuse(candidates: list[ForegroundCandidate]) -> list[ForegroundCandidate]:
    first_by_key: dict[str, ForegroundCandidate] = {}
    planned: list[ForegroundCandidate] = []
    for candidate in candidates:
        key = candidate.component_key
        if (
            key
            and candidate.classification not in {"rejected_text_like_region", "uncertain"}
            and key in first_by_key
        ):
            provenance = _as_dict(candidate.provenance)
            provenance["reuses_candidate_id"] = first_by_key[key].candidate_id
            planned.append(
                replace(
                    candidate,
                    classification="duplicate",
                    provenance=provenance,
                )
            )
            continue
        if key and candidate.classification not in {"rejected_text_like_region", "uncertain"}:
            first_by_key[key] = candidate
        planned.append(candidate)
    return planned


def _load_text_mask(path: str | Path | None, size: tuple[int, int]) -> Image.Image | None:
    if path is None:
        return None
    with Image.open(path) as mask:
        return mask.convert("L").resize(size)


def _difference_pixels(
    difference: Image.Image,
    text_mask: Image.Image | None,
    threshold: int,
) -> set[tuple[int, int]]:
    pixels: set[tuple[int, int]] = set()
    for y in range(difference.height):
        for x in range(difference.width):
            if text_mask is not None and text_mask.getpixel((x, y)) > 0:
                continue
            if max(difference.getpixel((x, y))) > threshold:
                pixels.add((x, y))
    return pixels


def _connected_components(pixels: set[tuple[int, int]]) -> list[list[tuple[int, int]]]:
    remaining = set(pixels)
    components: list[list[tuple[int, int]]] = []
    while remaining:
        seed = remaining.pop()
        stack = [seed]
        component = [seed]
        while stack:
            x, y = stack.pop()
            for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    stack.append(neighbor)
                    component.append(neighbor)
        components.append(component)
    components.sort(
        key=lambda item: (min(point[1] for point in item), min(point[0] for point in item))
    )
    return components


def _classify_crop(
    crop: Image.Image,
    bbox: PixelBBox,
    image_size: tuple[int, int],
    rejected_text_regions: list[PixelBBox],
    min_area: int,
) -> tuple[CandidateClassification, float, dict]:
    if any(_intersects(bbox, region) for region in rejected_text_regions):
        return "rejected_text_like_region", 1.0, {"reason": "overlaps_rejected_text_region"}

    area = _bbox_area(bbox)
    if area < min_area:
        return "uncertain", 0.2, {"reason": "below_min_area"}

    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    unique_colors = crop.getcolors(maxcolors=crop.width * crop.height + 1) or []
    fill_ratio = _non_white_ratio(crop)
    image_area_ratio = area / float(image_size[0] * image_size[1])

    if len(unique_colors) > 24 or image_area_ratio > 0.20:
        return (
            "complex_whole_visual",
            0.86,
            {
                "reason": "large_or_visually_complex",
                "unique_color_count": len(unique_colors),
            },
        )

    if (width / max(height, 1) >= 8 or height / max(width, 1) >= 8) and min(width, height) <= 5:
        return "native_shape_candidate", 0.93, {"shape_hint": "line"}

    if len(unique_colors) <= 2 and fill_ratio >= 0.92:
        return "native_shape_candidate", 0.94, {"shape_hint": "rectangle"}

    if len(unique_colors) <= 4 and fill_ratio >= 0.35:
        return "bitmap_asset_candidate", 0.82, {"reason": "simple_nonrectangular_visual"}

    return "uncertain", 0.5, {"reason": "low_classification_confidence"}


def _bbox_area(bbox: PixelBBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _validate_bbox_in_image(name: str, bbox: PixelBBox, image_size: tuple[int, int]) -> None:
    left, top, right, bottom = bbox
    width, height = image_size
    if min(bbox) < 0 or right <= left or bottom <= top or right > width or bottom > height:
        raise ValueError(f"{name} must be inside source image bounds")


def _intersects(a: PixelBBox, b: PixelBBox) -> bool:
    return max(a[0], b[0]) < min(a[2], b[2]) and max(a[1], b[1]) < min(a[3], b[3])


def _non_white_ratio(crop: Image.Image) -> float:
    histogram = crop.convert("L").histogram()
    non_white = sum(histogram[:245])
    total = crop.width * crop.height
    return non_white / float(total or 1)


def _component_key(crop: Image.Image) -> str:
    digest = hashlib.sha1()
    digest.update(str(crop.size).encode("ascii"))
    digest.update(crop.tobytes())
    return digest.hexdigest()


def _as_dict(value: object) -> dict:
    return dict(value) if isinstance(value, dict) else {}

"""Page-level analysis contracts for generative editable PPTX reconstruction."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .generative_editable_manifest import TextBoxSpec


BBox = tuple[int, int, int, int]


@dataclass(frozen=True)
class RejectedOCRHint:
    text: str
    source_pixel_bbox: BBox
    reason: str
    provenance: dict[str, Any]


@dataclass(frozen=True)
class PageTextAnalysis:
    accepted_text_boxes: list[TextBoxSpec]
    rejected_ocr_hints: list[RejectedOCRHint]
    visual_text_candidates: list[BBox]
    source_image_size: tuple[int, int]


def build_page_text_analysis(
    *,
    text_boxes: list[TextBoxSpec],
    visual_text_candidates: list[BBox],
    source_image_size: tuple[int, int],
) -> PageTextAnalysis:
    """Promote only visually anchored OCR layouts into editable text boxes.

    OCR text is useful as content and style hints, but approximate OCR geometry
    is not authoritative. This mirrors the reference workflows: a page-level
    analysis contract decides which layouts are safe to reconstruct, then the
    composer deterministically turns accepted objects into PPTX elements.
    """

    accepted: list[TextBoxSpec] = []
    rejected: list[RejectedOCRHint] = []
    for text_box in text_boxes:
        if not _text_box_has_approximate_ocr_layout(text_box):
            accepted.append(text_box)
            continue
        if _approximate_text_box_is_anchored(
            text_box.source_pixel_bbox,
            visual_text_candidates,
            source_image_size,
            text=text_box.text,
        ):
            accepted.append(_with_visual_layout_provenance(text_box))
            continue
        rejected.append(
            RejectedOCRHint(
                text=text_box.text,
                source_pixel_bbox=text_box.source_pixel_bbox,
                reason="unanchored_approximate_ocr",
                provenance=dict(text_box.provenance),
            )
        )
    return PageTextAnalysis(
        accepted_text_boxes=accepted,
        rejected_ocr_hints=rejected,
        visual_text_candidates=list(visual_text_candidates),
        source_image_size=source_image_size,
    )


def _with_visual_layout_provenance(text_box: TextBoxSpec) -> TextBoxSpec:
    return TextBoxSpec(
        text=text_box.text,
        source_pixel_bbox=text_box.source_pixel_bbox,
        source_pixel_polygon=text_box.source_pixel_polygon,
        font_family=text_box.font_family,
        font_size=text_box.font_size,
        color_hex=text_box.color_hex,
        alignment=text_box.alignment,
        opacity=text_box.opacity,
        style_hints={
            **dict(text_box.style_hints),
            "layout_source": "visual_text_candidate",
        },
        provenance={
            **dict(text_box.provenance),
            "layout_source": "visual_text_candidate",
            "ocr_layout_usage": "hint_only",
        },
    )


def _text_box_has_approximate_ocr_layout(text_box: TextBoxSpec) -> bool:
    provenance = text_box.provenance.get("ocr_provenance")
    return isinstance(provenance, dict) and bool(provenance.get("approximate_layout"))


def _approximate_text_box_is_anchored(
    bbox: BBox,
    visual_text_candidates: list[BBox],
    source_image_size: tuple[int, int],
    *,
    text: str = "",
) -> bool:
    image_width, image_height = source_image_size
    if _is_large_top_text_box(bbox, image_width, image_height):
        return True
    if _is_small_top_approximate_text_box(bbox, image_width, image_height):
        return False
    return any(
        _visual_candidate_can_anchor_text(text, candidate, source_image_size)
        and _visual_candidate_size_matches_text_bbox(bbox, candidate, source_image_size)
        and (_bbox_iou(bbox, candidate) >= 0.05 or _bbox_center_inside(bbox, candidate))
        for candidate in visual_text_candidates
    )


def _visual_candidate_size_matches_text_bbox(
    bbox: BBox,
    candidate: BBox,
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
    candidate: BBox,
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
    bbox: BBox,
    image_width: int,
    image_height: int,
) -> bool:
    left, top, right, bottom = bbox
    return (
        top <= image_height * 0.12 and (right - left) >= image_width * 0.25 and (bottom - top) >= 20
    )


def _is_small_top_approximate_text_box(
    bbox: BBox,
    image_width: int,
    image_height: int,
) -> bool:
    left, top, right, bottom = bbox
    return (
        top <= image_height * 0.12
        and (bottom - top) <= max(18, image_height * 0.025)
        and (right - left) <= image_width * 0.18
    )


def _bbox_center_inside(bbox: BBox, candidate: BBox) -> bool:
    center_x = (bbox[0] + bbox[2]) / 2.0
    center_y = (bbox[1] + bbox[3]) / 2.0
    horizontal_padding = max(6, round((candidate[2] - candidate[0]) * 0.08))
    vertical_padding = max(6, round((candidate[3] - candidate[1]) * 0.18))
    return (
        candidate[0] - horizontal_padding <= center_x <= candidate[2] + horizontal_padding
        and candidate[1] - vertical_padding <= center_y <= candidate[3] + vertical_padding
    )


def _bbox_iou(first: BBox, second: BBox) -> float:
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

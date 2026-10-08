"""Text extraction helpers for generative editable PPTX reconstruction."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from .generative_editable_manifest import TextBoxSpec, sanitize_persisted_payload
from .generative_editable_providers import OCRResult, OCRTextItem


@dataclass(frozen=True)
class TextExtractionResult:
    text_boxes: list[TextBoxSpec]
    issues: list[dict[str, Any]]
    validation_status: str


def extract_text_boxes(
    text_metadata: list[dict[str, Any]],
    ocr_result: OCRResult,
) -> list[TextBoxSpec]:
    """Build editable text boxes using AIPPT content and OCR geometry/style."""
    if not text_metadata:
        return [_text_box_from_ocr(item) for item in ocr_result.items]

    boxes: list[TextBoxSpec] = []
    ordered_metadata = sorted(text_metadata, key=lambda item: int(item.get("order", 0)))
    if _duplicate_metadata_orders(ordered_metadata):
        raise ValueError("duplicate metadata order values are not allowed")
    matched_ocr_indexes: set[int] = set()
    for metadata in ordered_metadata:
        index = _metadata_ocr_index(metadata)
        if index < 0 or index >= len(ocr_result.items):
            break
        matched_ocr_indexes.add(index)
        boxes.append(_text_box_from_metadata_and_ocr(metadata, ocr_result.items[index]))
    for index, ocr_item in enumerate(ocr_result.items):
        if index not in matched_ocr_indexes:
            boxes.append(_text_box_from_ocr(ocr_item))
    return boxes


def extract_text_with_validation(
    text_metadata: list[dict[str, Any]],
    ocr_result: OCRResult,
    *,
    min_confidence: float = 0.75,
) -> TextExtractionResult:
    boxes: list[TextBoxSpec] = []
    issues: list[dict[str, Any]] = []
    unmatched_metadata_issues: list[dict[str, Any]] = []
    ordered_metadata = sorted(text_metadata, key=lambda item: int(item.get("order", 0)))
    matched_ocr_indexes: set[int] = set()
    kept_approximate_text_bboxes: dict[str, list[tuple[int, int, int, int]]] = {}
    duplicate_orders = _duplicate_metadata_orders(ordered_metadata)
    for order in duplicate_orders:
        issues.append({"code": "duplicate_metadata_order", "metadata_order": order})

    if ordered_metadata:
        for metadata in ordered_metadata:
            if metadata.get("order") in duplicate_orders:
                continue
            index = _metadata_ocr_index(metadata)
            if index < 0 or index >= len(ocr_result.items):
                unmatched_metadata_issues.append(
                    {
                        "code": "metadata_unmatched",
                        "metadata_text": str(metadata.get("text", "")),
                        "metadata_order": metadata.get("order"),
                    }
                )
                continue
            ocr_item = ocr_result.items[index]
            matched_ocr_indexes.add(index)
            if ocr_item.confidence < min_confidence and not _metadata_text_matches_ocr(
                metadata,
                ocr_item,
            ):
                issues.append(_low_confidence_issue(ocr_item, index, min_confidence))
                continue
            boxes.append(_text_box_from_metadata_and_ocr(metadata, ocr_item))
    else:
        if not ocr_result.items:
            issues.append({"code": "no_ocr_text_detected"})
        for index, ocr_item in enumerate(ocr_result.items):
            if _has_uniform_fallback_layout(ocr_item):
                issues.append(_uniform_fallback_layout_issue(ocr_item, index, min_confidence))
                matched_ocr_indexes.add(index)
                continue
            if _should_ignore_spurious_ocr_item(ocr_item, ocr_result.image_size):
                issues.append(_ignored_spurious_ocr_issue(ocr_item, index, min_confidence))
                matched_ocr_indexes.add(index)
                continue
            if _should_ignore_duplicate_approximate_ocr_item(
                ocr_item,
                kept_approximate_text_bboxes,
            ):
                issues.append(_ignored_spurious_ocr_issue(ocr_item, index, min_confidence))
                matched_ocr_indexes.add(index)
                continue
            if ocr_item.confidence < min_confidence:
                issues.append(_low_confidence_issue(ocr_item, index, min_confidence))
                matched_ocr_indexes.add(index)
                continue
            boxes.append(_text_box_from_ocr(ocr_item))
            _record_kept_approximate_ocr_item(ocr_item, kept_approximate_text_bboxes)
            matched_ocr_indexes.add(index)

    for index, ocr_item in enumerate(ocr_result.items):
        if index in matched_ocr_indexes:
            continue
        if _has_uniform_fallback_layout(ocr_item):
            issues.append(_uniform_fallback_layout_issue(ocr_item, index, min_confidence))
            continue
        if _should_ignore_spurious_ocr_item(ocr_item, ocr_result.image_size):
            issues.append(_ignored_spurious_ocr_issue(ocr_item, index, min_confidence))
            continue
        if _should_ignore_duplicate_approximate_ocr_item(
            ocr_item,
            kept_approximate_text_bboxes,
        ):
            issues.append(_ignored_spurious_ocr_issue(ocr_item, index, min_confidence))
            continue
        if ocr_item.confidence < min_confidence:
            if ordered_metadata and _is_likely_spurious_ocr_item(ocr_item, ocr_result.image_size):
                issues.append(_ignored_spurious_ocr_issue(ocr_item, index, min_confidence))
                continue
            issues.append(_low_confidence_issue(ocr_item, index, min_confidence))
            continue
        boxes.append(_text_box_from_ocr(ocr_item))
        _record_kept_approximate_ocr_item(ocr_item, kept_approximate_text_bboxes)

    issues.extend(unmatched_metadata_issues)
    return TextExtractionResult(
        text_boxes=boxes,
        issues=issues,
        validation_status="failed" if _has_blocking_text_issues(issues) else "passed",
    )


def _text_box_from_metadata_and_ocr(metadata: dict[str, Any], ocr_item: OCRTextItem) -> TextBoxSpec:
    style_hint = metadata.get("style_hint") or {}
    font_family = style_hint.get("font_family") or _font_family_for_ocr_item(ocr_item)
    provenance = {
        "content_source": "aippt_metadata",
        "layout_source": "ocr",
        "ocr_confidence": ocr_item.confidence,
        "ocr_provenance": sanitize_persisted_payload({"payload": dict(ocr_item.provenance)}).get(
            "payload", {}
        ),
        "metadata_role": metadata.get("role", ""),
        "metadata_order": metadata.get("order"),
    }
    return TextBoxSpec(
        text=str(metadata.get("text", "")),
        source_pixel_bbox=ocr_item.bbox,
        source_pixel_polygon=ocr_item.polygon,
        font_family=str(font_family or ""),
        font_size=_font_size_for_ocr_item(ocr_item),
        color_hex=_normalize_color(ocr_item.color_hex),
        alignment=_normalize_alignment(ocr_item.alignment),
        style_hints=_safe_style_hints(ocr_item.style_hints),
        provenance=provenance,
    )


def _text_box_from_ocr(ocr_item: OCRTextItem) -> TextBoxSpec:
    return TextBoxSpec(
        text=ocr_item.text,
        source_pixel_bbox=ocr_item.bbox,
        source_pixel_polygon=ocr_item.polygon,
        font_family=_font_family_for_ocr_item(ocr_item),
        font_size=_font_size_for_ocr_item(ocr_item),
        color_hex=_normalize_color(ocr_item.color_hex),
        alignment=_normalize_alignment(ocr_item.alignment),
        style_hints=_safe_style_hints(ocr_item.style_hints),
        provenance={
            "content_source": "ocr",
            "layout_source": "ocr",
            "ocr_confidence": ocr_item.confidence,
            "ocr_provenance": sanitize_persisted_payload(
                {"payload": dict(ocr_item.provenance)}
            ).get("payload", {}),
        },
    )


def _font_family_for_ocr_item(ocr_item: OCRTextItem) -> str:
    if ocr_item.font_family_hint:
        return ocr_item.font_family_hint
    if _contains_cjk(ocr_item.text):
        return "Microsoft YaHei"
    return "Arial"


def _font_size_for_ocr_item(ocr_item: OCRTextItem) -> float:
    size = ocr_item.font_size_hint or 18
    if _is_approximate_layout_ocr_item(ocr_item):
        meaningful_len = len(_meaningful_text(ocr_item.text))
        height = max(1, ocr_item.bbox[3] - ocr_item.bbox[1])
        if height >= 40 and meaningful_len <= 12 and size <= 20:
            size = min(size, 14.0)
        elif height >= 55 and meaningful_len <= 12:
            size = min(size, 14.0)
        elif height >= 70 and meaningful_len <= 20:
            size = min(size, 16.0)
    return size


def _normalize_color(value: str | None) -> str:
    if not isinstance(value, str):
        return "#000000"
    color = value.strip().upper()
    if re.fullmatch(r"#?[0-9A-F]{6}", color):
        return color if color.startswith("#") else f"#{color}"
    return "#000000"


def _normalize_alignment(value: str) -> str:
    return value if value in {"left", "center", "right", "justify"} else "left"


def _contains_cjk(value: str) -> bool:
    return any(
        "\u3040" <= char <= "\u30ff"
        or "\u3400" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
        or "\uac00" <= char <= "\ud7af"
        for char in value
    )


def _low_confidence_issue(
    ocr_item: OCRTextItem, index: int, min_confidence: float
) -> dict[str, Any]:
    return {
        "code": "low_ocr_confidence",
        "ocr_index": index,
        "ocr_text": ocr_item.text,
        "confidence": ocr_item.confidence,
        "min_confidence": min_confidence,
    }


def _ignored_spurious_ocr_issue(
    ocr_item: OCRTextItem, index: int, min_confidence: float
) -> dict[str, Any]:
    return {
        "code": "ignored_spurious_ocr",
        "severity": "warning",
        "ocr_index": index,
        "ocr_text": ocr_item.text,
        "confidence": ocr_item.confidence,
        "min_confidence": min_confidence,
        "bbox": ocr_item.bbox,
    }


def _uniform_fallback_layout_issue(
    ocr_item: OCRTextItem, index: int, min_confidence: float
) -> dict[str, Any]:
    if _is_low_value_uniform_fallback_text(ocr_item.text):
        return _ignored_spurious_ocr_issue(ocr_item, index, min_confidence)
    return {
        "code": "unreliable_ocr_layout",
        "ocr_index": index,
        "ocr_text": ocr_item.text,
        "confidence": ocr_item.confidence,
        "min_confidence": min_confidence,
        "bbox": ocr_item.bbox,
        "layout_source": "uniform_fallback",
    }


def _has_blocking_text_issues(issues: list[dict[str, Any]]) -> bool:
    return any(issue.get("severity") != "warning" for issue in issues)


def _metadata_text_matches_ocr(metadata: dict[str, Any], ocr_item: OCRTextItem) -> bool:
    return _normalize_match_text(str(metadata.get("text", ""))) == _normalize_match_text(
        ocr_item.text
    )


def _normalize_match_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _is_likely_spurious_ocr_item(
    ocr_item: OCRTextItem,
    image_size: tuple[int, int],
) -> bool:
    text = ocr_item.text.strip()
    alnum_count = sum(1 for char in text if char.isalnum())
    bbox_area = max(0, ocr_item.bbox[2] - ocr_item.bbox[0]) * max(
        0,
        ocr_item.bbox[3] - ocr_item.bbox[1],
    )
    image_area = max(1, image_size[0] * image_size[1])
    if alnum_count <= 1 and bbox_area <= 500:
        return True
    return alnum_count <= 3 and bbox_area / float(image_area) >= 0.15 and not text.isalnum()


def _should_ignore_spurious_ocr_item(
    ocr_item: OCRTextItem,
    image_size: tuple[int, int],
) -> bool:
    if _is_likely_spurious_ocr_item(ocr_item, image_size):
        return True
    if _is_likely_repetitive_hallucinated_text(ocr_item.text):
        return True
    if _long_text_does_not_fit_bbox(ocr_item, image_size):
        return True
    if _approximate_text_does_not_fit_bbox(ocr_item):
        return True
    return False


def _has_uniform_fallback_layout(ocr_item: OCRTextItem) -> bool:
    return str(ocr_item.provenance.get("layout_source", "")) == "uniform_fallback"


def _is_low_value_uniform_fallback_text(text: str) -> bool:
    meaningful = _meaningful_text(text)
    if len(meaningful) <= 3:
        return True
    digit_count = sum(1 for char in meaningful if char.isdigit())
    if digit_count and digit_count / float(len(meaningful)) >= 0.75:
        return True
    return False


def _should_ignore_duplicate_approximate_ocr_item(
    ocr_item: OCRTextItem,
    kept_bboxes: dict[str, list[tuple[int, int, int, int]]],
) -> bool:
    if not _is_approximate_layout_ocr_item(ocr_item):
        return False
    key = _normalize_match_text(ocr_item.text)
    if len(key) < 4:
        return False
    return any(
        _approximate_bboxes_overlap(ocr_item.bbox, kept_bbox)
        for kept_bbox in kept_bboxes.get(key, [])
    )


def _record_kept_approximate_ocr_item(
    ocr_item: OCRTextItem,
    kept_bboxes: dict[str, list[tuple[int, int, int, int]]],
) -> None:
    if not _is_approximate_layout_ocr_item(ocr_item):
        return
    key = _normalize_match_text(ocr_item.text)
    if len(key) < 4:
        return
    kept_bboxes.setdefault(key, []).append(ocr_item.bbox)


def _approximate_bboxes_overlap(
    first: tuple[int, int, int, int],
    second: tuple[int, int, int, int],
) -> bool:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    if right <= left or bottom <= top:
        center_dx = abs((first[0] + first[2]) / 2.0 - (second[0] + second[2]) / 2.0)
        center_dy = abs((first[1] + first[3]) / 2.0 - (second[1] + second[3]) / 2.0)
        return center_dx <= 8 and center_dy <= 8
    intersection = (right - left) * (bottom - top)
    first_area = max(1, (first[2] - first[0]) * (first[3] - first[1]))
    second_area = max(1, (second[2] - second[0]) * (second[3] - second[1]))
    return intersection / float(min(first_area, second_area)) >= 0.45


def _is_approximate_layout_ocr_item(ocr_item: OCRTextItem) -> bool:
    return bool(ocr_item.provenance.get("approximate_layout"))


def _is_likely_repetitive_hallucinated_text(text: str) -> bool:
    meaningful = _meaningful_text(text)
    if len(meaningful) < 40:
        return False
    if len(set(meaningful)) / float(len(meaningful)) <= 0.22:
        return True
    for width in (4, 5, 6, 8):
        counts: dict[str, int] = {}
        for index in range(0, len(meaningful) - width + 1):
            token = meaningful[index : index + width]
            counts[token] = counts.get(token, 0) + 1
        if not counts:
            continue
        repeat_count = max(counts.values())
        if repeat_count >= 4 and repeat_count * width / float(len(meaningful)) >= 0.32:
            return True
    return False


def _long_text_does_not_fit_bbox(
    ocr_item: OCRTextItem,
    image_size: tuple[int, int],
) -> bool:
    meaningful = _meaningful_text(ocr_item.text)
    if len(meaningful) < 20:
        return False
    left, top, right, bottom = ocr_item.bbox
    width = max(1, right - left)
    height = max(1, bottom - top)
    bbox_area = width * height
    image_area = max(1, image_size[0] * image_size[1])
    char_density = len(meaningful) / float(bbox_area)
    return bbox_area / float(image_area) <= 0.02 and char_density >= 0.004


def _approximate_text_does_not_fit_bbox(ocr_item: OCRTextItem) -> bool:
    if not _is_approximate_layout_ocr_item(ocr_item):
        return False
    meaningful = _meaningful_text(ocr_item.text)
    if len(meaningful) < 4:
        return False
    left, top, right, bottom = ocr_item.bbox
    width = max(1, right - left)
    height = max(1, bottom - top)
    min_horizontal_width = len(meaningful) * max(8, height) * 0.42
    if width < min_horizontal_width * 0.88:
        return True
    return False


def _meaningful_text(text: str) -> str:
    return "".join(char for char in text if char.isalnum())


def _safe_style_hints(style_hints: dict[str, Any]) -> dict[str, Any]:
    return sanitize_persisted_payload({"payload": dict(style_hints)}).get("payload", {})


def _metadata_ocr_index(metadata: dict[str, Any]) -> int:
    return int(metadata.get("order", 0)) - 1


def _duplicate_metadata_orders(metadata_items: list[dict[str, Any]]) -> set[int]:
    seen: set[int] = set()
    duplicates: set[int] = set()
    for metadata in metadata_items:
        order = int(metadata.get("order", 0))
        if order in seen:
            duplicates.add(order)
        seen.add(order)
    return duplicates

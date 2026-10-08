"""Asset sheet request, slicing, QA, and repair helpers."""

from __future__ import annotations

from dataclasses import dataclass, replace
import math
from pathlib import Path
import re
from typing import Literal

from PIL import Image

from .generative_editable_foreground_planner import ForegroundCandidate
from .generative_editable_manifest import BitmapAssetSpec, RepairAttempt
from .generative_editable_providers import ImageEditProvider, ImageEditRequest


@dataclass(frozen=True)
class AssetSliceSpec:
    candidate_id: str
    sheet_bbox: tuple[int, int, int, int]
    source_pixel_bbox: tuple[int, int, int, int]
    output_filename: str
    z_order: int = 1


@dataclass(frozen=True)
class AssetQAReport:
    status: Literal["passed", "failed"]
    reasons: list[str]


def build_asset_sheet_request(
    *,
    source_image_path: str | Path,
    candidates: list[ForegroundCandidate],
    output_asset_path: str | Path,
    asset_root: str | Path,
    chroma_key_mode: str = "solid #FF00FF chroma key",
    provider_role: str = "edit_model",
    timeout_seconds: int = 180,
) -> ImageEditRequest:
    if not candidates:
        raise ValueError("candidates are required")
    source_ref = _artifact_ref(source_image_path, asset_root)
    candidate_boxes = [
        {
            "candidate_id": candidate.candidate_id,
            "bbox": candidate.source_pixel_bbox,
            "classification": candidate.classification,
        }
        for candidate in candidates
    ]
    prompt = (
        "Create a sparse asset sheet for these source regions. Preserve each candidate's "
        "visual identity, geometry, stroke, color, proportions, and internal cutouts. "
        "Produce exactly one separated object per candidate id, in the same visual order. "
        "Do not merge, omit, rename, replace, or add objects. "
        f"Use {chroma_key_mode} background mode with generous empty space around every object. "
        "The background must be flat pure #FF00FF only. "
        "Do not use checkerboard, gray, white, shadows, gradients, or scene floors. "
        "Do not include readable text, labels, numbers, pseudo-text, or watermarks. "
        "Keep text boxes out of the asset sheet because editable text is rebuilt separately. "
        "Do not include full cards, panels, charts, or source-slide fragments; extract only the listed non-text foreground objects. "
        "Candidate boxes are source-image pixel coordinates in (left, top, right, bottom) order. "
        "Extract only the visual object inside each box. Candidate boxes:\n"
        + "\n".join(
            f"- {candidate.candidate_id} bbox={candidate.source_pixel_bbox} "
            f"classification={candidate.classification}"
            for candidate in candidates
        )
    )
    return ImageEditRequest(
        source_image_path=str(source_image_path),
        prompt_id="asset_sheet",
        prompt=prompt,
        output_asset_path=str(output_asset_path),
        asset_root=str(asset_root),
        timeout_seconds=timeout_seconds,
        metadata={
            "source_image_ref": source_ref,
            "candidate_boxes": candidate_boxes,
            "chroma_key_mode": chroma_key_mode,
            "provider_role": provider_role,
        },
    )


def slice_asset_sheet(
    *,
    sheet_path: str | Path,
    slice_specs: list[AssetSliceSpec],
    output_dir: str | Path,
    asset_root: str | Path,
    chroma_key: tuple[int, int, int] | None = None,
) -> list[BitmapAssetSpec]:
    output_root = _resolve_inside_root(output_dir, asset_root, "output_dir")
    resolved_sheet = _resolve_inside_root(sheet_path, asset_root, "sheet_path")
    output_root.mkdir(parents=True, exist_ok=True)
    assets: list[BitmapAssetSpec] = []
    with Image.open(resolved_sheet) as sheet:
        rgba = sheet.convert("RGBA")
        for spec in slice_specs:
            _validate_bbox(spec.sheet_bbox, rgba.size, "sheet_bbox")
            _validate_filename(spec.output_filename)
            crop = rgba.crop(spec.sheet_bbox)
            if chroma_key is not None:
                crop = _remove_chroma_key(crop, chroma_key)
            output_path = output_root / spec.output_filename
            crop.save(output_path)
            assets.append(
                BitmapAssetSpec(
                    asset_id=spec.candidate_id,
                    source_pixel_bbox=spec.source_pixel_bbox,
                    asset_path=_artifact_ref(output_path, asset_root),
                    z_order=spec.z_order,
                    provenance={
                        "candidate_id": spec.candidate_id,
                        "sheet_bbox": spec.sheet_bbox,
                    },
                )
            )
    return assets


def slice_asset_sheet_by_components(
    *,
    sheet_path: str | Path,
    candidates: list[ForegroundCandidate],
    output_dir: str | Path,
    asset_root: str | Path,
    padding: int = 12,
    min_component_area: int = 32,
    allow_extra_components: bool = False,
) -> list[BitmapAssetSpec]:
    if not candidates:
        return []
    output_root = _resolve_inside_root(output_dir, asset_root, "output_dir")
    resolved_sheet = _resolve_inside_root(sheet_path, asset_root, "sheet_path")
    output_root.mkdir(parents=True, exist_ok=True)
    with Image.open(resolved_sheet) as sheet:
        rgba = _sheet_with_inferred_alpha(sheet)
        boxes = _component_boxes_from_alpha(
            rgba,
            min_area=min_component_area,
            merge_gap=24,
            merge_union_growth=2.6,
        )
        if len(boxes) < len(candidates):
            raise ValueError(
                f"asset sheet contains {len(boxes)} component(s), expected at least {len(candidates)}"
            )
        if len(candidates) == 1 and len(boxes) > 1 and _candidate_allows_multipart(candidates[0]):
            boxes = [_union_all_boxes(boxes)]
        elif len(candidates) == 1 and len(boxes) > 1:
            raise ValueError(
                f"asset sheet contains unexpected extra component(s) for {candidates[0].candidate_id}"
            )
        ignored_extra_component_count = 0
        if len(boxes) > len(candidates) and allow_extra_components:
            original_count = len(boxes)
            boxes = [
                box
                for box in boxes
                if not _is_ignorable_extra_component(box, min_component_area=min_component_area)
            ]
            ignored_extra_component_count = original_count - len(boxes)
        if len(boxes) > len(candidates):
            raise ValueError(
                f"asset sheet contains unexpected extra component(s), got {len(boxes)} for {len(candidates)} candidate(s)"
            )
        boxes = _reading_order_boxes(boxes)
        assets: list[BitmapAssetSpec] = []
        for index, (candidate, bbox) in enumerate(zip(candidates, boxes, strict=True), start=1):
            output_filename = f"{_safe_name(candidate.candidate_id)}.png"
            _validate_filename(output_filename)
            crop_box = _pad_box(bbox, rgba.size, padding=padding)
            output_path = output_root / output_filename
            rgba.crop(crop_box).save(output_path)
            assets.append(
                BitmapAssetSpec(
                    asset_id=candidate.candidate_id,
                    source_pixel_bbox=candidate.source_pixel_bbox,
                    asset_path=_artifact_ref(output_path, asset_root),
                    z_order=index,
                    provenance={
                        "candidate_id": candidate.candidate_id,
                        "candidate_classification": candidate.classification,
                        "component_bbox": bbox,
                        "sheet_bbox": crop_box,
                        "split_method": "connected_components",
                        "ignored_extra_component_count": ignored_extra_component_count,
                    },
                )
            )
    return assets


def _is_ignorable_extra_component(
    bbox: tuple[int, int, int, int],
    *,
    min_component_area: int,
) -> bool:
    width = max(0, bbox[2] - bbox[0])
    height = max(0, bbox[3] - bbox[1])
    return width * height <= max(min_component_area, min_component_area * 4)


def validate_sliced_asset(
    *,
    asset_path: str | Path,
    expected_object_count: int | None = None,
    expected_text_free: bool = False,
    min_opaque_area_ratio: float | None = None,
    source_image_path: str | Path | None = None,
    source_pixel_bbox: tuple[int, int, int, int] | None = None,
    min_source_color_similarity: float | None = None,
) -> AssetQAReport:
    with Image.open(asset_path) as image:
        rgba = image.convert("RGBA")
        opaque_pixels = _opaque_pixels(rgba)
        reasons: list[str] = []
        if not opaque_pixels:
            reasons.append("empty_asset")
            if expected_object_count:
                reasons.append("missing_object")
            return AssetQAReport(status="failed", reasons=reasons)

        if any(x in {0, rgba.width - 1} or y in {0, rgba.height - 1} for x, y in opaque_pixels):
            reasons.append("edge_touch")

        components = _connected_components(opaque_pixels)
        if expected_object_count is not None and len(components) > expected_object_count:
            reasons.append("neighboring_object_contamination")
        if expected_object_count is not None and len(components) < expected_object_count:
            reasons.append("missing_object")
        if min_opaque_area_ratio is not None:
            opaque_ratio = len(opaque_pixels) / float(rgba.width * rgba.height)
            if opaque_ratio < min_opaque_area_ratio:
                reasons.append("missing_object")

        if expected_text_free and _looks_like_baked_text(rgba, opaque_pixels):
            reasons.append("baked_text_contamination")
        if (
            source_image_path is not None
            and source_pixel_bbox is not None
            and min_source_color_similarity is not None
        ):
            similarity = _source_color_similarity(
                asset_rgba=rgba,
                opaque_pixels=opaque_pixels,
                source_image_path=source_image_path,
                source_pixel_bbox=source_pixel_bbox,
            )
            if similarity is not None and similarity < min_source_color_similarity:
                reasons.append("source_visual_mismatch")
            if _source_geometry_mismatch(
                asset_rgba=rgba,
                opaque_pixels=opaque_pixels,
                source_image_path=source_image_path,
                source_pixel_bbox=source_pixel_bbox,
            ):
                reasons.append("source_geometry_mismatch")

    return AssetQAReport(status="failed" if reasons else "passed", reasons=reasons)


def repair_failed_assets(
    *,
    source_image_path: str | Path,
    failed_assets: list[BitmapAssetSpec],
    failure_reasons: dict[str, list[str]],
    output_dir: str | Path,
    asset_root: str | Path,
    edit_provider: ImageEditProvider,
    max_attempts: int,
    timeout_seconds: int = 180,
) -> tuple[list[BitmapAssetSpec], list[RepairAttempt]]:
    repaired: list[BitmapAssetSpec] = []
    attempts: list[RepairAttempt] = []
    output_root = _resolve_inside_root(output_dir, asset_root, "output_dir")
    output_root.mkdir(parents=True, exist_ok=True)
    source_ref = _artifact_ref(source_image_path, asset_root)
    for asset in failed_assets:
        reasons = failure_reasons.get(asset.asset_id, ["asset_quality_failed"])
        reason_text = ",".join(reasons)
        if max_attempts <= 0:
            attempts.append(
                RepairAttempt(
                    target_id=asset.asset_id,
                    attempt_index=1,
                    reason=f"repair_limit_exceeded:{reason_text}",
                    provider_role=edit_provider.config.role,
                    status="failed",
                    provenance={},
                )
            )
            continue
        for attempt_index in range(1, max_attempts + 1):
            reason_text = ",".join(reasons)
            output_path = output_root / f"{asset.asset_id}.repair-{attempt_index}.png"
            request = ImageEditRequest(
                source_image_path=str(source_image_path),
                prompt_id="repair_asset",
                prompt=(
                    "Regenerate only the failed foreground asset from the source slide. "
                    f"Failure reasons: {reason_text}."
                ),
                output_asset_path=str(output_path),
                asset_root=str(asset_root),
                timeout_seconds=timeout_seconds,
                metadata={
                    "source_image_ref": source_ref,
                    "candidate_id": asset.asset_id,
                    "source_pixel_bbox": asset.source_pixel_bbox,
                    "failure_reasons": reasons,
                    "attempt_index": attempt_index,
                },
            )
            result = edit_provider.edit(request)
            repaired_ref = _artifact_ref(result.output_asset_path, asset_root)
            qa = validate_sliced_asset(
                asset_path=result.output_asset_path,
                expected_object_count=1,
                expected_text_free="baked_text_contamination" in reasons,
                min_opaque_area_ratio=0.01,
                source_image_path=source_image_path,
                source_pixel_bbox=asset.source_pixel_bbox,
                min_source_color_similarity=0.75,
            )
            status = "passed" if qa.status == "passed" else "failed"
            attempts.append(
                RepairAttempt(
                    target_id=asset.asset_id,
                    attempt_index=attempt_index,
                    reason=reason_text if status == "passed" else ",".join(qa.reasons),
                    provider_role=result.provider_role,
                    status=status,
                    provenance={
                        "prompt_id": "repair_asset",
                        "output_asset_ref": repaired_ref,
                    },
                )
            )
            if qa.status == "passed":
                repaired_asset = replace(
                    asset,
                    asset_path=repaired_ref,
                    provenance={
                        **asset.provenance,
                        "repair_attempt": attempt_index,
                        "failure_reasons": reasons,
                    },
                )
                repaired.append(repaired_asset)
                break
        else:
            for index in range(len(attempts) - 1, -1, -1):
                if attempts[index].target_id == asset.asset_id:
                    attempts[index] = replace(
                        attempts[index],
                        reason=f"repair_limit_exceeded:{attempts[index].reason}",
                        status="failed",
                    )
                    break
    return repaired, attempts


def _remove_chroma_key(crop: Image.Image, chroma_key: tuple[int, int, int]) -> Image.Image:
    output = crop.copy()
    pixels = output.load()
    for y in range(output.height):
        for x in range(output.width):
            red, green, blue, alpha = pixels[x, y]
            if (
                abs(red - chroma_key[0]) <= 8
                and abs(green - chroma_key[1]) <= 8
                and abs(blue - chroma_key[2]) <= 8
            ):
                pixels[x, y] = (red, green, blue, 0)
            else:
                pixels[x, y] = (red, green, blue, alpha)
    return output


def _sheet_with_inferred_alpha(sheet: Image.Image) -> Image.Image:
    rgba = sheet.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] == 0:
        return rgba
    key = _dominant_border_color(rgba)
    if key is not None:
        keyed = _remove_chroma_key_with_tolerance(rgba, key, tolerance=36)
        if _has_transparent_pixels(keyed):
            return keyed
    magenta_keyed = _remove_magenta_chroma_background(rgba)
    if _has_transparent_pixels(magenta_keyed):
        return magenta_keyed
    checkerboard = _remove_light_neutral_border_background(rgba)
    if _has_transparent_pixels(checkerboard):
        return checkerboard
    return rgba


def _has_transparent_pixels(image: Image.Image) -> bool:
    return image.getchannel("A").getextrema()[0] == 0


def _dominant_border_color(image: Image.Image) -> tuple[int, int, int] | None:
    if image.width == 0 or image.height == 0:
        return None
    counts: dict[tuple[int, int, int], int] = {}
    for x in range(image.width):
        for y in (0, image.height - 1):
            pixel = image.getpixel((x, y))[:3]
            counts[pixel] = counts.get(pixel, 0) + 1
    for y in range(image.height):
        for x in (0, image.width - 1):
            pixel = image.getpixel((x, y))[:3]
            counts[pixel] = counts.get(pixel, 0) + 1
    if not counts:
        return None
    color, count = max(counts.items(), key=lambda item: item[1])
    border_count = max(1, 2 * image.width + 2 * image.height)
    if count / border_count < 0.25:
        return None
    return color


def _remove_chroma_key_with_tolerance(
    image: Image.Image,
    chroma_key: tuple[int, int, int],
    *,
    tolerance: int,
) -> Image.Image:
    output = image.copy()
    pixels = output.load()
    red_key, green_key, blue_key = chroma_key
    for y in range(output.height):
        for x in range(output.width):
            red, green, blue, alpha = pixels[x, y]
            if (
                abs(red - red_key) <= tolerance
                and abs(green - green_key) <= tolerance
                and abs(blue - blue_key) <= tolerance
            ):
                pixels[x, y] = (red, green, blue, 0)
            else:
                pixels[x, y] = (red, green, blue, alpha)
    return output


def _remove_light_neutral_border_background(image: Image.Image) -> Image.Image:
    border_pixels = _border_rgb_pixels(image)
    neutral_lumas = [
        _luma(pixel)
        for pixel in border_pixels
        if _is_light_neutral(pixel, min_luma=180, max_channel_delta=24)
    ]
    if len(neutral_lumas) < max(16, len(border_pixels) // 5):
        return image
    min_luma = max(180, min(neutral_lumas) - 18)
    max_luma = min(255, max(neutral_lumas) + 18)
    output = image.copy()
    pixels = output.load()
    for y in range(output.height):
        for x in range(output.width):
            red, green, blue, alpha = pixels[x, y]
            rgb = (red, green, blue)
            if min_luma <= _luma(rgb) <= max_luma and _is_light_neutral(
                rgb, min_luma=min_luma, max_channel_delta=30
            ):
                pixels[x, y] = (red, green, blue, 0)
            else:
                pixels[x, y] = (red, green, blue, alpha)
    return output


def _remove_magenta_chroma_background(image: Image.Image) -> Image.Image:
    border_pixels = _border_rgb_pixels(image)
    magenta_border_count = sum(1 for pixel in border_pixels if _is_magenta_chroma(pixel))
    if magenta_border_count < max(16, len(border_pixels) // 5):
        return image
    output = image.copy()
    pixels = output.load()
    for y in range(output.height):
        for x in range(output.width):
            red, green, blue, alpha = pixels[x, y]
            if _is_magenta_chroma((red, green, blue)):
                pixels[x, y] = (red, green, blue, 0)
            else:
                pixels[x, y] = (red, green, blue, alpha)
    return output


def _border_rgb_pixels(image: Image.Image) -> list[tuple[int, int, int]]:
    if image.width == 0 or image.height == 0:
        return []
    pixels: list[tuple[int, int, int]] = []
    for x in range(image.width):
        pixels.append(image.getpixel((x, 0))[:3])
        pixels.append(image.getpixel((x, image.height - 1))[:3])
    for y in range(1, max(1, image.height - 1)):
        pixels.append(image.getpixel((0, y))[:3])
        pixels.append(image.getpixel((image.width - 1, y))[:3])
    return pixels


def _is_light_neutral(
    pixel: tuple[int, int, int],
    *,
    min_luma: int,
    max_channel_delta: int,
) -> bool:
    red, green, blue = pixel
    return (
        _luma(pixel) >= min_luma
        and max(red, green, blue) - min(red, green, blue) <= max_channel_delta
    )


def _is_magenta_chroma(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel
    return red >= 170 and blue >= 160 and green <= 130 and red - green >= 70 and blue - green >= 60


def _luma(pixel: tuple[int, int, int]) -> int:
    red, green, blue = pixel
    return int(round((red * 0.299) + (green * 0.587) + (blue * 0.114)))


def _component_boxes_from_alpha(
    image: Image.Image,
    *,
    min_area: int,
    merge_gap: int,
    merge_union_growth: float,
) -> list[tuple[int, int, int, int]]:
    components = _connected_components(_opaque_pixels(image))
    boxes = [_box_from_points(component) for component in components if len(component) >= min_area]
    return _merge_nearby_boxes(boxes, gap=merge_gap, max_union_growth=merge_union_growth)


def _box_from_points(points: set[tuple[int, int]]) -> tuple[int, int, int, int]:
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def _merge_nearby_boxes(
    boxes: list[tuple[int, int, int, int]],
    *,
    gap: int,
    max_union_growth: float,
) -> list[tuple[int, int, int, int]]:
    merged = list(boxes)
    changed = True
    while changed:
        changed = False
        for left_index in range(len(merged)):
            if changed:
                break
            for right_index in range(left_index + 1, len(merged)):
                left = merged[left_index]
                right = merged[right_index]
                if not _boxes_should_merge(left, right, gap=gap, max_union_growth=max_union_growth):
                    continue
                merged[left_index] = _union_box(left, right)
                del merged[right_index]
                changed = True
                break
    return merged


def _boxes_should_merge(
    left: tuple[int, int, int, int],
    right: tuple[int, int, int, int],
    *,
    gap: int,
    max_union_growth: float,
) -> bool:
    if _box_distance(left, right) > gap:
        return False
    union = _union_box(left, right)
    union_area = _box_area(union)
    source_area = max(_box_area(left), _box_area(right), 1)
    return union_area / source_area <= max_union_growth


def _box_distance(
    left: tuple[int, int, int, int],
    right: tuple[int, int, int, int],
) -> int:
    horizontal_gap = max(0, max(left[0], right[0]) - min(left[2], right[2]))
    vertical_gap = max(0, max(left[1], right[1]) - min(left[3], right[3]))
    return max(horizontal_gap, vertical_gap)


def _union_box(
    left: tuple[int, int, int, int],
    right: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    return (
        min(left[0], right[0]),
        min(left[1], right[1]),
        max(left[2], right[2]),
        max(left[3], right[3]),
    )


def _union_all_boxes(boxes: list[tuple[int, int, int, int]]) -> tuple[int, int, int, int]:
    if not boxes:
        raise ValueError("boxes are required")
    union = boxes[0]
    for box in boxes[1:]:
        union = _union_box(union, box)
    return union


def _candidate_allows_multipart(candidate: ForegroundCandidate) -> bool:
    provenance = candidate.provenance or {}
    return bool(provenance.get("merged_candidate_ids") or provenance.get("allow_multipart"))


def _box_area(box: tuple[int, int, int, int]) -> int:
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def _largest_boxes(
    boxes: list[tuple[int, int, int, int]],
    count: int,
) -> list[tuple[int, int, int, int]]:
    return sorted(boxes, key=_box_area, reverse=True)[:count]


def _reading_order_boxes(
    boxes: list[tuple[int, int, int, int]],
) -> list[tuple[int, int, int, int]]:
    if not boxes:
        return []
    median_height = sorted(box[3] - box[1] for box in boxes)[len(boxes) // 2]
    row_threshold = max(12.0, median_height * 0.75)
    rows: list[list[tuple[int, int, int, int]]] = []
    row_centers: list[float] = []
    for box in sorted(boxes, key=lambda item: _box_center_y(item)):
        center_y = _box_center_y(box)
        for row_index, row_center in enumerate(row_centers):
            if abs(center_y - row_center) <= row_threshold:
                rows[row_index].append(box)
                row_centers[row_index] = sum(_box_center_y(item) for item in rows[row_index]) / len(
                    rows[row_index]
                )
                break
        else:
            rows.append([box])
            row_centers.append(center_y)
    ordered: list[tuple[int, int, int, int]] = []
    for _center, row in sorted(zip(row_centers, rows, strict=True), key=lambda item: item[0]):
        ordered.extend(sorted(row, key=lambda box: box[0]))
    return ordered


def _box_center_y(box: tuple[int, int, int, int]) -> float:
    return (box[1] + box[3]) / 2.0


def _pad_box(
    box: tuple[int, int, int, int],
    size: tuple[int, int],
    *,
    padding: int,
) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    width, height = size
    return (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )


def _opaque_pixels(image: Image.Image) -> set[tuple[int, int]]:
    alpha = image.getchannel("A")
    pixels: set[tuple[int, int]] = set()
    for y in range(image.height):
        for x in range(image.width):
            if alpha.getpixel((x, y)) > 0:
                pixels.add((x, y))
    return pixels


def _connected_components(pixels: set[tuple[int, int]]) -> list[set[tuple[int, int]]]:
    remaining = set(pixels)
    components: list[set[tuple[int, int]]] = []
    while remaining:
        seed = remaining.pop()
        stack = [seed]
        component = {seed}
        while stack:
            x, y = stack.pop()
            for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    stack.append(neighbor)
                    component.add(neighbor)
        components.append(component)
    return components


def _looks_like_baked_text(image: Image.Image, opaque_pixels: set[tuple[int, int]]) -> bool:
    if not opaque_pixels:
        return False
    xs = [point[0] for point in opaque_pixels]
    ys = [point[1] for point in opaque_pixels]
    width = max(xs) - min(xs) + 1
    height = max(ys) - min(ys) + 1
    area_ratio = len(opaque_pixels) / float(width * height)
    dark_ratio = sum(1 for x, y in opaque_pixels if max(image.getpixel((x, y))[:3]) < 64) / float(
        len(opaque_pixels)
    )
    return dark_ratio > 0.85 and 0.45 <= area_ratio <= 1.0 and width > height


def _source_color_similarity(
    *,
    asset_rgba: Image.Image,
    opaque_pixels: set[tuple[int, int]],
    source_image_path: str | Path,
    source_pixel_bbox: tuple[int, int, int, int],
) -> float | None:
    asset_color = _mean_color([asset_rgba.getpixel((x, y))[:3] for x, y in opaque_pixels])
    if asset_color is None:
        return None
    with Image.open(source_image_path) as source:
        rgb = source.convert("RGB")
        _validate_bbox(source_pixel_bbox, rgb.size, "source_pixel_bbox")
        crop = rgb.crop(source_pixel_bbox)
    source_pixels = _foreground_source_pixels(crop)
    source_color = _mean_color(source_pixels)
    if source_color is None:
        return None
    distance = math.sqrt(sum((asset_color[index] - source_color[index]) ** 2 for index in range(3)))
    return max(0.0, 1.0 - distance / math.sqrt(3 * 255**2))


def _source_geometry_mismatch(
    *,
    asset_rgba: Image.Image,
    opaque_pixels: set[tuple[int, int]],
    source_image_path: str | Path,
    source_pixel_bbox: tuple[int, int, int, int],
    max_aspect_ratio_delta: float = 2.4,
) -> bool:
    asset_bbox = _box_from_points(opaque_pixels)
    asset_aspect = _box_aspect_ratio(asset_bbox)
    with Image.open(source_image_path) as source:
        rgb = source.convert("RGB")
        _validate_bbox(source_pixel_bbox, rgb.size, "source_pixel_bbox")
        crop = rgb.crop(source_pixel_bbox)
    source_bbox = _foreground_source_bbox(crop)
    if source_bbox is None:
        source_bbox = (0, 0, crop.width, crop.height)
    source_aspect = _box_aspect_ratio(source_bbox)
    if source_aspect <= 0 or asset_aspect <= 0:
        return False
    ratio = max(asset_aspect / source_aspect, source_aspect / asset_aspect)
    return ratio > max_aspect_ratio_delta


def _box_aspect_ratio(box: tuple[int, int, int, int]) -> float:
    width = max(1, box[2] - box[0])
    height = max(1, box[3] - box[1])
    return width / float(height)


def _foreground_source_pixels(crop: Image.Image) -> list[tuple[int, int, int]]:
    foreground = _foreground_source_points(crop)
    return [crop.getpixel(point) for point in foreground]


def _foreground_source_bbox(crop: Image.Image) -> tuple[int, int, int, int] | None:
    foreground = _foreground_source_points(crop)
    if not foreground:
        return None
    xs = [point[0] for point in foreground]
    ys = [point[1] for point in foreground]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def _foreground_source_points(crop: Image.Image) -> list[tuple[int, int]]:
    if crop.width == 0 or crop.height == 0:
        return []
    corners = [
        crop.getpixel((0, 0)),
        crop.getpixel((crop.width - 1, 0)),
        crop.getpixel((0, crop.height - 1)),
        crop.getpixel((crop.width - 1, crop.height - 1)),
    ]
    background = _mean_color(corners)
    if background is None:
        return []
    points: list[tuple[int, int]] = []
    for y in range(crop.height):
        for x in range(crop.width):
            pixel = crop.getpixel((x, y))
            distance = math.sqrt(sum((pixel[index] - background[index]) ** 2 for index in range(3)))
            if distance > 24:
                points.append((x, y))
    return points


def _mean_color(pixels) -> tuple[float, float, float] | None:
    values = list(pixels)
    if not values:
        return None
    count = float(len(values))
    return (
        sum(pixel[0] for pixel in values) / count,
        sum(pixel[1] for pixel in values) / count,
        sum(pixel[2] for pixel in values) / count,
    )


def _artifact_ref(path: str | Path, asset_root: str | Path) -> str:
    item = Path(path)
    root = Path(asset_root)
    try:
        return item.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as exc:
        raise ValueError("artifact path must be inside asset_root") from exc


def _resolve_inside_root(path: str | Path, asset_root: str | Path, field_name: str) -> Path:
    root = Path(asset_root).resolve()
    value = Path(path)
    if not value.is_absolute():
        value = root / value
    resolved = value.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"{field_name} must be inside asset_root")
    return resolved


def _validate_bbox(bbox: tuple[int, int, int, int], size: tuple[int, int], name: str) -> None:
    left, top, right, bottom = bbox
    width, height = size
    if min(bbox) < 0 or right <= left or bottom <= top or right > width or bottom > height:
        raise ValueError(f"{name} must be inside image bounds")


def _validate_filename(filename: str) -> None:
    if Path(filename).name != filename or filename in {"", ".", ".."}:
        raise ValueError("output_filename must be a plain filename")


def _safe_name(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value)).strip("-._")
    return safe or "asset"

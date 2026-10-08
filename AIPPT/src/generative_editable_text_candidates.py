"""Classical text-like region detection for editable PPTX quality gates."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

BBox = tuple[int, int, int, int]

TILE = 96
MIN_GLYPH_PX = 6
MAX_TEXT_FILL = 0.65
MIN_CLASS_SEPARATION = 25.0
MAX_INK_FRACTION = 0.45
MIN_INK_PIXELS = 8
ROW_GAP_ABS_FRACTION = 0.003
COL_GAP_BAND_FRACTION = 0.25


def detect_text_candidate_bboxes(
    image_path: str | Path,
    *,
    min_glyph: int = MIN_GLYPH_PX,
) -> list[BBox]:
    gray = _load_gray(image_path)
    height, width = gray.shape
    mask = _binarize_page(gray)
    boxes: list[tuple[int, int, int, int]] = []
    _xy_cut(
        mask,
        0,
        0,
        max(6, round(height * 0.008)),
        max(14, round(width * 0.011)),
        boxes,
    )
    candidates = _measure_leaves(gray, mask, boxes, min_glyph)
    candidates.extend(_detect_bright_text_group_bboxes(image_path))
    candidates.extend(_detect_large_bright_text_line_bboxes(image_path))
    candidates.extend(_detect_left_blue_label_bboxes(image_path))
    return _dedupe_bboxes(candidates)


def _load_gray(path: str | Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("L"), dtype=np.float32)


def _load_rgb(path: str | Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)


def _detect_left_blue_label_bboxes(image_path: str | Path) -> list[BBox]:
    rgb = _load_rgb(image_path)
    height, width = rgb.shape[:2]
    red = rgb[:, :, 0].astype(np.int16)
    green = rgb[:, :, 1].astype(np.int16)
    blue = rgb[:, :, 2].astype(np.int16)
    mask = ((blue >= 120) & (green >= 70) & ((blue - red) >= 25)) | (
        (green >= 120) & (blue >= 120) & (red <= 140)
    )
    x_limit = max(1, int(width * 0.35))
    left_mask = mask[:, :x_limit]
    row_threshold = max(4, int(width * 0.003))
    rows = np.flatnonzero(left_mask.sum(axis=1) >= row_threshold)
    candidates: list[BBox] = []
    for top, bottom in _runs_from_indexes(rows, max_gap=8):
        band = left_mask[top:bottom, :]
        if bottom - top < 8:
            continue
        column_threshold = max(2, int((bottom - top) * 0.08))
        columns = np.flatnonzero(band.sum(axis=0) >= column_threshold)
        for left, right in _runs_from_indexes(columns, max_gap=8):
            box = _tight_mask_bbox(left_mask, left, top, right, bottom)
            if box is None:
                continue
            if _is_left_blue_label_bbox(box, (width, height)):
                candidates.append(box)
    return candidates


def _detect_large_bright_text_line_bboxes(image_path: str | Path) -> list[BBox]:
    rgb = _load_rgb(image_path)
    height, width = rgb.shape[:2]
    top_region_height = max(1, int(height * 0.46))
    left_region_width = max(1, int(width * 0.65))
    region = rgb[:top_region_height, :left_region_width, :]
    channels = region.astype(np.int16)
    max_channel = channels.max(axis=2)
    min_channel = channels.min(axis=2)
    mask = (max_channel >= 150) & ((max_channel - min_channel) <= 90)
    row_threshold = max(12, int(width * 0.010))
    rows = np.flatnonzero(mask.sum(axis=1) >= row_threshold)
    candidates: list[BBox] = []
    for top, bottom in _runs_from_indexes(rows, max_gap=10):
        if bottom - top < max(18, int(height * 0.025)):
            continue
        band = mask[top:bottom, :]
        column_threshold = max(4, int((bottom - top) * 0.06))
        columns = np.flatnonzero(band.sum(axis=0) >= column_threshold)
        column_runs = _runs_from_indexes(columns, max_gap=max(18, int(width * 0.035)))
        if not column_runs:
            continue
        left = min(run[0] for run in column_runs)
        right = max(run[1] for run in column_runs)
        if right - left < max(220, int(width * 0.22)):
            continue
        box = _tight_mask_bbox(mask, left, top, right, bottom)
        if box is not None and _is_large_bright_text_bbox(box, (width, height)):
            candidates.append(box)
    return candidates


def _detect_bright_text_group_bboxes(image_path: str | Path) -> list[BBox]:
    rgb = _load_rgb(image_path)
    height, width = rgb.shape[:2]
    channels = rgb.astype(np.int16)
    max_channel = channels.max(axis=2)
    min_channel = channels.min(axis=2)
    mask = (max_channel >= 150) & ((max_channel - min_channel) <= 100)
    row_threshold = max(8, int(width * 0.004))
    rows = np.flatnonzero(mask.sum(axis=1) >= row_threshold)
    candidates: list[BBox] = []
    for top, bottom in _runs_from_indexes(rows, max_gap=8):
        if bottom - top < 8:
            continue
        band = mask[top:bottom, :]
        column_threshold = max(2, int((bottom - top) * 0.05))
        columns = np.flatnonzero(band.sum(axis=0) >= column_threshold)
        for left, right in _runs_from_indexes(columns, max_gap=max(16, int(width * 0.010))):
            box = _tight_mask_bbox(mask, left, top, right, bottom)
            if box is not None and _is_bright_text_group_bbox(box, (width, height)):
                candidates.append(box)
    return candidates


def _is_bright_text_group_bbox(bbox: BBox, image_size: tuple[int, int]) -> bool:
    width, height = image_size
    x1, _y1, x2, y2 = bbox
    box_width = x2 - x1
    box_height = y2 - bbox[1]
    aspect = box_width / float(max(1, box_height))
    return (
        width * 0.02 <= box_width <= width * 0.24
        and height * 0.012 <= box_height <= height * 0.10
        and aspect >= 1.25
    )


def _is_large_bright_text_bbox(bbox: BBox, image_size: tuple[int, int]) -> bool:
    width, height = image_size
    x1, y1, x2, y2 = bbox
    box_width = x2 - x1
    box_height = y2 - y1
    return (
        x1 <= width * 0.25
        and y1 <= height * 0.42
        and box_width >= width * 0.22
        and height * 0.035 <= box_height <= height * 0.18
    )


def _runs_from_indexes(indexes: np.ndarray, *, max_gap: int) -> list[tuple[int, int]]:
    if indexes.size == 0:
        return []
    runs: list[tuple[int, int]] = []
    start = int(indexes[0])
    previous = int(indexes[0])
    for raw_index in indexes[1:]:
        index = int(raw_index)
        if index - previous > max_gap:
            runs.append((start, previous + 1))
            start = index
        previous = index
    runs.append((start, previous + 1))
    return runs


def _tight_mask_bbox(
    mask: np.ndarray,
    left: int,
    top: int,
    right: int,
    bottom: int,
) -> BBox | None:
    crop = mask[top:bottom, left:right]
    if not crop.any():
        return None
    ys, xs = np.nonzero(crop)
    x1 = max(0, left + int(xs.min()) - 3)
    y1 = max(0, top + int(ys.min()) - 3)
    x2 = min(mask.shape[1], left + int(xs.max()) + 4)
    y2 = min(mask.shape[0], top + int(ys.max()) + 4)
    return (x1, y1, x2, y2)


def _is_left_blue_label_bbox(bbox: BBox, image_size: tuple[int, int]) -> bool:
    width, height = image_size
    x1, y1, x2, y2 = bbox
    box_width = x2 - x1
    box_height = y2 - y1
    center_x = (x1 + x2) / 2.0
    return (
        width * 0.12 <= center_x <= width * 0.30
        and 40 <= box_width <= width * 0.18
        and 12 <= box_height <= max(70, height * 0.08)
        and box_width >= box_height * 1.2
    )


def _dedupe_bboxes(bboxes: list[BBox]) -> list[BBox]:
    deduped: list[BBox] = []
    for bbox in sorted(bboxes, key=lambda item: (item[1], item[0], -(item[2] - item[0]))):
        if _is_broad_container_for_existing_text_groups(bbox, deduped):
            continue
        if any(_bbox_iou(bbox, existing) >= 0.55 for existing in deduped):
            continue
        deduped.append(bbox)
    return deduped


def _is_broad_container_for_existing_text_groups(bbox: BBox, existing_bboxes: list[BBox]) -> bool:
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    if bbox[0] <= 150 and bbox[1] >= 100 and width >= 700 and height <= 80 and width >= height * 10:
        return True
    if width < 320 or width < height * 6:
        return False
    contained = [
        existing
        for existing in existing_bboxes
        if _bbox_contains_ratio(bbox, existing) >= 0.85
        and (existing[2] - existing[0]) <= width * 0.55
    ]
    return len(contained) >= (1 if width >= 700 and width >= height * 12 else 2)


def _bbox_contains_ratio(container: BBox, inner: BBox) -> float:
    left = max(container[0], inner[0])
    top = max(container[1], inner[1])
    right = min(container[2], inner[2])
    bottom = min(container[3], inner[3])
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    inner_area = max(0, inner[2] - inner[0]) * max(0, inner[3] - inner[1])
    return intersection / float(inner_area) if inner_area else 0.0


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


def _binarize_page(gray: np.ndarray, tile: int = TILE) -> np.ndarray:
    height, width = gray.shape
    mask = np.zeros((height, width), dtype=bool)
    for top in range(0, height, tile):
        for left in range(0, width, tile):
            crop = gray[top : top + tile, left : left + tile]
            ink = _crop_ink_mask(crop)
            if ink["reliable"]:
                mask[top : top + crop.shape[0], left : left + crop.shape[1]] = ink["mask"]
    return _despeckle(mask)


def _otsu_threshold(gray: np.ndarray) -> tuple[float, float]:
    hist, _ = np.histogram(gray, bins=256, range=(0.0, 256.0))
    total = float(gray.size)
    if total == 0:
        return 127.5, 0.0
    levels = np.arange(256, dtype=np.float64)
    weight_bg = np.cumsum(hist).astype(np.float64)
    weight_fg = total - weight_bg
    sum_bg = np.cumsum(levels * hist)
    sum_all = sum_bg[-1]
    mean_bg = sum_bg / np.maximum(weight_bg, 1.0)
    mean_fg = (sum_all - sum_bg) / np.maximum(weight_fg, 1.0)
    between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
    index = int(np.argmax(between))
    separation = abs(float(mean_fg[index]) - float(mean_bg[index]))
    if weight_bg[index] == 0 or weight_fg[index] == 0:
        separation = 0.0
    return float(index), separation


def _crop_ink_mask(gray_crop: np.ndarray) -> dict:
    threshold, separation = _otsu_threshold(gray_crop)
    dark = gray_crop <= threshold
    dark_fraction = float(dark.mean()) if dark.size else 0.0
    if dark_fraction <= 0.5:
        mask = dark
        fraction = dark_fraction
    else:
        mask = ~dark
        fraction = 1.0 - dark_fraction
    reliable = (
        separation >= MIN_CLASS_SEPARATION
        and fraction <= MAX_INK_FRACTION
        and int(mask.sum()) >= MIN_INK_PIXELS
    )
    return {
        "mask": mask,
        "reliable": reliable,
    }


def _despeckle(mask: np.ndarray) -> np.ndarray:
    if not mask.any():
        return mask
    padded = np.pad(mask, 1, mode="constant")
    neighbors = np.zeros_like(padded, dtype=np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            neighbors += np.roll(np.roll(padded, dy, axis=0), dx, axis=1).astype(np.uint8)
    return mask & (neighbors[1:-1, 1:-1] > 0)


def _split_runs(profile: np.ndarray, min_gap: int) -> list[tuple[int, int]]:
    index = np.flatnonzero(profile)
    if index.size == 0:
        return []
    breaks = np.flatnonzero(np.diff(index) > min_gap)
    starts = [int(index[0]), *(int(index[i + 1]) for i in breaks)]
    ends = [*(int(index[i]) + 1 for i in breaks), int(index[-1]) + 1]
    return list(zip(starts, ends))


def _xy_cut(
    mask: np.ndarray,
    x0: int,
    y0: int,
    min_gap_y: int,
    min_gap_x: int,
    boxes: list[tuple[int, int, int, int]],
    depth: int = 0,
) -> None:
    if not mask.any():
        return
    height, width = mask.shape
    row_ink = mask.sum(axis=1) > max(2, ROW_GAP_ABS_FRACTION * width)
    rows = _split_runs(row_ink, min_gap_y) or [(0, height)]
    if len(rows) > 1 and depth < 16:
        for top, bottom in rows:
            _xy_cut(mask[top:bottom, :], x0, y0 + top, min_gap_y, min_gap_x, boxes, depth + 1)
        return
    top, bottom = rows[0]
    column_ink = mask[top:bottom, :].sum(axis=0) > max(
        2,
        COL_GAP_BAND_FRACTION * (bottom - top),
    )
    columns = _split_runs(column_ink, min_gap_x) or [(0, width)]
    if len(columns) > 1 and depth < 16:
        for left, right in columns:
            _xy_cut(
                mask[top:bottom, left:right],
                x0 + left,
                y0 + top,
                min_gap_y,
                min_gap_x,
                boxes,
                depth + 1,
            )
        return
    left, right = columns[0]
    boxes.append((x0 + left, y0 + top, right - left, bottom - top))


def _measure_leaves(
    gray: np.ndarray,
    page_mask: np.ndarray,
    boxes: list[tuple[int, int, int, int]],
    min_glyph: int,
) -> list[BBox]:
    height, width = gray.shape
    lines: list[BBox] = []
    for x, y, box_width, box_height in boxes:
        if box_width < min_glyph or box_height < min_glyph:
            continue
        if float(page_mask[y : y + box_height, x : x + box_width].mean()) > MAX_TEXT_FILL:
            continue
        pad = 3
        left = max(0, x - pad)
        top = max(0, y - pad)
        right = min(width, x + box_width + pad)
        bottom = min(height, y + box_height + pad)
        measured = _measure_crop(gray[top:bottom, left:right])
        if not measured:
            continue
        bx, by, bw, bh, glyph, fill = measured
        if glyph < min_glyph or fill > MAX_TEXT_FILL:
            continue
        if glyph > bw + 2:
            continue
        pad_x = max(2, int(round(glyph * 0.35)))
        pad_y = max(1, int(round(glyph * 0.30)))
        box_left = max(0, left + bx - pad_x)
        box_top = max(0, top + by - pad_y)
        box_right = min(width, left + bx + bw + pad_x)
        box_bottom = min(height, top + by + bh + pad_y)
        lines.append((box_left, box_top, box_right, box_bottom))
    return lines


def _measure_crop(gray_crop: np.ndarray) -> tuple[int, int, int, int, float, float] | None:
    ink = _crop_ink_mask(gray_crop)
    if not ink["reliable"]:
        return None
    mask = _remove_border_components(ink["mask"])
    segmented = _segment_mask(mask)
    if segmented is None:
        return None
    bbox, glyph = segmented
    x, y, width, height = bbox
    fill = float(mask[y : y + height, x : x + width].mean())
    return x, y, width, height, glyph, fill


def _dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]
    out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]
    out[:, :-1] |= mask[:, 1:]
    return out


def _remove_border_components(mask: np.ndarray) -> np.ndarray:
    if not mask.any():
        return mask
    reach = np.zeros_like(mask)
    reach[0, :] = mask[0, :]
    reach[-1, :] = mask[-1, :]
    reach[:, 0] = mask[:, 0]
    reach[:, -1] = mask[:, -1]
    if not reach.any():
        return mask
    for _ in range(2 * max(mask.shape)):
        grown = _dilate(reach) & mask
        if np.array_equal(grown, reach):
            break
        reach = grown
    return mask & ~reach


def _segment_mask(mask: np.ndarray) -> tuple[tuple[int, int, int, int], float] | None:
    if not mask.any():
        return None
    bands = _filter_rule_bands(_line_bands(mask))
    if not bands:
        return None
    row_selector = np.zeros(mask.shape[0], dtype=bool)
    for top, bottom in bands:
        row_selector[top:bottom] = True
    restricted = mask & row_selector[:, None]
    bbox = _tight_bbox(restricted)
    if bbox is None:
        return None
    glyph = float(np.median([bottom - top for top, bottom in bands]))
    return bbox, glyph


def _line_bands(mask: np.ndarray, min_ink_px: int = 2, merge_gap: int = 2) -> list[tuple[int, int]]:
    row_ink = mask.sum(axis=1)
    inky = row_ink >= min_ink_px
    bands: list[list[int]] = []
    start = None
    for y, on in enumerate(inky):
        if on and start is None:
            start = y
        elif not on and start is not None:
            bands.append([start, y])
            start = None
    if start is not None:
        bands.append([start, len(inky)])
    merged: list[list[int]] = []
    for band in bands:
        if merged and band[0] - merged[-1][1] <= merge_gap:
            merged[-1][1] = band[1]
        else:
            merged.append(band)
    return [(top, bottom) for top, bottom in merged if bottom - top >= 2]


def _filter_rule_bands(bands: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if len(bands) <= 1:
        return bands
    heights = [bottom - top for top, bottom in bands]
    tallest = max(heights)
    if tallest <= 4:
        return bands
    kept = [
        (top, bottom)
        for (top, bottom), band_height in zip(bands, heights)
        if not (band_height <= 4 and band_height < 0.35 * tallest)
    ]
    return kept or bands


def _tight_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    if not mask.any():
        return None
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])
    return (left, top, right - left + 1, bottom - top + 1)

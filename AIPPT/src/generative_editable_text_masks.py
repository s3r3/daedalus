"""Mask generation for editable text reconstruction."""

from __future__ import annotations

from PIL import Image, ImageDraw, ImageFilter

from .generative_editable_manifest import TextBoxSpec

MAX_MASK_PIXELS = 16_000_000


def create_text_mask(
    image_size: tuple[int, int],
    text_boxes: list[TextBoxSpec],
    *,
    padding: int = 0,
    use_polygons: bool = False,
) -> Image.Image:
    _validate_mask_request(image_size, padding)
    mask = Image.new("L", image_size, 0)
    draw = ImageDraw.Draw(mask)
    for box in text_boxes:
        if use_polygons:
            polygon = _clipped_polygon_or_none(box.source_pixel_polygon, image_size)
            if polygon is None:
                continue
            draw.polygon(polygon, fill=255)
        else:
            padded = _padded_bbox(box.source_pixel_bbox, image_size, padding)
            if padded is not None:
                draw.rectangle(padded, fill=255)
    if use_polygons and padding > 0:
        return mask.filter(ImageFilter.MaxFilter(padding * 2 + 1))
    return mask


def _validate_mask_request(image_size: tuple[int, int], padding: int) -> None:
    width, height = image_size
    if width <= 0 or height <= 0 or width * height > MAX_MASK_PIXELS:
        raise ValueError("image_size is outside supported mask bounds")
    if padding < 0:
        raise ValueError("padding must be non-negative")


def _padded_bbox(
    bbox: tuple[int, int, int, int],
    image_size: tuple[int, int],
    padding: int,
) -> tuple[int, int, int, int] | None:
    width, height = image_size
    x1, y1, x2, y2 = bbox
    if x2 < 0 or y2 < 0 or x1 > width - 1 or y1 > height - 1:
        return None
    clipped = (
        max(0, min(width - 1, x1 - padding)),
        max(0, min(height - 1, y1 - padding)),
        max(0, min(width - 1, x2 + padding)),
        max(0, min(height - 1, y2 + padding)),
    )
    if clipped[2] < clipped[0] or clipped[3] < clipped[1]:
        return None
    return clipped


def _padded_polygon(
    polygon: tuple[tuple[int, int], ...],
    image_size: tuple[int, int],
    padding: int,
) -> list[tuple[int, int]]:
    if padding <= 0:
        return [_clip_point(point, image_size) for point in polygon]
    x1 = min(point[0] for point in polygon)
    y1 = min(point[1] for point in polygon)
    x2 = max(point[0] for point in polygon)
    y2 = max(point[1] for point in polygon)
    return [
        _clip_point((x - padding if x == x1 else x + padding if x == x2 else x, y), image_size)
        if y not in {y1, y2}
        else _clip_point(
            (
                x - padding if x == x1 else x + padding if x == x2 else x,
                y - padding if y == y1 else y + padding,
            ),
            image_size,
        )
        for x, y in polygon
    ]


def _clip_point(point: tuple[int, int], image_size: tuple[int, int]) -> tuple[int, int]:
    width, height = image_size
    return (min(max(point[0], 0), width - 1), min(max(point[1], 0), height - 1))


def _clipped_polygon_or_none(
    polygon: tuple[tuple[int, int], ...], image_size: tuple[int, int]
) -> list[tuple[int, int]] | None:
    width, height = image_size
    if (
        max(point[0] for point in polygon) < 0
        or max(point[1] for point in polygon) < 0
        or min(point[0] for point in polygon) > width - 1
        or min(point[1] for point in polygon) > height - 1
    ):
        return None
    return [_clip_point(point, image_size) for point in polygon]

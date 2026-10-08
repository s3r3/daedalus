"""Background cleanup helpers for generative editable PPTX export."""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
import shutil
from statistics import mean, pstdev
from typing import Literal

from PIL import Image, ImageDraw

from .generative_editable_manifest import PageManifest, sanitize_persisted_payload
from .generative_editable_providers import ImageEditProvider, ImageEditRequest, ProviderError

BackgroundStrategy = Literal["local_fill", "local_inpaint", "image_edit"]
MAX_LOCAL_FILL_AREA_RATIO = 0.12
MAX_LOCAL_INPAINT_AREA_RATIO = 0.03
MAX_SOURCE_PRESERVING_LOCAL_INPAINT_AREA_RATIO = 0.20
MIN_BORDER_SAMPLE_PIXELS = 8
LOCAL_FILL_BORDER_STDDEV_THRESHOLD = 1.5


@dataclass(frozen=True)
class BackgroundResult:
    output_asset_path: str
    artifact_path: str
    strategy: BackgroundStrategy
    provider_role: str
    prompt_id: str
    input_asset_refs: list[str]
    validation_status: str
    provenance: dict


def local_cleanup_text_mask(
    source_image_path: str | Path,
    text_mask_path: str | Path,
    output_asset_path: str | Path,
    *,
    asset_root: str | Path | None = None,
    flat_stddev_threshold: float = 6.0,
    max_local_inpaint_area_ratio: float = MAX_LOCAL_INPAINT_AREA_RATIO,
    max_local_fill_area_ratio: float = MAX_LOCAL_FILL_AREA_RATIO,
) -> BackgroundResult:
    source_path = Path(source_image_path)
    mask_path = Path(text_mask_path)
    output_path = Path(output_asset_path)
    artifact_root = (
        Path(asset_root).resolve() if asset_root is not None else _infer_artifact_root(output_path)
    )
    _validate_background_paths(
        source_image_path=source_path,
        output_asset_path=output_path,
        asset_root=artifact_root,
        text_mask_path=mask_path,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source_path) as source, Image.open(mask_path) as mask:
        rgb = source.convert("RGB")
        mask_l = mask.convert("L")
        bbox = mask_l.getbbox()
        if bbox is None:
            rgb.save(output_path)
            return BackgroundResult(
                output_asset_path=str(output_path),
                artifact_path=_artifact_ref(output_path, artifact_root),
                strategy="local_fill",
                provider_role="local",
                prompt_id="local_text_cleanup",
                input_asset_refs=[str(source_path)],
                validation_status="passed",
                provenance={"decision": "empty text mask copied source"},
            )

        border_pixels = _sample_border_pixels(rgb, bbox)
        if len(border_pixels) < MIN_BORDER_SAMPLE_PIXELS:
            raise ValueError("text mask requires image edit cleanup")
        stddev = _rgb_stddev(border_pixels)
        mask_pixels = _count_mask_pixels(mask_l)
        area_ratio = mask_pixels / float(mask_l.width * mask_l.height)
        if (
            stddev <= min(flat_stddev_threshold, LOCAL_FILL_BORDER_STDDEV_THRESHOLD)
            and area_ratio <= max_local_fill_area_ratio
            and len(border_pixels) >= MIN_BORDER_SAMPLE_PIXELS
        ):
            cleaned = _fill_mask_with_color(rgb, mask_l, _mean_rgb(border_pixels))
            strategy: BackgroundStrategy = "local_fill"
            decision = "local cleanup flat fill"
        else:
            if area_ratio > max_local_inpaint_area_ratio:
                raise ValueError("text mask requires image edit cleanup")
            cleaned = _local_inpaint(rgb, mask_l)
            strategy = "local_inpaint"
            decision = "local cleanup simple inpaint"

        cleaned.save(output_path)

    return BackgroundResult(
        output_asset_path=str(output_path),
        artifact_path=_artifact_ref(output_path, artifact_root),
        strategy=strategy,
        provider_role="local",
        prompt_id="local_text_cleanup",
        input_asset_refs=[str(source_path), str(mask_path)],
        validation_status="passed",
        provenance={
            "decision": decision,
            "mask_bbox": bbox,
            "border_stddev": round(stddev, 4),
        },
    )


def create_text_clean_background(
    *,
    source_image_path: str | Path,
    text_mask_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
    edit_provider: ImageEditProvider,
    timeout_seconds: int = 180,
) -> BackgroundResult:
    _validate_background_paths(
        source_image_path=source_image_path,
        output_asset_path=output_asset_path,
        asset_root=asset_root,
        text_mask_path=text_mask_path,
    )
    try:
        local_result = local_cleanup_text_mask(
            source_image_path,
            text_mask_path,
            output_asset_path,
            asset_root=asset_root,
        )
    except ValueError:
        local_result = None
    if local_result is not None:
        return _with_job_relative_refs(local_result, asset_root)

    source_ref = _artifact_ref(source_image_path, asset_root)
    mask_ref = _artifact_ref(text_mask_path, asset_root)
    request = ImageEditRequest(
        source_image_path=str(source_image_path),
        prompt_id="text_clean_background",
        prompt=(
            "Return a text-free background layer inside the mask while preserving all "
            "non-text visuals, background texture, decorations, and layout geometry."
        ),
        output_asset_path=str(output_asset_path),
        asset_root=str(asset_root),
        mask_path=str(text_mask_path),
        timeout_seconds=timeout_seconds,
        metadata={
            "source_image_ref": source_ref,
            "text_mask_ref": mask_ref,
            "stage": "text_clean_background",
        },
    )
    try:
        edit_result = edit_provider.edit(request)
    except ProviderError:
        raise
    normalization_provenance = _normalize_background_to_source_size(
        edit_result.output_asset_path,
        source_image_path,
    )
    return BackgroundResult(
        output_asset_path=edit_result.output_asset_path,
        artifact_path=_artifact_ref(output_asset_path, asset_root),
        strategy="image_edit",
        provider_role=edit_result.provider_role,
        prompt_id=edit_result.prompt_id,
        input_asset_refs=[source_ref, mask_ref],
        validation_status="passed",
        provenance=sanitize_persisted_payload(
            {
                "decision": "image edit cleanup after local cleanup was insufficient",
                "provider": edit_result.provider_name,
                "model": edit_result.model,
                "prompt_id": edit_result.prompt_id,
                "source_image_ref": source_ref,
                "text_mask_ref": mask_ref,
                **normalization_provenance,
            }
        ),
    )


def create_source_preserving_text_background(
    *,
    source_image_path: str | Path,
    text_bboxes: list[tuple[int, int, int, int]],
    output_asset_path: str | Path,
    asset_root: str | Path,
    prefer_inpaint: bool = False,
) -> BackgroundResult:
    source_path = Path(source_image_path)
    output_path = Path(output_asset_path)
    artifact_root = Path(asset_root)
    _validate_background_paths(
        source_image_path=source_path,
        output_asset_path=output_path,
        asset_root=artifact_root,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source_path) as source:
        cleaned = source.convert("RGB")
        if prefer_inpaint and text_bboxes:
            mask = Image.new("L", cleaned.size, 0)
            draw = ImageDraw.Draw(mask)
            for bbox in text_bboxes:
                left, top, right, bottom = _clamp_bbox(bbox, cleaned.size)
                if right > left and bottom > top:
                    draw.rectangle((left, top, right, bottom), fill=255)
            mask_pixels = _count_mask_pixels(mask)
            area_ratio = mask_pixels / float(mask.width * mask.height)
            if area_ratio <= MAX_SOURCE_PRESERVING_LOCAL_INPAINT_AREA_RATIO:
                cleaned = _local_inpaint(cleaned, mask)
                strategy: BackgroundStrategy = "local_inpaint"
                decision = "source preserving local inpaint cleanup"
            else:
                for bbox in text_bboxes:
                    _fill_bbox_from_border(cleaned, bbox)
                strategy = "local_fill"
                decision = "source preserving local text cleanup"
        else:
            for bbox in text_bboxes:
                _fill_bbox_from_border(cleaned, bbox)
            strategy = "local_fill"
            decision = "source preserving local text cleanup"
        cleaned.save(output_path)
    return BackgroundResult(
        output_asset_path=str(output_path),
        artifact_path=_artifact_ref(output_path, artifact_root),
        strategy=strategy,
        provider_role="local",
        prompt_id="source_preserving_text_background",
        input_asset_refs=[_artifact_ref(source_path, artifact_root)],
        validation_status="passed",
        provenance={
            "decision": decision,
            "text_bbox_count": len(text_bboxes),
        },
    )


def create_source_raster_background(
    *,
    source_image_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
) -> BackgroundResult:
    source_path = Path(source_image_path)
    output_path = Path(output_asset_path)
    artifact_root = Path(asset_root)
    _validate_background_paths(
        source_image_path=source_path,
        output_asset_path=output_path,
        asset_root=artifact_root,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source_path, output_path)
    return BackgroundResult(
        output_asset_path=str(output_path),
        artifact_path=_artifact_ref(output_path, artifact_root),
        strategy="local_fill",
        provider_role="local",
        prompt_id="source_raster_background",
        input_asset_refs=[_artifact_ref(source_path, artifact_root)],
        validation_status="passed",
        provenance={
            "decision": "source raster guardrail preserved original slide",
        },
    )


def _fill_bbox_from_border(image: Image.Image, bbox: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = _clamp_bbox(bbox, image.size)
    if right <= left or bottom <= top:
        return
    sample_bbox = (
        max(0, left - 3),
        max(0, top - 3),
        min(image.width, right + 3),
        min(image.height, bottom + 3),
    )
    pixels = []
    source = image.load()
    for y in range(sample_bbox[1], sample_bbox[3]):
        for x in range(sample_bbox[0], sample_bbox[2]):
            if left <= x < right and top <= y < bottom:
                continue
            pixels.append(source[x, y])
    color = _mean_rgb(pixels) if pixels else source[left, top]
    draw = ImageDraw.Draw(image)
    draw.rectangle((left, top, right, bottom), fill=color)


def _clamp_bbox(
    bbox: tuple[int, int, int, int],
    size: tuple[int, int],
) -> tuple[int, int, int, int]:
    width, height = size
    return (
        max(0, min(width, int(bbox[0]))),
        max(0, min(height, int(bbox[1]))),
        max(0, min(width, int(bbox[2]))),
        max(0, min(height, int(bbox[3]))),
    )


def create_base_clean_background(
    *,
    source_image_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
    edit_provider: ImageEditProvider,
    text_mask_path: str | Path | None = None,
    removal_bboxes: list[tuple[int, int, int, int]] | None = None,
    timeout_seconds: int = 180,
) -> BackgroundResult:
    _validate_background_paths(
        source_image_path=source_image_path,
        output_asset_path=output_asset_path,
        asset_root=asset_root,
        text_mask_path=text_mask_path,
    )
    source_ref = _artifact_ref(source_image_path, asset_root)
    metadata = {
        "source_image_ref": source_ref,
        "stage": "base_clean_background",
    }
    input_refs = [source_ref]
    mask_path = None
    if text_mask_path is not None:
        mask_path = str(text_mask_path)
        text_mask_ref = _artifact_ref(text_mask_path, asset_root)
        metadata["text_mask_ref"] = text_mask_ref
        input_refs.append(text_mask_ref)
    removal_bboxes = list(removal_bboxes or [])
    if removal_bboxes:
        metadata["removal_bboxes"] = removal_bboxes
    if mask_path is not None or removal_bboxes:
        removal_instruction = (
            "Remove only the supplied mask regions and listed source-pixel boxes. "
            "Preserve all other readable text, icons, flowchart labels, cards, "
            "and visual objects unless they are inside those removal regions. "
        )
        if removal_bboxes:
            removal_instruction += (
                "Removal boxes: " + ", ".join(str(bbox) for bbox in removal_bboxes) + ". "
            )
    else:
        removal_instruction = (
            "Omit movable foreground graphics and baked text from this background layer."
        )
    if mask_path is not None or removal_bboxes:
        removal_instruction = " " + removal_instruction

    request = ImageEditRequest(
        source_image_path=str(source_image_path),
        prompt_id="base_clean_background",
        prompt=(
            "Return the slide background layer only. Preserve theme background, edge "
            "decoration, ambient texture, and layout background. " + removal_instruction
        ),
        output_asset_path=str(output_asset_path),
        asset_root=str(asset_root),
        mask_path=mask_path,
        timeout_seconds=timeout_seconds,
        metadata=metadata,
    )
    edit_result = edit_provider.edit(request)
    normalization_provenance = _normalize_background_to_source_size(
        edit_result.output_asset_path,
        source_image_path,
    )
    return BackgroundResult(
        output_asset_path=edit_result.output_asset_path,
        artifact_path=_artifact_ref(output_asset_path, asset_root),
        strategy="image_edit",
        provider_role=edit_result.provider_role,
        prompt_id=edit_result.prompt_id,
        input_asset_refs=input_refs,
        validation_status="passed",
        provenance=sanitize_persisted_payload(
            {
                "decision": "image edit base cleanup",
                "provider": edit_result.provider_name,
                "model": edit_result.model,
                "prompt_id": edit_result.prompt_id,
                "source_image_ref": source_ref,
                **({"text_mask_ref": input_refs[1]} if len(input_refs) > 1 else {}),
                **normalization_provenance,
            }
        ),
    )


def update_page_manifest_backgrounds(
    page_manifest: PageManifest,
    text_clean_background: BackgroundResult,
    base_clean_background: BackgroundResult,
    *,
    chosen_background: str | None = None,
) -> PageManifest:
    chosen = chosen_background or base_clean_background.artifact_path
    provenance = dict(page_manifest.provenance)
    provenance["backgrounds"] = {
        "text_clean": _manifest_background_record(text_clean_background),
        "base_clean": _manifest_background_record(base_clean_background),
    }
    return replace(
        page_manifest,
        text_clean_background=text_clean_background.artifact_path,
        base_clean_background=base_clean_background.artifact_path,
        chosen_background=chosen,
        provenance=provenance,
    )


def _manifest_background_record(result: BackgroundResult) -> dict:
    return sanitize_persisted_payload(
        {
            "strategy": result.strategy,
            "provider_role": result.provider_role,
            "prompt_id": result.prompt_id,
            "input_asset_refs": list(result.input_asset_refs),
            "output_asset_ref": result.artifact_path,
            "validation_status": result.validation_status,
            "provenance": result.provenance,
        }
    )


def _normalize_background_to_source_size(
    output_asset_path: str | Path,
    source_image_path: str | Path,
) -> dict:
    output_path = Path(output_asset_path)
    with Image.open(source_image_path) as source:
        source_size = source.size
    needs_resize = False
    with Image.open(output_path) as output:
        if output.size != source_size:
            needs_resize = True
            normalized = output.convert("RGB").resize(source_size)
    if needs_resize:
        normalized.save(output_path)
        return {"normalized_to_source_size": list(source_size)}
    return {}


def _sample_border_pixels(
    image: Image.Image, bbox: tuple[int, int, int, int]
) -> list[tuple[int, int, int]]:
    left, top, right, bottom = bbox
    expanded = (
        max(0, left - 2),
        max(0, top - 2),
        min(image.width, right + 2),
        min(image.height, bottom + 2),
    )
    pixels: list[tuple[int, int, int]] = []
    for y in range(expanded[1], expanded[3]):
        for x in range(expanded[0], expanded[2]):
            if left <= x < right and top <= y < bottom:
                continue
            pixels.append(image.getpixel((x, y)))
    return pixels


def _rgb_stddev(pixels: list[tuple[int, int, int]]) -> float:
    channel_values = [[pixel[index] for pixel in pixels] for index in range(3)]
    return mean(pstdev(values) for values in channel_values)


def _mean_rgb(pixels: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    return tuple(round(mean(pixel[index] for pixel in pixels)) for index in range(3))


def _fill_mask_with_color(
    image: Image.Image, mask: Image.Image, color: tuple[int, int, int]
) -> Image.Image:
    fill = Image.new("RGB", image.size, color)
    cleaned = image.copy()
    cleaned.paste(fill, mask=mask)
    return cleaned


def _local_inpaint(image: Image.Image, mask: Image.Image) -> Image.Image:
    cleaned = image.copy()
    source = image.load()
    target = cleaned.load()
    mask_pixels = mask.load()
    for y in range(image.height):
        for x in range(image.width):
            if mask_pixels[x, y] <= 0:
                continue
            target[x, y] = _nearest_unmasked_average(source, mask_pixels, x, y, image.size)
    return cleaned


def _nearest_unmasked_average(
    source,
    mask,
    x: int,
    y: int,
    size: tuple[int, int],
    *,
    max_radius: int = 8,
) -> tuple[int, int, int]:
    width, height = size
    for radius in range(1, max_radius + 1):
        pixels = []
        for yy in range(max(0, y - radius), min(height, y + radius + 1)):
            for xx in range(max(0, x - radius), min(width, x + radius + 1)):
                if mask[xx, yy] == 0:
                    pixels.append(source[xx, yy])
        if pixels:
            return _mean_rgb(pixels)
    return source[x, y]


def _count_mask_pixels(mask: Image.Image) -> int:
    return sum(mask.histogram()[1:])


def _with_job_relative_refs(result: BackgroundResult, asset_root: str | Path) -> BackgroundResult:
    return BackgroundResult(
        output_asset_path=result.output_asset_path,
        artifact_path=_artifact_ref(result.output_asset_path, asset_root),
        strategy=result.strategy,
        provider_role=result.provider_role,
        prompt_id=result.prompt_id,
        input_asset_refs=[_artifact_ref(path, asset_root) for path in result.input_asset_refs],
        validation_status=result.validation_status,
        provenance=result.provenance,
    )


def _artifact_ref(path: str | Path, asset_root: str | Path) -> str:
    item = Path(path)
    root = Path(asset_root)
    try:
        return item.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return item.as_posix()


def _infer_artifact_root(path: Path) -> Path:
    resolved = path.resolve()
    for category in ("backgrounds", "assets", "asset_sheets", "sources", "previews"):
        if category in resolved.parts:
            index = resolved.parts.index(category)
            if index > 0:
                return Path(*resolved.parts[:index])
    return resolved.parent


def _validate_background_paths(
    *,
    source_image_path: str | Path,
    output_asset_path: str | Path,
    asset_root: str | Path,
    text_mask_path: str | Path | None = None,
) -> None:
    source = _resolve_asset_root_path(source_image_path, asset_root, "source_image_path")
    output = _resolve_asset_root_path(output_asset_path, asset_root, "output_asset_path")
    if source == output:
        raise ValueError("output_asset_path must not overwrite source_image_path")
    if text_mask_path is not None:
        _resolve_asset_root_path(text_mask_path, asset_root, "text_mask_path")


def _resolve_asset_root_path(path: str | Path, asset_root: str | Path, field_name: str) -> Path:
    root = Path(asset_root).resolve()
    value = Path(path)
    if not value.is_absolute():
        value = root / value
    resolved = value.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"{field_name} must be inside asset_root")
    return resolved


def _masked_region_is_flat(image: Image.Image, mask: Image.Image, threshold: float) -> bool:
    pixels = []
    image_pixels = image.load()
    mask_pixels = mask.load()
    for y in range(mask.height):
        for x in range(mask.width):
            if mask_pixels[x, y] > 0:
                pixels.append(image_pixels[x, y])
    if not pixels:
        return True
    return _rgb_stddev(pixels) <= threshold

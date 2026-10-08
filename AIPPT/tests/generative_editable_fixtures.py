"""Deterministic fixture deck images for generative editable PPTX tests."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw


@dataclass(frozen=True)
class FixtureSlide:
    slide_id: str
    image_path: Path
    text_metadata: list[dict]
    coverage_tags: set[str]


@dataclass(frozen=True)
class FixtureDeck:
    root: Path
    aspect_ratio: str
    image_size: tuple[int, int]
    slides: list[FixtureSlide]

    @property
    def slide_order(self) -> list[str]:
        return [slide.slide_id for slide in self.slides]

    @property
    def coverage_tags(self) -> set[str]:
        tags: set[str] = set()
        for slide in self.slides:
            tags.update(slide.coverage_tags)
        return tags


def write_deterministic_fixture_deck(root: Path, *, aspect_ratio: str = "16:9") -> FixtureDeck:
    if aspect_ratio not in {"16:9", "4:3"}:
        raise ValueError("aspect_ratio must be 16:9 or 4:3")
    image_size = (800, 450) if aspect_ratio == "16:9" else (800, 600)
    source_root = root / f"generative-editable-{aspect_ratio.replace(':', '-')}" / "sources"
    source_root.mkdir(parents=True, exist_ok=True)

    slides = [
        _write_text_and_shapes_slide(source_root, image_size),
        _write_repeated_assets_slide(source_root, image_size),
        _write_complex_visual_slide(source_root, image_size),
        _write_text_clean_fallback_slide(source_root, image_size),
    ]
    return FixtureDeck(
        root=source_root.parent, aspect_ratio=aspect_ratio, image_size=image_size, slides=slides
    )


def _write_text_and_shapes_slide(root: Path, size: tuple[int, int]) -> FixtureSlide:
    image = _base_slide(size)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (48, 46, 752, 118), radius=18, fill="#E0F2FE", outline="#0284C7", width=3
    )
    draw.text((82, 66), "Quarterly Plan", fill="#0F172A")
    draw.rectangle((82, 172, 278, 300), fill="#DCFCE7", outline="#16A34A", width=3)
    draw.rounded_rectangle(
        (328, 172, 524, 300), radius=22, fill="#FEF3C7", outline="#D97706", width=3
    )
    draw.line((574, 292, 718, 188), fill="#7C3AED", width=6)
    path = root / "01-text-shapes.png"
    image.save(path)
    return FixtureSlide(
        slide_id="fixture-text-shapes",
        image_path=path,
        text_metadata=[
            {
                "text": "Quarterly Plan",
                "role": "title",
                "order": 1,
                "style_hint": {"font_size": 32, "bold": True},
            }
        ],
        coverage_tags={"text", "simple_shapes", "native_shape_candidates"},
    )


def _write_repeated_assets_slide(root: Path, size: tuple[int, int]) -> FixtureSlide:
    image = _base_slide(size)
    draw = ImageDraw.Draw(image)
    draw.text((72, 54), "Repeated Components", fill="#0F172A")
    for index, x in enumerate((110, 310, 510)):
        draw.rounded_rectangle(
            (x, 160, x + 110, 270), radius=18, fill="#CCFBF1", outline="#0F766E", width=3
        )
        draw.ellipse((x + 26, 186, x + 84, 244), fill="#14B8A6")
        draw.text((x + 36, 292), f"A{index + 1}", fill="#115E59")
    path = root / "02-repeated-assets.png"
    image.save(path)
    return FixtureSlide(
        slide_id="fixture-repeated-assets",
        image_path=path,
        text_metadata=[{"text": "Repeated Components", "role": "title", "order": 1}],
        coverage_tags={"repeated_bitmap_asset", "component_reuse"},
    )


def _write_complex_visual_slide(root: Path, size: tuple[int, int]) -> FixtureSlide:
    image = _base_slide(size)
    draw = ImageDraw.Draw(image)
    draw.text((72, 54), "Complex Visual", fill="#0F172A")
    points = [(100, 330), (190, 260), (290, 286), (398, 198), (520, 224), (680, 146)]
    draw.line(points, fill="#2563EB", width=5)
    for x, y in points:
        draw.ellipse((x - 9, y - 9, x + 9, y + 9), fill="#DB2777")
    draw.polygon(
        [(90, 360), (250, 250), (430, 310), (700, 170), (700, 382), (90, 382)], fill="#DBEAFE"
    )
    draw.line(points, fill="#2563EB", width=5)
    path = root / "03-complex-visual.png"
    image.save(path)
    return FixtureSlide(
        slide_id="fixture-complex-visual",
        image_path=path,
        text_metadata=[{"text": "Complex Visual", "role": "title", "order": 1}],
        coverage_tags={"complex_visual", "bitmap_asset_candidate"},
    )


def _write_text_clean_fallback_slide(root: Path, size: tuple[int, int]) -> FixtureSlide:
    image = _base_slide(size)
    draw = ImageDraw.Draw(image)
    draw.rectangle((56, 138, 744, 348), fill="#F1F5F9", outline="#94A3B8", width=2)
    draw.text((86, 64), "Fallback Text Layer", fill="#0F172A")
    for row, text in enumerate(("Editable title", "OCR layout hint", "Preserve background visual")):
        y = 178 + row * 48
        draw.rounded_rectangle(
            (94, y - 12, 706, y + 26), radius=10, fill="#FFFFFF", outline="#CBD5E1"
        )
        draw.text((122, y), text, fill="#334155")
    path = root / "04-text-clean-fallback.png"
    image.save(path)
    return FixtureSlide(
        slide_id="fixture-text-clean-fallback",
        image_path=path,
        text_metadata=[
            {"text": "Fallback Text Layer", "role": "title", "order": 1},
        ],
        coverage_tags={"text_clean_fallback", "ocr_layout_fallback"},
    )


def _base_slide(size: tuple[int, int]) -> Image.Image:
    image = Image.new("RGB", size, "#F8FAFC")
    draw = ImageDraw.Draw(image)
    width, height = size
    draw.rectangle((0, 0, width - 1, height - 1), outline="#CBD5E1", width=2)
    draw.rectangle((0, height - 24, width, height), fill="#E2E8F0")
    return image

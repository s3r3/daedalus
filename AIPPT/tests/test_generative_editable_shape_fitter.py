import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


class GenerativeEditableShapeFitterTest(unittest.TestCase):
    def test_fits_high_confidence_rectangle_rounded_rectangle_ellipse_and_line(self):
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_shape_fitter import fit_native_shape

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (220, 140), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((10, 12, 70, 42), fill="#2563EB")
            draw.rounded_rectangle((90, 12, 160, 54), radius=10, fill="#F97316")
            draw.ellipse((20, 78, 64, 122), fill="#10B981")
            draw.rectangle((100, 100, 180, 103), fill="#111827")
            image.save(source)

            rectangle = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="rect",
                    source_pixel_bbox=(10, 12, 71, 43),
                    area=1891,
                    classification="native_shape_candidate",
                    confidence=0.95,
                    provenance={"shape_hint": "rectangle"},
                ),
                source_image_path=source,
            )
            rounded = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="rounded",
                    source_pixel_bbox=(90, 12, 161, 55),
                    area=3053,
                    classification="native_shape_candidate",
                    confidence=0.96,
                    provenance={"shape_hint": "rounded_rectangle", "radius": 10},
                ),
                source_image_path=source,
            )
            ellipse = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="ellipse",
                    source_pixel_bbox=(20, 78, 65, 123),
                    area=2025,
                    classification="native_shape_candidate",
                    confidence=0.94,
                    provenance={"shape_hint": "ellipse"},
                ),
                source_image_path=source,
                enable_ellipses=True,
            )
            line = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="line",
                    source_pixel_bbox=(100, 100, 181, 104),
                    area=324,
                    classification="native_shape_candidate",
                    confidence=0.93,
                    provenance={"shape_hint": "line"},
                ),
                source_image_path=source,
            )
            vertical_line = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="vertical-line",
                    source_pixel_bbox=(200, 20, 204, 100),
                    area=320,
                    classification="native_shape_candidate",
                    confidence=0.93,
                    provenance={"shape_hint": "line"},
                ),
                source_image_path=source,
            )
            diagonal_line = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="diagonal-line",
                    source_pixel_bbox=(140, 78, 205, 120),
                    area=320,
                    classification="native_shape_candidate",
                    confidence=0.93,
                    provenance={
                        "shape_hint": "line",
                        "line_start": (145, 118),
                        "line_end": (200, 82),
                        "stroke_width": 5,
                    },
                ),
                source_image_path=source,
            )

        self.assertEqual(rectangle.shape_type, "rectangle")
        self.assertEqual(rectangle.fill_color, "#2563EB")
        self.assertEqual(rectangle.source_pixel_bbox, (10, 12, 71, 43))
        self.assertEqual(rounded.shape_type, "rounded_rectangle")
        self.assertEqual(rounded.radius, 10)
        self.assertEqual(ellipse.shape_type, "ellipse")
        self.assertEqual(line.shape_type, "line")
        self.assertEqual(line.line_color, "#111827")
        self.assertEqual(line.line_start, (100, 102))
        self.assertEqual(line.line_end, (181, 102))
        self.assertEqual(line.stroke_width, 4)
        self.assertEqual(line.opacity, 1.0)
        self.assertEqual(vertical_line.line_start, (202, 20))
        self.assertEqual(vertical_line.line_end, (202, 100))
        self.assertEqual(vertical_line.stroke_width, 4)
        self.assertEqual(diagonal_line.line_start, (145, 118))
        self.assertEqual(diagonal_line.line_end, (200, 82))
        self.assertEqual(diagonal_line.stroke_width, 5)

    def test_low_confidence_or_complex_candidates_are_not_forced_to_native_shapes(self):
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_shape_fitter import (
            fit_native_shape,
            fit_native_shape_with_fallback,
        )

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (100, 80), "white")
            draw = ImageDraw.Draw(image)
            for x in range(10, 80):
                for y in range(12, 64):
                    draw.point((x, y), fill=((x * 7) % 255, (y * 9) % 255, 120))
            image.save(source)

            low_confidence = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="low",
                    source_pixel_bbox=(10, 12, 80, 64),
                    area=3640,
                    classification="native_shape_candidate",
                    confidence=0.72,
                    provenance={"shape_hint": "rectangle"},
                ),
                source_image_path=source,
            )
            complex_candidate = fit_native_shape(
                ForegroundCandidate(
                    candidate_id="complex",
                    source_pixel_bbox=(10, 12, 80, 64),
                    area=3640,
                    classification="bitmap_asset_candidate",
                    confidence=0.95,
                    provenance={"reason": "visually_complex"},
                ),
                source_image_path=source,
            )
            fallback_result = fit_native_shape_with_fallback(
                ForegroundCandidate(
                    candidate_id="low",
                    source_pixel_bbox=(10, 12, 80, 64),
                    area=3640,
                    classification="native_shape_candidate",
                    confidence=0.72,
                    provenance={"shape_hint": "rectangle"},
                ),
                source_image_path=source,
            )
            rejected_result = fit_native_shape_with_fallback(
                ForegroundCandidate(
                    candidate_id="rejected",
                    source_pixel_bbox=(10, 12, 80, 64),
                    area=3640,
                    classification="rejected_text_like_region",
                    confidence=1.0,
                    provenance={"reason": "text_like"},
                ),
                source_image_path=source,
            )
            duplicate_result = fit_native_shape_with_fallback(
                ForegroundCandidate(
                    candidate_id="duplicate",
                    source_pixel_bbox=(10, 12, 80, 64),
                    area=3640,
                    classification="duplicate",
                    confidence=1.0,
                    provenance={"reuses_candidate_id": "original"},
                ),
                source_image_path=source,
            )
            complex_result = fit_native_shape_with_fallback(
                ForegroundCandidate(
                    candidate_id="complex",
                    source_pixel_bbox=(10, 12, 80, 64),
                    area=3640,
                    classification="complex_whole_visual",
                    confidence=0.95,
                    provenance={"reason": "large_or_visually_complex"},
                ),
                source_image_path=source,
            )

        self.assertIsNone(low_confidence)
        self.assertIsNone(complex_candidate)
        self.assertIsNone(fallback_result.native_shape)
        self.assertEqual(fallback_result.bitmap_candidate.classification, "bitmap_asset_candidate")
        self.assertEqual(
            fallback_result.bitmap_candidate.provenance["shape_fit_fallback_reason"],
            "below_native_shape_confidence_threshold",
        )
        self.assertIsNone(rejected_result.native_shape)
        self.assertIsNone(rejected_result.bitmap_candidate)
        self.assertIsNone(duplicate_result.bitmap_candidate)
        self.assertIsNone(complex_result.bitmap_candidate)

    def test_rejects_candidate_bbox_outside_source_image_bounds(self):
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_shape_fitter import fit_native_shape

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            Image.new("RGB", (100, 80), "white").save(source)

            with self.assertRaisesRegex(ValueError, "source_pixel_bbox"):
                fit_native_shape(
                    ForegroundCandidate(
                        candidate_id="outside",
                        source_pixel_bbox=(90, 10, 120, 30),
                        area=600,
                        classification="native_shape_candidate",
                        confidence=0.95,
                        provenance={"shape_hint": "rectangle"},
                    ),
                    source_image_path=source,
                )

    def test_non_dict_candidate_provenance_is_ignored(self):
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_shape_fitter import (
            fit_native_shape,
            fit_native_shape_with_fallback,
        )

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (100, 80), "white")
            ImageDraw.Draw(image).rectangle((10, 12, 70, 42), fill="#2563EB")
            image.save(source)

            candidate = ForegroundCandidate(
                candidate_id="bad-provenance",
                source_pixel_bbox=(10, 12, 71, 43),
                area=1891,
                classification="native_shape_candidate",
                confidence=0.95,
                provenance=1,
            )

            shape = fit_native_shape(candidate, source_image_path=source)
            fallback = fit_native_shape_with_fallback(candidate, source_image_path=source)

        self.assertIsNone(shape)
        self.assertIsNone(fallback.native_shape)
        self.assertEqual(fallback.bitmap_candidate.classification, "bitmap_asset_candidate")
        self.assertEqual(
            fallback.bitmap_candidate.provenance["shape_fit_fallback_reason"],
            "unsupported_or_disabled_native_shape",
        )


if __name__ == "__main__":
    unittest.main()

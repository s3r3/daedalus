import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from PIL import Image, ImageDraw


class GenerativeEditableForegroundPlannerTest(unittest.TestCase):
    def test_detects_foreground_candidates_from_source_vs_base_clean_excluding_text_mask(self):
        from src.generative_editable_foreground_planner import plan_foreground_candidates

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            base = root / "base.png"
            text_mask = root / "text-mask.png"
            Image.new("RGB", (120, 80), "white").save(base)
            source_image = Image.new("RGB", (120, 80), "white")
            draw = ImageDraw.Draw(source_image)
            draw.rectangle((12, 14, 42, 34), fill="#2563EB")
            draw.rectangle((70, 20, 104, 34), fill="#111111")
            source_image.save(source)
            mask = Image.new("L", (120, 80), 0)
            ImageDraw.Draw(mask).rectangle((66, 16, 108, 38), fill=255)
            mask.save(text_mask)

            candidates = plan_foreground_candidates(
                source_image_path=source,
                base_clean_image_path=base,
                text_mask_path=text_mask,
                min_area=20,
            )

        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate.source_pixel_bbox, (12, 14, 43, 35))
        self.assertEqual(candidate.classification, "uncertain")
        self.assertEqual(candidate.provenance["detection"], "source_base_difference")

    def test_classifies_candidate_inventory_into_expected_buckets(self):
        from src.generative_editable_foreground_planner import classify_foreground_candidates

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (180, 120), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((10, 10, 50, 34), fill="#2563EB")
            for x in range(70, 135):
                for y in range(12, 82):
                    draw.point((x, y), fill=((x * 3) % 255, (y * 5) % 255, (x + y) % 255))
            draw.ellipse((20, 70, 48, 98), fill="#10B981")
            draw.rectangle((140, 10, 154, 18), fill="#111111")
            image.save(source)

            candidates = classify_foreground_candidates(
                source_image_path=source,
                candidate_boxes=[
                    (10, 10, 51, 35),
                    (70, 12, 136, 83),
                    (20, 70, 49, 99),
                    (140, 10, 155, 19),
                    (160, 100, 163, 102),
                ],
                rejected_text_regions=[(136, 6, 160, 24)],
            )

        self.assertEqual(
            [candidate.classification for candidate in candidates],
            [
                "native_shape_candidate",
                "complex_whole_visual",
                "bitmap_asset_candidate",
                "rejected_text_like_region",
                "uncertain",
            ],
        )
        self.assertGreaterEqual(candidates[0].confidence, 0.9)
        self.assertEqual(candidates[0].provenance["shape_hint"], "rectangle")
        self.assertEqual(candidates[1].provenance["reason"], "large_or_visually_complex")

    def test_rejects_candidate_boxes_outside_source_image_bounds(self):
        from src.generative_editable_foreground_planner import classify_foreground_candidates

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            Image.new("RGB", (100, 60), "white").save(source)

            with self.assertRaisesRegex(ValueError, "candidate_boxes"):
                classify_foreground_candidates(
                    source_image_path=source,
                    candidate_boxes=[(90, 10, 120, 30)],
                )

    def test_records_component_reuse_for_repeated_visual_candidates(self):
        from src.generative_editable_foreground_planner import (
            classify_foreground_candidates,
            foreground_candidates_to_manifest_specs,
            record_component_reuse,
        )
        from src.generative_editable_manifest import (
            PageManifest,
            read_page_manifest,
            write_manifest,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (140, 80), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((10, 10, 34, 34), fill="#2563EB")
            draw.rectangle((70, 10, 94, 34), fill="#2563EB")
            image.save(source)

            candidates = classify_foreground_candidates(
                source_image_path=source,
                candidate_boxes=[(10, 10, 35, 35), (70, 10, 95, 35)],
            )
            reused = record_component_reuse(candidates)
            page = PageManifest(
                slide_id="slide-a",
                page_index=0,
                source_image_path="sources/slide-a.png",
                source_image_size=(140, 80),
                slide_size=(10.0, 5.625),
                foreground_candidates=foreground_candidates_to_manifest_specs(reused),
            )
            manifest_path = root / "page.json"
            write_manifest(manifest_path, page)
            loaded = read_page_manifest(manifest_path)

        self.assertEqual(reused[0].classification, "native_shape_candidate")
        self.assertEqual(reused[1].classification, "duplicate")
        self.assertEqual(reused[0].component_key, reused[1].component_key)
        self.assertEqual(reused[1].provenance["reuses_candidate_id"], reused[0].candidate_id)
        self.assertEqual(loaded.foreground_candidates[1].classification, "duplicate")
        self.assertEqual(
            loaded.foreground_candidates[1].provenance["reuses_candidate_id"],
            loaded.foreground_candidates[0].candidate_id,
        )
        self.assertEqual(loaded.foreground_candidates[0].component_key, reused[0].component_key)

    def test_non_dict_candidate_provenance_is_ignored_for_manifest_and_reuse(self):
        from src.generative_editable_foreground_planner import (
            ForegroundCandidate,
            foreground_candidates_to_manifest_specs,
            record_component_reuse,
        )

        first = ForegroundCandidate(
            candidate_id="first",
            source_pixel_bbox=(10, 10, 20, 20),
            area=100,
            classification="native_shape_candidate",
            confidence=0.95,
            component_key="same",
            provenance={"shape_hint": "rectangle"},
        )
        duplicate = replace(
            first, candidate_id="duplicate", source_pixel_bbox=(30, 10, 40, 20), provenance=1
        )

        reused = record_component_reuse([first, duplicate])
        specs = foreground_candidates_to_manifest_specs(reused)

        self.assertEqual(reused[1].classification, "duplicate")
        self.assertEqual(reused[1].provenance["reuses_candidate_id"], "first")
        self.assertEqual(specs[1].provenance, {"reuses_candidate_id": "first"})


if __name__ == "__main__":
    unittest.main()

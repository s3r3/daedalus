import tempfile
import unittest
from pathlib import Path

from src.generative_editable_manifest import (
    AssetSheetSpec,
    BitmapAssetSpec,
    DeckManifest,
    NativeShapeSpec,
    PageManifest,
    RepairAttempt,
    TextBoxSpec,
    read_deck_manifest,
    read_page_manifest,
    write_manifest,
)


class GenerativeEditableManifestTest(unittest.TestCase):
    def test_deck_manifest_records_run_structure(self):
        manifest = DeckManifest(
            job_id="job-001",
            slide_order=["slide-b", "slide-a"],
            aspect_ratio="16:9",
            provider_roles={
                "ocr": "ocr_model",
                "clean_base": "edit_model",
                "asset_sheet": "edit_model",
                "repair": "edit_model",
                "generation": "image_model",
            },
            quality_settings={
                "preview_similarity_threshold": 0.92,
                "max_repair_attempts": 2,
                "require_preview_validation": True,
            },
            fallback_policy="fail",
            page_manifest_paths=["pages/0000-slide-b.json", "pages/0001-slide-a.json"],
            validation_status="pending",
        )

        self.assertEqual(manifest.slide_order, ["slide-b", "slide-a"])
        self.assertEqual(manifest.provider_roles["ocr"], "ocr_model")
        self.assertEqual(manifest.quality_settings["max_repair_attempts"], 2)
        self.assertEqual(manifest.fallback_policy, "fail")
        self.assertEqual(manifest.validation_status, "pending")

    def test_page_manifest_records_source_pixel_structure_and_validation(self):
        text_box = TextBoxSpec(
            text="Quarterly Plan",
            source_pixel_bbox=(80, 54, 420, 102),
            source_pixel_polygon=((80, 54), (420, 54), (420, 102), (80, 102)),
            font_family="Arial",
            font_size=32,
            color_hex="#1F2937",
            alignment="center",
            provenance={"source": "ocr"},
        )
        shape = NativeShapeSpec(
            shape_type="rounded_rectangle",
            source_pixel_bbox=(60, 140, 300, 220),
            fill_color="#FFFFFF",
            line_color="#CBD5E1",
            radius=12,
            confidence=0.95,
            provenance={"classifier": "fake"},
        )
        bitmap = BitmapAssetSpec(
            asset_id="asset-1",
            source_pixel_bbox=(340, 120, 620, 300),
            asset_path="assets/asset-1.png",
            z_order=3,
            provenance={"sheet_id": "sheet-1"},
        )
        sheet = AssetSheetSpec(
            sheet_id="sheet-1",
            asset_path="assets/sheet-1.png",
            prompt_id="asset_sheet",
            candidate_ids=["asset-1"],
            provider_role="generation",
            provenance={"model": "fake-image-generation"},
        )
        repair = RepairAttempt(
            target_id="asset-1",
            attempt_index=1,
            reason="edge_touch",
            provider_role="repair",
            status="passed",
            provenance={"prompt_id": "repair_asset"},
        )

        manifest = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="slides/slide-a.png",
            source_image_size=(800, 450),
            slide_size=(10.0, 5.625),
            text_clean_background="backgrounds/slide-a.text-clean.png",
            base_clean_background="backgrounds/slide-a.base-clean.png",
            chosen_background="backgrounds/slide-a.base-clean.png",
            text_boxes=[text_box],
            native_shapes=[shape],
            bitmap_assets=[bitmap],
            asset_sheets=[sheet],
            repair_attempts=[repair],
            provenance={"input_hash": "abc123"},
            validation_status="pending",
        )

        self.assertEqual(manifest.source_image_size, (800, 450))
        self.assertEqual(manifest.text_boxes[0].source_pixel_bbox, (80, 54, 420, 102))
        self.assertEqual(manifest.native_shapes[0].source_pixel_bbox, (60, 140, 300, 220))
        self.assertEqual(manifest.bitmap_assets[0].source_pixel_bbox, (340, 120, 620, 300))
        self.assertEqual(manifest.asset_sheets[0].provider_role, "generation")
        self.assertEqual(manifest.repair_attempts[0].status, "passed")
        self.assertEqual(manifest.validation_status, "pending")

    def test_legacy_page_manifest_without_text_opacity_defaults_to_visible_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            page_path = root / "pages" / "0000-slide-a.json"
            page_path.parent.mkdir(parents=True)
            page_path.write_text(
                """{
  "slide_id": "slide-a",
  "page_index": 0,
  "source_image_path": "slides/slide-a.png",
  "source_image_size": [800, 450],
  "slide_size": [10.0, 5.625],
  "text_boxes": [
    {
      "text": "Legacy text",
      "source_pixel_bbox": [80, 54, 420, 102],
      "source_pixel_polygon": [[80, 54], [420, 54], [420, 102], [80, 102]],
      "font_family": "Arial",
      "font_size": 32,
      "color_hex": "#1F2937",
      "alignment": "center"
    }
  ]
}
""",
                encoding="utf-8",
            )

            page = read_page_manifest(page_path)

        self.assertEqual(page.text_boxes[0].opacity, 1.0)

    def test_manifest_models_validate_status_policy_and_source_pixel_boxes(self):
        with self.assertRaisesRegex(ValueError, "fallback_policy"):
            DeckManifest(
                job_id="job",
                slide_order=[],
                aspect_ratio="16:9",
                provider_roles={},
                quality_settings={},
                fallback_policy="best_effort",
                page_manifest_paths=[],
                validation_status="pending",
            )

        with self.assertRaisesRegex(ValueError, "aspect_ratio"):
            DeckManifest(
                job_id="job",
                slide_order=[],
                aspect_ratio="16-9",
                provider_roles={},
                quality_settings={},
                fallback_policy="fail",
                page_manifest_paths=[],
                validation_status="pending",
            )

        with self.assertRaisesRegex(ValueError, "page_manifest_paths"):
            DeckManifest(
                job_id="job",
                slide_order=["slide-a", "slide-b"],
                aspect_ratio="16:9",
                provider_roles={},
                quality_settings={},
                fallback_policy="fail",
                page_manifest_paths=["pages/0000-slide-a.json"],
                validation_status="pending",
            )

        with self.assertRaisesRegex(ValueError, "page_manifest_paths"):
            DeckManifest(
                job_id="job",
                slide_order=["slide-a"],
                aspect_ratio="16:9",
                provider_roles={},
                quality_settings={},
                fallback_policy="fail",
                page_manifest_paths=["pages/0000-slide-b.json"],
                validation_status="pending",
            )

    def test_page_manifest_round_trips_through_json_without_losing_structure(self):
        manifest = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="slides/slide-a.png",
            source_image_size=(800, 450),
            slide_size=(10.0, 5.625),
            text_clean_background="backgrounds/slide-a.text-clean.png",
            base_clean_background="backgrounds/slide-a.base-clean.png",
            chosen_background="backgrounds/slide-a.base-clean.png",
            text_boxes=[
                TextBoxSpec(
                    text="Visit https://example.com",
                    source_pixel_bbox=(80, 54, 420, 102),
                    source_pixel_polygon=((80, 54), (420, 54), (420, 102), (80, 102)),
                    style_hints={"keyline": True},
                    provenance={"provider_role": "ocr_model"},
                )
            ],
            native_shapes=[
                NativeShapeSpec(
                    shape_type="rectangle",
                    source_pixel_bbox=(60, 140, 300, 220),
                    fill_color="#FFFFFF",
                    confidence=0.95,
                    provenance={"classifier": "fake"},
                )
            ],
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id="asset-1",
                    source_pixel_bbox=(340, 120, 620, 300),
                    asset_path="assets/asset-1.png",
                    z_order=3,
                    provenance={
                        "provider_role": "generation",
                        "asset_key": "legitimate-layout-key",
                    },
                )
            ],
            asset_sheets=[
                AssetSheetSpec(
                    sheet_id="sheet-1",
                    asset_path="assets/sheet-1.png",
                    prompt_id="asset_sheet",
                    candidate_ids=["asset-1"],
                    provider_role="generation",
                    provenance={"model": "fake-image-generation"},
                )
            ],
            repair_attempts=[
                RepairAttempt(
                    target_id="asset-1",
                    attempt_index=1,
                    reason="edge_touch",
                    provider_role="repair",
                    status="passed",
                    provenance={"prompt_id": "repair_asset"},
                )
            ],
            provider_output_paths={
                "ocr": "provider_outputs/ocr/0000-slide-a/result.json",
                "image_edit": "provider_outputs/image_edit/0000-slide-a/base-clean.json",
                "image_generation": "provider_outputs/image_generation/0000-slide-a/asset-sheet.json",
                "repair": "provider_outputs/repair/0000-slide-a/repair.json",
            },
            provenance={"input_hash": "abc123"},
            validation_status="passed",
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "page.json"
            write_manifest(path, manifest)
            loaded = read_page_manifest(path)

        self.assertEqual(loaded.text_boxes[0].text, "Visit https://example.com")
        self.assertTrue(loaded.text_boxes[0].style_hints["keyline"])
        self.assertEqual(loaded.text_boxes[0].source_pixel_bbox, (80, 54, 420, 102))
        self.assertEqual(
            loaded.text_boxes[0].source_pixel_polygon,
            ((80, 54), (420, 54), (420, 102), (80, 102)),
        )
        self.assertEqual(loaded.bitmap_assets[0].asset_path, "assets/asset-1.png")
        self.assertEqual(
            loaded.bitmap_assets[0].provenance["asset_key"],
            "legitimate-layout-key",
        )
        self.assertEqual(loaded.native_shapes[0].shape_type, "rectangle")
        self.assertEqual(loaded.asset_sheets[0].provenance["model"], "fake-image-generation")
        self.assertEqual(loaded.repair_attempts[0].provenance["prompt_id"], "repair_asset")
        self.assertEqual(loaded.text_clean_background, "backgrounds/slide-a.text-clean.png")
        self.assertEqual(loaded.base_clean_background, "backgrounds/slide-a.base-clean.png")
        self.assertEqual(
            loaded.provider_output_paths["repair"],
            "provider_outputs/repair/0000-slide-a/repair.json",
        )
        self.assertEqual(loaded.provenance["input_hash"], "abc123")
        self.assertEqual(loaded.validation_status, "passed")

    def test_deck_manifest_round_trips_through_json_without_losing_provider_metadata(self):
        manifest = DeckManifest(
            job_id="job-001",
            slide_order=["slide-a"],
            aspect_ratio="16:9",
            provider_roles={"ocr": "ocr_model", "generation": "image_model"},
            quality_settings={"preview_similarity_threshold": 0.92},
            fallback_policy="fail",
            page_manifest_paths=["pages/0000-slide-a.json"],
            validation_status="failed",
            provenance={"validation_error": "preview similarity below threshold"},
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deck.json"
            write_manifest(path, manifest)
            loaded = read_deck_manifest(path)

        self.assertEqual(loaded.provider_roles["generation"], "image_model")
        self.assertEqual(loaded.page_manifest_paths, ["pages/0000-slide-a.json"])
        self.assertEqual(loaded.validation_status, "failed")
        self.assertEqual(
            loaded.provenance["validation_error"], "preview similarity below threshold"
        )

        with self.assertRaisesRegex(ValueError, "validation_status"):
            PageManifest(
                slide_id="slide",
                page_index=0,
                source_image_path="slide.png",
                source_image_size=(800, 450),
                slide_size=(10.0, 5.625),
                validation_status="unknown",
            )

        with self.assertRaisesRegex(ValueError, "source_pixel_bbox"):
            TextBoxSpec(
                text="bad box",
                source_pixel_bbox=(100, 100, 50, 120),
                source_pixel_polygon=((100, 100), (50, 100), (50, 120), (100, 120)),
            )

        with self.assertRaisesRegex(ValueError, "source_pixel_bbox"):
            TextBoxSpec(
                text="negative box",
                source_pixel_bbox=(-1, 10, 50, 120),
                source_pixel_polygon=((0, 10), (50, 10), (50, 120), (0, 120)),
            )

        with self.assertRaisesRegex(ValueError, "source_pixel_bbox"):
            TextBoxSpec(
                text="float box",
                source_pixel_bbox=(1.5, 10, 50, 120),
                source_pixel_polygon=((1, 10), (50, 10), (50, 120), (1, 120)),
            )

        with self.assertRaisesRegex(ValueError, "source_pixel_bbox"):
            PageManifest(
                slide_id="slide",
                page_index=0,
                source_image_path="slides/slide.png",
                source_image_size=(800, 450),
                slide_size=(10.0, 5.625),
                text_boxes=[
                    TextBoxSpec(
                        text="out of bounds",
                        source_pixel_bbox=(10, 10, 900, 120),
                        source_pixel_polygon=((10, 10), (900, 10), (900, 120), (10, 120)),
                    )
                ],
            )

        with self.assertRaisesRegex(ValueError, "confidence"):
            NativeShapeSpec(
                shape_type="rectangle",
                source_pixel_bbox=(10, 10, 50, 50),
                confidence=1.5,
            )

        with self.assertRaisesRegex(ValueError, "shape_type"):
            NativeShapeSpec(
                shape_type="freeform",
                source_pixel_bbox=(10, 10, 50, 50),
            )

        with self.assertRaisesRegex(ValueError, "radius"):
            NativeShapeSpec(
                shape_type="rounded_rectangle",
                source_pixel_bbox=(10, 10, 50, 50),
                radius=-1,
            )

        with self.assertRaisesRegex(ValueError, "attempt_index"):
            RepairAttempt(
                target_id="asset",
                attempt_index=0,
                reason="retry",
                provider_role="repair",
                status="pending",
            )

    def test_manifest_rejects_unscoped_artifact_paths_and_redacts_persisted_secrets(self):
        with self.assertRaisesRegex(ValueError, "source_image_path"):
            PageManifest(
                slide_id="slide",
                page_index=0,
                source_image_path="../outside.png",
                source_image_size=(800, 450),
                slide_size=(10.0, 5.625),
            )

        with self.assertRaisesRegex(ValueError, "asset_path"):
            BitmapAssetSpec(
                asset_id="asset",
                source_pixel_bbox=(10, 10, 50, 50),
                asset_path="/tmp/asset.png",
                z_order=1,
            )

        manifest = DeckManifest(
            job_id="job-001",
            slide_order=["???"],
            aspect_ratio="16:9",
            provider_roles={"ocr": "ocr_model"},
            quality_settings={},
            fallback_policy="fail",
            page_manifest_paths=["pages/0000-item.json"],
            provenance={"error": "api_key=secret at https://example.test/path"},
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deck.json"
            write_manifest(path, manifest)
            raw = path.read_text(encoding="utf-8")

        self.assertNotIn("secret", raw)
        self.assertNotIn("https://example.test/path", raw)
        self.assertIn("[REDACTED]", raw)

        with self.assertRaisesRegex(ValueError, "provider_output_paths"):
            PageManifest(
                slide_id="slide-a",
                page_index=0,
                source_image_path="slides/slide-a.png",
                source_image_size=(800, 450),
                slide_size=(10.0, 5.625),
                provider_output_paths={
                    "ocr": "provider_outputs/repair/0000-slide-a/result.json",
                },
            )

        with self.assertRaisesRegex(ValueError, "provider_output_paths"):
            PageManifest(
                slide_id="slide-a",
                page_index=0,
                source_image_path="slides/slide-a.png",
                source_image_size=(800, 450),
                slide_size=(10.0, 5.625),
                provider_output_paths={
                    "unknown": "provider_outputs/unknown/0000-slide-a/result.json",
                },
            )

    def test_manifest_persistence_drops_sensitive_key_substrings_in_provenance(self):
        manifest = DeckManifest(
            job_id="job-001",
            slide_order=["slide-a"],
            aspect_ratio="16:9",
            provider_roles={"ocr": "ocr_model"},
            quality_settings={},
            fallback_policy="fail",
            page_manifest_paths=["pages/0000-slide-a.json"],
            provenance={
                "openai_api_key": "openai-secret",
                "provider_api_key": "provider-secret",
                "imageEditToken": "image-edit-secret",
                "safe_note": "keep-me",
            },
        )

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deck.json"
            write_manifest(path, manifest)
            raw = path.read_text(encoding="utf-8")
            loaded = read_deck_manifest(path)

        self.assertNotIn("openai-secret", raw)
        self.assertNotIn("provider-secret", raw)
        self.assertNotIn("image-edit-secret", raw)
        self.assertNotIn("openai_api_key", loaded.provenance)
        self.assertNotIn("provider_api_key", loaded.provenance)
        self.assertNotIn("imageEditToken", loaded.provenance)
        self.assertEqual(loaded.provenance["safe_note"], "keep-me")


if __name__ == "__main__":
    unittest.main()

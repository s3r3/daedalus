import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from src.generative_editable_config import ProviderConfig
from src.generative_editable_foreground_planner import ForegroundCandidate
from src.generative_editable_manifest import BitmapAssetSpec, RepairAttempt
from src.generative_editable_providers import (
    FakeImageEditProvider,
    ImageEditProvider,
)


class RecordingImageEditProvider(ImageEditProvider):
    def __init__(self):
        super().__init__(
            ProviderConfig(
                role="edit_model",
                provider="fake-image-edit",
                model="fake-image-edit-model",
                base_url="https://fake.local",
                api_key="fake-key",
            )
        )
        self.calls = []
        self.fake = FakeImageEditProvider(self.config)

    def edit(self, request):
        self.calls.append(request)
        return self.fake.edit(request)


class RecordingValidAssetRepairProvider(ImageEditProvider):
    def __init__(self):
        super().__init__(
            ProviderConfig(
                role="edit_model",
                provider="valid-repair",
                model="valid-repair-model",
                base_url="https://fake.local",
                api_key="fake-key",
            )
        )
        self.calls = []

    def edit(self, request):
        self.calls.append(request)
        output = Path(request.output_asset_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGBA", (30, 22), (0, 0, 0, 0))
        ImageDraw.Draw(image).ellipse((8, 5, 22, 19), fill=(16, 185, 129, 255))
        image.save(output)
        return type(
            "Result",
            (),
            {
                "output_asset_path": str(output),
                "provider_role": self.config.role,
            },
        )()


class GenerativeEditableAssetsTest(unittest.TestCase):
    def test_builds_asset_sheet_edit_request_from_bitmap_candidates(self):
        from src.generative_editable_assets import build_asset_sheet_request

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            source.parent.mkdir(parents=True)
            Image.new("RGB", (200, 120), "white").save(source)
            candidates = [
                ForegroundCandidate(
                    candidate_id="fg-001",
                    source_pixel_bbox=(10, 12, 50, 42),
                    area=1200,
                    classification="bitmap_asset_candidate",
                    confidence=0.85,
                    provenance={"reason": "simple_nonrectangular_visual"},
                )
            ]

            request = build_asset_sheet_request(
                source_image_path=source,
                candidates=candidates,
                output_asset_path=output,
                asset_root=root,
                provider_role="edit_model",
            )

        self.assertEqual(request.prompt_id, "asset_sheet")
        self.assertIn("fg-001", request.prompt)
        self.assertIn("pure #FF00FF", request.prompt)
        self.assertIn(
            "Do not use checkerboard, gray, white, shadows, gradients, or scene floors",
            request.prompt,
        )
        self.assertIn("exactly one separated object per candidate id", request.prompt)
        self.assertIn("Do not merge, omit, rename, replace, or add objects", request.prompt)
        self.assertIn("Do not include readable text", request.prompt)
        self.assertIn(
            "Do not include full cards, panels, charts, or source-slide fragments", request.prompt
        )
        self.assertIn("Keep text boxes out of the asset sheet", request.prompt)
        self.assertIn("fg-001 bbox=(10, 12, 50, 42)", request.prompt)
        self.assertIn("classification=bitmap_asset_candidate", request.prompt)
        self.assertEqual(request.metadata["source_image_ref"], "sources/slide.png")
        self.assertEqual(request.metadata["candidate_boxes"][0]["bbox"], (10, 12, 50, 42))
        self.assertEqual(request.metadata["chroma_key_mode"], "solid #FF00FF chroma key")
        self.assertEqual(request.metadata["provider_role"], "edit_model")

    def test_slices_asset_sheet_preserving_alpha_padding_and_mapping(self):
        from src.generative_editable_assets import AssetSliceSpec, slice_asset_sheet

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (100, 60), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((12, 10, 34, 28), fill=(37, 99, 235, 255))
            draw.rectangle((60, 16, 80, 40), fill=(16, 185, 129, 180))
            image.save(sheet)
            specs = [
                AssetSliceSpec(
                    candidate_id="fg-001",
                    sheet_bbox=(10, 8, 36, 30),
                    source_pixel_bbox=(20, 20, 46, 42),
                    output_filename="fg-001.png",
                ),
                AssetSliceSpec(
                    candidate_id="fg-002",
                    sheet_bbox=(58, 14, 82, 42),
                    source_pixel_bbox=(70, 24, 94, 52),
                    output_filename="fg-002.png",
                ),
            ]

            assets = slice_asset_sheet(
                sheet_path=sheet,
                slice_specs=specs,
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
            )
            with Image.open(root / assets[1].asset_path) as sliced:
                sliced_mode = sliced.mode
                sliced_alpha = sliced.getpixel((4, 4))[3]

        self.assertEqual([asset.asset_id for asset in assets], ["fg-001", "fg-002"])
        self.assertEqual(assets[0].asset_path, "assets/0000-slide-a/fg-001.png")
        self.assertEqual(assets[0].source_pixel_bbox, (20, 20, 46, 42))
        self.assertEqual(assets[0].provenance["candidate_id"], "fg-001")
        self.assertEqual(sliced_mode, "RGBA")
        self.assertEqual(sliced_alpha, 180)

    def test_slice_asset_sheet_rejects_sheet_path_outside_asset_root(self):
        from src.generative_editable_assets import AssetSliceSpec, slice_asset_sheet

        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            outside_sheet = Path(outside_tmp) / "sheet.png"
            Image.new("RGBA", (40, 30), (0, 0, 0, 0)).save(outside_sheet)

            with self.assertRaisesRegex(ValueError, "sheet_path"):
                slice_asset_sheet(
                    sheet_path=outside_sheet,
                    slice_specs=[
                        AssetSliceSpec(
                            candidate_id="fg-001",
                            sheet_bbox=(0, 0, 40, 30),
                            source_pixel_bbox=(0, 0, 40, 30),
                            output_filename="fg-001.png",
                        )
                    ],
                    output_dir=root / "assets" / "0000-slide-a",
                    asset_root=root,
                )

    def test_chroma_key_slicing_removes_green_background(self):
        from src.generative_editable_assets import AssetSliceSpec, slice_asset_sheet

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGB", (40, 30), (0, 255, 0))
            ImageDraw.Draw(image).rectangle((10, 8, 26, 20), fill="#2563EB")
            image.save(sheet)

            assets = slice_asset_sheet(
                sheet_path=sheet,
                slice_specs=[
                    AssetSliceSpec(
                        candidate_id="fg-001",
                        sheet_bbox=(0, 0, 40, 30),
                        source_pixel_bbox=(0, 0, 40, 30),
                        output_filename="fg-001.png",
                    )
                ],
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
                chroma_key=(0, 255, 0),
            )
            with Image.open(root / assets[0].asset_path) as sliced:
                sliced_mode = sliced.mode
                transparent_alpha = sliced.getpixel((0, 0))[3]
                object_alpha = sliced.getpixel((12, 10))[3]

        self.assertEqual(sliced_mode, "RGBA")
        self.assertEqual(transparent_alpha, 0)
        self.assertEqual(object_alpha, 255)

    def test_component_slicing_treats_checkerboard_background_as_transparent(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGB", (160, 90), "white")
            pixels = image.load()
            for y in range(image.height):
                for x in range(image.width):
                    tile = ((x // 8) + (y // 8)) % 2
                    base = 246 if tile == 0 else 232
                    variation = (x * 7 + y * 11) % 9
                    value = base + variation - 4
                    pixels[x, y] = (value, value, value)
            draw = ImageDraw.Draw(image)
            draw.ellipse((18, 20, 48, 50), fill=(0, 112, 243))
            draw.rectangle((104, 28, 138, 58), fill=(16, 185, 129))
            image.save(sheet)

            candidates = [
                ForegroundCandidate(
                    candidate_id="fg-left",
                    source_pixel_bbox=(10, 10, 45, 45),
                    area=1200,
                    classification="complex_whole_visual",
                    confidence=0.9,
                    provenance={},
                ),
                ForegroundCandidate(
                    candidate_id="fg-right",
                    source_pixel_bbox=(80, 12, 126, 54),
                    area=1400,
                    classification="complex_whole_visual",
                    confidence=0.9,
                    provenance={},
                ),
            ]

            assets = slice_asset_sheet_by_components(
                sheet_path=sheet,
                candidates=candidates,
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
                padding=4,
            )
            with Image.open(root / assets[0].asset_path) as first:
                first_corner_alpha = first.getpixel((0, 0))[3]
            with Image.open(root / assets[1].asset_path) as second:
                second_corner_alpha = second.getpixel((0, 0))[3]

        self.assertEqual([asset.asset_id for asset in assets], ["fg-left", "fg-right"])
        self.assertEqual(first_corner_alpha, 0)
        self.assertEqual(second_corner_alpha, 0)

    def test_component_slicing_treats_noisy_magenta_chroma_as_transparent(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGB", (160, 90), "white")
            pixels = image.load()
            for y in range(image.height):
                for x in range(image.width):
                    variation = (x * 5 + y * 13) % 23
                    pixels[x, y] = (245 + variation // 3, variation // 4, 238 + variation // 2)
            draw = ImageDraw.Draw(image)
            draw.ellipse((18, 20, 48, 50), fill=(0, 112, 243))
            draw.rectangle((104, 28, 138, 58), fill=(16, 185, 129))
            image.save(sheet)

            candidates = [
                ForegroundCandidate(
                    candidate_id="fg-left",
                    source_pixel_bbox=(10, 10, 45, 45),
                    area=1200,
                    classification="complex_whole_visual",
                    confidence=0.9,
                    provenance={},
                ),
                ForegroundCandidate(
                    candidate_id="fg-right",
                    source_pixel_bbox=(80, 12, 126, 54),
                    area=1400,
                    classification="complex_whole_visual",
                    confidence=0.9,
                    provenance={},
                ),
            ]

            assets = slice_asset_sheet_by_components(
                sheet_path=sheet,
                candidates=candidates,
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
                padding=4,
            )
            with Image.open(root / assets[0].asset_path) as first:
                first_corner_alpha = first.getpixel((0, 0))[3]
            with Image.open(root / assets[1].asset_path) as second:
                second_corner_alpha = second.getpixel((0, 0))[3]

        self.assertEqual([asset.asset_id for asset in assets], ["fg-left", "fg-right"])
        self.assertEqual(first_corner_alpha, 0)
        self.assertEqual(second_corner_alpha, 0)

    def test_component_slicing_rejects_extra_components_for_unmerged_single_candidate(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (180, 90), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 28, 58, 60), fill=(0, 112, 243, 255))
            draw.rectangle((112, 28, 150, 60), fill=(16, 185, 129, 255))
            image.save(sheet)

            with self.assertRaisesRegex(ValueError, "unexpected extra component"):
                slice_asset_sheet_by_components(
                    sheet_path=sheet,
                    candidates=[
                        ForegroundCandidate(
                            candidate_id="fg-group",
                            source_pixel_bbox=(10, 10, 160, 70),
                            area=9000,
                            classification="complex_whole_visual",
                        )
                    ],
                    output_dir=root / "assets" / "0000-slide-a",
                    asset_root=root,
                    padding=4,
                )

    def test_component_slicing_rejects_extra_components_for_multiple_candidates(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (240, 120), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 32, 58, 70), fill=(0, 112, 243, 255))
            draw.rectangle((90, 32, 128, 70), fill=(16, 185, 129, 255))
            draw.rectangle((168, 28, 220, 78), fill=(255, 255, 255, 255))
            image.save(sheet)

            with self.assertRaisesRegex(ValueError, "unexpected extra component"):
                slice_asset_sheet_by_components(
                    sheet_path=sheet,
                    candidates=[
                        ForegroundCandidate(
                            candidate_id="fg-left",
                            source_pixel_bbox=(10, 10, 45, 45),
                            area=1200,
                            classification="bitmap_asset_candidate",
                        ),
                        ForegroundCandidate(
                            candidate_id="fg-right",
                            source_pixel_bbox=(80, 12, 126, 54),
                            area=1400,
                            classification="bitmap_asset_candidate",
                        ),
                    ],
                    output_dir=root / "assets" / "0000-slide-a",
                    asset_root=root,
                    padding=4,
                )

    def test_component_slicing_can_ignore_extra_components_when_explicitly_allowed(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (240, 160), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 32, 58, 70), fill=(0, 112, 243, 255))
            draw.rectangle((90, 32, 128, 70), fill=(16, 185, 129, 255))
            draw.rectangle((20, 112, 27, 119), fill=(255, 255, 255, 255))
            image.save(sheet)

            assets = slice_asset_sheet_by_components(
                sheet_path=sheet,
                candidates=[
                    ForegroundCandidate(
                        candidate_id="fg-left",
                        source_pixel_bbox=(10, 10, 45, 45),
                        area=1200,
                        classification="bitmap_asset_candidate",
                    ),
                    ForegroundCandidate(
                        candidate_id="fg-right",
                        source_pixel_bbox=(80, 12, 126, 54),
                        area=1400,
                        classification="bitmap_asset_candidate",
                    ),
                ],
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
                padding=4,
                allow_extra_components=True,
            )

        self.assertEqual([asset.asset_id for asset in assets], ["fg-left", "fg-right"])
        self.assertTrue(
            all(asset.provenance["ignored_extra_component_count"] == 1 for asset in assets)
        )

    def test_component_slicing_rejects_large_extra_components_even_when_allowed(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (240, 120), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 32, 58, 70), fill=(255, 255, 255, 255))
            draw.rectangle((90, 32, 128, 70), fill=(0, 112, 243, 255))
            draw.rectangle((168, 28, 220, 78), fill=(16, 185, 129, 255))
            image.save(sheet)

            with self.assertRaisesRegex(ValueError, "unexpected extra component"):
                slice_asset_sheet_by_components(
                    sheet_path=sheet,
                    candidates=[
                        ForegroundCandidate(
                            candidate_id="fg-left",
                            source_pixel_bbox=(10, 10, 45, 45),
                            area=1200,
                            classification="bitmap_asset_candidate",
                        ),
                        ForegroundCandidate(
                            candidate_id="fg-right",
                            source_pixel_bbox=(80, 12, 126, 54),
                            area=1400,
                            classification="bitmap_asset_candidate",
                        ),
                    ],
                    output_dir=root / "assets" / "0000-slide-a",
                    asset_root=root,
                    padding=4,
                    allow_extra_components=True,
                )

    def test_component_slicing_orders_same_row_by_horizontal_position(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (300, 120), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((28, 34, 68, 74), fill=(0, 112, 243, 255))
            draw.rectangle((120, 10, 190, 82), fill=(16, 185, 129, 255))
            draw.rectangle((226, 28, 266, 76), fill=(245, 158, 11, 255))
            image.save(sheet)

            assets = slice_asset_sheet_by_components(
                sheet_path=sheet,
                candidates=[
                    ForegroundCandidate(
                        candidate_id="fg-left",
                        source_pixel_bbox=(10, 10, 45, 45),
                        area=1200,
                        classification="bitmap_asset_candidate",
                    ),
                    ForegroundCandidate(
                        candidate_id="fg-middle",
                        source_pixel_bbox=(80, 12, 126, 54),
                        area=1400,
                        classification="bitmap_asset_candidate",
                    ),
                    ForegroundCandidate(
                        candidate_id="fg-right",
                        source_pixel_bbox=(140, 12, 190, 54),
                        area=1400,
                        classification="bitmap_asset_candidate",
                    ),
                ],
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
                padding=2,
            )
            with Image.open(root / assets[0].asset_path) as first:
                first_pixels = list(first.convert("RGBA").getdata())
            with Image.open(root / assets[1].asset_path) as second:
                second_pixels = list(second.convert("RGBA").getdata())

        self.assertEqual([asset.asset_id for asset in assets], ["fg-left", "fg-middle", "fg-right"])
        self.assertGreater(sum(1 for pixel in first_pixels if pixel[:3] == (0, 112, 243)), 0)
        self.assertGreater(sum(1 for pixel in second_pixels if pixel[:3] == (16, 185, 129)), 0)

    def test_component_slicing_unions_multiple_components_for_explicitly_merged_candidate(self):
        from src.generative_editable_assets import slice_asset_sheet_by_components

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sheet = root / "asset_sheets" / "0000-slide-a" / "sheet.png"
            sheet.parent.mkdir(parents=True)
            image = Image.new("RGBA", (180, 90), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 28, 58, 60), fill=(0, 112, 243, 255))
            draw.rectangle((112, 28, 150, 60), fill=(16, 185, 129, 255))
            image.save(sheet)

            assets = slice_asset_sheet_by_components(
                sheet_path=sheet,
                candidates=[
                    ForegroundCandidate(
                        candidate_id="fg-group",
                        source_pixel_bbox=(10, 10, 160, 70),
                        area=9000,
                        classification="complex_whole_visual",
                        provenance={"merged_candidate_ids": ["fg-left", "fg-right"]},
                    )
                ],
                output_dir=root / "assets" / "0000-slide-a",
                asset_root=root,
                padding=4,
            )
            with Image.open(root / assets[0].asset_path) as sliced:
                sliced_bbox = sliced.getchannel("A").getbbox()
                sliced_size = sliced.size

        self.assertEqual([asset.asset_id for asset in assets], ["fg-group"])
        self.assertIsNotNone(sliced_bbox)
        self.assertGreaterEqual(sliced_size[0], 130)

    def test_asset_qa_rejects_edge_neighbor_text_missing_and_empty_assets(self):
        from src.generative_editable_assets import validate_sliced_asset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset = root / "asset.png"
            image = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((0, 6, 20, 20), fill=(37, 99, 235, 255))
            image.save(asset)
            edge_report = validate_sliced_asset(asset_path=asset, expected_text_free=True)

            image = Image.new("RGBA", (60, 30), (0, 0, 0, 0))
            draw = ImageDraw.Draw(image)
            draw.rectangle((10, 8, 22, 20), fill=(37, 99, 235, 255))
            draw.rectangle((42, 8, 54, 20), fill=(249, 115, 22, 255))
            image.save(asset)
            neighbor_report = validate_sliced_asset(asset_path=asset, expected_object_count=1)

            image = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
            ImageDraw.Draw(image).rectangle((12, 8, 30, 18), fill=(10, 10, 10, 255))
            image.save(asset)
            text_report = validate_sliced_asset(asset_path=asset, expected_text_free=True)

            Image.new("RGBA", (40, 30), (0, 0, 0, 0)).save(asset)
            empty_report = validate_sliced_asset(asset_path=asset)

            image = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
            ImageDraw.Draw(image).ellipse((12, 8, 16, 12), fill=(16, 185, 129, 255))
            image.save(asset)
            missing_report = validate_sliced_asset(
                asset_path=asset,
                expected_object_count=1,
                min_opaque_area_ratio=0.08,
            )

            image = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
            ImageDraw.Draw(image).ellipse((12, 8, 28, 24), fill=(16, 185, 129, 255))
            image.save(asset)
            passed_report = validate_sliced_asset(asset_path=asset, expected_object_count=1)

        self.assertEqual(edge_report.status, "failed")
        self.assertIn("edge_touch", edge_report.reasons)
        self.assertIn("neighboring_object_contamination", neighbor_report.reasons)
        self.assertIn("baked_text_contamination", text_report.reasons)
        self.assertIn("empty_asset", empty_report.reasons)
        self.assertIn("missing_object", missing_report.reasons)
        self.assertEqual(passed_report.status, "passed")

    def test_asset_qa_rejects_source_geometry_mismatch(self):
        from src.generative_editable_assets import validate_sliced_asset

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            asset = root / "asset.png"

            source_image = Image.new("RGB", (160, 90), "#0B1020")
            ImageDraw.Draw(source_image).rectangle((20, 34, 140, 46), fill="#10B981")
            source_image.save(source)

            asset_image = Image.new("RGBA", (60, 60), (0, 0, 0, 0))
            ImageDraw.Draw(asset_image).rectangle((14, 10, 46, 50), fill=(16, 185, 129, 255))
            asset_image.save(asset)

            report = validate_sliced_asset(
                asset_path=asset,
                expected_object_count=1,
                source_image_path=source,
                source_pixel_bbox=(20, 34, 141, 47),
                min_source_color_similarity=0.55,
            )

        self.assertEqual(report.status, "failed")
        self.assertIn("source_geometry_mismatch", report.reasons)

    def test_repair_orchestration_retries_failed_assets_and_records_history(self):
        from src.generative_editable_assets import repair_failed_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output_dir = root / "assets" / "0000-slide-a"
            source.parent.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            Image.new("RGB", (120, 80), "white").save(source)
            failed_asset = BitmapAssetSpec(
                asset_id="fg-001",
                source_pixel_bbox=(10, 10, 40, 32),
                asset_path="assets/0000-slide-a/fg-001.png",
                z_order=1,
                provenance={"candidate_id": "fg-001"},
            )
            provider = RecordingValidAssetRepairProvider()

            repaired, attempts = repair_failed_assets(
                source_image_path=source,
                failed_assets=[failed_asset],
                failure_reasons={"fg-001": ["edge_touch"]},
                output_dir=output_dir,
                asset_root=root,
                edit_provider=provider,
                max_attempts=1,
            )

        self.assertEqual(repaired[0].asset_id, "fg-001")
        self.assertEqual(repaired[0].asset_path, "assets/0000-slide-a/fg-001.repair-1.png")
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0].prompt_id, "repair_asset")
        self.assertEqual(provider.calls[0].metadata["failure_reasons"], ["edge_touch"])
        self.assertEqual(
            attempts,
            [
                RepairAttempt(
                    target_id="fg-001",
                    attempt_index=1,
                    reason="edge_touch",
                    provider_role="edit_model",
                    status="passed",
                    provenance={
                        "prompt_id": "repair_asset",
                        "output_asset_ref": "assets/0000-slide-a/fg-001.repair-1.png",
                    },
                )
            ],
        )

    def test_repair_orchestration_runs_qa_between_bounded_attempts(self):
        from src.generative_editable_assets import repair_failed_assets

        class SequenceRepairProvider(ImageEditProvider):
            def __init__(self, root):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="sequence",
                        model="sequence",
                        base_url="",
                        api_key="",
                    )
                )
                self.calls = []
                self.root = Path(root)

            def edit(self, request):
                self.calls.append(request)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                if len(self.calls) == 1:
                    Image.new("RGBA", (30, 22), (0, 0, 0, 0)).save(output)
                else:
                    image = Image.new("RGBA", (30, 22), (0, 0, 0, 0))
                    ImageDraw.Draw(image).ellipse((8, 5, 22, 19), fill=(16, 185, 129, 255))
                    image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output_dir = root / "assets" / "0000-slide-a"
            source.parent.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            Image.new("RGB", (120, 80), "white").save(source)
            failed_asset = BitmapAssetSpec(
                asset_id="fg-001",
                source_pixel_bbox=(10, 10, 40, 32),
                asset_path="assets/0000-slide-a/fg-001.png",
                z_order=1,
            )
            provider = SequenceRepairProvider(root)

            repaired, attempts = repair_failed_assets(
                source_image_path=source,
                failed_assets=[failed_asset],
                failure_reasons={"fg-001": ["empty_asset"]},
                output_dir=output_dir,
                asset_root=root,
                edit_provider=provider,
                max_attempts=2,
            )

        self.assertEqual(len(provider.calls), 2)
        self.assertEqual([attempt.status for attempt in attempts], ["failed", "passed"])
        self.assertEqual(attempts[0].attempt_index, 1)
        self.assertEqual(attempts[1].attempt_index, 2)
        self.assertEqual(repaired[0].asset_path, "assets/0000-slide-a/fg-001.repair-2.png")

    def test_repair_revalidates_text_free_when_original_failure_was_baked_text(self):
        from src.generative_editable_assets import repair_failed_assets

        class TextThenCleanRepairProvider(RecordingValidAssetRepairProvider):
            def edit(self, request):
                self.calls.append(request)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGBA", (40, 30), (0, 0, 0, 0))
                if len(self.calls) == 1:
                    ImageDraw.Draw(image).rectangle((10, 10, 30, 18), fill=(10, 10, 10, 255))
                else:
                    ImageDraw.Draw(image).ellipse((10, 8, 28, 24), fill=(16, 185, 129, 255))
                image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output_dir = root / "assets" / "0000-slide-a"
            source.parent.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            Image.new("RGB", (120, 80), "white").save(source)
            failed_asset = BitmapAssetSpec(
                asset_id="fg-001",
                source_pixel_bbox=(10, 10, 40, 32),
                asset_path="assets/0000-slide-a/fg-001.png",
                z_order=1,
            )
            provider = TextThenCleanRepairProvider()

            repaired, attempts = repair_failed_assets(
                source_image_path=source,
                failed_assets=[failed_asset],
                failure_reasons={"fg-001": ["baked_text_contamination"]},
                output_dir=output_dir,
                asset_root=root,
                edit_provider=provider,
                max_attempts=2,
            )

        self.assertEqual([attempt.status for attempt in attempts], ["failed", "passed"])
        self.assertIn("baked_text_contamination", attempts[0].reason)
        self.assertEqual(repaired[0].asset_path, "assets/0000-slide-a/fg-001.repair-2.png")

    def test_repair_rejects_wrong_object_even_when_asset_shape_qa_passes(self):
        from src.generative_editable_assets import repair_failed_assets

        class WrongThenMatchingRepairProvider(RecordingValidAssetRepairProvider):
            def edit(self, request):
                self.calls.append(request)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGBA", (30, 22), (0, 0, 0, 0))
                if len(self.calls) == 1:
                    ImageDraw.Draw(image).ellipse((8, 5, 22, 19), fill=(249, 115, 22, 255))
                else:
                    ImageDraw.Draw(image).ellipse((8, 5, 22, 19), fill=(16, 185, 129, 255))
                image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output_dir = root / "assets" / "0000-slide-a"
            source.parent.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            source_image = Image.new("RGB", (120, 80), "white")
            ImageDraw.Draw(source_image).ellipse((10, 10, 40, 32), fill=(16, 185, 129))
            source_image.save(source)
            failed_asset = BitmapAssetSpec(
                asset_id="fg-001",
                source_pixel_bbox=(10, 10, 40, 32),
                asset_path="assets/0000-slide-a/fg-001.png",
                z_order=1,
            )
            provider = WrongThenMatchingRepairProvider()

            repaired, attempts = repair_failed_assets(
                source_image_path=source,
                failed_assets=[failed_asset],
                failure_reasons={"fg-001": ["wrong_object"]},
                output_dir=output_dir,
                asset_root=root,
                edit_provider=provider,
                max_attempts=2,
            )

        self.assertEqual([attempt.status for attempt in attempts], ["failed", "passed"])
        self.assertIn("source_visual_mismatch", attempts[0].reason)
        self.assertEqual(repaired[0].asset_path, "assets/0000-slide-a/fg-001.repair-2.png")

    def test_repair_orchestration_records_limit_failure(self):
        from src.generative_editable_assets import repair_failed_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output_dir = root / "assets" / "0000-slide-a"
            source.parent.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            Image.new("RGB", (120, 80), "white").save(source)
            failed_asset = BitmapAssetSpec(
                asset_id="fg-001",
                source_pixel_bbox=(10, 10, 40, 32),
                asset_path="assets/0000-slide-a/fg-001.png",
                z_order=1,
            )
            provider = RecordingImageEditProvider()

            repaired, attempts = repair_failed_assets(
                source_image_path=source,
                failed_assets=[failed_asset],
                failure_reasons={"fg-001": ["missing_object"]},
                output_dir=output_dir,
                asset_root=root,
                edit_provider=provider,
                max_attempts=0,
            )

        self.assertEqual(repaired, [])
        self.assertEqual(provider.calls, [])
        self.assertEqual(attempts[0].status, "failed")
        self.assertEqual(attempts[0].reason, "repair_limit_exceeded:missing_object")

    def test_repair_history_does_not_record_synthetic_attempt_after_limit(self):
        from src.generative_editable_assets import repair_failed_assets

        class AlwaysEmptyRepairProvider(RecordingValidAssetRepairProvider):
            def edit(self, request):
                self.calls.append(request)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (30, 22), (0, 0, 0, 0)).save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output_dir = root / "assets" / "0000-slide-a"
            source.parent.mkdir(parents=True)
            output_dir.mkdir(parents=True)
            Image.new("RGB", (120, 80), "white").save(source)
            failed_asset = BitmapAssetSpec(
                asset_id="fg-001",
                source_pixel_bbox=(10, 10, 40, 32),
                asset_path="assets/0000-slide-a/fg-001.png",
                z_order=1,
            )
            provider = AlwaysEmptyRepairProvider()

            repaired, attempts = repair_failed_assets(
                source_image_path=source,
                failed_assets=[failed_asset],
                failure_reasons={"fg-001": ["missing_object"]},
                output_dir=output_dir,
                asset_root=root,
                edit_provider=provider,
                max_attempts=2,
            )

        self.assertEqual(repaired, [])
        self.assertEqual(len(provider.calls), 2)
        self.assertEqual([attempt.attempt_index for attempt in attempts], [1, 2])
        self.assertEqual(attempts[-1].reason, "repair_limit_exceeded:empty_asset,missing_object")


if __name__ == "__main__":
    unittest.main()

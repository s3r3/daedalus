import json
import tempfile
import threading
import unittest
from pathlib import Path

from src.generative_editable_manifest import (
    BitmapAssetSpec,
    NativeShapeSpec,
    PageManifest,
    RepairAttempt,
    TextBoxSpec,
)
from src.generative_editable_preview_validator import ValidationIssue, ValidationReport


def _write_test_asset(
    asset_root: str | Path, relative_path: str, size: tuple[int, int] = (16, 16)
) -> None:
    from PIL import Image

    path = Path(asset_root) / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGBA", size, (37, 99, 235, 255)).save(path)


class GenerativeEditablePipelineTest(unittest.TestCase):
    def test_visual_text_coverage_reports_unmatched_left_label_candidate(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_visual_text_coverage_issues", None)
        self.assertIsNotNone(helper)

        text_boxes = [
            TextBoxSpec(
                text="智能域",
                source_pixel_bbox=(286, 247, 391, 282),
                source_pixel_polygon=((286, 247), (391, 247), (391, 282), (286, 282)),
            ),
            TextBoxSpec(
                text="动力域",
                source_pixel_bbox=(274, 747, 379, 782),
                source_pixel_polygon=((274, 747), (379, 747), (379, 782), (274, 782)),
            ),
        ]

        issues = helper(
            text_boxes,
            visual_text_candidates=[
                (286, 247, 391, 282),
                (286, 497, 391, 532),
                (274, 747, 379, 782),
            ],
        )

        self.assertEqual(
            [issue["code"] for issue in issues], ["visual_text_candidate_missing_ocr_text"]
        )
        self.assertEqual(issues[0]["source_pixel_bbox"], (286, 497, 391, 532))

    def test_unanchored_approximate_text_boxes_are_filtered_when_local_candidates_exist(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        anchored = TextBoxSpec(
            text="日常操作",
            source_pixel_bbox=(150, 127, 339, 190),
            source_pixel_polygon=((150, 127), (339, 127), (339, 190), (150, 190)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        unanchored = TextBoxSpec(
            text="连接充电枪不可启动车辆",
            source_pixel_bbox=(701, 87, 929, 97),
            source_pixel_polygon=((701, 87), (929, 87), (929, 97), (701, 97)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        exact = TextBoxSpec(
            text="人工元数据",
            source_pixel_bbox=(20, 20, 120, 60),
            source_pixel_polygon=((20, 20), (120, 20), (120, 60), (20, 60)),
        )

        kept, issues = helper(
            [anchored, unanchored, exact],
            visual_text_candidates=[
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
                (279, 9, 551, 89),
            ],
            source_image_size=(1600, 900),
        )

        self.assertEqual([box.text for box in kept], ["日常操作", "人工元数据"])
        self.assertEqual(issues[0]["code"], "unanchored_approximate_ocr")
        self.assertEqual(issues[0]["ocr_text"], "连接充电枪不可启动车辆")
        self.assertEqual(issues[0]["severity"], "warning")

    def test_small_top_approximate_text_is_not_anchored_by_title_candidate(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        misplaced = TextBoxSpec(
            text="连接充电枪不可启动车辆",
            source_pixel_bbox=(701, 87, 929, 97),
            source_pixel_polygon=((701, 87), (929, 87), (929, 97), (701, 97)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )

        kept, issues = helper(
            [misplaced],
            visual_text_candidates=[
                (279, 9, 551, 89),
                (609, 9, 693, 89),
                (775, 9, 1299, 89),
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
                (560, 789, 740, 879),
            ],
            source_image_size=(1672, 941),
        )

        self.assertEqual(kept, [])
        self.assertEqual(issues[0]["code"], "unanchored_approximate_ocr")

    def test_quality_gate_keeps_dashboard_card_heading_candidates(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_quality_gate_visual_text_candidates", None)
        self.assertIsNotNone(helper)

        quality_candidates = helper(
            [
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
                (279, 9, 551, 89),
            ],
            (1672, 941),
        )

        self.assertEqual(quality_candidates, [(150, 127, 339, 190), (801, 127, 1037, 190)])

    def test_quality_gate_keeps_general_text_like_candidates_for_focused_recovery(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_quality_gate_visual_text_candidates", None)
        self.assertIsNotNone(helper)

        visual_candidates = [
            (279, 9, 551, 89),  # oversized title fragment already covered elsewhere
            (751, 381, 1072, 461),  # flowchart node text
            (1179, 381, 1548, 461),  # flowchart node text
            (762, 490, 1061, 557),  # flowchart branch text
            (1205, 490, 1525, 557),  # flowchart branch text
            (206, 807, 514, 842),  # bottom card text
            (1414, 814, 1593, 848),  # bottom card text
        ]

        quality_candidates = helper(visual_candidates, (1672, 941))

        self.assertEqual(
            quality_candidates,
            [
                (751, 381, 1072, 461),
                (1179, 381, 1548, 461),
                (762, 490, 1061, 557),
                (1205, 490, 1525, 557),
                (206, 807, 514, 842),
                (1414, 814, 1593, 848),
            ],
        )

    def test_right_side_spec_stack_approximate_ocr_is_dropped_without_visual_candidates(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        stack = [
            TextBoxSpec(
                text=text,
                source_pixel_bbox=bbox,
                source_pixel_polygon=(
                    (bbox[0], bbox[1]),
                    (bbox[2], bbox[1]),
                    (bbox[2], bbox[3]),
                    (bbox[0], bbox[3]),
                ),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            )
            for text, bbox in [
                ("线控转向", (1250, 440, 1380, 467)),
                ("后轮转向", (1291, 473, 1380, 497)),
                ("空气悬架", (1292, 507, 1380, 530)),
                ("Livis版800V主动悬架", (1292, 540, 1502, 563)),
                ("EMB", (1292, 575, 1340, 595)),
            ]
        ]

        kept, issues = helper(
            stack,
            visual_text_candidates=[
                (328, 36, 704, 126),
                (285, 245, 391, 283),
                (278, 497, 385, 536),
            ],
            source_image_size=(1706, 960),
        )

        self.assertEqual(kept, [])
        self.assertEqual([issue["ocr_text"] for issue in issues], [box.text for box in stack])

    def test_right_side_spec_stack_approximate_ocr_requires_visual_column_anchors(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        stack = [
            TextBoxSpec(
                text=text,
                source_pixel_bbox=bbox,
                source_pixel_polygon=(
                    (bbox[0], bbox[1]),
                    (bbox[2], bbox[1]),
                    (bbox[2], bbox[3]),
                    (bbox[0], bbox[3]),
                ),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            )
            for text, bbox in [
                ("制动", (1332, 321, 1388, 349)),
                ("车窗", (1326, 322, 1410, 350)),
                ("调整坐姿 | 250mm", (1211, 404, 1548, 450)),
                ("拔充电枪后启动", (1207, 502, 1433, 546)),
            ]
        ]

        kept, issues = helper(
            stack,
            visual_text_candidates=[
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
                (257, 490, 555, 529),
                (258, 580, 485, 616),
                (256, 675, 543, 711),
            ],
            source_image_size=(1672, 941),
        )

        self.assertEqual(kept, [])
        self.assertEqual(
            [issue["ocr_text"] for issue in issues],
            ["制动", "车窗", "调整坐姿 | 250mm", "拔充电枪后启动"],
        )

    def test_approximate_ocr_is_not_anchored_by_non_text_like_visual_candidates(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        text_boxes = [
            TextBoxSpec(
                text="非高压",
                source_pixel_bbox=(80, 130, 138, 179),
                source_pixel_polygon=((80, 130), (138, 130), (138, 179), (80, 179)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="日常操作",
                source_pixel_bbox=(150, 127, 339, 190),
                source_pixel_polygon=((150, 127), (339, 127), (339, 190), (150, 190)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
        ]

        kept, issues = helper(
            text_boxes,
            visual_text_candidates=[
                (80, 130, 138, 179),
                (150, 127, 339, 190),
                (294, 21, 1086, 77),
            ],
            source_image_size=(1672, 941),
        )

        self.assertEqual([box.text for box in kept], ["日常操作"])
        self.assertEqual([issue["ocr_text"] for issue in issues], ["非高压"])

    def test_approximate_ocr_is_not_anchored_by_broad_row_band_candidates(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        misplaced = TextBoxSpec(
            text="非高压",
            source_pixel_bbox=(80, 130, 138, 179),
            source_pixel_polygon=((80, 130), (138, 130), (138, 179), (80, 179)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        anchored = TextBoxSpec(
            text="日常操作",
            source_pixel_bbox=(150, 127, 339, 190),
            source_pixel_polygon=((150, 127), (339, 127), (339, 190), (150, 190)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )

        kept, issues = helper(
            [misplaced, anchored],
            visual_text_candidates=[
                (90, 137, 1026, 181),
                (150, 127, 339, 190),
                (294, 21, 1086, 77),
            ],
            source_image_size=(1672, 941),
        )

        self.assertEqual([box.text for box in kept], ["日常操作"])
        self.assertEqual([issue["ocr_text"] for issue in issues], ["非高压"])

    def test_right_side_spec_stack_approximate_ocr_survives_row_band_boundaries(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        boxes = [
            TextBoxSpec(
                text=text,
                source_pixel_bbox=bbox,
                source_pixel_polygon=(
                    (bbox[0], bbox[1]),
                    (bbox[2], bbox[1]),
                    (bbox[2], bbox[3]),
                    (bbox[0], bbox[3]),
                ),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            )
            for text, bbox in [
                ("核心架构设计：增程、底盘与智能域", (347, 51, 1330, 111)),
                ("智能域", (286, 247, 391, 282)),
                ("29英寸6K屏", (1291, 208, 1406, 230)),
                ("21英寸4K后舱屏", (1292, 240, 1448, 263)),
                ("5440W音响", (1292, 273, 1404, 295)),
                ("理想同学", (1291, 306, 1377, 328)),
                ("线控转向", (1250, 440, 1380, 467)),
                ("后轮转向", (1291, 473, 1380, 497)),
                ("空气悬架", (1292, 507, 1380, 530)),
                ("Livis版800V主动悬架", (1292, 540, 1502, 563)),
                ("EMB", (1292, 575, 1340, 595)),
                ("动力域", (274, 747, 379, 782)),
                ("第三代增程器", (1292, 732, 1437, 757)),
                ("72.7kWh 5C电池", (1292, 774, 1475, 799)),
            ]
        ]

        kept, issues = helper(
            boxes,
            visual_text_candidates=[
                (328, 36, 704, 126),
                (345, 50, 1086, 111),
                (555, 195, 598, 316),
                (1297, 203, 1411, 234),
                (1299, 235, 1411, 267),
                (285, 245, 391, 283),
                (1297, 268, 1409, 299),
                (1291, 301, 1383, 333),
                (750, 305, 807, 317),
                (999, 380, 1067, 544),
                (278, 497, 385, 536),
                (941, 683, 1075, 833),
                (299, 738, 376, 790),
                (1392, 772, 1431, 800),
            ],
            source_image_size=(1672, 941),
        )

        kept_text = {box.text for box in kept}
        self.assertIn("线控转向", kept_text)
        self.assertIn("后轮转向", kept_text)
        self.assertIn("Livis版800V主动悬架", kept_text)
        self.assertIn("EMB", kept_text)
        self.assertIn("第三代增程器", kept_text)
        self.assertNotIn("unanchored_approximate_ocr", {issue["code"] for issue in issues})

    def test_dense_approximate_ocr_drops_substantial_unanchored_text(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_filter_unanchored_approximate_text_boxes", None)
        self.assertIsNotNone(helper)

        right_panel_text = TextBoxSpec(
            text="调整坐姿 | 250mm",
            source_pixel_bbox=(1211, 404, 1548, 450),
            source_pixel_polygon=((1211, 404), (1548, 404), (1548, 450), (1211, 450)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        small_top_fragment = TextBoxSpec(
            text="OTA并级",
            source_pixel_bbox=(736, 131, 772, 153),
            source_pixel_polygon=((736, 131), (772, 131), (772, 153), (736, 153)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )

        kept, issues = helper(
            [right_panel_text, small_top_fragment],
            visual_text_candidates=[
                (279, 9, 551, 89),
                (609, 9, 693, 89),
                (775, 9, 1299, 89),
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
                (112, 468, 168, 513),
                (111, 647, 164, 675),
                (560, 789, 740, 879),
            ],
            source_image_size=(1672, 941),
        )

        self.assertEqual(kept, [])
        self.assertEqual(
            [issue["ocr_text"] for issue in issues],
            ["调整坐姿 | 250mm", "OTA并级"],
        )
        self.assertFalse(any(issue.get("kept") for issue in issues))

    def test_default_visual_text_candidate_detector_uses_local_image_hints(self):
        from PIL import Image, ImageDraw, ImageFont

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_pipeline import GenerativeEditablePipelineDependencies
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        font_path = Path("/System/Library/Fonts/STHeiti Medium.ttc")
        if not font_path.exists():
            self.skipTest("system CJK font unavailable")

        config = load_generative_editable_config(use_fake=True)
        dependencies = GenerativeEditablePipelineDependencies(
            ocr_provider=FakeOCRProvider(config.ocr),
            image_edit_provider=FakeImageEditProvider(config.clean_base_model),
            image_generation_provider=FakeImageGenerationProvider(config.generation_model),
        )
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            image = Image.new("RGB", (900, 300), "#030914")
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype(str(font_path), 34)
            draw.rounded_rectangle((70, 110, 830, 198), radius=12, fill="#0B2340")
            draw.text((155, 144), "底盘域", font=font, fill="#168BFF")
            image.save(image_path)

            candidates = dependencies.visual_text_candidate_detector(
                source_image_path=str(image_path),
                source_image_size=image.size,
                text_boxes=[],
            )

        self.assertTrue(candidates)

    def test_recovers_uncovered_visual_text_candidate_with_focused_crop_ocr(self):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_providers import OCRProvider, OCRResult, OCRTextItem

        helper = getattr(pipeline, "_recover_visual_text_candidates", None)
        self.assertIsNotNone(helper)

        class CropOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(107, 39),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="底盘域",
                            bbox=(0, 0, 107, 39),
                            polygon=((0, 0), (107, 0), (107, 39), (0, 39)),
                            confidence=0.93,
                            font_size_hint=13,
                            color_hex="#168BFF",
                        )
                    ],
                )

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            crop_dir = Path(tmp) / "crops"
            Image.new("RGB", (800, 450), "#030914").save(source)

            recovered = helper(
                source_image_path=source,
                source_image_size=(800, 450),
                text_boxes=[
                    TextBoxSpec(
                        text="智能域",
                        source_pixel_bbox=(278, 90, 385, 129),
                        source_pixel_polygon=((278, 90), (385, 90), (385, 129), (278, 129)),
                        font_size=12.05,
                        color_hex="#2E88F5",
                    )
                ],
                uncovered_candidates=[(278, 197, 385, 236)],
                ocr_provider=CropOCRProvider(
                    ProviderConfig(
                        role="ocr_model",
                        provider="test_ocr",
                        model="test",
                        base_url="",
                        api_key="",
                    )
                ),
                crop_dir=crop_dir,
            )

        self.assertEqual([box.text for box in recovered], ["底盘域"])
        self.assertEqual(recovered[0].source_pixel_bbox, (278, 197, 385, 236))
        self.assertEqual(recovered[0].font_size, 12.05)
        self.assertEqual(recovered[0].style_hints["recovered_from_visual_candidate"], True)

    def test_recovery_skips_text_fragment_already_covered_by_existing_title(self):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_providers import OCRProvider, OCRResult, OCRTextItem

        helper = getattr(pipeline, "_recover_visual_text_candidates", None)
        self.assertIsNotNone(helper)

        class FragmentOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(272, 80),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="落地建议：",
                            bbox=(0, 0, 272, 80),
                            polygon=((0, 0), (272, 0), (272, 80), (0, 80)),
                            confidence=0.91,
                            color_hex="#FFFFFF",
                        )
                    ],
                )

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            crop_dir = Path(tmp) / "crops"
            Image.new("RGB", (1672, 941), "#030914").save(source)
            ignored_candidates: set[tuple[int, int, int, int]] = set()

            recovered = helper(
                source_image_path=source,
                source_image_size=(1672, 941),
                text_boxes=[
                    TextBoxSpec(
                        text="落地建议：用车、补能与维护的最佳实践",
                        source_pixel_bbox=(296, 22, 1283, 76),
                        source_pixel_polygon=((296, 22), (1283, 22), (1283, 76), (296, 76)),
                        font_size=18.59,
                        color_hex="#F7F7F8",
                    )
                ],
                uncovered_candidates=[(279, 9, 551, 89)],
                ocr_provider=FragmentOCRProvider(
                    ProviderConfig(
                        role="ocr_model",
                        provider="test_ocr",
                        model="test",
                        base_url="",
                        api_key="",
                    )
                ),
                crop_dir=crop_dir,
                ignored_noise_candidates=ignored_candidates,
            )

        self.assertEqual(recovered, [])
        self.assertEqual(ignored_candidates, {(279, 9, 551, 89)})

    def test_recovery_dedupes_overlapping_recovered_candidates_in_same_batch(self):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_providers import OCRProvider, OCRResult, OCRTextItem

        helper = getattr(pipeline, "_recover_visual_text_candidates", None)
        self.assertIsNotNone(helper)

        class DuplicateOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(120, 40),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="日常操作",
                            bbox=(0, 0, 120, 40),
                            polygon=((0, 0), (120, 0), (120, 40), (0, 40)),
                            confidence=0.92,
                            color_hex="#FFFFFF",
                        )
                    ],
                )

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            crop_dir = Path(tmp) / "crops"
            Image.new("RGB", (800, 450), "#030914").save(source)
            ignored_candidates: set[tuple[int, int, int, int]] = set()

            recovered = helper(
                source_image_path=source,
                source_image_size=(800, 450),
                text_boxes=[],
                uncovered_candidates=[
                    (100, 100, 220, 140),
                    (104, 102, 224, 142),
                ],
                ocr_provider=DuplicateOCRProvider(
                    ProviderConfig(
                        role="ocr_model",
                        provider="test_ocr",
                        model="test",
                        base_url="",
                        api_key="",
                    )
                ),
                crop_dir=crop_dir,
                ignored_noise_candidates=ignored_candidates,
            )

        self.assertEqual([box.text for box in recovered], ["日常操作"])
        self.assertEqual(ignored_candidates, {(104, 102, 224, 142)})

    def test_recovery_rejects_repetitive_numeric_noise(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_best_recovered_ocr_item", None)
        self.assertIsNotNone(helper)

        item = OCRTextItem(
            text="1. 1. 1. 1. 1. 1. 1. 1. 1. 1.",
            bbox=(0, 0, 80, 24),
            polygon=((0, 0), (80, 0), (80, 24), (0, 24)),
            confidence=0.78,
        )

        self.assertIsNone(helper([item]))

    def test_recovery_rejects_repetitive_cjk_hallucination(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_best_recovered_ocr_item", None)
        self.assertIsNotNone(helper)

        item = OCRTextItem(
            text="2. 根据用户需求，根据需求，根据用户需求，根据需求，根据用户需求，根据用户需求，"
            * 4,
            bbox=(0, 0, 120, 62),
            polygon=((0, 0), (120, 0), (120, 62), (0, 62)),
            confidence=0.78,
        )

        self.assertIsNone(helper([item]))

    def test_recovery_rejects_short_repeated_cjk_noise_and_prompt_boilerplate(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_best_recovered_ocr_item", None)
        self.assertIsNotNone(helper)

        repeated = OCRTextItem(
            text="帮 帮 帮",
            bbox=(0, 0, 40, 24),
            polygon=((0, 0), (40, 0), (40, 24), (0, 24)),
            confidence=0.78,
        )
        boilerplate = OCRTextItem(
            text="2. 根据用户需求，设计一个符合用户需求、易用易操作的网站。",
            bbox=(0, 0, 240, 40),
            polygon=((0, 0), (240, 0), (240, 40), (0, 40)),
            confidence=0.78,
        )

        self.assertIsNone(helper([repeated]))
        self.assertIsNone(helper([boilerplate]))

    def test_recovery_rejects_repeated_symbol_noise(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_best_recovered_ocr_item", None)
        self.assertIsNotNone(helper)

        symbol_noise = OCRTextItem(
            text="🔥" * 80,
            bbox=(0, 0, 120, 32),
            polygon=((0, 0), (120, 0), (120, 32), (0, 32)),
            confidence=0.78,
        )

        self.assertIsNone(helper([symbol_noise]))

    def test_recovery_rejects_prompt_label_noise(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_best_recovered_ocr_item", None)
        self.assertIsNotNone(helper)

        prompt_label = OCRTextItem(
            text="1. 文本内容：",
            bbox=(0, 0, 160, 32),
            polygon=((0, 0), (160, 0), (160, 32), (0, 32)),
            confidence=0.78,
        )

        self.assertIsNone(helper([prompt_label]))

    def test_recovery_rejects_low_confidence_crop_ocr(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_best_recovered_ocr_item", None)
        self.assertIsNotNone(helper)

        low_confidence = OCRTextItem(
            text="总结与持续进化",
            bbox=(0, 0, 180, 36),
            polygon=((0, 0), (180, 0), (180, 36), (0, 36)),
            confidence=0.42,
        )

        self.assertIsNone(helper([low_confidence]))

    def test_recovered_summary_body_copy_font_size_is_capped_for_wrapped_text(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_providers import OCRTextItem

        helper = getattr(pipeline, "_recovered_text_box_from_candidate", None)
        self.assertIsNotNone(helper)

        text_box = helper(
            (418, 452, 1338, 501),
            OCRTextItem(
                text="增程架构重新定义豪华SUV，线控底盘与智能座舱建立新标杆；",
                bbox=(0, 0, 920, 113),
                polygon=((0, 0), (920, 0), (920, 113), (0, 113)),
                confidence=0.82,
                color_hex="#F8FAFC",
            ),
            source_image_size=(1672, 941),
            text_boxes=[],
        )

        self.assertLessEqual(text_box.font_size or 0, 22.0)

    def test_focused_recovery_uses_all_visual_text_candidates_when_ocr_only_hallucinates(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_focused_recovery_candidate_bboxes", None)
        self.assertIsNotNone(helper)

        visual_candidates = [
            (500, 210, 620, 260),
            (445, 464, 810, 507),
            (1411, 878, 1439, 905),
        ]
        text_issues = [
            {"code": "ignored_spurious_ocr", "ocr_text": "1. 了解用户需求"},
            {"code": "ignored_spurious_ocr", "ocr_text": "根据用户需求，设计一个符合用户需求" * 5},
        ]

        self.assertEqual(
            helper(
                text_boxes=[],
                text_issues=text_issues,
                visual_text_candidates=visual_candidates,
                quality_gate_candidates=[],
                source_image_size=(1672, 941),
            ),
            [
                (468, 207, 1204, 273),
                (451, 301, 1271, 433),
                (418, 452, 1338, 501),
                (502, 499, 1254, 565),
                (1354, 866, 1622, 922),
                *visual_candidates,
            ],
        )

    def test_summary_slide_recovery_body_copy_bboxes_cover_each_body_line(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_summary_slide_recovery_bboxes", None)
        self.assertIsNotNone(helper)

        bboxes = helper((1672, 941))

        self.assertIn((418, 452, 1338, 501), bboxes)
        self.assertIn((502, 499, 1254, 565), bboxes)
        self.assertNotIn((418, 452, 1338, 565), bboxes)
        self.assertNotIn((418, 452, 1304, 508), bboxes)

    def test_focused_recovery_does_not_add_summary_crops_for_dashboard_headings(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_focused_recovery_candidate_bboxes", None)
        self.assertIsNotNone(helper)

        visual_candidates = [
            (150, 127, 339, 190),
            (801, 127, 1037, 190),
        ]
        text_issues = [
            {"code": "ignored_spurious_ocr", "ocr_text": "随机无关文本"},
        ]

        self.assertEqual(
            helper(
                text_boxes=[],
                text_issues=text_issues,
                visual_text_candidates=visual_candidates,
                quality_gate_candidates=[],
                source_image_size=(1672, 941),
            ),
            visual_candidates,
        )

    def test_focused_recovery_does_not_use_summary_crops_for_cover_with_huge_candidate(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_focused_recovery_candidate_bboxes", None)
        self.assertIsNotNone(helper)

        visual_candidates = [
            (81, 66, 305, 102),
            (40, 404, 1672, 858),
            (261, 544, 339, 572),
            (157, 545, 257, 571),
        ]
        text_issues = [
            {"code": "ignored_spurious_ocr", "ocr_text": "基于增程系统消除长距离出行焦虑"},
            {"code": "ignored_spurious_ocr", "ocr_text": "72.7kWh 5C电池 | CLTC纯电续航420km"},
        ]

        self.assertEqual(
            helper(
                text_boxes=[],
                text_issues=text_issues,
                visual_text_candidates=visual_candidates,
                quality_gate_candidates=[],
                source_image_size=(1706, 960),
            ),
            [
                (81, 66, 305, 102),
                (261, 544, 339, 572),
                (157, 545, 257, 571),
            ],
        )

    def test_focused_recovery_keeps_quality_candidates_covered_only_by_approximate_ocr(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_focused_recovery_candidate_bboxes", None)
        self.assertIsNotNone(helper)

        text_boxes = [
            TextBoxSpec(
                text="驻车锁车",
                source_pixel_bbox=(92, 138, 327, 180),
                source_pixel_polygon=((92, 138), (327, 138), (327, 180), (92, 180)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="电量充足",
                source_pixel_bbox=(743, 138, 1025, 180),
                source_pixel_polygon=((743, 138), (1025, 138), (1025, 180), (743, 180)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
        ]

        recovered_candidates = helper(
            text_boxes=text_boxes,
            text_issues=[],
            visual_text_candidates=[
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
            ],
            quality_gate_candidates=[
                (150, 127, 339, 190),
                (801, 127, 1037, 190),
            ],
            source_image_size=(1672, 941),
        )

        self.assertEqual(recovered_candidates, [(150, 127, 339, 190), (801, 127, 1037, 190)])

    def test_focused_recovery_removes_overlapping_wrong_approximate_text_boxes(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(
            pipeline, "_remove_approximate_text_boxes_replaced_by_focused_recovery", None
        )
        self.assertIsNotNone(helper)

        original = [
            TextBoxSpec(
                text="驻车锁车",
                source_pixel_bbox=(92, 138, 327, 180),
                source_pixel_polygon=((92, 138), (327, 138), (327, 180), (92, 180)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="落地建议：用车、补能与维护的最佳实践",
                source_pixel_bbox=(296, 22, 1283, 76),
                source_pixel_polygon=((296, 22), (1283, 22), (1283, 76), (296, 76)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
        ]
        recovered = [
            TextBoxSpec(
                text="日常操作",
                source_pixel_bbox=(150, 127, 339, 190),
                source_pixel_polygon=((150, 127), (339, 127), (339, 190), (150, 190)),
                provenance={"content_source": "focused_crop_ocr"},
            )
        ]

        filtered = helper(original, recovered)

        self.assertEqual([box.text for box in filtered], ["落地建议：用车、补能与维护的最佳实践"])

    def test_focused_recovery_replaces_offset_approximate_text_in_same_visual_region(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(
            pipeline, "_remove_approximate_text_boxes_replaced_by_focused_recovery", None
        )
        self.assertIsNotNone(helper)

        original = [
            TextBoxSpec(
                text="高压事故",
                source_pixel_bbox=(1207, 578, 1525, 665),
                source_pixel_polygon=((1207, 578), (1525, 578), (1525, 665), (1207, 665)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="落地建议：用车、补能与维护的最佳实践",
                source_pixel_bbox=(296, 22, 1283, 76),
                source_pixel_polygon=((296, 22), (1283, 22), (1283, 76), (296, 76)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
        ]
        recovered = [
            TextBoxSpec(
                text="调整线路或现场处理",
                source_pixel_bbox=(1205, 490, 1525, 557),
                source_pixel_polygon=((1205, 490), (1525, 490), (1525, 557), (1205, 557)),
                provenance={"content_source": "focused_crop_ocr"},
            )
        ]

        filtered = helper(original, recovered)

        self.assertEqual([box.text for box in filtered], ["落地建议：用车、补能与维护的最佳实践"])

    def test_recovery_marks_noise_candidates_as_non_blocking(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_visual_text_coverage_issues", None)
        self.assertIsNotNone(helper)

        issues = helper(
            [],
            visual_text_candidates=[(251, 236, 330, 258)],
            non_blocking_visual_text_candidates={(251, 236, 330, 258)},
        )

        self.assertEqual(issues, [])

    def test_prefers_text_clean_background_when_base_clean_removes_complex_visuals(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_choose_text_clean_background", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            base_clean = root / "base-clean.png"
            text_clean = root / "text-clean.png"

            source_image = Image.new("RGB", (400, 240), "#020A18")
            draw = ImageDraw.Draw(source_image)
            draw.rounded_rectangle((120, 70, 280, 150), radius=12, fill="#586272")
            draw.text((24, 20), "Title", fill="#FFFFFF")
            source_image.save(source)

            Image.new("RGB", (400, 240), "#020A18").save(base_clean)
            text_clean_image = source_image.copy()
            ImageDraw.Draw(text_clean_image).rectangle((20, 18, 90, 42), fill="#020A18")
            text_clean_image.save(text_clean)

            choose_text_clean = helper(
                source_image_path=source,
                base_clean_image_path=base_clean,
                text_clean_image_path=text_clean,
                text_boxes=[
                    TextBoxSpec(
                        text="Title",
                        source_pixel_bbox=(20, 18, 90, 42),
                        source_pixel_polygon=((20, 18), (90, 18), (90, 42), (20, 42)),
                    )
                ],
            )

        self.assertTrue(choose_text_clean)

    def test_pipeline_chooses_text_clean_background_when_it_preserves_visuals_better(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            ImageEditProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
            FakeImageGenerationProvider,
        )

        class TitleOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="Title",
                            bbox=(20, 18, 90, 42),
                            polygon=((20, 18), (90, 18), (90, 42), (20, 42)),
                            confidence=0.96,
                        )
                    ],
                )

        class DivergentBackgroundEditProvider(ImageEditProvider):
            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                if request.prompt_id == "base_clean_background":
                    Image.new("RGB", (400, 240), "#020A18").save(output)
                else:
                    with Image.open(request.source_image_path) as source:
                        image = source.convert("RGB")
                    ImageDraw.Draw(image).rectangle((20, 18, 90, 42), fill="#020A18")
                    image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#020A18")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle((120, 70, 280, 150), radius=12, fill="#586272")
            draw.text((24, 20), "Title", fill="#FFFFFF")
            image.save(source)

            def fake_asset_builder(**kwargs):
                asset = BitmapAssetSpec(
                    asset_id="photo",
                    source_pixel_bbox=(120, 70, 280, 150),
                    asset_path="assets/0000-slide-a/photo.png",
                    z_order=1,
                )
                _write_test_asset(kwargs["asset_root"], asset.asset_path)
                return AssetBuildResult(bitmap_assets=[asset])

            run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=TitleOCRProvider(config.ocr),
                    image_edit_provider=DivergentBackgroundEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=lambda **kwargs: [],
                    asset_builder=fake_asset_builder,
                    visual_text_candidate_detector=lambda **kwargs: [],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

        self.assertEqual(page.chosen_background, "backgrounds/0000-slide-a/text-clean.png")

    def test_pipeline_keeps_reconstruction_background_when_generated_backgrounds_lose_visuals(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageGenerationProvider,
            ImageEditProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class LargeTitleOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="Architecture",
                            bbox=(20, 18, 220, 80),
                            polygon=((20, 18), (220, 18), (220, 80), (20, 80)),
                            confidence=0.96,
                        )
                    ],
                )

        class BadGeneratedBackgroundEditProvider(ImageEditProvider):
            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                if request.prompt_id == "base_clean_background":
                    Image.new("RGB", (400, 240), "#020A18").save(output)
                else:
                    Image.new("RGB", (400, 240), "#27496D").save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#020A18")
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 18, 220, 80), fill="#FFFFFF")
            draw.rounded_rectangle((120, 90, 280, 170), radius=12, fill="#586272")
            image.save(source)

            def fake_asset_builder(**kwargs):
                asset = BitmapAssetSpec(
                    asset_id="complex-visual",
                    source_pixel_bbox=(120, 90, 280, 170),
                    asset_path="assets/0000-slide-a/complex-visual.png",
                    z_order=1,
                )
                _write_test_asset(kwargs["asset_root"], asset.asset_path)
                return AssetBuildResult(bitmap_assets=[asset])

            run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=LargeTitleOCRProvider(config.ocr),
                    image_edit_provider=BadGeneratedBackgroundEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=lambda **kwargs: [],
                    asset_builder=fake_asset_builder,
                    visual_text_candidate_detector=lambda **kwargs: [],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

        self.assertEqual(page.chosen_background, "backgrounds/0000-slide-a/base-clean.png")
        self.assertNotEqual(
            page.provenance.get("chosen_background_kind"), "source_preserving_text_clean"
        )
        self.assertNotIn("source_preserving", page.provenance.get("backgrounds", {}))

    def test_pipeline_uses_source_raster_guardrail_when_approximate_ocr_layout_is_unreliable(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class UnreliableApproximateOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                items = [
                    OCRTextItem(
                        text="落地建议：用车、补能与维护的最佳实践",
                        bbox=(54, 20, 330, 60),
                        polygon=((54, 20), (330, 20), (330, 60), (54, 60)),
                        confidence=0.95,
                        provenance={},
                    ),
                    OCRTextItem(
                        text="核心架构设计：增程、底盘与智能域",
                        bbox=(20, 92, 380, 142),
                        polygon=((20, 92), (380, 92), (380, 142), (20, 142)),
                        confidence=0.9,
                        provenance={"layout_source": "uniform_fallback"},
                    ),
                ]
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=items,
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#03101F")
            draw = ImageDraw.Draw(image)
            draw.text((54, 24), "落地建议：用车、补能与维护的最佳实践", fill="#FFFFFF")
            draw.rectangle((20, 80, 180, 210), outline="#183B62")
            image.save(source)

            run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                fallback_policy="raster_pptx",
                fallback_output_factory=lambda: str(output_path),
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=UnreliableApproximateOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=lambda **kwargs: [],
                    asset_builder=lambda **kwargs: AssetBuildResult(bitmap_assets=[]),
                    visual_text_candidate_detector=lambda **kwargs: [],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

        self.assertEqual(
            page.chosen_background,
            "backgrounds/0000-slide-a/source-raster-background.png",
        )
        self.assertEqual(page.provenance["chosen_background_kind"], "source_raster_guardrail")
        self.assertEqual(page.text_boxes, [])
        self.assertIn("source_raster", page.provenance["backgrounds"])
        self.assertTrue(page.provenance["text_issues"])

    def test_pipeline_records_stage_events_for_provider_boundaries(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class SimpleOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="核心架构设计",
                            bbox=(54, 20, 220, 60),
                            polygon=((54, 20), (220, 20), (220, 60), (54, 60)),
                            confidence=0.95,
                        )
                    ],
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#03101F")
            draw = ImageDraw.Draw(image)
            draw.text((54, 24), "核心架构设计", fill="#FFFFFF")
            image.save(source)

            run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=SimpleOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=lambda **kwargs: [],
                    asset_builder=lambda **kwargs: AssetBuildResult(bitmap_assets=[]),
                    visual_text_candidate_detector=lambda **kwargs: [],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])
            stage_events = [
                json.loads(line)
                for line in (artifact_root / "job-1" / "stage-events.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        stages = [event["stage"] for event in stage_events]
        self.assertIn("ocr", stages)
        self.assertIn("text_mask", stages)
        self.assertIn("text_clean_background", stages)
        self.assertIn("base_clean_background", stages)
        self.assertTrue(all("status" in event for event in stage_events))

    def test_pipeline_source_raster_guardrail_does_not_call_image_edit_provider(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageGenerationProvider,
            ImageEditProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
            ProviderError,
        )

        class UnreliableApproximateOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                items = [
                    OCRTextItem(
                        text="落地建议：用车、补能与维护的最佳实践",
                        bbox=(54, 20, 330, 60),
                        polygon=((54, 20), (330, 20), (330, 60), (54, 60)),
                        confidence=0.95,
                        provenance={},
                    ),
                    OCRTextItem(
                        text="核心架构设计：增程、底盘与智能域",
                        bbox=(20, 92, 380, 142),
                        polygon=((20, 92), (380, 92), (380, 142), (20, 142)),
                        confidence=0.9,
                        provenance={"layout_source": "uniform_fallback"},
                    ),
                ]
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=items,
                )

        class FailingImageEditProvider(ImageEditProvider):
            def edit(self, request):
                raise ProviderError(
                    provider_role="edit_model",
                    operation=request.prompt_id,
                    message="image edit must not be called for source raster guardrail",
                    retryable=False,
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#03101F")
            draw = ImageDraw.Draw(image)
            draw.text((54, 24), "落地建议：用车、补能与维护的最佳实践", fill="#FFFFFF")
            image.save(source)

            run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                fallback_policy="raster_pptx",
                fallback_output_factory=lambda: str(output_path),
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=UnreliableApproximateOCRProvider(config.ocr),
                    image_edit_provider=FailingImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=lambda **kwargs: [],
                    asset_builder=lambda **kwargs: AssetBuildResult(bitmap_assets=[]),
                    visual_text_candidate_detector=lambda **kwargs: [],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

        self.assertEqual(page.provenance["chosen_background_kind"], "source_raster_guardrail")

    def test_pipeline_runs_reconstruction_for_dense_approximate_ocr_layout(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageGenerationProvider,
            ImageEditProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
            ProviderError,
        )

        class DenseApproximateOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="落地建议：用车、补能与维护",
                            bbox=(70, 18, 330, 52),
                            polygon=((70, 18), (330, 18), (330, 52), (70, 52)),
                            confidence=0.9,
                            provenance={"approximate_layout": True},
                        ),
                        OCRTextItem(
                            text="日常操作",
                            bbox=(50, 90, 160, 122),
                            polygon=((50, 90), (160, 90), (160, 122), (50, 122)),
                            confidence=0.9,
                            provenance={"approximate_layout": True},
                        ),
                        OCRTextItem(
                            text="补能与维护",
                            bbox=(240, 90, 360, 122),
                            polygon=((240, 90), (360, 90), (360, 122), (240, 122)),
                            confidence=0.9,
                            provenance={"approximate_layout": True},
                        ),
                    ],
                )

        class FailingImageEditProvider(ImageEditProvider):
            def edit(self, request):
                raise ProviderError(
                    provider_role="edit_model",
                    operation=request.prompt_id,
                    message="image edit should be called before any source-preserving fallback",
                    retryable=False,
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#03101F")
            draw = ImageDraw.Draw(image)
            draw.text((70, 22), "落地建议：用车、补能与维护", fill="#FFFFFF")
            draw.text((50, 94), "日常操作", fill="#FFFFFF")
            draw.text((240, 94), "补能与维护", fill="#FFFFFF")
            image.save(source)

            with self.assertRaises(ProviderError) as caught:
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=DenseApproximateOCRProvider(config.ocr),
                        image_edit_provider=FailingImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        foreground_planner=lambda **kwargs: [],
                        asset_builder=lambda **kwargs: AssetBuildResult(bitmap_assets=[]),
                        visual_text_candidate_detector=lambda **kwargs: [
                            (70, 18, 330, 52),
                            (50, 90, 160, 122),
                            (240, 90, 360, 122),
                            (40, 150, 140, 180),
                            (230, 150, 350, 180),
                            (40, 190, 140, 220),
                        ],
                        composer=fake_composer,
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                    ),
                )

        self.assertIn(
            caught.exception.operation, {"text_clean_background", "base_clean_background"}
        )

    def test_text_validation_marks_source_raster_guardrail_as_degraded(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_text_validation_report", None)
        self.assertIsNotNone(helper)

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(400, 240),
            slide_size=(10.0, 5.625),
            chosen_background="backgrounds/0000-slide-a/source-raster-background.png",
            provenance={
                "chosen_background_kind": "source_raster_guardrail",
                "text_validation_status": "degraded",
                "text_issues": [
                    {
                        "code": "ignored_spurious_ocr",
                        "severity": "warning",
                        "ocr_text": "重复噪声",
                    }
                ],
            },
        )

        report = helper(page)

        self.assertEqual(report.status, "failed")
        self.assertEqual(report.issues[0].code, "source_raster_guardrail_degraded")

    def test_bitmap_coverage_validation_fails_large_source_preserved_assets(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_bitmap_coverage_validation_report", None)
        self.assertIsNotNone(helper)

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(400, 240),
            slide_size=(10.0, 5.625),
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id="large-source-preserved",
                    source_pixel_bbox=(0, 0, 360, 220),
                    asset_path="assets/0000-slide-a/large.png",
                    z_order=1,
                    provenance={"asset_strategy": "masked_source_element"},
                )
            ],
            native_shapes=[],
            text_boxes=[],
        )

        report = helper(page)

        self.assertEqual(report.status, "failed")
        self.assertEqual(report.issues[0].code, "oversized_bitmap_asset_coverage")
        self.assertEqual(report.issues[0].details["largest_asset_id"], "large-source-preserved")

    def test_bitmap_coverage_validation_allows_split_row_level_complex_assets(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_bitmap_coverage_validation_report", None)
        self.assertIsNotNone(helper)

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(1706, 960),
            slide_size=(10.0, 5.625),
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id=f"row-{index}",
                    source_pixel_bbox=(59, top, 1672, bottom),
                    asset_path=f"assets/0000-slide-a/row-{index}.png",
                    z_order=index,
                    provenance={"asset_strategy": "masked_source_element"},
                )
                for index, (top, bottom) in enumerate(
                    [(168, 405), (405, 642), (642, 880)],
                    start=1,
                )
            ],
            native_shapes=[
                NativeShapeSpec(
                    shape_type="line",
                    source_pixel_bbox=(100, 180 + index * 30, 1500, 183 + index * 30),
                )
                for index in range(6)
            ],
            text_boxes=[
                TextBoxSpec(
                    text="智能域",
                    source_pixel_bbox=(160, 220, 260, 260),
                    source_pixel_polygon=((160, 220), (260, 220), (260, 260), (160, 260)),
                ),
                TextBoxSpec(
                    text="底盘域",
                    source_pixel_bbox=(160, 450, 260, 490),
                    source_pixel_polygon=((160, 450), (260, 450), (260, 490), (160, 490)),
                ),
                TextBoxSpec(
                    text="动力域",
                    source_pixel_bbox=(160, 680, 260, 720),
                    source_pixel_polygon=((160, 680), (260, 680), (260, 720), (160, 720)),
                ),
            ],
        )

        report = helper(page)

        self.assertEqual(report.status, "passed")
        self.assertEqual(report.issues, [])

    def test_bitmap_coverage_validation_allows_infographic_assets_with_dense_editable_structure(
        self,
    ):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_bitmap_coverage_validation_report", None)
        self.assertIsNotNone(helper)

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(1672, 941),
            slide_size=(10.0, 5.625),
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id="dominant-visual-band",
                    source_pixel_bbox=(0, 100, 1672, 720),
                    asset_path="assets/0000-slide-a/dominant.png",
                    z_order=1,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                        "alpha_visible_area_ratio": 0.53,
                    },
                ),
                BitmapAssetSpec(
                    asset_id="lower-visual",
                    source_pixel_bbox=(320, 650, 1200, 860),
                    asset_path="assets/0000-slide-a/lower.png",
                    z_order=2,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                        "alpha_visible_area_ratio": 0.08,
                    },
                ),
                BitmapAssetSpec(
                    asset_id="left-icon",
                    source_pixel_bbox=(120, 220, 240, 340),
                    asset_path="assets/0000-slide-a/left.png",
                    z_order=3,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                        "alpha_visible_area_ratio": 0.04,
                    },
                ),
                BitmapAssetSpec(
                    asset_id="right-icon",
                    source_pixel_bbox=(1380, 220, 1500, 340),
                    asset_path="assets/0000-slide-a/right.png",
                    z_order=4,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                        "alpha_visible_area_ratio": 0.07,
                    },
                ),
            ],
            native_shapes=[
                NativeShapeSpec(
                    shape_type="line",
                    source_pixel_bbox=(100, 200 + index * 40, 1500, 203 + index * 40),
                )
                for index in range(8)
            ],
            text_boxes=[
                TextBoxSpec(
                    text=f"规格 {index}",
                    source_pixel_bbox=(1200, 180 + index * 36, 1450, 205 + index * 36),
                    source_pixel_polygon=((1200, 180), (1450, 180), (1450, 205), (1200, 205)),
                )
                for index in range(10)
            ],
        )

        report = helper(page)

        self.assertEqual(report.status, "passed")
        self.assertEqual(report.issues, [])

    def test_bitmap_coverage_validation_uses_alpha_visible_area_for_transparent_source_assets(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_bitmap_coverage_validation_report", None)
        self.assertIsNotNone(helper)

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(1000, 600),
            slide_size=(10.0, 5.625),
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id="transparent-row-a",
                    source_pixel_bbox=(0, 80, 1000, 320),
                    asset_path="assets/0000-slide-a/row-a.png",
                    z_order=1,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                        "alpha_visible_area_ratio": 0.18,
                    },
                ),
                BitmapAssetSpec(
                    asset_id="transparent-row-b",
                    source_pixel_bbox=(0, 300, 1000, 560),
                    asset_path="assets/0000-slide-a/row-b.png",
                    z_order=2,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                        "alpha_visible_area_ratio": 0.17,
                    },
                ),
            ],
            native_shapes=[
                NativeShapeSpec(shape_type="line", source_pixel_bbox=(100, 100, 900, 104))
                for _ in range(6)
            ],
            text_boxes=[
                TextBoxSpec(
                    text="可编辑文本",
                    source_pixel_bbox=(100, 120, 240, 160),
                    source_pixel_polygon=((100, 120), (240, 120), (240, 160), (100, 160)),
                )
            ],
        )

        report = helper(page)

        self.assertEqual(report.status, "passed")
        self.assertEqual(report.issues, [])

    def test_pipeline_keeps_bitmap_assets_when_source_preserving_background_is_not_used(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageGenerationProvider,
            ImageEditProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class TitleOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(400, 240),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="Architecture",
                            bbox=(20, 18, 220, 80),
                            polygon=((20, 18), (220, 18), (220, 80), (20, 80)),
                            confidence=0.96,
                        )
                    ],
                )

        class BadGeneratedBackgroundEditProvider(ImageEditProvider):
            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                if request.prompt_id == "base_clean_background":
                    Image.new("RGB", (400, 240), "#020A18").save(output)
                else:
                    Image.new("RGB", (400, 240), "#27496D").save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_path = root / "deck.pptx"
            artifact_root = root / "jobs"
            image = Image.new("RGB", (400, 240), "#020A18")
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 18, 220, 80), fill="#FFFFFF")
            draw.rounded_rectangle((10, 84, 390, 232), radius=12, fill="#94A3B8")
            image.save(source)

            def fake_asset_builder(**kwargs):
                assets = [
                    BitmapAssetSpec(
                        asset_id="oversized-source",
                        source_pixel_bbox=(0, 80, 400, 138),
                        asset_path="assets/0000-slide-a/oversized-source.png",
                        z_order=1,
                        provenance={"asset_strategy": "masked_source_element"},
                    ),
                    BitmapAssetSpec(
                        asset_id="wide-transparent-source",
                        source_pixel_bbox=(0, 80, 400, 240),
                        asset_path="assets/0000-slide-a/wide-transparent-source.png",
                        z_order=2,
                        provenance={
                            "asset_strategy": "masked_source_element",
                            "background_difference_alpha": True,
                        },
                    ),
                    BitmapAssetSpec(
                        asset_id="small-icon",
                        source_pixel_bbox=(24, 88, 70, 134),
                        asset_path="assets/0000-slide-a/small-icon.png",
                        z_order=3,
                        provenance={
                            "asset_strategy": "masked_source_element",
                            "background_difference_alpha": True,
                        },
                    ),
                ]
                for asset in assets:
                    _write_test_asset(kwargs["asset_root"], asset.asset_path)
                return AssetBuildResult(bitmap_assets=assets)

            run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=TitleOCRProvider(config.ocr),
                    image_edit_provider=BadGeneratedBackgroundEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=lambda **kwargs: [],
                    asset_builder=fake_asset_builder,
                    visual_text_candidate_detector=lambda **kwargs: [],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

        self.assertNotEqual(
            page.provenance.get("chosen_background_kind"), "source_preserving_text_clean"
        )
        self.assertEqual(
            [asset.asset_id for asset in page.bitmap_assets], ["oversized-source", "small-icon"]
        )

    def test_diff_alpha_source_preserved_asset_is_not_treated_as_oversized_source_crop(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_is_oversized_source_preserved_asset", None)
        self.assertIsNotNone(helper)

        asset = BitmapAssetSpec(
            asset_id="wide-transparent-asset",
            source_pixel_bbox=(0, 80, 400, 240),
            asset_path="assets/0000-slide-a/wide-transparent-asset.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "background_difference_alpha": True,
            },
        )

        self.assertFalse(helper(asset, (400, 240)))

    def test_large_diff_alpha_asset_is_not_kept_as_overlay(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_bitmap_assets_for_clean_background", None)
        self.assertIsNotNone(helper)

        large_asset = BitmapAssetSpec(
            asset_id="large-diff-alpha",
            source_pixel_bbox=(40, 40, 160, 112),
            asset_path="assets/0000-slide-a/large.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "background_difference_alpha": True,
            },
        )
        small_asset = BitmapAssetSpec(
            asset_id="small-diff-alpha",
            source_pixel_bbox=(40, 40, 80, 80),
            asset_path="assets/0000-slide-a/small.png",
            z_order=2,
            provenance={
                "asset_strategy": "masked_source_element",
                "background_difference_alpha": True,
            },
        )

        kept = helper([large_asset, small_asset], (400, 240))

        self.assertEqual([asset.asset_id for asset in kept], ["small-diff-alpha"])

    def test_large_complex_whole_visual_diff_alpha_asset_is_kept_as_overlay(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_bitmap_assets_for_clean_background", None)
        self.assertIsNotNone(helper)

        complex_asset = BitmapAssetSpec(
            asset_id="complex-panel",
            source_pixel_bbox=(10, 20, 360, 180),
            asset_path="assets/0000-slide-a/complex-panel.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "background_difference_alpha": True,
                "candidate_classification": "complex_whole_visual",
            },
        )

        kept = helper([complex_asset], (400, 240))

        self.assertEqual([asset.asset_id for asset in kept], ["complex-panel"])

    def test_text_boxes_covered_by_complex_bitmap_assets_are_dropped(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_drop_text_boxes_covered_by_complex_bitmap_assets", None)
        self.assertIsNotNone(helper)

        title = TextBoxSpec(
            text="落地建议",
            source_pixel_bbox=(296, 22, 1283, 76),
            source_pixel_polygon=((296, 22), (1283, 22), (1283, 76), (296, 76)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        covered = TextBoxSpec(
            text="电量充足",
            source_pixel_bbox=(743, 138, 1025, 180),
            source_pixel_polygon=((743, 138), (1025, 138), (1025, 180), (743, 180)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        asset = BitmapAssetSpec(
            asset_id="complex-panel",
            source_pixel_bbox=(46, 77, 1627, 743),
            asset_path="assets/0000-slide-a/complex-panel.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "candidate_classification": "complex_whole_visual",
            },
        )

        filtered, issues = helper([title, covered], [asset])

        self.assertEqual([box.text for box in filtered], ["落地建议"])
        self.assertEqual(issues[0]["code"], "text_covered_by_complex_bitmap_asset")
        self.assertEqual(issues[0]["ocr_text"], "电量充足")

    def test_text_masked_complex_bitmap_does_not_drop_right_side_spec_text(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_drop_text_boxes_covered_by_complex_bitmap_assets", None)
        self.assertIsNotNone(helper)

        spec = TextBoxSpec(
            text="29英寸6K屏",
            source_pixel_bbox=(1291, 208, 1406, 230),
            source_pixel_polygon=((1291, 208), (1406, 208), (1406, 230), (1291, 230)),
            provenance={"ocr_provenance": {"approximate_layout": True}},
        )
        asset = BitmapAssetSpec(
            asset_id="text-masked-band",
            source_pixel_bbox=(94, 169, 1576, 413),
            asset_path="assets/0000-slide-a/text-masked-band.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "candidate_classification": "complex_whole_visual",
                "text_mask_applied": True,
                "background_difference_alpha": True,
            },
        )

        filtered, issues = helper([spec], [asset])

        self.assertEqual([box.text for box in filtered], ["29英寸6K屏"])
        self.assertEqual(issues, [])

    def test_exact_text_covered_by_opaque_complex_bitmap_asset_is_dropped(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_drop_text_boxes_covered_by_complex_bitmap_assets", None)
        self.assertIsNotNone(helper)

        exact_text = TextBoxSpec(
            text="Metadata title",
            source_pixel_bbox=(120, 100, 320, 150),
            source_pixel_polygon=((120, 100), (320, 100), (320, 150), (120, 150)),
            provenance={"content_source": "aippt_metadata", "layout_source": "aippt_metadata"},
        )
        asset = BitmapAssetSpec(
            asset_id="opaque-complex",
            source_pixel_bbox=(80, 60, 360, 200),
            asset_path="assets/0000-slide-a/opaque-complex.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "candidate_classification": "complex_whole_visual",
                "text_mask_applied": False,
                "background_difference_alpha": False,
            },
        )

        filtered, issues = helper([exact_text], [asset])

        self.assertEqual(filtered, [])
        self.assertEqual(issues[0]["code"], "text_covered_by_opaque_complex_bitmap_asset")
        self.assertEqual(issues[0]["ocr_text"], "Metadata title")

    def test_native_shapes_covered_by_complex_bitmap_assets_are_dropped(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_drop_native_shapes_covered_by_complex_bitmap_assets", None)
        self.assertIsNotNone(helper)

        outside = NativeShapeSpec(
            shape_type="line",
            source_pixel_bbox=(10, 10, 80, 12),
            line_start=(10, 10),
            line_end=(80, 12),
        )
        covered = NativeShapeSpec(
            shape_type="rounded_rectangle",
            source_pixel_bbox=(764, 493, 1067, 726),
            fill_color="#001332",
        )
        asset = BitmapAssetSpec(
            asset_id="complex-panel",
            source_pixel_bbox=(701, 111, 1625, 744),
            asset_path="assets/0000-slide-a/complex-panel.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "candidate_classification": "complex_whole_visual",
            },
        )

        filtered = helper([outside, covered], [asset])

        self.assertEqual(filtered, [outside])

    def test_native_shapes_are_not_dropped_by_transparent_complex_bitmap_assets(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_drop_native_shapes_covered_by_complex_bitmap_assets", None)
        self.assertIsNotNone(helper)

        panel = NativeShapeSpec(
            shape_type="rounded_rectangle",
            source_pixel_bbox=(80, 60, 360, 180),
            fill_color="#001332",
        )
        transparent_asset = BitmapAssetSpec(
            asset_id="transparent-complex",
            source_pixel_bbox=(40, 40, 400, 220),
            asset_path="assets/0000-slide-a/transparent-complex.png",
            z_order=1,
            provenance={
                "asset_strategy": "masked_source_element",
                "candidate_classification": "complex_whole_visual",
                "text_mask_applied": True,
                "background_difference_alpha": True,
            },
        )

        filtered = helper([panel], [transparent_asset])

        self.assertEqual(filtered, [panel])

    def test_structural_container_bitmap_candidate_is_dropped_when_native_shapes_cover_children(
        self,
    ):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (800, 450), "#050B16")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (40, 80, 760, 190), radius=18, fill="#0B2140", outline="#1D4ED8", width=3
            )
            draw.rounded_rectangle(
                (40, 220, 760, 330), radius=18, fill="#0B2140", outline="#1D4ED8", width=3
            )
            draw.line((120, 140, 700, 140), fill="#38BDF8", width=3)
            draw.line((120, 280, 700, 280), fill="#38BDF8", width=3)
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="large-container",
                        source_pixel_bbox=(30, 70, 770, 340),
                        area=740 * 270,
                        classification="complex_whole_visual",
                        confidence=0.86,
                        provenance={
                            "detection": "source_base_difference",
                            "reason": "large_or_visually_complex",
                        },
                    ),
                    ForegroundCandidate(
                        candidate_id="panel-1",
                        source_pixel_bbox=(40, 80, 760, 190),
                        area=720 * 110,
                        classification="native_shape_candidate",
                        confidence=0.94,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "rounded_rectangle",
                        },
                    ),
                    ForegroundCandidate(
                        candidate_id="panel-2",
                        source_pixel_bbox=(40, 220, 760, 330),
                        area=720 * 110,
                        classification="native_shape_candidate",
                        confidence=0.94,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "rounded_rectangle",
                        },
                    ),
                    ForegroundCandidate(
                        candidate_id="line-1",
                        source_pixel_bbox=(120, 138, 700, 143),
                        area=580 * 5,
                        classification="native_shape_candidate",
                        confidence=0.93,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "line",
                            "line_start": (120, 140),
                            "line_end": (700, 140),
                            "stroke_width": 3,
                        },
                    ),
                    ForegroundCandidate(
                        candidate_id="line-2",
                        source_pixel_bbox=(120, 278, 700, 283),
                        area=580 * 5,
                        classification="native_shape_candidate",
                        confidence=0.93,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "line",
                            "line_start": (120, 280),
                            "line_end": (700, 280),
                            "stroke_width": 3,
                        },
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertGreaterEqual(len(native_shapes), 4)
        self.assertNotIn(
            "large-container", [candidate.candidate_id for candidate in bitmap_candidates]
        )

    def test_structural_container_drop_accepts_many_native_children_with_quarter_coverage(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_is_structural_container_bitmap_candidate", None)
        self.assertIsNotNone(helper)

        candidate = ForegroundCandidate(
            candidate_id="right-panel-container",
            source_pixel_bbox=(700, 100, 1620, 720),
            area=920 * 620,
            classification="complex_whole_visual",
            provenance={
                "reason": "large_or_visually_complex",
                "original_detection": {"detection": "source_base_difference"},
            },
        )
        native_shapes = [
            NativeShapeSpec(
                shape_type="rounded_rectangle",
                source_pixel_bbox=(
                    720 + (index % 4) * 170,
                    120 + (index // 4) * 135,
                    720 + (index % 4) * 170 + 135,
                    120 + (index // 4) * 135 + 95,
                ),
                fill_color="#001332",
            )
            for index in range(12)
        ]

        self.assertTrue(helper(candidate, native_shapes=native_shapes))

    def test_source_preserving_background_choice_stays_disabled_for_large_diff_alpha_assets(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_choose_source_preserving_background", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            bad_base = root / "base-clean.png"
            bad_text = root / "text-clean.png"
            image = Image.new("RGB", (400, 240), "#020A18")
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 18, 220, 80), fill="#FFFFFF")
            draw.rounded_rectangle((10, 84, 390, 232), radius=12, fill="#94A3B8")
            image.save(source)
            Image.new("RGB", (400, 240), "#020A18").save(bad_base)
            Image.new("RGB", (400, 240), "#FFFFFF").save(bad_text)

            text_boxes = [
                TextBoxSpec(
                    text="Architecture",
                    source_pixel_bbox=(20, 18, 220, 80),
                    source_pixel_polygon=((20, 18), (220, 18), (220, 80), (20, 80)),
                )
            ]
            bitmap_assets = [
                BitmapAssetSpec(
                    asset_id="wide-transparent-asset",
                    source_pixel_bbox=(0, 80, 400, 240),
                    asset_path="assets/0000-slide-a/wide-transparent-asset.png",
                    z_order=1,
                    provenance={
                        "asset_strategy": "masked_source_element",
                        "background_difference_alpha": True,
                    },
                )
            ]

            choose = helper(
                source_image_path=source,
                chosen_background_image_path=bad_base,
                text_clean_image_path=bad_text,
                text_boxes=text_boxes,
                native_shapes=[],
                bitmap_assets=bitmap_assets,
                source_image_size=(400, 240),
            )

        self.assertFalse(choose)

    def test_generic_visual_anchors_are_added_as_complex_bitmap_candidates(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (800, 450), "#000105")
            draw = ImageDraw.Draw(image)
            draw.rectangle((260, 110, 520, 210), fill="#0b64ff")
            draw.ellipse((300, 125, 365, 190), fill="#dbeafe")
            draw.rectangle((390, 135, 500, 185), fill="#111827")
            draw.text((45, 120), "智能域", fill="#ffffff")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="智能域",
                    source_pixel_bbox=(40, 112, 125, 145),
                    source_pixel_polygon=((40, 112), (125, 112), (125, 145), (40, 145)),
                )
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                max_assets=3,
                max_area_ratio=0.12,
            )

        generic = [
            candidate
            for candidate in augmented
            if candidate.provenance["detection"] == "source_generic_visual_anchor"
        ]
        self.assertEqual(len(generic), 1)
        self.assertEqual(generic[0].classification, "complex_whole_visual")
        self.assertGreaterEqual(generic[0].source_pixel_bbox[0], 240)
        self.assertLessEqual(generic[0].source_pixel_bbox[2], 540)

    def test_generic_visual_anchor_allows_larger_assets_for_structural_band_pages(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (800, 450), "#000105")
            draw = ImageDraw.Draw(image)
            draw.rectangle((250, 125, 650, 320), fill="#334155")
            draw.ellipse((280, 150, 390, 260), fill="#CBD5E1")
            draw.rectangle((440, 160, 610, 280), fill="#111827")
            draw.text((45, 205), "底盘域", fill="#ffffff")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="底盘域",
                    source_pixel_bbox=(40, 198, 125, 235),
                    source_pixel_polygon=((40, 198), (125, 198), (125, 235), (40, 235)),
                )
            ]
            native_shapes = [
                NativeShapeSpec(
                    shape_type="rounded_rectangle",
                    source_pixel_bbox=(0, 110, 800, 340),
                    fill_color="#0B2140",
                    provenance={"detection": "split_edge_spanning_difference"},
                )
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                native_shapes=native_shapes,
                max_assets=3,
            )

        generic = [
            candidate
            for candidate in augmented
            if candidate.provenance["detection"] == "source_generic_visual_anchor"
        ]
        self.assertEqual(len(generic), 1)
        area_ratio = (
            (generic[0].source_pixel_bbox[2] - generic[0].source_pixel_bbox[0])
            * (generic[0].source_pixel_bbox[3] - generic[0].source_pixel_bbox[1])
            / float(800 * 450)
        )
        self.assertGreater(area_ratio, 0.10)

    def test_generic_visual_anchors_are_not_added_for_cover_title_slides(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (800, 450), "#000105")
            draw = ImageDraw.Draw(image)
            draw.rectangle((190, 245, 710, 385), fill="#0b64ff")
            draw.line((0, 365, 800, 315), fill="#A855F7", width=12)
            draw.text((30, 80), "理想 L9:", fill="#ffffff")
            draw.text((30, 145), "旗舰增程 SUV 的技术实验", fill="#ffffff")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="理想L9:",
                    source_pixel_bbox=(28, 76, 210, 125),
                    source_pixel_polygon=((28, 76), (210, 76), (210, 125), (28, 125)),
                ),
                TextBoxSpec(
                    text="旗舰增程 SUV 的技术实验",
                    source_pixel_bbox=(28, 142, 470, 196),
                    source_pixel_polygon=((28, 142), (470, 142), (470, 196), (28, 196)),
                ),
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                max_assets=3,
                max_area_ratio=0.12,
            )

        self.assertEqual(augmented, [])

    def test_generic_visual_anchors_are_added_for_cover_title_slides_with_lower_visuals(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (800, 450), "#020813")
            draw = ImageDraw.Draw(image)
            draw.rectangle((45, 285, 330, 410), fill="#D1D5DB")
            draw.rectangle((90, 315, 260, 370), fill="#111827")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="总结与持续进化",
                    source_pixel_bbox=(245, 118, 650, 190),
                    source_pixel_polygon=((245, 118), (650, 118), (650, 190), (245, 190)),
                ),
                TextBoxSpec(
                    text="续航无忧 全时防护 持续进化",
                    source_pixel_bbox=(260, 70, 640, 105),
                    source_pixel_polygon=((260, 70), (640, 70), (640, 105), (260, 105)),
                ),
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                max_assets=3,
                max_area_ratio=0.12,
            )

        self.assertTrue(
            any(
                candidate.provenance["detection"] == "source_generic_visual_anchor"
                for candidate in augmented
            )
        )

    def test_generic_visual_anchors_are_added_for_cover_title_slides_with_wide_lower_photo(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (900, 506), "#020813")
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 300, 900, 506), fill="#1F2937")
            draw.line((0, 450, 900, 350), fill="#F8FAFC", width=10)
            draw.rectangle((40, 345, 310, 460), fill="#CBD5E1")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="总结与持续进化",
                    source_pixel_bbox=(260, 118, 650, 190),
                    source_pixel_polygon=((260, 118), (650, 118), (650, 190), (260, 190)),
                )
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                max_assets=3,
                max_area_ratio=0.12,
            )

        self.assertTrue(
            any(
                candidate.provenance["detection"] == "source_generic_visual_anchor"
                for candidate in augmented
            )
        )

    def test_cover_title_slide_adds_wide_lower_source_visual_anchor(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (900, 506), "#020813")
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 280, 900, 506), fill="#111827")
            draw.rectangle((0, 330, 340, 500), fill="#1F2937")
            draw.ellipse((60, 425, 145, 505), fill="#CBD5E1")
            draw.ellipse((260, 425, 345, 505), fill="#CBD5E1")
            draw.rectangle((735, 360, 850, 475), fill="#F8FAFC")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="总结与持续进化",
                    source_pixel_bbox=(240, 118, 660, 190),
                    source_pixel_polygon=((240, 118), (660, 118), (660, 190), (240, 190)),
                ),
                TextBoxSpec(
                    text="官方帮助中心 OTA更新说明",
                    source_pixel_bbox=(720, 475, 870, 500),
                    source_pixel_polygon=((720, 475), (870, 475), (870, 500), (720, 500)),
                ),
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                max_assets=8,
                max_area_ratio=0.12,
            )

        lower_anchors = [
            candidate
            for candidate in augmented
            if candidate.provenance["detection"] == "cover_title_lower_visual_anchor"
        ]
        self.assertEqual(len(lower_anchors), 1)
        lower_bbox = lower_anchors[0].source_pixel_bbox
        self.assertLessEqual(lower_bbox[0], 20)
        self.assertGreaterEqual(lower_bbox[2], 880)
        self.assertLessEqual(lower_bbox[1], 300)
        self.assertGreaterEqual(lower_bbox[3], 500)

    def test_cover_title_slide_does_not_add_lower_anchor_for_top_ota_marker_only(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_augment_bitmap_candidates_with_generic_visual_anchors", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            image = Image.new("RGB", (900, 506), "#020813")
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 300, 900, 506), fill="#111827")
            draw.rectangle((40, 345, 310, 460), fill="#CBD5E1")
            image.save(source)

            text_boxes = [
                TextBoxSpec(
                    text="OTA升级体验",
                    source_pixel_bbox=(260, 80, 640, 120),
                    source_pixel_polygon=((260, 80), (640, 80), (640, 120), (260, 120)),
                ),
                TextBoxSpec(
                    text="总结与持续进化",
                    source_pixel_bbox=(260, 150, 650, 220),
                    source_pixel_polygon=((260, 150), (650, 150), (650, 220), (260, 220)),
                ),
            ]

            augmented = helper(
                [],
                source_image_path=str(source),
                text_boxes=text_boxes,
                max_assets=8,
                max_area_ratio=0.12,
            )

        self.assertFalse(
            any(
                candidate.provenance["detection"] == "cover_title_lower_visual_anchor"
                for candidate in augmented
            )
        )

    def test_generic_visual_anchor_source_asset_uses_background_alpha(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_build_masked_source_element_assets", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            background = root / "background.png"
            output_dir = root / "assets"

            source_image = Image.new("RGB", (120, 80), "#001020")
            draw = ImageDraw.Draw(source_image)
            draw.rectangle((34, 24, 86, 56), fill="#dbeafe")
            source_image.save(source)
            Image.new("RGB", (120, 80), "#001020").save(background)

            assets = helper(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="generic-visual-001",
                        source_pixel_bbox=(20, 12, 100, 68),
                        area=80 * 56,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_generic_visual_anchor"},
                    )
                ],
                source_image_path=str(source),
                background_image_path=background,
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

            asset_path = root / assets[0].asset_path
            with Image.open(asset_path).convert("RGBA") as asset_image:
                alpha_extrema = asset_image.getchannel("A").getextrema()

        self.assertEqual(assets[0].provenance["background_difference_alpha"], True)
        self.assertEqual(assets[0].source_pixel_bbox, (34, 24, 87, 57))
        self.assertEqual(alpha_extrema, (255, 255))
        self.assertEqual(assets[0].provenance["trimmed_transparent_bounds"], True)

    def test_masked_source_element_asset_bbox_is_trimmed_to_visible_alpha(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_build_masked_source_element_assets", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            background = root / "background.png"
            output_dir = root / "assets"

            Image.new("RGB", (120, 80), "#001020").save(background)
            source_image = Image.new("RGB", (120, 80), "#001020")
            draw = ImageDraw.Draw(source_image)
            draw.rectangle((44, 30, 66, 44), fill="#dbeafe")
            source_image.save(source)

            assets = helper(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="generic-visual-001",
                        source_pixel_bbox=(20, 12, 100, 68),
                        area=80 * 56,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_generic_visual_anchor"},
                    )
                ],
                source_image_path=str(source),
                background_image_path=background,
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

            with Image.open(root / assets[0].asset_path).convert("RGBA") as asset_image:
                size = asset_image.size
                alpha_extrema = asset_image.getchannel("A").getextrema()

        self.assertEqual(assets[0].source_pixel_bbox, (44, 30, 67, 45))
        self.assertEqual(size, (23, 15))
        self.assertEqual(alpha_extrema, (255, 255))
        self.assertEqual(assets[0].provenance["trimmed_transparent_bounds"], True)

    def test_source_base_difference_large_complex_visual_uses_alpha_trim(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_build_masked_source_element_assets", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            background = root / "background.png"
            output_dir = root / "assets"
            Image.new("RGB", (200, 120), "#061020").save(background)
            source_image = Image.new("RGB", (200, 120), "#061020")
            draw = ImageDraw.Draw(source_image)
            draw.rounded_rectangle(
                (40, 30, 160, 90), radius=10, fill="#0B2140", outline="#1D4ED8", width=2
            )
            draw.rectangle((86, 50, 116, 70), fill="#DCEAFE")
            source_image.save(source)

            assets = helper(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="large-diff",
                        source_pixel_bbox=(20, 20, 180, 100),
                        area=160 * 80,
                        classification="complex_whole_visual",
                        provenance={
                            "reason": "large_or_visually_complex",
                            "original_detection": {"detection": "source_base_difference"},
                        },
                    )
                ],
                source_image_path=str(source),
                background_image_path=background,
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

        self.assertEqual(assets[0].provenance["background_difference_alpha"], True)
        self.assertEqual(assets[0].provenance["trimmed_transparent_bounds"], True)
        self.assertLess((assets[0].source_pixel_bbox[2] - assets[0].source_pixel_bbox[0]), 160)

    def test_edge_spanning_diff_candidate_is_split_into_complex_visual_bands(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_expand_edge_spanning_bitmap_candidates", None)
        self.assertIsNotNone(helper)

        expanded = helper(
            [
                ForegroundCandidate(
                    candidate_id="fg-wide",
                    source_pixel_bbox=(0, 150, 1600, 920),
                    area=1600 * 770,
                    classification="complex_whole_visual",
                    provenance={"detection": "source_base_difference"},
                )
            ],
            source_size=(1600, 940),
        )

        self.assertEqual(
            [candidate.candidate_id for candidate in expanded],
            ["fg-wide-band-1", "fg-wide-band-2", "fg-wide-band-3"],
        )
        self.assertTrue(
            all(candidate.classification == "complex_whole_visual" for candidate in expanded)
        )
        self.assertEqual(expanded[0].provenance["detection"], "split_edge_spanning_difference")
        self.assertEqual(expanded[0].provenance["parent_candidate_id"], "fg-wide")

    def test_large_layered_diff_candidate_is_split_into_row_level_bitmap_bands(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_expand_edge_spanning_bitmap_candidates", None)
        self.assertIsNotNone(helper)

        expanded = helper(
            [
                ForegroundCandidate(
                    candidate_id="fg-layered",
                    source_pixel_bbox=(59, 168, 1672, 880),
                    area=1613 * 712,
                    classification="complex_whole_visual",
                    provenance={"detection": "source_base_difference"},
                )
            ],
            source_size=(1706, 960),
        )

        self.assertEqual(
            [candidate.candidate_id for candidate in expanded],
            ["fg-layered-band-1", "fg-layered-band-2", "fg-layered-band-3"],
        )
        self.assertTrue(
            all(
                candidate.provenance["detection"] == "split_large_layered_difference"
                for candidate in expanded
            )
        )
        self.assertLess(
            max(candidate.area for candidate in expanded) / float(1706 * 960),
            0.35,
        )

    def test_large_layered_diff_candidate_with_low_bottom_margin_is_split(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_foreground_planner import ForegroundCandidate

        helper = getattr(pipeline, "_expand_edge_spanning_bitmap_candidates", None)
        self.assertIsNotNone(helper)

        expanded = helper(
            [
                ForegroundCandidate(
                    candidate_id="fg-layered-low",
                    source_pixel_bbox=(53, 170, 1660, 918),
                    area=1607 * 748,
                    classification="complex_whole_visual",
                    provenance={"detection": "source_base_difference"},
                )
            ],
            source_size=(1706, 960),
        )

        self.assertEqual(
            [candidate.candidate_id for candidate in expanded],
            ["fg-layered-low-band-1", "fg-layered-low-band-2", "fg-layered-low-band-3"],
        )

    def test_reconstruction_targets_promote_edge_spanning_bands_to_native_shapes(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1600, 940), "#020817")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (0, 150, 1600, 405), radius=22, fill="#0B2140", outline="#1D4ED8", width=3
            )
            draw.rounded_rectangle(
                (0, 405, 1600, 660), radius=22, fill="#0B2140", outline="#1D4ED8", width=3
            )
            draw.rounded_rectangle(
                (0, 660, 1600, 920), radius=22, fill="#0B2140", outline="#1D4ED8", width=3
            )
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="fg-wide",
                        source_pixel_bbox=(0, 150, 1600, 920),
                        area=1600 * 770,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    )
                ],
                source_image_path=str(source),
            )

        promoted = [
            shape
            for shape in native_shapes
            if shape.provenance.get("detection") == "split_edge_spanning_difference"
        ]
        self.assertEqual(len(promoted), 3)
        self.assertTrue(all(shape.shape_type == "rounded_rectangle" for shape in promoted))
        self.assertTrue(all(shape.opacity == 0.15 for shape in promoted))
        self.assertFalse(
            any(
                candidate.candidate_id.startswith("fg-wide-band-")
                for candidate in bitmap_candidates
            )
        )

    def test_reconstruction_targets_promote_large_card_containers_to_native_shapes(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1000, 600), "#020817")
            draw = ImageDraw.Draw(image)
            for offset in range(0, 390):
                color = f"#{6 + offset % 18:02x}{19 + offset % 22:02x}{43 + offset % 30:02x}"
                draw.line((30, 80 + offset, 410, 80 + offset), fill=color)
                draw.line((430, 80 + offset, 970, 80 + offset), fill=color)
            draw.rounded_rectangle((30, 80, 410, 470), radius=18, outline="#1D4ED8", width=3)
            draw.rounded_rectangle((430, 80, 970, 470), radius=18, outline="#1D4ED8", width=3)
            draw.rectangle((85, 170, 150, 230), fill="#DCEAFE")
            draw.rectangle((245, 300, 330, 350), fill="#DCEAFE")
            draw.rectangle((545, 175, 650, 235), fill="#DCEAFE")
            draw.rectangle((750, 315, 870, 375), fill="#DCEAFE")
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="left-card",
                        source_pixel_bbox=(30, 80, 410, 470),
                        area=380 * 390,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="right-card",
                        source_pixel_bbox=(430, 80, 970, 470),
                        area=540 * 390,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="left-icon",
                        source_pixel_bbox=(85, 170, 150, 230),
                        area=65 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="left-row",
                        source_pixel_bbox=(245, 300, 330, 350),
                        area=85 * 50,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="right-icon",
                        source_pixel_bbox=(545, 175, 650, 235),
                        area=105 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="right-row",
                        source_pixel_bbox=(750, 315, 870, 375),
                        area=120 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        promoted = [
            shape
            for shape in native_shapes
            if shape.provenance.get("fitter") == "large_card_container"
        ]
        self.assertEqual(
            [shape.provenance.get("parent_candidate_id") for shape in promoted],
            ["left-card", "right-card"],
        )
        self.assertFalse(
            any(
                candidate.candidate_id in {"left-card", "right-card"}
                for candidate in bitmap_candidates
            )
        )
        self.assertTrue(
            any(candidate.candidate_id == "left-icon" for candidate in bitmap_candidates)
        )

    def test_reconstruction_targets_do_not_promote_unframed_screenshot_as_card_container(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1000, 600), "#020817")
            draw = ImageDraw.Draw(image)
            for y in range(100, 450):
                for x in range(120, 700):
                    red = (x * 7 + y * 3) % 255
                    green = (x * 5 + y * 11) % 255
                    blue = (x * 13 + y * 17) % 255
                    draw.point((x, y), fill=(red, green, blue))
            draw.rectangle((220, 190, 300, 250), fill="#DCEAFE")
            draw.rectangle((455, 305, 560, 365), fill="#DCEAFE")
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="screenshot",
                        source_pixel_bbox=(120, 100, 700, 450),
                        area=580 * 350,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="screenshot-region-a",
                        source_pixel_bbox=(220, 190, 300, 250),
                        area=80 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="screenshot-region-b",
                        source_pixel_bbox=(455, 305, 560, 365),
                        area=105 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertFalse(
            any(
                shape.provenance.get("parent_candidate_id") == "screenshot"
                for shape in native_shapes
            )
        )
        self.assertTrue(
            any(candidate.candidate_id == "screenshot" for candidate in bitmap_candidates)
        )

    def test_reconstruction_targets_promote_large_card_container_with_native_children(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1000, 600), "#020817")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (40, 90, 450, 480), radius=18, fill="#071B36", outline="#1D4ED8", width=3
            )
            draw.line((80, 210, 410, 210), fill="#94A3B8", width=3)
            draw.line((80, 330, 410, 330), fill="#94A3B8", width=3)
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="left-card",
                        source_pixel_bbox=(40, 90, 450, 480),
                        area=410 * 390,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="row-line-a",
                        source_pixel_bbox=(80, 208, 410, 213),
                        area=330 * 5,
                        classification="native_shape_candidate",
                        confidence=0.98,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "line",
                            "line_start": (80, 210),
                            "line_end": (410, 210),
                            "stroke_width": 3,
                        },
                    ),
                    ForegroundCandidate(
                        candidate_id="row-line-b",
                        source_pixel_bbox=(80, 328, 410, 333),
                        area=330 * 5,
                        classification="native_shape_candidate",
                        confidence=0.98,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "line",
                            "line_start": (80, 330),
                            "line_end": (410, 330),
                            "stroke_width": 3,
                        },
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertTrue(
            any(
                shape.provenance.get("parent_candidate_id") == "left-card"
                for shape in native_shapes
            )
        )
        self.assertFalse(
            any(candidate.candidate_id == "left-card" for candidate in bitmap_candidates)
        )

    def test_reconstruction_targets_promote_card_container_when_candidate_is_trimmed_inside_border(
        self,
    ):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1000, 600), "#020817")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (40, 90, 450, 480), radius=18, fill="#071B36", outline="#1D4ED8", width=3
            )
            draw.line((80, 210, 410, 210), fill="#94A3B8", width=3)
            draw.line((80, 330, 410, 330), fill="#94A3B8", width=3)
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="trimmed-card",
                        source_pixel_bbox=(48, 100, 438, 458),
                        area=390 * 358,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="row-line-a",
                        source_pixel_bbox=(80, 208, 410, 213),
                        area=330 * 5,
                        classification="native_shape_candidate",
                        confidence=0.98,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "line",
                            "line_start": (80, 210),
                            "line_end": (410, 210),
                            "stroke_width": 3,
                        },
                    ),
                    ForegroundCandidate(
                        candidate_id="row-line-b",
                        source_pixel_bbox=(80, 328, 410, 333),
                        area=330 * 5,
                        classification="native_shape_candidate",
                        confidence=0.98,
                        provenance={
                            "detection": "source_native_shape_scan",
                            "shape_hint": "line",
                            "line_start": (80, 330),
                            "line_end": (410, 330),
                            "stroke_width": 3,
                        },
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertTrue(
            any(
                shape.provenance.get("parent_candidate_id") == "trimmed-card"
                for shape in native_shapes
            )
        )
        self.assertFalse(
            any(candidate.candidate_id == "trimmed-card" for candidate in bitmap_candidates)
        )

    def test_reconstruction_targets_do_not_promote_framed_high_texture_screenshot(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1000, 600), "#020817")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (120, 100, 700, 450), radius=18, fill="#071B36", outline="#1D4ED8", width=3
            )
            for y in range(120, 430):
                for x in range(145, 675):
                    red = (x * 7 + y * 3) % 255
                    green = (x * 5 + y * 11) % 255
                    blue = (x * 13 + y * 17) % 255
                    draw.point((x, y), fill=(red, green, blue))
            draw.rectangle((220, 190, 300, 250), fill="#DCEAFE")
            draw.rectangle((455, 305, 560, 365), fill="#DCEAFE")
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="framed-screenshot",
                        source_pixel_bbox=(120, 100, 700, 450),
                        area=580 * 350,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="screenshot-region-a",
                        source_pixel_bbox=(220, 190, 300, 250),
                        area=80 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="screenshot-region-b",
                        source_pixel_bbox=(455, 305, 560, 365),
                        area=105 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertFalse(
            any(
                shape.provenance.get("parent_candidate_id") == "framed-screenshot"
                for shape in native_shapes
            )
        )
        self.assertTrue(
            any(candidate.candidate_id == "framed-screenshot" for candidate in bitmap_candidates)
        )

    def test_reconstruction_targets_do_not_promote_nested_screenshot_inside_card_container(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (1000, 600), "#020817")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (100, 90, 850, 450), radius=18, fill="#071B36", outline="#1D4ED8", width=3
            )
            for y in range(140, 390):
                for x in range(260, 760):
                    red = (x * 7 + y * 3) % 255
                    green = (x * 5 + y * 11) % 255
                    blue = (x * 13 + y * 17) % 255
                    draw.point((x, y), fill=(red, green, blue))
            draw.rectangle((330, 205, 410, 265), fill="#DCEAFE")
            draw.rectangle((600, 305, 720, 365), fill="#DCEAFE")
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="outer-card",
                        source_pixel_bbox=(100, 90, 850, 450),
                        area=750 * 360,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="inner-screenshot",
                        source_pixel_bbox=(260, 140, 760, 390),
                        area=500 * 250,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="inner-region-a",
                        source_pixel_bbox=(330, 205, 410, 265),
                        area=80 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="inner-region-b",
                        source_pixel_bbox=(600, 305, 720, 365),
                        area=120 * 60,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertTrue(
            any(
                shape.provenance.get("parent_candidate_id") == "outer-card"
                for shape in native_shapes
            )
        )
        self.assertFalse(
            any(
                shape.provenance.get("parent_candidate_id") == "inner-screenshot"
                for shape in native_shapes
            )
        )
        self.assertTrue(
            any(candidate.candidate_id == "inner-screenshot" for candidate in bitmap_candidates)
        )

    def test_domain_row_visual_anchor_bboxes_use_space_between_label_and_specs(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_domain_row_visual_anchor_bboxes", None)
        self.assertIsNotNone(helper)

        bboxes = helper(
            [
                TextBoxSpec(
                    text="动力域",
                    source_pixel_bbox=(274, 747, 379, 782),
                    source_pixel_polygon=((274, 747), (379, 747), (379, 782), (274, 782)),
                ),
                TextBoxSpec(
                    text="72.7kWh 5C电池",
                    source_pixel_bbox=(1292, 774, 1475, 799),
                    source_pixel_polygon=((1292, 774), (1475, 774), (1475, 799), (1292, 799)),
                ),
            ],
            source_size=(1672, 941),
        )

        self.assertEqual(len(bboxes), 1)
        left, top, right, bottom = bboxes[0]
        self.assertGreater(left, 379)
        self.assertLess(right, 1292)
        self.assertLess(top, 747)
        self.assertGreater(bottom, 782)

    def test_domain_row_visual_anchor_bboxes_require_right_side_specs(self):
        import src.generative_editable_pipeline as pipeline
        from src.generative_editable_text import TextBoxSpec

        helper = getattr(pipeline, "_domain_row_visual_anchor_bboxes", None)
        self.assertIsNotNone(helper)

        bboxes = helper(
            [
                TextBoxSpec(
                    text="业务域",
                    source_pixel_bbox=(120, 220, 220, 260),
                    source_pixel_polygon=((120, 220), (220, 220), (220, 260), (120, 260)),
                )
            ],
            source_size=(1200, 675),
        )

        self.assertEqual(bboxes, [])

    def test_source_preserving_background_drops_native_overlays(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_native_shapes_for_source_preserving_background", None)
        self.assertIsNotNone(helper)

        native_shapes = [
            NativeShapeSpec(
                shape_type="rounded_rectangle",
                source_pixel_bbox=(120, 80, 260, 150),
                fill_color="#000000",
                radius=12,
                provenance={"candidate_id": "source-native-001"},
            ),
            NativeShapeSpec(
                shape_type="line",
                source_pixel_bbox=(300, 120, 360, 124),
                line_color="#000000",
                line_start=(300, 122),
                line_end=(360, 122),
                stroke_width=4,
                provenance={"candidate_id": "fg-001"},
            ),
        ]

        self.assertEqual(helper(native_shapes), [])

    def test_oversized_native_shapes_are_dropped(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_drop_oversized_native_shapes", None)
        self.assertIsNotNone(helper)

        huge_line = NativeShapeSpec(
            shape_type="line",
            source_pixel_bbox=(444, 64, 1346, 885),
            line_color="#111111",
            line_start=(444, 64),
            line_end=(1346, 885),
            stroke_width=2,
        )
        small_line = NativeShapeSpec(
            shape_type="line",
            source_pixel_bbox=(40, 64, 120, 66),
            line_color="#111111",
            line_start=(40, 65),
            line_end=(120, 65),
            stroke_width=2,
        )

        kept = helper([huge_line, small_line], (1672, 941))

        self.assertEqual(kept, [small_line])

    def test_source_preserving_fallback_creates_small_icon_anchor_assets(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_build_source_preserving_anchor_assets", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_dir = root / "assets" / "0000-slide-a"
            image = Image.new("RGB", (240, 140), "#020A18")
            draw = ImageDraw.Draw(image)
            draw.ellipse((48, 42, 86, 80), outline="#168BFF", width=3)
            draw.rectangle((60, 54, 74, 68), fill="#168BFF")
            image.save(source)

            text_box = TextBoxSpec(
                text="底盘域",
                source_pixel_bbox=(108, 48, 168, 72),
                source_pixel_polygon=((108, 48), (168, 48), (168, 72), (108, 72)),
            )

            assets = helper(
                source_image_path=source,
                text_boxes=[text_box],
                output_dir=output_dir,
                asset_root=root,
                start_z_order=1,
            )

            with Image.open(root / assets[0].asset_path) as asset_image:
                alpha_bbox = asset_image.convert("RGBA").getchannel("A").getbbox()

        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0].asset_id, "anchor-001")
        self.assertLessEqual(
            (assets[0].source_pixel_bbox[2] - assets[0].source_pixel_bbox[0])
            * (assets[0].source_pixel_bbox[3] - assets[0].source_pixel_bbox[1]),
            5000,
        )
        self.assertIsNotNone(alpha_bbox)

    def test_source_preserving_fallback_creates_generic_visual_anchor_assets(self):
        from PIL import Image, ImageDraw

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_build_source_preserving_anchor_assets", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output_dir = root / "assets" / "0000-slide-b"
            image = Image.new("RGB", (360, 220), "#020814")
            draw = ImageDraw.Draw(image)
            draw.ellipse((92, 56, 205, 169), outline="#4D6D86", width=4)
            draw.ellipse((125, 88, 172, 135), outline="#D2E1F0", width=3)
            draw.rectangle((138, 108, 188, 134), fill="#24384A")
            draw.line((205, 112, 284, 92), fill="#8CA7BB", width=2)
            image.save(source)

            text_box = TextBoxSpec(
                text="高压隔离",
                source_pixel_bbox=(284, 82, 338, 104),
                source_pixel_polygon=((284, 82), (338, 82), (338, 104), (284, 104)),
            )

            assets = helper(
                source_image_path=source,
                text_boxes=[text_box],
                output_dir=output_dir,
                asset_root=root,
                start_z_order=1,
            )

            with Image.open(root / assets[0].asset_path) as asset_image:
                alpha_bbox = asset_image.convert("RGBA").getchannel("A").getbbox()

        self.assertGreaterEqual(len(assets), 1)
        self.assertEqual(assets[0].asset_id, "anchor-001")
        self.assertLessEqual(
            (assets[0].source_pixel_bbox[2] - assets[0].source_pixel_bbox[0])
            * (assets[0].source_pixel_bbox[3] - assets[0].source_pixel_bbox[1]),
            int(360 * 220 * 0.08),
        )
        self.assertIsNotNone(alpha_bbox)

    def test_source_preserving_background_is_not_chosen_for_dense_native_heavy_complex_page(self):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_choose_source_preserving_background", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            chosen = root / "base-clean.png"
            text_clean = root / "text-clean.png"
            image = Image.new("RGB", (360, 220), "#030915")
            image.save(source)
            Image.new("RGB", (360, 220), "#FFFFFF").save(chosen)
            Image.new("RGB", (360, 220), "#FFFFFF").save(text_clean)

            text_boxes = [
                TextBoxSpec(
                    text=f"文本{i}",
                    source_pixel_bbox=(240, 20 + i * 16, 320, 32 + i * 16),
                    source_pixel_polygon=(
                        (240, 20 + i * 16),
                        (320, 20 + i * 16),
                        (320, 32 + i * 16),
                        (240, 32 + i * 16),
                    ),
                )
                for i in range(8)
            ]
            native_shapes = [
                NativeShapeSpec(
                    shape_type="rounded_rectangle",
                    source_pixel_bbox=(20 + i * 14, 60 + i * 4, 32 + i * 14, 74 + i * 4),
                    fill_color="#123456",
                )
                for i in range(8)
            ]
            asset_path = root / "assets" / "tiny.png"
            asset_path.parent.mkdir(parents=True)
            Image.new("RGBA", (12, 12), "#123456").save(asset_path)
            bitmap_assets = [
                BitmapAssetSpec(
                    asset_id="tiny",
                    source_pixel_bbox=(120, 80, 132, 92),
                    asset_path="assets/tiny.png",
                    z_order=1,
                )
            ]

            should_choose = helper(
                source_image_path=source,
                chosen_background_image_path=chosen,
                text_clean_image_path=text_clean,
                text_boxes=text_boxes,
                native_shapes=native_shapes,
                bitmap_assets=bitmap_assets,
                source_image_size=(360, 220),
            )

        self.assertFalse(should_choose)

    def test_native_heavy_page_keeps_editable_shapes_when_background_is_clean(self):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_choose_source_preserving_background", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            chosen = root / "base-clean.png"
            text_clean = root / "text-clean.png"
            image = Image.new("RGB", (360, 220), "#030915")
            image.save(source)
            image.save(chosen)
            Image.new("RGB", (360, 220), "#FFFFFF").save(text_clean)

            text_boxes = [
                TextBoxSpec(
                    text=f"文本{i}",
                    source_pixel_bbox=(240, 20 + i * 16, 320, 32 + i * 16),
                    source_pixel_polygon=(
                        (240, 20 + i * 16),
                        (320, 20 + i * 16),
                        (320, 32 + i * 16),
                        (240, 32 + i * 16),
                    ),
                )
                for i in range(8)
            ]
            native_shapes = [
                NativeShapeSpec(
                    shape_type="rounded_rectangle",
                    source_pixel_bbox=(
                        10 + (i % 10) * 32,
                        45 + (i // 10) * 42,
                        34 + (i % 10) * 32,
                        69 + (i // 10) * 42,
                    ),
                    fill_color="#123456",
                )
                for i in range(20)
            ]

            should_choose = helper(
                source_image_path=source,
                chosen_background_image_path=chosen,
                text_clean_image_path=text_clean,
                text_boxes=text_boxes,
                native_shapes=native_shapes,
                bitmap_assets=[],
                source_image_size=(360, 220),
            )

        self.assertFalse(should_choose)

    def test_source_preserving_background_is_not_chosen_for_very_native_heavy_complex_page(self):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_choose_source_preserving_background", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            chosen = root / "base-clean.png"
            text_clean = root / "text-clean.png"
            image = Image.new("RGB", (360, 220), "#030915")
            image.save(source)
            Image.new("RGB", (360, 220), "#FFFFFF").save(chosen)
            Image.new("RGB", (360, 220), "#FFFFFF").save(text_clean)

            text_boxes = [
                TextBoxSpec(
                    text=f"文本{i}",
                    source_pixel_bbox=(240, 20 + i * 16, 320, 32 + i * 16),
                    source_pixel_polygon=(
                        (240, 20 + i * 16),
                        (320, 20 + i * 16),
                        (320, 32 + i * 16),
                        (240, 32 + i * 16),
                    ),
                )
                for i in range(8)
            ]
            native_shapes = [
                NativeShapeSpec(
                    shape_type="rounded_rectangle",
                    source_pixel_bbox=(
                        10 + (i % 10) * 32,
                        45 + (i // 10) * 42,
                        34 + (i % 10) * 32,
                        69 + (i // 10) * 42,
                    ),
                    fill_color="#123456",
                )
                for i in range(20)
            ]
            bitmap_assets = []
            for i in range(5):
                asset_path = root / "assets" / f"asset-{i}.png"
                asset_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (40, 30), "#123456").save(asset_path)
                bitmap_assets.append(
                    BitmapAssetSpec(
                        asset_id=f"asset-{i}",
                        source_pixel_bbox=(20 + i * 45, 120, 60 + i * 45, 150),
                        asset_path=f"assets/asset-{i}.png",
                        z_order=i + 1,
                    )
                )

            should_choose = helper(
                source_image_path=source,
                chosen_background_image_path=chosen,
                text_clean_image_path=text_clean,
                text_boxes=text_boxes,
                native_shapes=native_shapes,
                bitmap_assets=bitmap_assets,
                source_image_size=(360, 220),
            )

        self.assertFalse(should_choose)

    def test_source_preserving_background_is_not_chosen_for_many_native_shapes_with_few_bitmap_assets(
        self,
    ):
        from PIL import Image

        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_choose_source_preserving_background", None)
        self.assertIsNotNone(helper)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            chosen = root / "base-clean.png"
            text_clean = root / "text-clean.png"
            image = Image.new("RGB", (360, 220), "#030915")
            image.save(source)
            Image.new("RGB", (360, 220), "#FFFFFF").save(chosen)
            Image.new("RGB", (360, 220), "#FFFFFF").save(text_clean)

            text_boxes = [
                TextBoxSpec(
                    text=f"标签{i}",
                    source_pixel_bbox=(250, 20 + i * 18, 330, 34 + i * 18),
                    source_pixel_polygon=(
                        (250, 20 + i * 18),
                        (330, 20 + i * 18),
                        (330, 34 + i * 18),
                        (250, 34 + i * 18),
                    ),
                )
                for i in range(10)
            ]
            native_shapes = [
                NativeShapeSpec(
                    shape_type="rounded_rectangle",
                    source_pixel_bbox=(20 + i * 8, 40 + i * 5, 38 + i * 8, 58 + i * 5),
                    fill_color="#123456",
                )
                for i in range(12)
            ]
            bitmap_assets = []
            for i in range(2):
                asset_path = root / "assets" / f"asset-{i}.png"
                asset_path.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (100, 80), "#123456").save(asset_path)
                bitmap_assets.append(
                    BitmapAssetSpec(
                        asset_id=f"asset-{i}",
                        source_pixel_bbox=(60 + i * 120, 80, 160 + i * 120, 160),
                        asset_path=f"assets/asset-{i}.png",
                        z_order=i + 1,
                    )
                )

            should_choose = helper(
                source_image_path=source,
                chosen_background_image_path=chosen,
                text_clean_image_path=text_clean,
                text_boxes=text_boxes,
                native_shapes=native_shapes,
                bitmap_assets=bitmap_assets,
                source_image_size=(360, 220),
            )

        self.assertFalse(should_choose)

    def test_source_raster_guardrail_does_not_trigger_for_many_tall_short_warning_only_text_boxes(
        self,
    ):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_use_source_raster_guardrail", None)
        self.assertIsNotNone(helper)

        text_boxes = [
            TextBoxSpec(
                text=f"短标签{i}",
                source_pixel_bbox=(900, 300 + i * 70, 1160, 365 + i * 70),
                source_pixel_polygon=(
                    (900, 300 + i * 70),
                    (1160, 300 + i * 70),
                    (1160, 365 + i * 70),
                    (900, 365 + i * 70),
                ),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            )
            for i in range(4)
        ]
        text_boxes.append(
            TextBoxSpec(
                text="落地建议：用车、补能与维护的最佳实践",
                source_pixel_bbox=(296, 22, 1283, 76),
                source_pixel_polygon=((296, 22), (1283, 22), (1283, 76), (296, 76)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            )
        )

        should_guard = helper(text_boxes=text_boxes, text_issues=[])

        self.assertFalse(should_guard)

    def test_source_raster_guardrail_does_not_trigger_for_fragmented_top_warning_only_ocr(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_use_source_raster_guardrail", None)
        self.assertIsNotNone(helper)

        text_boxes = [
            TextBoxSpec(
                text="理想汽车技术实验室",
                source_pixel_bbox=(1434, 132, 1486, 140),
                source_pixel_polygon=((1434, 132), (1486, 132), (1486, 140), (1434, 140)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="理想L9:",
                source_pixel_bbox=(111, 85, 143, 96),
                source_pixel_polygon=((111, 85), (143, 85), (143, 96), (111, 96)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="旗舰增程SUV的技术实验",
                source_pixel_bbox=(1315, 184, 1417, 192),
                source_pixel_polygon=((1315, 184), (1417, 184), (1417, 192), (1315, 192)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="72.7kWh 5C电池 | CLTC纯电续航420km | 综合1650km",
                source_pixel_bbox=(1181, 131, 1327, 198),
                source_pixel_polygon=((1181, 131), (1327, 131), (1327, 198), (1181, 198)),
                provenance={"ocr_provenance": {"approximate_layout": True}},
            ),
            TextBoxSpec(
                text="5C电池",
                source_pixel_bbox=(261, 544, 339, 572),
                source_pixel_polygon=((261, 544), (339, 544), (339, 572), (261, 572)),
            ),
            TextBoxSpec(
                text="72.7kWh",
                source_pixel_bbox=(157, 545, 257, 571),
                source_pixel_polygon=((157, 545), (257, 545), (257, 571), (157, 571)),
            ),
        ]
        text_issues = [
            {
                "code": "ignored_spurious_ocr",
                "severity": "warning",
                "ocr_text": "基于增程系统消除长距离出行焦虑",
            },
            {
                "code": "ignored_spurious_ocr",
                "severity": "warning",
                "ocr_text": "从用户安全与长期用车角度建立系统性落地指南",
            },
        ]

        should_guard = helper(
            text_boxes=text_boxes,
            text_issues=text_issues,
            source_image_size=(1672, 941),
        )

        self.assertFalse(should_guard)

    def test_source_raster_guardrail_triggers_for_unreliable_ocr_layout_issue(self):
        import src.generative_editable_pipeline as pipeline

        helper = getattr(pipeline, "_should_use_source_raster_guardrail", None)
        self.assertIsNotNone(helper)

        text_boxes = [
            TextBoxSpec(
                text="真实标题",
                source_pixel_bbox=(80, 40, 260, 80),
                source_pixel_polygon=((80, 40), (260, 40), (260, 80), (80, 80)),
            )
        ]
        text_issues = [
            {
                "code": "unreliable_ocr_layout",
                "ocr_text": "核心架构设计：增程、底盘与智能域",
            }
        ]

        should_guard = helper(text_boxes=text_boxes, text_issues=text_issues)

        self.assertTrue(should_guard)

    def test_records_asset_repair_history_on_page_manifest(self):
        from src.generative_editable_pipeline import apply_asset_repair_results

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(120, 80),
            slide_size=(10.0, 5.625),
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id="fg-001",
                    source_pixel_bbox=(10, 10, 40, 32),
                    asset_path="assets/0000-slide-a/fg-001.png",
                    z_order=1,
                )
            ],
        )
        repaired_asset = BitmapAssetSpec(
            asset_id="fg-001",
            source_pixel_bbox=(10, 10, 40, 32),
            asset_path="assets/0000-slide-a/fg-001.repair-1.png",
            z_order=1,
            provenance={"repair_attempt": 1},
        )
        attempt = RepairAttempt(
            target_id="fg-001",
            attempt_index=1,
            reason="edge_touch",
            provider_role="edit_model",
            status="passed",
            provenance={"prompt_id": "repair_asset"},
        )

        updated = apply_asset_repair_results(page, [repaired_asset], [attempt])

        self.assertEqual(updated.bitmap_assets[0].asset_path, repaired_asset.asset_path)
        self.assertEqual(updated.repair_attempts, [attempt])
        self.assertEqual(updated.provenance["asset_repair"]["repaired_asset_ids"], ["fg-001"])

    def test_rejects_repaired_assets_that_do_not_match_existing_manifest_targets(self):
        from src.generative_editable_pipeline import apply_asset_repair_results

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/slide-a.png",
            source_image_size=(120, 80),
            slide_size=(10.0, 5.625),
            bitmap_assets=[
                BitmapAssetSpec(
                    asset_id="fg-001",
                    source_pixel_bbox=(10, 10, 40, 32),
                    asset_path="assets/0000-slide-a/fg-001.png",
                    z_order=1,
                )
            ],
        )
        unexpected_asset = BitmapAssetSpec(
            asset_id="fg-999",
            source_pixel_bbox=(10, 10, 40, 32),
            asset_path="assets/0000-slide-a/fg-999.repair-1.png",
            z_order=1,
        )

        with self.assertRaisesRegex(ValueError, "unknown repaired asset"):
            apply_asset_repair_results(page, [unexpected_asset], [])

    def test_finalize_validated_export_returns_output_when_validation_passes(self):
        from src.generative_editable_pipeline import finalize_validated_export

        report = ValidationReport(status="passed", checked_pages=1, issues=[])

        result = finalize_validated_export(
            validation_report=report,
            output_path="deck.pptx",
        )

        self.assertEqual(result.status, "passed")
        self.assertEqual(result.output_path, "deck.pptx")
        self.assertEqual(result.fallback_policy, "fail")
        self.assertEqual(result.fallback_used, "")

    def test_finalize_validated_export_defaults_to_fail_policy_on_validation_failure(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableValidationError,
            finalize_validated_export,
        )

        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[
                ValidationIssue(
                    code="preview_similarity_failed",
                    message="preview differs",
                    slide_id="slide-a",
                )
            ],
        )

        with self.assertRaises(GenerativeEditableValidationError) as ctx:
            finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy=None,
            )

        self.assertEqual(ctx.exception.fallback_policy, "fail")
        self.assertIs(ctx.exception.validation_report, report)
        self.assertIn("validation failed", str(ctx.exception))
        self.assertIn("preview_similarity_failed", str(ctx.exception))

    def test_default_fail_policy_does_not_silently_return_low_fidelity_fallback(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableValidationError,
            finalize_validated_export,
        )

        fallback_calls = []
        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="missing_required_text", message="missing text")],
        )

        with self.assertRaises(GenerativeEditableValidationError):
            finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy="fail",
                fallback_output_factory=lambda: fallback_calls.append("called") or "raster.pptx",
            )

        self.assertEqual(fallback_calls, [])

    def test_default_fail_policy_with_factory_still_does_not_call_fallback(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableValidationError,
            finalize_validated_export,
        )

        fallback_calls = []
        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="preview_similarity_failed", message="preview differs")],
        )

        with self.assertRaises(GenerativeEditableValidationError):
            finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy=None,
                fallback_output_factory=lambda: fallback_calls.append("called") or "fallback.pptx",
            )

        self.assertEqual(fallback_calls, [])

    def test_inconsistent_passed_report_with_issues_does_not_return_output(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableValidationError,
            finalize_validated_export,
        )

        report = ValidationReport(
            status="passed",
            checked_pages=1,
            issues=[ValidationIssue(code="object_order_mismatch", message="bad order")],
        )

        with self.assertRaises(GenerativeEditableValidationError):
            finalize_validated_export(validation_report=report, output_path="deck.pptx")

    def test_invalid_runtime_fallback_policy_is_rejected_explicitly(self):
        from src.generative_editable_pipeline import finalize_validated_export

        with self.assertRaisesRegex(ValueError, "unsupported fallback policy"):
            finalize_validated_export(
                validation_report=ValidationReport(status="passed", checked_pages=1, issues=[]),
                output_path="deck.pptx",
                fallback_policy="",
            )

    def test_explicit_future_fallback_policy_raises_project_error_until_implemented(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableFallbackError,
            finalize_validated_export,
        )

        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="preview_similarity_failed", message="preview differs")],
        )

        with self.assertRaises(GenerativeEditableFallbackError):
            finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy="raster_pptx",
            )

    def test_explicit_raster_fallback_returns_fallback_metadata_when_output_succeeds(self):
        from src.generative_editable_pipeline import finalize_validated_export

        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="preview_similarity_failed", message="preview differs")],
        )

        with tempfile.TemporaryDirectory() as tmp:
            fallback_path = Path(tmp) / "raster.pptx"
            fallback_path.write_bytes(b"pptx")

            result = finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy="raster_pptx",
                fallback_output_factory=lambda: str(fallback_path),
            )

        self.assertEqual(result.status, "fallback_used")
        self.assertEqual(result.output_path, str(fallback_path))
        self.assertEqual(result.fallback_policy, "raster_pptx")
        self.assertEqual(result.fallback_used, "raster_pptx")
        self.assertIs(result.validation_report, report)

    def test_explicit_text_editable_background_fallback_returns_fallback_metadata(self):
        from src.generative_editable_pipeline import finalize_validated_export

        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="missing_object", message="asset failed")],
        )

        with tempfile.TemporaryDirectory() as tmp:
            fallback_path = Path(tmp) / "text-background.pptx"
            fallback_path.write_bytes(b"pptx")

            result = finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy="text_editable_background",
                fallback_output_factory=lambda: str(fallback_path),
            )

        self.assertEqual(result.status, "fallback_used")
        self.assertEqual(result.output_path, str(fallback_path))
        self.assertEqual(result.fallback_used, "text_editable_background")

    def test_explicit_fallback_missing_output_path_reports_failure_reason(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableFallbackError,
            finalize_validated_export,
        )

        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="missing_object", message="asset failed")],
        )

        with tempfile.TemporaryDirectory() as tmp:
            missing_path = Path(tmp) / "missing.pptx"
            with self.assertRaises(GenerativeEditableFallbackError) as ctx:
                finalize_validated_export(
                    validation_report=report,
                    output_path="deck.pptx",
                    fallback_policy="raster_pptx",
                    fallback_output_factory=lambda: str(missing_path),
                )

        self.assertIn("missing_object", str(ctx.exception))
        self.assertIn("does not exist", str(ctx.exception))

    def test_explicit_fallback_failure_reports_original_and_fallback_reasons(self):
        from src.generative_editable_pipeline import (
            GenerativeEditableFallbackError,
            finalize_validated_export,
        )

        report = ValidationReport(
            status="failed",
            checked_pages=1,
            issues=[ValidationIssue(code="preview_similarity_failed", message="preview differs")],
        )

        def failing_fallback():
            raise RuntimeError("raster exporter unavailable")

        with self.assertRaises(GenerativeEditableFallbackError) as ctx:
            finalize_validated_export(
                validation_report=report,
                output_path="deck.pptx",
                fallback_policy="raster_pptx",
                fallback_output_factory=failing_fallback,
            )

        self.assertIs(ctx.exception.validation_report, report)
        self.assertEqual(ctx.exception.fallback_policy, "raster_pptx")
        self.assertIn("preview_similarity_failed", str(ctx.exception))
        self.assertIn("raster exporter unavailable", str(ctx.exception))

    def test_orchestrates_one_slide_deck_with_fake_components(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_manifest import (
            BitmapAssetSpec,
            read_deck_manifest,
            read_page_manifest,
        )
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import (
            PreviewRenderResult,
            ValidationReport,
        )
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
            ImageGenerationRequest,
        )

        config = load_generative_editable_config(use_fake=True)
        calls: list[str] = []

        class RecordingImageGenerationProvider(FakeImageGenerationProvider):
            def generate(self, request: ImageGenerationRequest):
                calls.append(f"image_generation:{request.prompt_id}")
                return super().generate(request)

        def fake_planner(**kwargs):
            calls.append("planner")
            self.assertTrue(Path(kwargs["base_clean_image_path"]).exists())
            self.assertTrue(Path(kwargs["text_mask_path"]).exists())
            return [
                ForegroundCandidate(
                    candidate_id="fg-001",
                    source_pixel_bbox=(500, 120, 620, 220),
                    area=12000,
                    classification="bitmap_asset_candidate",
                    confidence=0.91,
                )
            ]

        def fake_asset_builder(**kwargs):
            calls.append("assets")
            output_path = Path(kwargs["asset_root"]) / "assets" / "0000-slide-a" / "fg-001.png"
            kwargs["image_generation_provider"].generate(
                ImageGenerationRequest(
                    prompt_id="asset_sheet",
                    prompt="fake asset generation",
                    output_asset_path=str(output_path),
                    asset_root=str(kwargs["asset_root"]),
                    visual_reference={"candidate_ids": ["fg-001"]},
                )
            )
            return [
                BitmapAssetSpec(
                    asset_id="fg-001",
                    source_pixel_bbox=(500, 120, 620, 220),
                    asset_path="assets/0000-slide-a/fg-001.png",
                    z_order=1,
                )
            ]

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            calls.append("composer")
            self.assertTrue(Path(deck_manifest_path).exists())
            Path(output_path).write_bytes(b"fake-pptx")

        def fake_preview_renderer(page_manifest, artifact_root):
            calls.append("preview")
            return PreviewRenderResult(
                image=Image.new("RGB", page_manifest.source_image_size, "white"),
                metadata={"renderer": "fake_powerpoint", "is_powerpoint_render": True},
            )

        def fake_structure_validator(**kwargs):
            calls.append("structure_validator")
            return ValidationReport(status="passed", checked_pages=1, issues=[])

        def fake_preview_validator(**kwargs):
            calls.append("preview_validator")
            self.assertEqual(kwargs["slide_id"], "slide-a")
            return ValidationReport(status="passed", checked_pages=1, issues=[])

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                        text_metadata=[
                            {
                                "text": "Quarterly Plan",
                                "role": "title",
                                "order": 1,
                            }
                        ],
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                aspect_ratio="16:9",
                fallback_policy="fail",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FakeOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=RecordingImageGenerationProvider(
                        config.generation_model
                    ),
                    foreground_planner=fake_planner,
                    asset_builder=fake_asset_builder,
                    composer=fake_composer,
                    preview_renderer=fake_preview_renderer,
                    structure_validator=fake_structure_validator,
                    preview_validator=fake_preview_validator,
                ),
            )

            deck_manifest = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page_manifest = read_page_manifest(
                artifact_root / "job-1" / deck_manifest.page_manifest_paths[0]
            )

            self.assertEqual(result.status, "passed")
            self.assertEqual(result.output_path, str(output_path))
            self.assertEqual(deck_manifest.validation_status, "passed")
            self.assertEqual(page_manifest.validation_status, "passed")
            self.assertEqual(page_manifest.text_boxes[0].text, "Quarterly Plan")
            self.assertEqual(page_manifest.bitmap_assets[0].asset_id, "fg-001")
            self.assertIn("ocr", page_manifest.provider_output_paths)
            self.assertIn("image_edit", page_manifest.provider_output_paths)
            self.assertIn("image_generation", page_manifest.provider_output_paths)
            self.assertIn("text_mask_path", page_manifest.provenance)

        self.assertEqual(
            calls,
            [
                "planner",
                "assets",
                "image_generation:asset_sheet",
                "composer",
                "structure_validator",
                "preview",
                "preview_validator",
            ],
        )

    def test_default_reconstruction_builds_shapes_asset_sheets_and_bitmap_assets(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
            ImageEditRequest,
        )

        config = load_generative_editable_config(use_fake=True)
        edit_prompt_ids: list[str] = []

        class RecordingImageEditProvider(FakeImageEditProvider):
            def edit(self, request: ImageEditRequest):
                edit_prompt_ids.append(request.prompt_id)
                if request.prompt_id == "asset_sheet":
                    output = Path(request.output_asset_path)
                    output.parent.mkdir(parents=True, exist_ok=True)
                    sheet = Image.new("RGBA", (800, 450), (0, 0, 0, 0))
                    ImageDraw.Draw(sheet).ellipse((502, 142, 608, 208), fill="#10B981")
                    sheet.save(output)
                    return type(
                        "Result",
                        (),
                        {
                            "output_asset_path": str(output),
                            "source_image_path": request.source_image_path,
                            "prompt_id": request.prompt_id,
                            "provider_role": self.config.role,
                            "provider_name": self.config.provider,
                            "model": self.config.model,
                            "timeout_seconds": request.timeout_seconds,
                        },
                    )()
                return super().edit(request)

        def fake_planner(**kwargs):
            return [
                ForegroundCandidate(
                    candidate_id="shape-001",
                    source_pixel_bbox=(80, 320, 280, 360),
                    area=8000,
                    classification="native_shape_candidate",
                    confidence=0.95,
                    provenance={"shape_hint": "rectangle"},
                ),
                ForegroundCandidate(
                    candidate_id="asset-001",
                    source_pixel_bbox=(480, 118, 626, 224),
                    area=15476,
                    classification="bitmap_asset_candidate",
                    confidence=0.91,
                ),
            ]

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            image = Image.new("RGB", (800, 450), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((80, 320, 280, 360), fill="#2563EB")
            draw.ellipse((500, 140, 610, 210), fill="#10B981")
            image.save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FakeOCRProvider(config.ocr),
                    image_edit_provider=RecordingImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=fake_planner,
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

            self.assertEqual(result.status, "passed")
            self.assertEqual([shape.shape_type for shape in page.native_shapes], ["rectangle"])
            self.assertEqual([asset.asset_id for asset in page.bitmap_assets], ["asset-001"])
            self.assertTrue(
                Path(artifact_root / "job-1" / page.bitmap_assets[0].asset_path).exists()
            )
            self.assertEqual([sheet.sheet_id for sheet in page.asset_sheets], ["asset-sheet-0000"])
            self.assertEqual(page.asset_sheets[0].candidate_ids, ["asset-001"])
            self.assertIn("asset_sheet", edit_prompt_ids)

    def test_approximate_ocr_layout_still_runs_reconstruction(self):
        from PIL import Image

        from src.generative_editable_config import ProviderConfig, load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class ApproximateOCRProvider(OCRProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="ocr_model",
                        provider="plain-text-ocr",
                        model="plain-text-ocr",
                        base_url="",
                        api_key="",
                    )
                )

            def extract_text(self, image_path: str):
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(800, 450),
                    provider_role=self.config.role,
                    provider_name=self.config.provider,
                    model=self.config.model,
                    items=[
                        OCRTextItem(
                            text="Approximate title",
                            bbox=(60, 40, 740, 110),
                            polygon=((60, 40), (740, 40), (740, 110), (60, 110)),
                            confidence=0.78,
                            style_hints={"approximate_layout": True},
                            provenance={"approximate_layout": True},
                        )
                    ],
                )

        class RecordingImageEditProvider(FakeImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="fake_image_edit",
                        model="fake-image-edit",
                        base_url="",
                        api_key="",
                    )
                )
                self.prompt_ids: list[str] = []

            def edit(self, request):
                self.prompt_ids.append(request.prompt_id)
                return super().edit(request)

        asset_builder_calls = []

        def recording_asset_builder(**kwargs):
            asset_builder_calls.append(kwargs)
            return AssetBuildResult(bitmap_assets=[])

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        config = load_generative_editable_config(use_fake=True)
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "#0B1020").save(source_path)
            image_edit_provider = RecordingImageEditProvider()

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-approx",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=ApproximateOCRProvider(),
                    image_edit_provider=image_edit_provider,
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    asset_builder=recording_asset_builder,
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

            deck = read_deck_manifest(artifact_root / "job-approx" / "deck.json")
            page = read_page_manifest(artifact_root / "job-approx" / deck.page_manifest_paths[0])

        self.assertEqual(result.status, "passed")
        self.assertNotEqual(page.chosen_background, "backgrounds/0000-slide-a/source-visual.png")
        self.assertNotEqual(page.provenance.get("reconstruction_mode"), "source_visual_background")
        self.assertIn("text_clean_background", image_edit_provider.prompt_ids)
        self.assertIn("base_clean_background", image_edit_provider.prompt_ids)
        self.assertEqual(len(asset_builder_calls), 1)
        self.assertNotEqual(
            asset_builder_calls[0]["asset_reference_image_path"],
            asset_builder_calls[0]["source_image_path"],
        )
        self.assertTrue(
            asset_builder_calls[0]["asset_reference_image_path"].endswith("text-clean.png")
        )
        self.assertEqual(page.bitmap_assets, [])
        self.assertEqual(page.native_shapes, [])
        self.assertTrue(page.text_boxes[0].style_hints["approximate_layout"])

    def test_asset_reference_uses_text_clean_only_when_unmasked_geometry_is_stable(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_pipeline import _select_asset_reference_image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            stable = root / "text-clean-stable.png"
            drifted = root / "text-clean-drifted.png"
            mask = root / "mask.png"

            image = Image.new("RGB", (160, 90), "#0B1020")
            draw = ImageDraw.Draw(image)
            draw.rectangle((16, 24, 72, 64), fill="#2563EB")
            draw.rectangle((96, 24, 142, 64), fill="#10B981")
            draw.text((20, 6), "TEXT", fill="#FFFFFF")
            image.save(source)

            stable_image = image.copy()
            ImageDraw.Draw(stable_image).rectangle((18, 4, 62, 18), fill="#0B1020")
            stable_image.save(stable)

            drifted_image = Image.new("RGB", (160, 90), "#0B1020")
            drifted_draw = ImageDraw.Draw(drifted_image)
            drifted_draw.rectangle((26, 34, 82, 74), fill="#2563EB")
            drifted_draw.rectangle((106, 34, 152, 74), fill="#10B981")
            drifted_image.save(drifted)

            mask_image = Image.new("L", (160, 90), 0)
            ImageDraw.Draw(mask_image).rectangle((16, 2, 68, 22), fill=255)
            mask_image.save(mask)

            stable_choice = _select_asset_reference_image(
                source_image_path=source,
                text_clean_image_path=stable,
                text_mask_path=mask,
            )
            drifted_choice = _select_asset_reference_image(
                source_image_path=source,
                text_clean_image_path=drifted,
                text_mask_path=mask,
            )

        self.assertEqual(Path(stable_choice), stable)
        self.assertEqual(Path(drifted_choice), source)

    def test_reconstruction_targets_reclassify_uncertain_simple_source_shapes_as_native(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (200, 120), "white")
            ImageDraw.Draw(image).rectangle((30, 34, 120, 82), fill="#2563EB")
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="fg-001",
                        source_pixel_bbox=(30, 34, 121, 83),
                        area=4459,
                        classification="uncertain",
                        confidence=0.0,
                    )
                ],
                source_image_path=str(source),
            )

        self.assertEqual([shape.shape_type for shape in native_shapes], ["rectangle"])
        self.assertEqual(bitmap_candidates, [])

    def test_asset_sheet_batches_complex_whole_visuals_as_singletons(self):
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _candidate_batches

        candidates = [
            ForegroundCandidate(
                candidate_id="complex-1",
                source_pixel_bbox=(0, 0, 100, 80),
                area=8000,
                classification="complex_whole_visual",
            ),
            ForegroundCandidate(
                candidate_id="complex-2",
                source_pixel_bbox=(120, 0, 220, 80),
                area=8000,
                classification="complex_whole_visual",
            ),
            ForegroundCandidate(
                candidate_id="icon-1",
                source_pixel_bbox=(0, 120, 40, 160),
                area=1600,
                classification="bitmap_asset_candidate",
            ),
            ForegroundCandidate(
                candidate_id="icon-2",
                source_pixel_bbox=(60, 120, 100, 160),
                area=1600,
                classification="bitmap_asset_candidate",
            ),
        ]

        batches = _candidate_batches(candidates, max_batch_size=6)

        self.assertEqual(
            [[candidate.candidate_id for candidate in batch] for batch in batches],
            [["complex-1"], ["complex-2"], ["icon-1", "icon-2"]],
        )

    def test_reconstruction_targets_drop_nested_bitmap_fragments_inside_larger_complex_visual(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (300, 180), "#0B1020")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle((40, 30, 240, 130), radius=12, fill="#1D4ED8")
            draw.rectangle((92, 58, 138, 100), fill="#F8FAFC")
            draw.rectangle((168, 58, 215, 100), fill="#94A3B8")
            draw.rectangle((252, 42, 286, 76), fill="#16A34A")
            image.save(source)

            _native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="large-panel",
                        source_pixel_bbox=(40, 30, 240, 130),
                        area=20000,
                        classification="complex_whole_visual",
                    ),
                    ForegroundCandidate(
                        candidate_id="nested-left",
                        source_pixel_bbox=(92, 58, 138, 100),
                        area=1932,
                        classification="complex_whole_visual",
                    ),
                    ForegroundCandidate(
                        candidate_id="nested-right",
                        source_pixel_bbox=(168, 58, 215, 100),
                        area=1974,
                        classification="complex_whole_visual",
                    ),
                    ForegroundCandidate(
                        candidate_id="outside",
                        source_pixel_bbox=(252, 42, 286, 76),
                        area=1156,
                        classification="complex_whole_visual",
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual(
            [candidate.candidate_id for candidate in bitmap_candidates],
            ["large-panel", "outside"],
        )

    def test_reconstruction_targets_drop_line_like_bitmap_residuals(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (500, 280), "#0B1020")
            draw = ImageDraw.Draw(image)
            draw.line((40, 80, 460, 80), fill="#2563EB", width=3)
            draw.rectangle((120, 120, 220, 200), fill="#10B981")
            image.save(source)

            _native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="glow-line-residual",
                        source_pixel_bbox=(40, 76, 461, 87),
                        area=4631,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="real-object",
                        source_pixel_bbox=(120, 120, 221, 201),
                        area=8181,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual(
            [candidate.candidate_id for candidate in bitmap_candidates], ["real-object"]
        )

    def test_reconstruction_targets_merge_nearby_bitmap_fragments(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (420, 240), "#0B1020")
            draw = ImageDraw.Draw(image)
            draw.rectangle((60, 80, 120, 140), fill="#2563EB")
            draw.rectangle((132, 82, 188, 138), fill="#1D4ED8")
            draw.rectangle((300, 80, 360, 140), fill="#10B981")
            image.save(source)

            _native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="near-left",
                        source_pixel_bbox=(60, 80, 121, 141),
                        area=3721,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="near-right",
                        source_pixel_bbox=(132, 82, 189, 139),
                        area=3249,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="far",
                        source_pixel_bbox=(300, 80, 361, 141),
                        area=3721,
                        classification="complex_whole_visual",
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual(len(bitmap_candidates), 2)
        self.assertEqual(bitmap_candidates[0].source_pixel_bbox, (60, 80, 189, 141))
        self.assertEqual(
            bitmap_candidates[0].provenance["merged_candidate_ids"], ["near-left", "near-right"]
        )
        self.assertEqual(bitmap_candidates[1].candidate_id, "far")

    def test_masked_source_element_assets_preserve_visuals_and_remove_text_pixels(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_masked_source_element_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "text-mask.png"
            output_dir = root / "assets" / "0000-slide-a"

            image = Image.new("RGB", (160, 90), "#0B1020")
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 20, 140, 70), fill="#1D4ED8")
            draw.rectangle((72, 34, 122, 48), fill="#FFFFFF")
            image.save(source)

            mask_image = Image.new("L", (160, 90), 0)
            ImageDraw.Draw(mask_image).rectangle((70, 32, 124, 50), fill=255)
            mask_image.save(mask)

            assets = _build_masked_source_element_assets(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="panel",
                        source_pixel_bbox=(20, 20, 141, 71),
                        area=6171,
                        classification="complex_whole_visual",
                    )
                ],
                source_image_path=str(source),
                text_mask_path=str(mask),
                output_dir=output_dir,
                asset_root=root,
                start_z_order=3,
            )

            asset_path = root / assets[0].asset_path
            with Image.open(asset_path) as asset_image:
                text_alpha = asset_image.getpixel((55, 20))[3]
                visual_alpha = asset_image.getpixel((10, 10))[3]
                visual_color = asset_image.getpixel((10, 10))[:3]

        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0].asset_path, "assets/0000-slide-a/panel.preserved.png")
        self.assertEqual(assets[0].z_order, 3)
        self.assertEqual(assets[0].provenance["asset_strategy"], "masked_source_element")
        self.assertEqual(text_alpha, 0)
        self.assertEqual(visual_alpha, 255)
        self.assertEqual(visual_color, (29, 78, 216))

    def test_masked_source_element_assets_use_clean_background_difference_for_alpha(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_masked_source_element_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            clean_background = root / "base-clean.png"
            mask = root / "text-mask.png"
            output_dir = root / "assets" / "0000-slide-a"

            background = Image.new("RGB", (180, 100), "#0B1020")
            draw_bg = ImageDraw.Draw(background)
            draw_bg.rounded_rectangle((10, 20, 170, 80), radius=8, fill="#10223A")
            background.save(clean_background)

            source_image = background.copy()
            draw = ImageDraw.Draw(source_image)
            draw.rectangle((72, 38, 118, 66), fill="#94A3B8")
            draw.rectangle((130, 36, 162, 50), fill="#FFFFFF")
            source_image.save(source)

            mask_image = Image.new("L", (180, 100), 0)
            ImageDraw.Draw(mask_image).rectangle((128, 34, 164, 52), fill=255)
            mask_image.save(mask)

            assets = _build_masked_source_element_assets(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="panel",
                        source_pixel_bbox=(10, 20, 171, 81),
                        area=9821,
                        classification="complex_whole_visual",
                    )
                ],
                source_image_path=str(source),
                background_image_path=str(clean_background),
                text_mask_path=str(mask),
                output_dir=output_dir,
                asset_root=root,
            )

            with Image.open(root / assets[0].asset_path) as asset_image:
                asset_size = asset_image.size
                object_alpha = asset_image.getpixel((10, 10))[3]

        self.assertEqual(object_alpha, 255)
        self.assertEqual(asset_size, (47, 29))
        self.assertEqual(assets[0].source_pixel_bbox, (72, 38, 119, 67))
        self.assertEqual(assets[0].provenance["background_difference_alpha"], True)
        self.assertEqual(assets[0].provenance["trimmed_transparent_bounds"], True)

    def test_visual_anchor_source_asset_suppresses_smooth_background_difference(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_masked_source_element_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            clean_background = root / "base-clean.png"
            output_dir = root / "assets" / "0000-slide-a"

            clean = Image.new("RGB", (220, 140), "#061020")
            clean_draw = ImageDraw.Draw(clean)
            clean_draw.rounded_rectangle((20, 30, 200, 112), radius=10, fill="#102642")
            clean.save(clean_background)

            source_image = Image.new("RGB", (220, 140), "#061020")
            source_draw = ImageDraw.Draw(source_image)
            source_draw.rounded_rectangle((20, 30, 200, 112), radius=10, fill="#12304F")
            source_draw.rectangle((78, 54, 142, 88), fill="#A8B6C8")
            source_draw.line((82, 60, 138, 60), fill="#F8FAFC", width=3)
            source_draw.line((82, 72, 138, 72), fill="#64748B", width=3)
            source_image.save(source)

            assets = _build_masked_source_element_assets(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="domain-row",
                        source_pixel_bbox=(20, 30, 201, 113),
                        area=181 * 83,
                        classification="complex_whole_visual",
                        provenance={"detection": "domain_row_visual_anchor"},
                    )
                ],
                source_image_path=str(source),
                background_image_path=str(clean_background),
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

            with Image.open(root / assets[0].asset_path).convert("RGBA") as asset_image:
                alpha_bbox = asset_image.getchannel("A").getbbox()
                object_alpha = asset_image.getpixel((20, 12))[3]

        self.assertEqual(assets[0].provenance["background_difference_alpha"], True)
        self.assertEqual(object_alpha, 255)
        self.assertGreater(assets[0].source_pixel_bbox[0], 60)
        self.assertGreater(assets[0].source_pixel_bbox[1], 40)
        self.assertLess(assets[0].source_pixel_bbox[2], 160)
        self.assertLessEqual(assets[0].source_pixel_bbox[3], 100)
        self.assertLess(alpha_bbox[2] - alpha_bbox[0], 100)
        self.assertLessEqual(alpha_bbox[3] - alpha_bbox[1], 60)

    def test_visual_anchor_source_asset_does_not_collapse_to_tiny_saliency_fragment(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_masked_source_element_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            clean_background = root / "base-clean.png"
            output_dir = root / "assets" / "0000-slide-a"

            clean = Image.new("RGB", (260, 160), "#061020")
            clean_draw = ImageDraw.Draw(clean)
            clean_draw.rounded_rectangle((20, 30, 240, 130), radius=10, fill="#102642")
            clean.save(clean_background)

            source_image = Image.new("RGB", (260, 160), "#061020")
            source_draw = ImageDraw.Draw(source_image)
            source_draw.rounded_rectangle((20, 30, 240, 130), radius=10, fill="#12304F")
            source_draw.rectangle((28, 62, 210, 106), fill="#23364A")
            source_draw.line((120, 82, 132, 86), fill="#F8FAFC", width=2)
            source_image.save(source)

            assets = _build_masked_source_element_assets(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="domain-row",
                        source_pixel_bbox=(20, 30, 241, 131),
                        area=221 * 101,
                        classification="complex_whole_visual",
                        provenance={"detection": "domain_row_visual_anchor"},
                    )
                ],
                source_image_path=str(source),
                background_image_path=str(clean_background),
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

        self.assertEqual(assets[0].provenance["background_difference_alpha"], True)
        self.assertGreater(assets[0].source_pixel_bbox[2] - assets[0].source_pixel_bbox[0], 160)
        self.assertFalse(assets[0].provenance["smooth_background_difference_suppressed"])

    def test_domain_row_visual_anchor_does_not_collapse_to_one_object_when_multiple_visuals_exist(
        self,
    ):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_masked_source_element_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            clean_background = root / "base-clean.png"
            output_dir = root / "assets" / "0000-slide-a"

            clean = Image.new("RGB", (360, 160), "#061020")
            clean_draw = ImageDraw.Draw(clean)
            clean_draw.rounded_rectangle((20, 30, 340, 130), radius=10, fill="#102642")
            clean.save(clean_background)

            source_image = Image.new("RGB", (360, 160), "#061020")
            source_draw = ImageDraw.Draw(source_image)
            source_draw.rounded_rectangle((20, 30, 340, 130), radius=10, fill="#12304F")
            source_draw.rounded_rectangle(
                (74, 58, 166, 106), radius=6, fill="#07111E", outline="#1F2937", width=3
            )
            source_draw.ellipse((236, 54, 304, 116), fill="#1F2937", outline="#CBD5E1", width=4)
            source_draw.ellipse((258, 76, 282, 100), fill="#94A3B8")
            source_image.save(source)

            assets = _build_masked_source_element_assets(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="domain-row",
                        source_pixel_bbox=(20, 30, 341, 131),
                        area=321 * 101,
                        classification="complex_whole_visual",
                        provenance={"detection": "domain_row_visual_anchor"},
                    )
                ],
                source_image_path=str(source),
                background_image_path=str(clean_background),
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

        self.assertGreater(assets[0].source_pixel_bbox[2] - assets[0].source_pixel_bbox[0], 230)
        self.assertFalse(assets[0].provenance["smooth_background_difference_suppressed"])

    def test_large_source_preserved_asset_feathers_outer_alpha_edges(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_masked_source_element_assets

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            clean_background = root / "base-clean.png"
            output_dir = root / "assets" / "0000-slide-a"

            Image.new("RGB", (240, 140), "#102642").save(clean_background)
            source_image = Image.new("RGB", (240, 140), "#12304F")
            ImageDraw.Draw(source_image).rectangle((80, 50, 160, 90), fill="#A8B6C8")
            source_image.save(source)

            assets = _build_masked_source_element_assets(
                candidates=[
                    ForegroundCandidate(
                        candidate_id="large-row",
                        source_pixel_bbox=(20, 20, 220, 120),
                        area=200 * 100,
                        classification="complex_whole_visual",
                        provenance={
                            "reason": "large_or_visually_complex",
                            "original_detection": {"detection": "source_base_difference"},
                        },
                    )
                ],
                source_image_path=str(source),
                background_image_path=str(clean_background),
                text_mask_path=None,
                output_dir=output_dir,
                asset_root=root,
            )

            with Image.open(root / assets[0].asset_path).convert("RGBA") as asset_image:
                edge_alpha = asset_image.getpixel((0, asset_image.height // 2))[3]
                center_alpha = asset_image.getpixel(
                    (asset_image.width // 2, asset_image.height // 2)
                )[3]

        self.assertLess(edge_alpha, center_alpha)
        self.assertEqual(center_alpha, 255)
        self.assertTrue(assets[0].provenance["edge_alpha_feathered"])

    def test_reconstruction_targets_drop_bitmap_candidates_covered_by_source_native_shapes(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (240, 140), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (30, 20, 130, 70), radius=12, fill="#FEF3C7", outline="#D97706", width=3
            )
            draw.line((150, 110, 220, 80), fill="#7C3AED", width=5)
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="fg-rounded",
                        source_pixel_bbox=(30, 20, 131, 71),
                        area=5151,
                        classification="uncertain",
                        confidence=0.0,
                    ),
                    ForegroundCandidate(
                        candidate_id="fg-line",
                        source_pixel_bbox=(148, 78, 223, 113),
                        area=2625,
                        classification="uncertain",
                        confidence=0.0,
                    ),
                    ForegroundCandidate(
                        candidate_id="source-rounded",
                        source_pixel_bbox=(30, 20, 131, 71),
                        area=4200,
                        classification="native_shape_candidate",
                        confidence=0.94,
                        provenance={"shape_hint": "rounded_rectangle", "radius": 12},
                    ),
                    ForegroundCandidate(
                        candidate_id="source-line",
                        source_pixel_bbox=(148, 78, 223, 113),
                        area=360,
                        classification="native_shape_candidate",
                        confidence=0.93,
                        provenance={"shape_hint": "line"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual(
            [shape.shape_type for shape in native_shapes], ["rounded_rectangle", "line"]
        )
        self.assertEqual(bitmap_candidates, [])

    def test_reconstruction_targets_ignore_full_page_diff_and_tiny_fragments_inside_native_shapes(
        self,
    ):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (800, 450), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (48, 46, 752, 118), radius=18, fill="#E0F2FE", outline="#0284C7", width=3
            )
            draw.text((82, 66), "Quarterly Plan", fill="#0F172A")
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="full-slide-diff",
                        source_pixel_bbox=(0, 0, 800, 450),
                        area=360000,
                        classification="complex_whole_visual",
                        confidence=0.86,
                    ),
                    ForegroundCandidate(
                        candidate_id="top-background-band",
                        source_pixel_bbox=(2, 2, 798, 125),
                        area=97908,
                        classification="complex_whole_visual",
                        confidence=0.86,
                    ),
                    ForegroundCandidate(
                        candidate_id="bottom-background-band",
                        source_pixel_bbox=(0, 287, 800, 450),
                        area=130400,
                        classification="complex_whole_visual",
                        confidence=0.86,
                    ),
                    ForegroundCandidate(
                        candidate_id="tiny-noise",
                        source_pixel_bbox=(383, 5, 392, 11),
                        area=54,
                        classification="uncertain",
                        confidence=0.5,
                    ),
                    ForegroundCandidate(
                        candidate_id="text-fragment",
                        source_pixel_bbox=(82, 68, 89, 77),
                        area=63,
                        classification="complex_whole_visual",
                        confidence=0.86,
                    ),
                    ForegroundCandidate(
                        candidate_id="right-edge-line",
                        source_pixel_bbox=(798, 47, 799, 89),
                        area=42,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="bottom-edge-line",
                        source_pixel_bbox=(206, 449, 347, 450),
                        area=141,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="left-edge-residual",
                        source_pixel_bbox=(2, 255, 53, 312),
                        area=2907,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="bottom-thin-residual",
                        source_pixel_bbox=(195, 426, 789, 441),
                        area=7935,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="blank-region-residual",
                        source_pixel_bbox=(487, 340, 606, 426),
                        area=962,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="inner-native-fill-residual",
                        source_pixel_bbox=(709, 51, 716, 57),
                        area=21,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="source-title-card",
                        source_pixel_bbox=(48, 46, 753, 119),
                        area=50000,
                        classification="native_shape_candidate",
                        confidence=0.94,
                        provenance={"shape_hint": "rounded_rectangle", "radius": 18},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual([shape.shape_type for shape in native_shapes], ["rounded_rectangle"])
        self.assertEqual(bitmap_candidates, [])

    def test_detects_source_native_shape_candidates_when_clean_background_is_unusable(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_pipeline import _detect_source_native_shape_candidates

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            image = Image.new("RGB", (220, 140), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.rectangle((30, 40, 120, 90), fill="#2563EB")
            draw.rounded_rectangle(
                (30, 12, 120, 30), radius=8, fill="#E0F2FE", outline="#0284C7", width=2
            )
            draw.rounded_rectangle(
                (132, 40, 200, 90), radius=12, fill="#FEF3C7", outline="#D97706", width=2
            )
            draw.line((145, 118, 205, 104), fill="#7C3AED", width=4)
            image.save(source)
            Image.new("L", (220, 140), 0).save(mask)

            candidates = _detect_source_native_shape_candidates(
                source_image_path=str(source),
                text_mask_path=str(mask),
            )

        self.assertEqual(
            [candidate.provenance.get("shape_hint") for candidate in candidates],
            ["rounded_rectangle", "rectangle", "rounded_rectangle", "line"],
        )

    def test_reconstruction_targets_drop_edge_residuals_without_native_shapes(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (800, 450), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.text((72, 46), "Complex Visual", fill="#0F172A")
            draw.polygon(
                [(90, 360), (250, 250), (430, 310), (700, 170), (700, 383), (90, 383)],
                fill="#DBEAFE",
            )
            draw.line(
                [(100, 330), (190, 260), (290, 286), (398, 198), (520, 224), (680, 146)],
                fill="#2563EB",
                width=4,
            )
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="fg-001",
                        source_pixel_bbox=(2, 2, 74, 79),
                        area=3025,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="fg-258",
                        source_pixel_bbox=(45, 137, 727, 426),
                        area=77010,
                        classification="complex_whole_visual",
                        confidence=0.86,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="fg-283",
                        source_pixel_bbox=(778, 350, 798, 426),
                        area=251,
                        classification="uncertain",
                        confidence=0.0,
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual(native_shapes, [])
        self.assertEqual([candidate.candidate_id for candidate in bitmap_candidates], ["fg-258"])

    def test_reconstruction_targets_keep_real_edge_touching_and_large_complex_visuals(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _plan_reconstruction_targets

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (800, 450), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.rectangle((0, 80, 120, 340), fill="#2563EB")
            draw.rectangle((30, 20, 790, 430), outline="#DC2626", width=8)
            image.save(source)

            native_shapes, bitmap_candidates = _plan_reconstruction_targets(
                [
                    ForegroundCandidate(
                        candidate_id="edge-real",
                        source_pixel_bbox=(0, 80, 121, 341),
                        area=31581,
                        classification="complex_whole_visual",
                        confidence=0.86,
                        provenance={"detection": "source_base_difference"},
                    ),
                    ForegroundCandidate(
                        candidate_id="large-real",
                        source_pixel_bbox=(30, 20, 790, 430),
                        area=311600,
                        classification="complex_whole_visual",
                        confidence=0.86,
                        provenance={"detection": "source_base_difference"},
                    ),
                ],
                source_image_path=str(source),
            )

        self.assertEqual(native_shapes, [])
        self.assertEqual(
            [candidate.candidate_id for candidate in bitmap_candidates],
            ["edge-real", "large-real"],
        )

    def test_text_exclusion_mask_adds_local_detected_text_when_ocr_bbox_is_misaligned(self):
        from PIL import Image, ImageDraw, ImageFont

        from src.generative_editable_manifest import TextBoxSpec
        from src.generative_editable_pipeline import _create_text_exclusion_mask

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (420, 220), "#0F172A")
            draw = ImageDraw.Draw(image)
            draw.text((220, 130), "AUDIO", fill="#F8FAFC", font=ImageFont.load_default())
            image.save(source)

            mask = _create_text_exclusion_mask(
                source_image_path=source,
                source_image_size=image.size,
                text_boxes=[
                    TextBoxSpec(
                        text="AUDIO",
                        source_pixel_bbox=(20, 20, 110, 44),
                        source_pixel_polygon=((20, 20), (110, 20), (110, 44), (20, 44)),
                    )
                ],
            )

        self.assertEqual(mask.getpixel((225, 135)), 255)
        self.assertEqual(mask.getpixel((24, 24)), 255)

    def test_text_exclusion_mask_does_not_add_unmatched_visual_highlights(self):
        from PIL import Image, ImageDraw, ImageFont

        from src.generative_editable_manifest import TextBoxSpec
        from src.generative_editable_pipeline import _create_text_exclusion_mask

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            image = Image.new("RGB", (420, 220), "#0F172A")
            draw = ImageDraw.Draw(image)
            draw.text((28, 24), "TITLE", fill="#F8FAFC", font=ImageFont.load_default())
            draw.rectangle((250, 130, 360, 165), fill="#38BDF8")
            image.save(source)

            mask = _create_text_exclusion_mask(
                source_image_path=source,
                source_image_size=image.size,
                text_boxes=[
                    TextBoxSpec(
                        text="TITLE",
                        source_pixel_bbox=(28, 24, 80, 42),
                        source_pixel_polygon=((28, 24), (80, 24), (80, 42), (28, 42)),
                    )
                ],
            )

        self.assertEqual(mask.getpixel((32, 28)), 255)
        self.assertEqual(mask.getpixel((300, 145)), 0)

    def test_pipeline_adds_source_native_shapes_even_when_base_clean_provider_returns_candidates(
        self,
    ):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_manifest import read_deck_manifest, read_page_manifest
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        config = load_generative_editable_config(use_fake=True)

        class OneItemOCRProvider(OCRProvider):
            def extract_text(self, image_path):
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(240, 140),
                    provider_role=self.config.role,
                    provider_name=self.config.provider,
                    model=self.config.model,
                    items=[
                        OCRTextItem(
                            text="Shape test",
                            bbox=(8, 2, 92, 14),
                            polygon=((8, 2), (92, 2), (92, 14), (8, 14)),
                            confidence=0.98,
                        )
                    ],
                )

        def fake_planner(**kwargs):
            return [
                ForegroundCandidate(
                    candidate_id="fg-rounded",
                    source_pixel_bbox=(30, 20, 131, 71),
                    area=5151,
                    classification="uncertain",
                    confidence=0.0,
                ),
                ForegroundCandidate(
                    candidate_id="fg-line",
                    source_pixel_bbox=(148, 78, 223, 113),
                    area=2625,
                    classification="uncertain",
                    confidence=0.0,
                ),
            ]

        def accept_bitmap_candidates_without_assets(**kwargs):
            return AssetBuildResult(bitmap_assets=[])

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            image = Image.new("RGB", (240, 140), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.rounded_rectangle(
                (30, 20, 130, 70), radius=12, fill="#FEF3C7", outline="#D97706", width=3
            )
            draw.line((150, 110, 220, 80), fill="#7C3AED", width=5)
            image.save(source)

            result = run_generative_editable_pipeline(
                slides=[GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source))],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=OneItemOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=fake_planner,
                    asset_builder=accept_bitmap_candidates_without_assets,
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page = read_page_manifest(artifact_root / "job-1" / deck.page_manifest_paths[0])

        self.assertEqual(result.status, "passed")
        self.assertEqual(
            [shape.shape_type for shape in page.native_shapes], ["rounded_rectangle", "line"]
        )
        self.assertEqual(page.bitmap_assets, [])
        self.assertEqual(
            page.chosen_background,
            "backgrounds/0000-slide-a/local-reconstruction-background.png",
        )

    def test_local_reconstruction_background_samples_outside_large_native_shapes(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_pipeline import (
            _create_local_reconstruction_background,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "source.png"
            output_path = root / "backgrounds" / "local.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (800, 450), "#FFFFFF")
            ImageDraw.Draw(image).rectangle((40, 40, 760, 360), fill="#2563EB")
            image.save(source)

            result = _create_local_reconstruction_background(
                source_image_path=source,
                output_asset_path=output_path,
                asset_root=root,
                foreground_bboxes=[(40, 40, 760, 360)],
            )
            with Image.open(output_path) as background:
                sampled = background.getpixel((400, 200))

        self.assertEqual(result.strategy, "local_fill")
        self.assertEqual(sampled, (255, 255, 255))

    def test_default_asset_sheet_falls_back_to_image_generation_when_edit_fails(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import (
            ImageEditProvider,
            ImageGenerationProvider,
            ImageGenerationRequest,
            ImageGenerationResult,
            ProviderError,
        )

        class FailingAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="failing-edit",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="asset sheet edit failed",
                    retryable=False,
                )

        class RecordingGenerationProvider(ImageGenerationProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="image_model",
                        provider="recording-generation",
                        model="image",
                        base_url="",
                        api_key="",
                    )
                )
                self.requests: list[ImageGenerationRequest] = []

            def generate(self, request):
                self.requests.append(request)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGBA", (800, 450), (0, 0, 0, 0))
                ImageDraw.Draw(image).ellipse((500, 140, 610, 210), fill=(16, 185, 129, 255))
                image.save(output)
                return ImageGenerationResult(
                    output_asset_path=str(output),
                    prompt_id=request.prompt_id,
                    provider_role=self.config.role,
                    provider_name=self.config.provider,
                    model=self.config.model,
                    timeout_seconds=request.timeout_seconds,
                    visual_reference=dict(request.visual_reference),
                )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            Image.new("RGB", (800, 450), "white").save(source)
            generation_provider = RecordingGenerationProvider()

            result = _build_default_assets(
                source_image_path=str(source),
                candidates=[
                    ForegroundCandidate(
                        candidate_id="asset-001",
                        source_pixel_bbox=(480, 118, 626, 224),
                        area=15476,
                        classification="bitmap_asset_candidate",
                        confidence=0.91,
                    )
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=generation_provider,
                image_edit_provider=FailingAssetSheetEditProvider(),
                slide_id="slide-a",
                page_index=0,
            )

        self.assertEqual(len(generation_provider.requests), 1)
        self.assertEqual(generation_provider.requests[0].prompt_id, "asset_sheet")
        self.assertEqual(result.bitmap_assets[0].asset_id, "asset-001")
        self.assertEqual(result.asset_sheets[0].provider_role, "image_model")
        self.assertEqual(result.asset_sheets[0].provenance["fallback_from"], "image_edit")

    def test_default_asset_sheet_splits_rearranged_sheet_components_not_source_bboxes(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider

        class RearrangedAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="rearranged-sheet",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGBA", (120, 80), (0, 0, 0, 0))
                draw = ImageDraw.Draw(image)
                draw.rectangle((10, 12, 34, 34), fill=(37, 99, 235, 255))
                draw.ellipse((72, 18, 104, 50), fill=(16, 185, 129, 255))
                image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (800, 450), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((500, 300, 620, 380), fill=(37, 99, 235))
            draw.ellipse((650, 310, 760, 420), fill=(16, 185, 129))
            image.save(source)

            result = _build_default_assets(
                source_image_path=str(source),
                candidates=[
                    ForegroundCandidate(
                        candidate_id="blue-block",
                        source_pixel_bbox=(500, 300, 621, 381),
                        area=9801,
                        classification="bitmap_asset_candidate",
                        confidence=0.91,
                    ),
                    ForegroundCandidate(
                        candidate_id="green-dot",
                        source_pixel_bbox=(650, 310, 761, 421),
                        area=12321,
                        classification="bitmap_asset_candidate",
                        confidence=0.91,
                    ),
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=None,
                image_edit_provider=RearrangedAssetSheetEditProvider(),
                slide_id="slide-a",
                page_index=0,
            )

            asset_paths = [root / asset.asset_path for asset in result.bitmap_assets]
            asset_sizes = []
            asset_pixels = []
            for path in asset_paths:
                with Image.open(path) as asset_image:
                    asset_sizes.append(asset_image.size)
                    asset_pixels.append(asset_image.convert("RGBA").getbbox())

        self.assertEqual(
            [asset.asset_id for asset in result.bitmap_assets], ["blue-block", "green-dot"]
        )
        self.assertEqual(len(result.asset_sheets), 1)
        self.assertTrue(all(size[0] < 80 and size[1] < 80 for size in asset_sizes))
        self.assertTrue(all(bbox is not None for bbox in asset_pixels))
        self.assertNotIn("fallback", result.bitmap_assets[0].provenance)
        self.assertEqual(result.bitmap_assets[0].provenance["split_method"], "connected_components")

    def test_default_asset_sheet_batches_large_candidate_sets_before_slicing(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider

        class BatchLimitedAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="batch-limited-sheet",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )
                self.batch_sizes: list[int] = []

            def edit(self, request):
                candidate_count = len(request.metadata["candidate_boxes"])
                self.batch_sizes.append(candidate_count)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGBA", (420, 90), (0, 0, 0, 0))
                draw = ImageDraw.Draw(image)
                for index in range(min(candidate_count, 6)):
                    left = 12 + index * 66
                    draw.rectangle((left, 16, left + 28, 46), fill=(37, 99, 235, 255))
                image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            Image.new("RGB", (900, 500), "white").save(source)
            provider = BatchLimitedAssetSheetEditProvider()

            result = _build_default_assets(
                source_image_path=str(source),
                candidates=[
                    ForegroundCandidate(
                        candidate_id=f"asset-{index:03d}",
                        source_pixel_bbox=(20 + index * 30, 100, 44 + index * 30, 124),
                        area=576,
                        classification="bitmap_asset_candidate",
                        confidence=0.91,
                    )
                    for index in range(7)
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=None,
                image_edit_provider=provider,
                slide_id="slide-a",
                page_index=0,
            )

        self.assertEqual(provider.batch_sizes, [6, 1])
        self.assertEqual(len(result.asset_sheets), 2)
        self.assertEqual(
            [asset.asset_id for asset in result.bitmap_assets],
            [f"asset-{index:03d}" for index in range(7)],
        )
        self.assertEqual(
            [sheet.candidate_ids for sheet in result.asset_sheets],
            [[f"asset-{index:03d}" for index in range(6)], ["asset-006"]],
        )

    def test_default_asset_sheet_raises_when_all_providers_fail(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import (
            ImageEditProvider,
            ImageGenerationProvider,
            ProviderError,
        )

        class FailingAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="failing-edit",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="asset sheet edit failed",
                    retryable=False,
                )

        class FailingGenerationProvider(ImageGenerationProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="image_model",
                        provider="failing-generation",
                        model="image",
                        base_url="",
                        api_key="",
                    )
                )

            def generate(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="asset sheet generation failed",
                    retryable=False,
                )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (120, 80), "white")
            ImageDraw.Draw(image).rectangle((10, 12, 50, 42), fill="#2563EB")
            image.save(source)

            with self.assertRaises(ProviderError):
                _build_default_assets(
                    source_image_path=str(source),
                    candidates=[
                        ForegroundCandidate(
                            candidate_id="asset-001",
                            source_pixel_bbox=(10, 12, 51, 43),
                            area=1271,
                            classification="bitmap_asset_candidate",
                            confidence=0.91,
                        )
                    ],
                    output_dir=str(root / "assets" / "0000-slide-a"),
                    asset_root=str(root),
                    image_generation_provider=FailingGenerationProvider(),
                    image_edit_provider=FailingAssetSheetEditProvider(),
                    slide_id="slide-a",
                    page_index=0,
                )

    def test_explicit_source_crop_fallback_handles_asset_sheet_provider_failure(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import (
            ImageEditProvider,
            ImageGenerationProvider,
            ProviderError,
        )

        class FailingAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="failing-edit",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="asset sheet edit failed",
                    retryable=False,
                )

        class FailingGenerationProvider(ImageGenerationProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="image_model",
                        provider="failing-generation",
                        model="image",
                        base_url="",
                        api_key="",
                    )
                )

            def generate(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="asset sheet generation failed",
                    retryable=False,
                )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (120, 80), "white")
            ImageDraw.Draw(image).rectangle((10, 12, 50, 42), fill="#2563EB")
            image.save(source)

            result = _build_default_assets(
                source_image_path=str(source),
                candidates=[
                    ForegroundCandidate(
                        candidate_id="asset-001",
                        source_pixel_bbox=(10, 12, 51, 43),
                        area=1271,
                        classification="bitmap_asset_candidate",
                        confidence=0.91,
                    )
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=FailingGenerationProvider(),
                image_edit_provider=FailingAssetSheetEditProvider(),
                slide_id="slide-a",
                page_index=0,
                allow_source_crop_fallback=True,
            )

            asset_path = root / result.bitmap_assets[0].asset_path
            self.assertTrue(asset_path.is_file())
            with Image.open(asset_path) as asset:
                asset_size = asset.size

        self.assertEqual(result.asset_sheets, [])
        self.assertEqual(result.bitmap_assets[0].asset_id, "asset-001")
        self.assertEqual(
            result.bitmap_assets[0].provenance["fallback"], "source_crop_after_asset_sheet_failure"
        )
        self.assertEqual(result.provider_output_payload["asset_sheet_fallback"], "source_crops")
        self.assertEqual(asset_size, (41, 31))

    def test_default_asset_sheet_raises_when_provider_writes_invalid_image(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider, ProviderError

        class CorruptAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="corrupt-edit",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"not a png")
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (120, 80), "white")
            ImageDraw.Draw(image).rectangle((10, 12, 50, 42), fill="#2563EB")
            image.save(source)

            with self.assertRaises(ProviderError):
                _build_default_assets(
                    source_image_path=str(source),
                    candidates=[
                        ForegroundCandidate(
                            candidate_id="asset-001",
                            source_pixel_bbox=(10, 12, 51, 43),
                            area=1271,
                            classification="bitmap_asset_candidate",
                            confidence=0.91,
                        )
                    ],
                    output_dir=str(root / "assets" / "0000-slide-a"),
                    asset_root=str(root),
                    image_generation_provider=None,
                    image_edit_provider=CorruptAssetSheetEditProvider(),
                    slide_id="slide-a",
                    page_index=0,
                )

    def test_default_asset_sheet_raises_on_provider_asset_mismatch(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider, ProviderError

        class WrongAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="wrong-sheet",
                        model="wrong-sheet",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGBA", (800, 450), (0, 0, 0, 0)).save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (800, 450), "white")
            ImageDraw.Draw(image).rectangle(
                (80, 172, 279, 301), fill="#DCFCE7", outline="#16A34A", width=3
            )
            image.save(source)

            with self.assertRaises(ProviderError):
                _build_default_assets(
                    source_image_path=str(source),
                    candidates=[
                        ForegroundCandidate(
                            candidate_id="asset-001",
                            source_pixel_bbox=(80, 172, 281, 303),
                            area=26000,
                            classification="bitmap_asset_candidate",
                            confidence=0.91,
                        )
                    ],
                    output_dir=str(root / "assets" / "0000-slide-a"),
                    asset_root=str(root),
                    image_generation_provider=None,
                    image_edit_provider=WrongAssetSheetEditProvider(),
                    slide_id="slide-a",
                    page_index=0,
                )

    def test_complex_whole_visual_uses_masked_source_element_without_provider_redraw(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider

        class FailingIfCalledAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="should-not-be-called",
                        model="should-not-be-called",
                        base_url="",
                        api_key="",
                    )
                )
                self.calls = 0

            def edit(self, request):
                self.calls += 1
                raise AssertionError("complex visual should not be redrawn by asset-sheet provider")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (800, 450), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.polygon(
                [(90, 360), (250, 250), (430, 310), (700, 170), (700, 383), (90, 383)],
                fill="#DBEAFE",
            )
            draw.line(
                [(100, 330), (190, 260), (290, 286), (398, 198), (520, 224), (680, 146)],
                fill="#2563EB",
                width=4,
            )
            image.save(source)
            background = root / "background.png"
            Image.new("RGB", (800, 450), "#F8FAFC").save(background)
            text_mask = root / "text-mask.png"
            mask = Image.new("L", (800, 450), 0)
            ImageDraw.Draw(mask).rectangle((120, 180, 300, 230), fill=255)
            mask.save(text_mask)
            provider = FailingIfCalledAssetSheetEditProvider()

            result = _build_default_assets(
                source_image_path=str(source),
                background_reference_image_path=str(background),
                text_mask_path=str(text_mask),
                candidates=[
                    ForegroundCandidate(
                        candidate_id="fg-258",
                        source_pixel_bbox=(45, 137, 727, 426),
                        area=77010,
                        classification="complex_whole_visual",
                        confidence=0.86,
                        provenance={"reason": "large_or_visually_complex"},
                    )
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=None,
                image_edit_provider=provider,
                slide_id="slide-a",
                page_index=0,
            )

            self.assertEqual(provider.calls, 0)
            self.assertEqual([asset.asset_id for asset in result.bitmap_assets], ["fg-258"])
            self.assertEqual(
                result.bitmap_assets[0].provenance["asset_strategy"], "masked_source_element"
            )
            self.assertFalse(result.bitmap_assets[0].provenance["text_mask_applied"])
            self.assertFalse(result.bitmap_assets[0].provenance["background_difference_alpha"])
            with Image.open(root / result.bitmap_assets[0].asset_path) as asset_image:
                alpha = asset_image.convert("RGBA").getchannel("A")
                self.assertEqual(alpha.getextrema(), (255, 255))
            self.assertEqual(
                result.provider_output_payload["asset_strategy"], "masked_source_elements"
            )

    def test_complex_whole_visual_skips_multi_component_asset_sheet_slicing(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider

        class MultiComponentAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="multi-component-sheet",
                        model="multi-component-sheet",
                        base_url="",
                        api_key="",
                    )
                )
                self.calls = 0

            def edit(self, request):
                self.calls += 1
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                image = Image.new("RGBA", (240, 120), (0, 0, 0, 0))
                draw = ImageDraw.Draw(image)
                draw.rectangle((24, 36, 84, 84), fill=(37, 99, 235, 255))
                draw.rectangle((148, 36, 208, 84), fill=(16, 185, 129, 255))
                image.save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (300, 180), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((40, 60, 100, 108), fill="#2563EB")
            draw.rectangle((164, 60, 224, 108), fill="#10B981")
            image.save(source)
            provider = MultiComponentAssetSheetEditProvider()

            result = _build_default_assets(
                source_image_path=str(source),
                candidates=[
                    ForegroundCandidate(
                        candidate_id="fg-complex",
                        source_pixel_bbox=(32, 52, 232, 116),
                        area=8832,
                        classification="complex_whole_visual",
                        confidence=0.86,
                    )
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=None,
                image_edit_provider=provider,
                slide_id="slide-a",
                page_index=0,
            )

        self.assertEqual([asset.asset_id for asset in result.bitmap_assets], ["fg-complex"])
        self.assertEqual(provider.calls, 0)
        self.assertEqual(
            result.bitmap_assets[0].provenance["asset_strategy"], "masked_source_element"
        )

    def test_complex_singleton_preservation_keeps_candidate_crop_without_provider_input(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import _build_default_assets
        from src.generative_editable_providers import ImageEditProvider

        class RecordingCropAssetSheetEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="crop-sheet",
                        model="crop-sheet",
                        base_url="",
                        api_key="",
                    )
                )
                self.source_image_paths: list[str] = []
                self.prompts: list[str] = []

            def edit(self, request):
                self.source_image_paths.append(request.source_image_path)
                self.prompts.append(request.prompt)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                with Image.open(request.source_image_path) as source:
                    source.convert("RGBA").save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (300, 180), "white")
            draw = ImageDraw.Draw(image)
            draw.rectangle((40, 60, 100, 108), fill="#2563EB")
            draw.rectangle((164, 60, 224, 108), fill="#10B981")
            image.save(source)
            provider = RecordingCropAssetSheetEditProvider()

            result = _build_default_assets(
                source_image_path=str(source),
                asset_reference_image_path=str(source),
                candidates=[
                    ForegroundCandidate(
                        candidate_id="fg-complex",
                        source_pixel_bbox=(32, 52, 232, 116),
                        area=8832,
                        classification="complex_whole_visual",
                        confidence=0.86,
                    )
                ],
                output_dir=str(root / "assets" / "0000-slide-a"),
                asset_root=str(root),
                image_generation_provider=None,
                image_edit_provider=provider,
                slide_id="slide-a",
                page_index=0,
            )
            crop_path = root / result.bitmap_assets[0].asset_path
            with Image.open(crop_path) as crop:
                crop_size = crop.size

        self.assertEqual(provider.source_image_paths, [])
        self.assertEqual(crop_size, (200, 64))
        self.assertIn("assets", crop_path.parts)
        self.assertEqual(
            result.bitmap_assets[0].provenance["asset_strategy"], "masked_source_element"
        )

    def test_orchestration_text_validation_failure_blocks_success(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_page_manifest
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            GenerativeEditableValidationError,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            with self.assertRaises(GenerativeEditableValidationError) as ctx:
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(source_path),
                            text_metadata=[
                                {
                                    "text": "Unmatched title",
                                    "role": "title",
                                    "order": 99,
                                }
                            ],
                        )
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=FakeOCRProvider(config.ocr),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        composer=fake_composer,
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                    ),
                )

            page_manifest = read_page_manifest(
                artifact_root / "job-1" / "pages" / "0000-slide-a.json"
            )

            self.assertEqual(page_manifest.validation_status, "failed")
            self.assertIn("metadata_unmatched", str(ctx.exception))

    def test_orchestration_blocks_when_visual_text_candidate_is_not_covered_by_ocr(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_page_manifest
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            GenerativeEditableValidationError,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class TwoDomainOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                if "visual-text-candidate" in image_path:
                    return OCRResult(
                        source_image_path=image_path,
                        image_size=(100, 34),
                        provider_role="ocr_model",
                        provider_name="test_ocr",
                        model="test",
                        items=[],
                    )
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(800, 450),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="智能域",
                            bbox=(120, 90, 220, 124),
                            polygon=((120, 90), (220, 90), (220, 124), (120, 124)),
                            confidence=0.95,
                        ),
                        OCRTextItem(
                            text="动力域",
                            bbox=(120, 310, 220, 344),
                            polygon=((120, 310), (220, 310), (220, 344), (120, 344)),
                            confidence=0.95,
                        ),
                    ],
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            with self.assertRaises(GenerativeEditableValidationError) as ctx:
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(source_path),
                        )
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=TwoDomainOCRProvider(config.ocr),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        visual_text_candidate_detector=lambda **kwargs: [
                            (120, 90, 220, 124),
                            (120, 200, 220, 234),
                            (120, 310, 220, 344),
                        ],
                        composer=fake_composer,
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                    ),
                )

            page_manifest = read_page_manifest(
                artifact_root / "job-1" / "pages" / "0000-slide-a.json"
            )

            self.assertEqual(page_manifest.validation_status, "failed")
            self.assertIn("visual_text_candidate_missing_ocr_text", str(ctx.exception))
            self.assertEqual(
                page_manifest.provenance["text_issues"][0]["code"],
                "visual_text_candidate_missing_ocr_text",
            )

    def test_orchestration_recovers_visual_text_candidate_with_focused_crop_ocr(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_page_manifest
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class RecoveringOCRProvider(OCRProvider):
            def extract_text(self, image_path: str) -> OCRResult:
                if "visual-text-candidate" in image_path:
                    return OCRResult(
                        source_image_path=image_path,
                        image_size=(100, 34),
                        provider_role="ocr_model",
                        provider_name="test_ocr",
                        model="test",
                        items=[
                            OCRTextItem(
                                text="底盘域",
                                bbox=(0, 0, 100, 34),
                                polygon=((0, 0), (100, 0), (100, 34), (0, 34)),
                                confidence=0.96,
                            )
                        ],
                    )
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(800, 450),
                    provider_role="ocr_model",
                    provider_name="test_ocr",
                    model="test",
                    items=[
                        OCRTextItem(
                            text="智能域",
                            bbox=(120, 90, 220, 124),
                            polygon=((120, 90), (220, 90), (220, 124), (120, 124)),
                            confidence=0.95,
                        ),
                        OCRTextItem(
                            text="动力域",
                            bbox=(120, 310, 220, 344),
                            polygon=((120, 310), (220, 310), (220, 344), (120, 344)),
                            confidence=0.95,
                        ),
                    ],
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=RecoveringOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    visual_text_candidate_detector=lambda **kwargs: [
                        (120, 90, 220, 124),
                        (120, 200, 220, 234),
                        (120, 310, 220, 344),
                    ],
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

            page_manifest = read_page_manifest(
                artifact_root / "job-1" / "pages" / "0000-slide-a.json"
            )

        self.assertEqual(page_manifest.validation_status, "passed")
        self.assertEqual(
            [box.text for box in page_manifest.text_boxes], ["智能域", "动力域", "底盘域"]
        )
        self.assertEqual(page_manifest.text_boxes[-1].source_pixel_bbox, (120, 200, 220, 234))
        self.assertEqual(page_manifest.provenance["text_issues"], [])

    def test_deck_manifest_records_configured_preview_similarity_threshold(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import read_deck_manifest
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FakeOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    preview_similarity_threshold=0.87,
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")

        self.assertEqual(deck.quality_settings["preview_similarity_threshold"], 0.87)

    def test_pipeline_passes_configured_provider_timeout_to_background_edits(self):
        from PIL import Image, ImageDraw

        from src.generative_editable_config import ProviderConfig, load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageGenerationProvider,
            ImageEditProvider,
            ImageEditResult,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class LargeMaskOCRProvider(OCRProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="ocr_model",
                        provider="large-mask-ocr",
                        model="ocr",
                        base_url="",
                        api_key="",
                    )
                )

            def extract_text(self, image_path):
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(160, 90),
                    provider_role=self.config.role,
                    provider_name=self.config.provider,
                    model=self.config.model,
                    items=[
                        OCRTextItem(
                            text="Title",
                            bbox=(20, 10, 145, 72),
                            polygon=((20, 10), (145, 10), (145, 72), (20, 72)),
                            confidence=0.99,
                        )
                    ],
                )

        class RecordingEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="recording-edit",
                        model="edit",
                        base_url="",
                        api_key="",
                    )
                )
                self.calls = []

            def edit(self, request):
                self.calls.append(request)
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.open(request.source_image_path).save(output)
                return ImageEditResult(
                    output_asset_path=str(output),
                    source_image_path=request.source_image_path,
                    prompt_id=request.prompt_id,
                    provider_role=self.config.role,
                    provider_name=self.config.provider,
                    model=self.config.model,
                    timeout_seconds=request.timeout_seconds,
                    mask_path=request.mask_path,
                )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            image = Image.new("RGB", (160, 90), "#FFFFFF")
            draw = ImageDraw.Draw(image)
            for x in range(160):
                for y in range(90):
                    draw.point((x, y), fill=((x * 7) % 255, (y * 11) % 255, (x + y) % 255))
            image.save(source_path)
            edit_provider = RecordingEditProvider()

            run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(slide_id="slide-a", image_path=str(source_path))
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=LargeMaskOCRProvider(),
                    image_edit_provider=edit_provider,
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    provider_timeout_seconds=37,
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

        timeouts = {call.prompt_id: call.timeout_seconds for call in edit_provider.calls}
        self.assertEqual(timeouts["text_clean_background"], 37)
        self.assertEqual(timeouts["base_clean_background"], 37)

    def test_explicit_fallback_handles_orchestration_exception(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)

        def failing_composer(deck_manifest_path, artifact_root, output_path):
            raise RuntimeError("composer unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            fallback_path = Path(tmp) / "fallback.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                fallback_policy="raster_pptx",
                fallback_output_factory=lambda: (
                    fallback_path.write_bytes(b"raster") and str(fallback_path)
                ),
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FakeOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    composer=failing_composer,
                ),
            )

            self.assertEqual(result.status, "fallback_used")
            self.assertEqual(result.output_path, str(fallback_path))
            self.assertIn("pipeline_orchestration_failed", str(result.validation_report.issues[0]))

    def test_explicit_fallback_handles_provider_error(self):
        from PIL import Image

        from src.generative_editable_config import ProviderConfig, load_generative_editable_config
        from src.generative_editable_foreground_planner import ForegroundCandidate
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
            OCRProvider,
            ImageEditProvider,
            ProviderError,
        )

        class FailingOCRProvider(OCRProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="ocr_model",
                        provider="failing-ocr",
                        model="ocr",
                        base_url="",
                        api_key="",
                    )
                )

            def extract_text(self, image_path):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation="extract_text",
                    message="ocr unavailable",
                    retryable=False,
                )

        config = load_generative_editable_config(use_fake=True)

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            fallback_path = Path(tmp) / "fallback.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                fallback_policy="raster_pptx",
                fallback_output_factory=lambda: (
                    fallback_path.write_bytes(b"raster") and str(fallback_path)
                ),
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FailingOCRProvider(),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                ),
            )

        self.assertEqual(result.status, "fallback_used")
        self.assertEqual(result.output_path, str(fallback_path))
        self.assertEqual(result.validation_report.issues[0].code, "provider_failure")

        class FailingAssetSheetProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="asset_sheet_model",
                        provider="failing-asset-sheet",
                        model="asset-sheet",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="asset sheet unavailable",
                    retryable=False,
                )

        def fake_planner(**kwargs):
            return [
                ForegroundCandidate(
                    candidate_id="fg-001",
                    source_pixel_bbox=(100, 100, 180, 180),
                    area=6400,
                    classification="bitmap_asset_candidate",
                    confidence=0.92,
                )
            ]

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "asset-source.png"
            output_path = Path(tmp) / "asset-deck.pptx"
            fallback_path = Path(tmp) / "asset-fallback.pptx"
            artifact_root = Path(tmp) / "asset-jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-asset-fallback",
                fallback_policy="raster_pptx",
                fallback_output_factory=lambda: (
                    fallback_path.write_bytes(b"raster") and str(fallback_path)
                ),
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FakeOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    asset_sheet_image_edit_provider=FailingAssetSheetProvider(),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    foreground_planner=fake_planner,
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

        self.assertEqual(result.status, "fallback_used")
        self.assertEqual(result.output_path, str(fallback_path))
        self.assertEqual(result.validation_report.issues[0].code, "provider_failure")

    def test_metadata_first_pipeline_does_not_hide_ocr_provider_failure_by_default(self):
        from PIL import Image

        from src.generative_editable_config import ProviderConfig, load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            ProviderError,
        )

        class FailingOCRProvider(OCRProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="ocr_model",
                        provider="failing-ocr",
                        model="ocr",
                        base_url="",
                        api_key="",
                    )
                )

            def extract_text(self, image_path):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation="extract_text",
                    message="ocr returned unstructured text",
                    retryable=False,
                )

        config = load_generative_editable_config(use_fake=True)

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            with self.assertRaises(ProviderError):
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(source_path),
                            text_metadata=[
                                {
                                    "text": "Metadata Title",
                                    "role": "title",
                                    "order": 1,
                                    "style_hint": {"font_size": 32},
                                }
                            ],
                        )
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=FailingOCRProvider(),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                    ),
                )

    def test_explicit_metadata_layout_fallback_can_be_used_outside_fail_policy(self):
        from PIL import Image

        from src.generative_editable_config import ProviderConfig, load_generative_editable_config
        from src.generative_editable_manifest import read_page_manifest
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            ProviderError,
        )

        class FailingOCRProvider(OCRProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="ocr_model",
                        provider="failing-ocr",
                        model="ocr",
                        base_url="",
                        api_key="",
                    )
                )

            def extract_text(self, image_path):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation="extract_text",
                    message="ocr returned unstructured text",
                    retryable=False,
                )

        config = load_generative_editable_config(use_fake=True)

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                        text_metadata=[
                            {
                                "text": "Metadata Title",
                                "role": "title",
                                "order": 1,
                                "style_hint": {"font_size": 32},
                            }
                        ],
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                fallback_policy="text_editable_background",
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FailingOCRProvider(),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    allow_metadata_ocr_fallback=True,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )
            page = read_page_manifest(artifact_root / "job-1" / "pages" / "0000-slide-a.json")

        self.assertEqual(result.status, "passed")
        self.assertEqual(page.text_boxes[0].text, "Metadata Title")
        self.assertEqual(
            page.text_boxes[0].provenance["ocr_provenance"]["fallback"], "ocr_provider_failed"
        )

    def test_pipeline_uses_configured_ocr_min_confidence(self):
        from PIL import Image

        from src.generative_editable_config import ProviderConfig, load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            GenerativeEditableValidationError,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            OCRProvider,
            OCRResult,
            OCRTextItem,
        )

        class LowConfidenceOCRProvider(OCRProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="ocr_model",
                        provider="low-confidence-ocr",
                        model="ocr",
                        base_url="",
                        api_key="",
                    )
                )

            def extract_text(self, image_path):
                return OCRResult(
                    source_image_path=image_path,
                    image_size=(800, 450),
                    provider_role=self.config.role,
                    provider_name=self.config.provider,
                    model=self.config.model,
                    items=[
                        OCRTextItem(
                            text="Low Confidence",
                            bbox=(80, 60, 280, 110),
                            polygon=((80, 60), (280, 60), (280, 110), (80, 110)),
                            confidence=0.8,
                        )
                    ],
                )

        config = load_generative_editable_config(use_fake=True)

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            with self.assertRaises(GenerativeEditableValidationError) as ctx:
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(source_path),
                        )
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=LowConfidenceOCRProvider(),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        ocr_min_confidence=0.95,
                    ),
                )

        self.assertIn("low_ocr_confidence", str(ctx.exception))

    def test_multi_slide_orchestration_preserves_order_and_aggregates_validation_and_repairs(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_manifest import (
            BitmapAssetSpec,
            RepairAttempt,
            read_deck_manifest,
            read_page_manifest,
        )
        from src.generative_editable_pipeline import (
            AssetBuildResult,
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            GenerativeEditableValidationError,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationIssue, ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)
        active_pages = 0
        max_active_pages = 0
        processed_slide_ids = []
        lock = threading.Lock()
        page_barrier = threading.Barrier(2, timeout=5)

        def fake_asset_builder(**kwargs):
            nonlocal active_pages, max_active_pages
            with lock:
                active_pages += 1
                max_active_pages = max(max_active_pages, active_pages)
            try:
                page_barrier.wait()
                processed_slide_ids.append(kwargs["slide_id"])
                asset = BitmapAssetSpec(
                    asset_id=f"{kwargs['slide_id']}-asset",
                    source_pixel_bbox=(500, 120, 620, 220),
                    asset_path=f"assets/{kwargs['page_index']:04d}-{kwargs['slide_id']}/fg-001.png",
                    z_order=1,
                )
                Path(kwargs["asset_root"], asset.asset_path).parent.mkdir(
                    parents=True, exist_ok=True
                )
                Image.new("RGBA", (120, 100), (0, 0, 0, 0)).save(
                    Path(kwargs["asset_root"], asset.asset_path)
                )
                repair_attempts = []
                if kwargs["slide_id"] == "slide-b":
                    repair_attempts.append(
                        RepairAttempt(
                            target_id=asset.asset_id,
                            attempt_index=1,
                            reason="edge_touch",
                            provider_role="edit_model",
                            status="passed",
                        )
                    )
                return AssetBuildResult(
                    bitmap_assets=[asset],
                    repair_attempts=repair_attempts,
                    provider_output_payload={"candidate_ids": ["should-not-override"]},
                )
            finally:
                with lock:
                    active_pages -= 1

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            deck = read_deck_manifest(deck_manifest_path)
            self.assertEqual(deck.slide_order, ["slide-b", "slide-a"])
            self.assertEqual(
                deck.page_manifest_paths,
                ["pages/0000-slide-b.json", "pages/0001-slide-a.json"],
            )
            Path(output_path).write_bytes(b"fake-pptx")

        def fake_preview_validator(**kwargs):
            if kwargs["slide_id"] == "slide-a":
                return ValidationReport(
                    status="failed",
                    checked_pages=1,
                    issues=[
                        ValidationIssue(
                            code="preview_similarity_failed",
                            message="slide-a differs",
                            slide_id="slide-a",
                        )
                    ],
                )
            return ValidationReport(status="passed", checked_pages=1, issues=[])

        with tempfile.TemporaryDirectory() as tmp:
            slide_b = Path(tmp) / "slide-b.png"
            slide_a = Path(tmp) / "slide-a.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(slide_b)
            Image.new("RGB", (800, 450), "white").save(slide_a)

            with self.assertRaises(GenerativeEditableValidationError) as ctx:
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-b",
                            image_path=str(slide_b),
                        ),
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(slide_a),
                        ),
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    max_page_concurrency=2,
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=FakeOCRProvider(config.ocr),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        asset_builder=fake_asset_builder,
                        composer=fake_composer,
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=fake_preview_validator,
                    ),
                )

            deck = read_deck_manifest(artifact_root / "job-1" / "deck.json")
            page_b = read_page_manifest(artifact_root / "job-1" / "pages" / "0000-slide-b.json")
            page_a = read_page_manifest(artifact_root / "job-1" / "pages" / "0001-slide-a.json")

            self.assertLessEqual(max_active_pages, 2)
            self.assertGreater(max_active_pages, 1)
            self.assertCountEqual(processed_slide_ids, ["slide-b", "slide-a"])
            self.assertEqual(deck.validation_status, "failed")
            self.assertEqual(deck.provenance["max_page_concurrency"], 2)
            self.assertEqual(page_b.validation_status, "passed")
            self.assertEqual(page_a.validation_status, "failed")
            self.assertEqual(page_b.repair_attempts[0].reason, "edge_touch")
            self.assertEqual(
                page_b.provider_output_paths["image_generation"],
                "provider_outputs/image_generation/0000-slide-b/assets.json",
            )
            image_generation_payload = (
                artifact_root / "job-1" / page_b.provider_output_paths["image_generation"]
            ).read_text(encoding="utf-8")
            self.assertIn("slide-b-asset", image_generation_payload)
            self.assertNotIn("should-not-override", image_generation_payload)
            self.assertIn("preview_similarity_failed", str(ctx.exception))
            self.assertEqual(ctx.exception.validation_report.checked_pages, 2)

    def test_cleanup_artifacts_runs_after_validation_failure_when_requested(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            GenerativeEditableValidationError,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationIssue, ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            with self.assertRaises(GenerativeEditableValidationError):
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(source_path),
                        )
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    cleanup_artifacts=True,
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=FakeOCRProvider(config.ocr),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        composer=fake_composer,
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="failed",
                            checked_pages=1,
                            issues=[
                                ValidationIssue(
                                    code="preview_similarity_failed",
                                    message="differs",
                                    slide_id="slide-a",
                                )
                            ],
                        ),
                    ),
                )

            self.assertFalse((artifact_root / "job-1").exists())
            self.assertTrue(output_path.exists())

    def test_cleanup_rejects_output_inside_job_artifacts(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            artifact_root = Path(tmp) / "jobs"
            output_path = artifact_root / "job-1" / "deck.pptx"
            Image.new("RGB", (800, 450), "white").save(source_path)

            with self.assertRaisesRegex(ValueError, "output_path must not be inside"):
                run_generative_editable_pipeline(
                    slides=[
                        GenerativeEditableSlideInput(
                            slide_id="slide-a",
                            image_path=str(source_path),
                        )
                    ],
                    output_path=str(output_path),
                    artifact_root=str(artifact_root),
                    job_id="job-1",
                    cleanup_artifacts=True,
                    dependencies=GenerativeEditablePipelineDependencies(
                        ocr_provider=FakeOCRProvider(config.ocr),
                        image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                        image_generation_provider=FakeImageGenerationProvider(
                            config.generation_model
                        ),
                        composer=fake_composer,
                        structure_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                        preview_validator=lambda **kwargs: ValidationReport(
                            status="passed", checked_pages=1, issues=[]
                        ),
                    ),
                )

    def test_successful_pipeline_can_cleanup_job_artifacts_without_removing_output(self):
        from PIL import Image

        from src.generative_editable_config import load_generative_editable_config
        from src.generative_editable_pipeline import (
            GenerativeEditablePipelineDependencies,
            GenerativeEditableSlideInput,
            run_generative_editable_pipeline,
        )
        from src.generative_editable_preview_validator import ValidationReport
        from src.generative_editable_providers import (
            FakeImageEditProvider,
            FakeImageGenerationProvider,
            FakeOCRProvider,
        )

        config = load_generative_editable_config(use_fake=True)

        def fake_composer(deck_manifest_path, artifact_root, output_path):
            Path(output_path).write_bytes(b"fake-pptx")

        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "deck.pptx"
            artifact_root = Path(tmp) / "jobs"
            Image.new("RGB", (800, 450), "white").save(source_path)

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id="slide-a",
                        image_path=str(source_path),
                    )
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="job-1",
                cleanup_artifacts=True,
                dependencies=GenerativeEditablePipelineDependencies(
                    ocr_provider=FakeOCRProvider(config.ocr),
                    image_edit_provider=FakeImageEditProvider(config.clean_base_model),
                    image_generation_provider=FakeImageGenerationProvider(config.generation_model),
                    composer=fake_composer,
                    structure_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                    preview_validator=lambda **kwargs: ValidationReport(
                        status="passed", checked_pages=1, issues=[]
                    ),
                ),
            )

            self.assertEqual(result.status, "passed")
            self.assertTrue(output_path.exists())
            self.assertFalse((artifact_root / "job-1").exists())


if __name__ == "__main__":
    unittest.main()

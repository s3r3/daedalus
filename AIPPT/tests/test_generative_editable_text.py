import unittest

from src.generative_editable_providers import OCRResult, OCRTextItem
from src.generative_editable_text import extract_text_boxes, extract_text_with_validation


class GenerativeEditableTextExtractionTest(unittest.TestCase):
    def test_metadata_first_text_uses_aippt_content_and_ocr_layout_style(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="Quarterly Plan",
                    bbox=(80, 54, 420, 102),
                    polygon=((80, 54), (420, 54), (420, 102), (80, 102)),
                    confidence=0.98,
                    font_family_hint="Arial",
                    font_size_hint=32,
                    style_hints={"weight": "bold", "italic": False},
                    color_hex="#1F2937",
                    alignment="center",
                    provenance={"provider_role": "ocr_model", "item_id": "ocr-1"},
                )
            ],
        )
        metadata = [
            {
                "text": "Quarterly Plan 2026",
                "role": "title",
                "order": 1,
                "style_hint": {"font_family": "Aptos Display"},
            }
        ]

        boxes = extract_text_boxes(metadata, ocr)

        self.assertEqual(len(boxes), 1)
        box = boxes[0]
        self.assertEqual(box.text, "Quarterly Plan 2026")
        self.assertEqual(box.source_pixel_bbox, (80, 54, 420, 102))
        self.assertEqual(box.source_pixel_polygon, ((80, 54), (420, 54), (420, 102), (80, 102)))
        self.assertEqual(box.font_family, "Aptos Display")
        self.assertEqual(box.font_size, 32)
        self.assertEqual(box.color_hex, "#1F2937")
        self.assertEqual(box.alignment, "center")
        self.assertEqual(box.style_hints["weight"], "bold")
        self.assertEqual(box.provenance["content_source"], "aippt_metadata")
        self.assertEqual(box.provenance["layout_source"], "ocr")

    def test_metadata_first_matches_by_order_when_text_differs_from_ocr(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="First OCR",
                    bbox=(10, 10, 110, 40),
                    polygon=((10, 10), (110, 10), (110, 40), (10, 40)),
                    confidence=0.95,
                ),
                OCRTextItem(
                    text="Second OCR",
                    bbox=(10, 60, 130, 90),
                    polygon=((10, 60), (130, 60), (130, 90), (10, 90)),
                    confidence=0.96,
                ),
            ],
        )
        metadata = [
            {"text": "First Metadata", "role": "body", "order": 1},
            {"text": "Second Metadata", "role": "body", "order": 2},
        ]

        boxes = extract_text_boxes(metadata, ocr)

        self.assertEqual([box.text for box in boxes], ["First Metadata", "Second Metadata"])
        self.assertEqual(boxes[1].source_pixel_bbox, (10, 60, 130, 90))

    def test_metadata_order_uses_one_based_ocr_index_and_falls_back_for_unmatched_ocr(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="OCR One",
                    bbox=(10, 10, 110, 40),
                    polygon=((10, 10), (110, 10), (110, 40), (10, 40)),
                    confidence=0.95,
                ),
                OCRTextItem(
                    text="OCR Two",
                    bbox=(10, 60, 130, 90),
                    polygon=((10, 60), (130, 60), (130, 90), (10, 90)),
                    confidence=0.96,
                    style_hints={"debug": "api_key=style-secret at https://style.example/path"},
                    provenance={"debug": "api_key=secret at https://debug.example/path"},
                ),
            ],
        )
        metadata = [{"text": "Metadata For Second", "role": "body", "order": 2}]

        boxes = extract_text_boxes(metadata, ocr)
        result = extract_text_with_validation(metadata, ocr)

        self.assertEqual([box.text for box in boxes], ["Metadata For Second", "OCR One"])
        self.assertEqual(boxes[0].source_pixel_bbox, (10, 60, 130, 90))
        self.assertEqual(
            [box.text for box in result.text_boxes], ["Metadata For Second", "OCR One"]
        )
        self.assertNotIn("secret", repr(result.text_boxes[0].provenance))
        self.assertNotIn("style-secret", repr(result.text_boxes[0].style_hints))

    def test_extract_text_boxes_rejects_duplicate_metadata_order(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="OCR",
                    bbox=(10, 10, 110, 40),
                    polygon=((10, 10), (110, 10), (110, 40), (10, 40)),
                    confidence=0.95,
                )
            ],
        )

        with self.assertRaisesRegex(ValueError, "duplicate metadata order"):
            extract_text_boxes(
                [
                    {"text": "First", "role": "body", "order": 1},
                    {"text": "Duplicate", "role": "body", "order": 1},
                ],
                ocr,
            )

    def test_ocr_only_fallback_preserves_confidence_and_uses_cjk_safe_font(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="季度计划",
                    bbox=(80, 54, 420, 102),
                    polygon=((80, 54), (420, 54), (420, 102), (80, 102)),
                    confidence=0.88,
                    font_size_hint=28,
                    color_hex="1f2937",
                    alignment="center",
                    provenance={"item_id": "ocr-cjk"},
                )
            ],
        )

        boxes = extract_text_boxes([], ocr)

        self.assertEqual(boxes[0].text, "季度计划")
        self.assertEqual(boxes[0].font_family, "Microsoft YaHei")
        self.assertEqual(boxes[0].font_size, 28)
        self.assertEqual(boxes[0].color_hex, "#1F2937")
        self.assertEqual(boxes[0].alignment, "center")
        self.assertEqual(boxes[0].provenance["content_source"], "ocr")
        self.assertEqual(boxes[0].provenance["ocr_confidence"], 0.88)

    def test_ocr_only_fallback_maps_missing_style_defaults(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="Plain text",
                    bbox=(80, 54, 420, 102),
                    polygon=((80, 54), (420, 54), (420, 102), (80, 102)),
                    confidence=0.91,
                    color_hex="not-a-color",
                    alignment="left",
                )
            ],
        )

        boxes = extract_text_boxes([], ocr)

        self.assertEqual(boxes[0].font_family, "Arial")
        self.assertEqual(boxes[0].font_size, 18)
        self.assertEqual(boxes[0].color_hex, "#000000")
        self.assertEqual(boxes[0].alignment, "left")

    def test_text_validation_fails_when_ocr_returns_no_items_without_metadata(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[],
        )

        result = extract_text_with_validation([], ocr)

        self.assertEqual(result.text_boxes, [])
        self.assertEqual(result.validation_status, "failed")
        self.assertIn("no_ocr_text_detected", [issue["code"] for issue in result.issues])

    def test_ocr_fallback_handles_kana_hangul_and_none_color(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="カタカナ",
                    bbox=(10, 10, 110, 40),
                    polygon=((10, 10), (110, 10), (110, 40), (10, 40)),
                    confidence=0.95,
                    color_hex=None,
                ),
                OCRTextItem(
                    text="한글",
                    bbox=(10, 60, 110, 90),
                    polygon=((10, 60), (110, 60), (110, 90), (10, 90)),
                    confidence=0.95,
                ),
            ],
        )

        boxes = extract_text_boxes([], ocr)

        self.assertEqual(boxes[0].font_family, "Microsoft YaHei")
        self.assertEqual(boxes[0].color_hex, "#000000")
        self.assertEqual(boxes[1].font_family, "Microsoft YaHei")

    def test_text_validation_reports_low_confidence_and_unmatched_metadata(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="Accepted OCR",
                    bbox=(10, 10, 110, 40),
                    polygon=((10, 10), (110, 10), (110, 40), (10, 40)),
                    confidence=0.93,
                ),
                OCRTextItem(
                    text="Low confidence",
                    bbox=(10, 60, 130, 90),
                    polygon=((10, 60), (130, 60), (130, 90), (10, 90)),
                    confidence=0.41,
                ),
            ],
        )
        metadata = [
            {"text": "Accepted Metadata", "role": "body", "order": 1},
            {"text": "Missing Metadata", "role": "body", "order": 3},
        ]

        result = extract_text_with_validation(metadata, ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["Accepted Metadata"])
        self.assertEqual(result.validation_status, "failed")
        self.assertEqual(
            [issue["code"] for issue in result.issues],
            ["low_ocr_confidence", "metadata_unmatched"],
        )
        self.assertEqual(result.issues[0]["ocr_text"], "Low confidence")
        self.assertEqual(result.issues[1]["metadata_text"], "Missing Metadata")

    def test_text_validation_accepts_low_confidence_when_metadata_text_matches_ocr(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="Quarterly Plan",
                    bbox=(82, 68, 148, 78),
                    polygon=((82, 68), (148, 68), (148, 78), (82, 78)),
                    confidence=0.0,
                ),
                OCRTextItem(
                    text="| ILA",
                    bbox=(82, 172, 720, 301),
                    polygon=((82, 172), (720, 172), (720, 301), (82, 301)),
                    confidence=0.52,
                ),
                OCRTextItem(
                    text="a",
                    bbox=(146, 294, 156, 302),
                    polygon=((146, 294), (156, 294), (156, 302), (146, 302)),
                    confidence=0.62,
                ),
            ],
        )
        metadata = [{"text": "Quarterly Plan", "role": "title", "order": 1}]

        result = extract_text_with_validation(metadata, ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["Quarterly Plan"])
        self.assertEqual(
            [issue["code"] for issue in result.issues],
            ["ignored_spurious_ocr", "ignored_spurious_ocr"],
        )
        self.assertEqual(result.issues[0]["severity"], "warning")
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_reports_low_confidence_for_short_text_that_could_be_real(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="Title",
                    bbox=(80, 40, 160, 60),
                    polygon=((80, 40), (160, 40), (160, 60), (80, 60)),
                    confidence=0.98,
                ),
                OCRTextItem(
                    text="AI",
                    bbox=(120, 120, 740, 300),
                    polygon=((120, 120), (740, 120), (740, 300), (120, 300)),
                    confidence=0.52,
                ),
            ],
        )
        metadata = [{"text": "Title", "role": "title", "order": 1}]

        result = extract_text_with_validation(metadata, ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["Title"])
        self.assertEqual([issue["code"] for issue in result.issues], ["low_ocr_confidence"])
        self.assertEqual(result.validation_status, "failed")

    def test_text_validation_reports_low_confidence_for_metadata_match_and_duplicate_order(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="Low metadata OCR",
                    bbox=(10, 10, 110, 40),
                    polygon=((10, 10), (110, 10), (110, 40), (10, 40)),
                    confidence=0.4,
                )
            ],
        )
        metadata = [
            {"text": "First", "role": "body", "order": 1},
            {"text": "Duplicate", "role": "body", "order": 1},
        ]

        result = extract_text_with_validation(metadata, ocr, min_confidence=0.75)

        self.assertEqual(result.text_boxes, [])
        self.assertEqual(
            [issue["code"] for issue in result.issues],
            ["duplicate_metadata_order", "low_ocr_confidence"],
        )

    def test_text_validation_ignores_uniform_fallback_layout_items(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="23",
                    bbox=(20, 360, 780, 390),
                    polygon=((20, 360), (780, 360), (780, 390), (20, 390)),
                    confidence=0.9,
                    provenance={"layout_source": "uniform_fallback"},
                ),
                OCRTextItem(
                    text="真实标题",
                    bbox=(80, 40, 260, 80),
                    polygon=((80, 40), (260, 40), (260, 80), (80, 80)),
                    confidence=0.95,
                ),
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["真实标题"])
        self.assertEqual([issue["code"] for issue in result.issues], ["ignored_spurious_ocr"])
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_blocks_credible_uniform_fallback_text(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="核心架构设计：增程、底盘与智能域",
                    bbox=(40, 40, 760, 90),
                    polygon=((40, 40), (760, 40), (760, 90), (40, 90)),
                    confidence=0.96,
                    provenance={"layout_source": "uniform_fallback"},
                ),
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual(result.text_boxes, [])
        self.assertEqual([issue["code"] for issue in result.issues], ["unreliable_ocr_layout"])
        self.assertEqual(result.validation_status, "failed")

    def test_text_validation_ignores_repetitive_hallucinated_ocr_text(self):
        repeated = "3. 根据用户需求，设计一个符合用户需求、符合用户体验、" * 5
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text=repeated,
                    bbox=(500, 70, 590, 130),
                    polygon=((500, 70), (590, 70), (590, 130), (500, 130)),
                    confidence=0.92,
                ),
                OCRTextItem(
                    text="总结与持续进化",
                    bbox=(180, 180, 420, 230),
                    polygon=((180, 180), (420, 180), (420, 230), (180, 230)),
                    confidence=0.96,
                ),
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["总结与持续进化"])
        self.assertEqual([issue["code"] for issue in result.issues], ["ignored_spurious_ocr"])
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_ignores_approximate_text_that_cannot_fit_bbox(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="禁止驾驶中调后视镜",
                    bbox=(700, 300, 718, 312),
                    polygon=((700, 300), (718, 300), (718, 312), (700, 312)),
                    confidence=0.78,
                    provenance={"approximate_layout": True},
                ),
                OCRTextItem(
                    text="总结与持续进化",
                    bbox=(180, 180, 420, 230),
                    polygon=((180, 180), (420, 180), (420, 230), (180, 230)),
                    confidence=0.96,
                ),
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["总结与持续进化"])
        self.assertEqual([issue["code"] for issue in result.issues], ["ignored_spurious_ocr"])
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_keeps_short_cjk_approximate_text_with_borderline_bbox(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(1672, 941),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="纯电续航",
                    bbox=(898, 257, 955, 291),
                    polygon=((898, 257), (955, 257), (955, 291), (898, 291)),
                    confidence=0.78,
                    provenance={"approximate_layout": True},
                )
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["纯电续航"])
        self.assertEqual(result.issues, [])
        self.assertEqual(result.validation_status, "passed")

    def test_approximate_mid_slide_short_label_font_size_is_capped(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(1672, 941),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="四零重力座椅，",
                    bbox=(169, 455, 486, 504),
                    polygon=((169, 455), (486, 455), (486, 504), (169, 504)),
                    confidence=0.78,
                    font_size_hint=16.87,
                    provenance={"approximate_layout": True},
                )
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["四零重力座椅，"])
        self.assertLessEqual(result.text_boxes[0].font_size or 0, 14.0)

    def test_text_validation_keeps_spatially_distinct_duplicate_approximate_text(self):
        items = [
            OCRTextItem(
                text="优先平板拖运",
                bbox=(100, 100 + index * 50, 240, 130 + index * 50),
                polygon=(
                    (100, 100 + index * 50),
                    (240, 100 + index * 50),
                    (240, 130 + index * 50),
                    (100, 130 + index * 50),
                ),
                confidence=0.78,
                provenance={"approximate_layout": True},
            )
            for index in range(3)
        ]
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=items,
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual(
            [box.text for box in result.text_boxes],
            ["优先平板拖运", "优先平板拖运", "优先平板拖运"],
        )
        self.assertEqual(result.issues, [])
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_dedupes_near_overlapping_approximate_text(self):
        items = [
            OCRTextItem(
                text="优先平板拖运",
                bbox=(100 + index * 4, 100 + index * 3, 240 + index * 4, 130 + index * 3),
                polygon=(
                    (100 + index * 4, 100 + index * 3),
                    (240 + index * 4, 100 + index * 3),
                    (240 + index * 4, 130 + index * 3),
                    (100 + index * 4, 130 + index * 3),
                ),
                confidence=0.78,
                provenance={"approximate_layout": True},
            )
            for index in range(3)
        ]
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=items,
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["优先平板拖运"])
        self.assertEqual(
            [issue["code"] for issue in result.issues],
            ["ignored_spurious_ocr", "ignored_spurious_ocr"],
        )
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_ignores_long_ocr_text_inside_tiny_bbox(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="根据用户需求，设计一个符合用户需求、符合用户体验的页面元素",
                    bbox=(500, 70, 560, 105),
                    polygon=((500, 70), (560, 70), (560, 105), (500, 105)),
                    confidence=0.91,
                ),
                OCRTextItem(
                    text="420 km",
                    bbox=(280, 120, 390, 160),
                    polygon=((280, 120), (390, 120), (390, 160), (280, 160)),
                    confidence=0.96,
                ),
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["420 km"])
        self.assertEqual([issue["code"] for issue in result.issues], ["ignored_spurious_ocr"])
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_caps_duplicate_approximate_layout_text(self):
        items = [
            OCRTextItem(
                text="保持视野清晰",
                bbox=(40 + index * 60, 120 + index * 20, 120 + index * 60, 145 + index * 20),
                polygon=(
                    (40 + index * 60, 120 + index * 20),
                    (120 + index * 60, 120 + index * 20),
                    (120 + index * 60, 145 + index * 20),
                    (40 + index * 60, 145 + index * 20),
                ),
                confidence=0.9,
                provenance={"approximate_layout": True},
            )
            for index in range(4)
        ]
        items.append(
            OCRTextItem(
                text="真实标题",
                bbox=(80, 40, 260, 80),
                polygon=((80, 40), (260, 40), (260, 80), (80, 80)),
                confidence=0.95,
                provenance={"approximate_layout": True},
            )
        )
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=items,
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual(
            [box.text for box in result.text_boxes],
            ["保持视野清晰", "保持视野清晰", "保持视野清晰", "保持视野清晰", "真实标题"],
        )
        self.assertEqual(result.issues, [])
        self.assertEqual(result.validation_status, "passed")

    def test_text_validation_caps_short_approximate_layout_font_size(self):
        ocr = OCRResult(
            source_image_path="slides/slide-a.png",
            image_size=(800, 450),
            provider_role="ocr_model",
            provider_name="fake_ocr",
            model="fake-ocr",
            items=[
                OCRTextItem(
                    text="长期停放",
                    bbox=(120, 200, 320, 286),
                    polygon=((120, 200), (320, 200), (320, 286), (120, 286)),
                    confidence=0.92,
                    font_size_hint=29.6,
                    provenance={"approximate_layout": True},
                )
            ],
        )

        result = extract_text_with_validation([], ocr, min_confidence=0.75)

        self.assertEqual([box.text for box in result.text_boxes], ["长期停放"])
        self.assertLessEqual(result.text_boxes[0].font_size, 14.0)


if __name__ == "__main__":
    unittest.main()

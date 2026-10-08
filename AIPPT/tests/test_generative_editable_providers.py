import base64
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from src.generative_editable_config import ProviderConfig
from src.generative_editable_providers import (
    FakeOCRProvider,
    FakeImageEditProvider,
    FakeImageGenerationProvider,
    ImageGenerationProvider,
    ImageGenerationRequest,
    ImageEditProvider,
    ImageEditRequest,
    OCRProvider,
    OCRTextItem,
    ProviderError,
    ProviderTimeoutError,
    RetryingOCRProvider,
    safe_provider_error_message,
)
from src.generative_editable_providers import _extract_ocr_text_items
from src.generative_editable_providers import _DetectedTextLine, _match_detected_lines_to_text


def _pixel_sha256(path: Path) -> str:
    with Image.open(path) as image:
        return hashlib.sha256(image.tobytes()).hexdigest()


class OCRProviderContractTest(unittest.TestCase):
    def test_fake_ocr_provider_returns_text_layout_style_and_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            provider = FakeOCRProvider(
                ProviderConfig(
                    role="ocr_model",
                    provider="fake_ocr",
                    model="fake-ocr",
                    base_url="",
                    api_key="",
                )
            )

            result = provider.extract_text(str(image_path))

        self.assertEqual(result.source_image_path, str(image_path))
        self.assertEqual(result.image_size, (800, 450))
        self.assertEqual(result.provider_role, "ocr_model")
        self.assertEqual(result.provider_name, "fake_ocr")
        self.assertGreaterEqual(len(result.items), 1)

        item = result.items[0]
        self.assertEqual(item.text, "Quarterly Plan")
        self.assertEqual(item.bbox, (80, 54, 420, 102))
        self.assertEqual(
            item.polygon,
            ((80, 54), (420, 54), (420, 102), (80, 102)),
        )
        self.assertGreaterEqual(item.confidence, 0.9)
        self.assertEqual(item.font_family_hint, "Arial")
        self.assertEqual(item.font_size_hint, 32)
        self.assertEqual(item.style_hints["weight"], "bold")
        self.assertFalse(item.style_hints["italic"])
        self.assertEqual(item.color_hex, "#1F2937")
        self.assertEqual(item.alignment, "center")
        self.assertEqual(item.provenance["provider_role"], "ocr_model")
        self.assertEqual(item.provenance["model"], "fake-ocr")
        self.assertIn("item_id", item.provenance)

    def test_ocr_text_item_validates_geometry_confidence_and_alignment(self):
        with self.assertRaisesRegex(ValueError, "bbox"):
            OCRTextItem(
                text="bad box",
                bbox=(10, 10, 5, 20),
                polygon=((10, 10), (5, 10), (5, 20), (10, 20)),
                confidence=0.9,
            )

        with self.assertRaisesRegex(ValueError, "confidence"):
            OCRTextItem(
                text="bad confidence",
                bbox=(10, 10, 50, 20),
                polygon=((10, 10), (50, 10), (50, 20), (10, 20)),
                confidence=1.5,
            )

        with self.assertRaisesRegex(ValueError, "alignment"):
            OCRTextItem(
                text="bad alignment",
                bbox=(10, 10, 50, 20),
                polygon=((10, 10), (50, 10), (50, 20), (10, 20)),
                confidence=0.9,
                alignment="diagonal",
            )

    def test_ocr_provider_interface_requires_extract_text(self):
        provider = OCRProvider(
            ProviderConfig(
                role="ocr_model",
                provider="base",
                model="base",
                base_url="",
                api_key="",
            )
        )

        with self.assertRaises(NotImplementedError):
            provider.extract_text("slide.png")

    def test_openai_chat_ocr_uses_crop_prompt_for_focused_recovery_images(self):
        from unittest.mock import patch

        from src.generative_editable_providers import OpenAIChatOCRProvider

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            crop_dir = root / "focused-crops"
            crop_dir.mkdir()
            image_path = crop_dir / "visual-text-candidate-004.png"
            Image.new("RGB", (752, 66), "#020813").save(image_path)
            payloads = []
            provider = OpenAIChatOCRProvider(
                ProviderConfig(
                    role="ocr_model",
                    provider="openai_chat",
                    model="PaddlePaddle/PaddleOCR-VL-1.5",
                    base_url="https://example.invalid/v1",
                    api_key="secret",
                )
            )

            def fake_post(config, payload, operation, timeout_seconds):
                payloads.append(payload)
                return {
                    "choices": [
                        {"message": {"content": "全周期安全管理与OTA进化能力，让车辆越用越新。"}}
                    ]
                }

            with patch(
                "src.generative_editable_providers._post_openai_chat", side_effect=fake_post
            ):
                result = provider.extract_text(str(image_path))

        prompt = payloads[0]["messages"][0]["content"][0]["text"]
        self.assertIn("cropped", prompt)
        self.assertIn("literal visible text", prompt)
        self.assertEqual(result.items[0].text, "全周期安全管理与OTA进化能力，让车辆越用越新。")

    def test_ocr_parser_accepts_safe_json_scalar_as_single_text_item(self):
        config = ProviderConfig(
            role="ocr_model",
            provider="openai_chat",
            model="ocr-test",
            base_url="https://example.test/v1",
            api_key="secret",
        )

        items = _extract_ocr_text_items(
            {"choices": [{"message": {"content": "1"}}]},
            config,
            (800, 450),
        )

        self.assertEqual(items[0].text, "1")
        self.assertEqual(items[0].provenance["fallback"], "plain_text_ocr")

    def test_ocr_parser_rejects_non_json_prose_instead_of_turning_it_into_slide_text(self):
        config = ProviderConfig(
            role="ocr_model",
            provider="openai_chat",
            model="ocr-test",
            base_url="https://example.test/v1",
            api_key="secret",
        )

        with self.assertRaisesRegex(ProviderError, "valid JSON"):
            _extract_ocr_text_items(
                {"choices": [{"message": {"content": "I cannot extract text from this image."}}]},
                config,
                (800, 450),
            )

    def test_ocr_parser_rejects_json_scalar_refusal(self):
        config = ProviderConfig(
            role="ocr_model",
            provider="openai_chat",
            model="ocr-test",
            base_url="https://example.test/v1",
            api_key="secret",
        )

        with self.assertRaisesRegex(ProviderError, "object or array"):
            _extract_ocr_text_items(
                {"choices": [{"message": {"content": '"I cannot extract text from this image."'}}]},
                config,
                (800, 450),
            )

    def test_text_line_matching_removes_fragments_inside_matched_title(self):
        detected = [
            _DetectedTextLine((347, 51, 1330, 111), "#FFFFFF", 20.0, 12),
            _DetectedTextLine((429, 52, 527, 84), "#FFFFFF", 11.0, 2),
            _DetectedTextLine((286, 247, 391, 282), "#2E89F4", 12.0, 3),
            _DetectedTextLine((1291, 208, 1406, 230), "#DADCDF", 8.0, 4),
        ]

        matched = _match_detected_lines_to_text(
            ["核心架构设计：增程、底盘与智能域", "智能域", "29英寸6K屏"],
            detected,
            (1672, 941),
        )

        self.assertEqual(matched[0][0], (347, 51, 1330, 111))
        self.assertEqual(matched[1][0], (286, 247, 391, 282))
        self.assertEqual(matched[2][0], (1291, 208, 1406, 230))

    def test_text_line_matching_prefers_slide_label_and_right_parameter_regions(self):
        detected = [
            _DetectedTextLine((347, 51, 1330, 111), "#FFFFFF", 20.0, 12),
            # Distractor from a screen/photo with similar visual width to the domain label.
            _DetectedTextLine((534, 192, 814, 264), "#8AB2E3", 24.8, 1),
            # Tiny blue product-detail fragment that should not win the domain label.
            _DetectedTextLine((539, 195, 566, 204), "#386CB4", 8.0, 1),
            # Correct left-side blue domain label.
            _DetectedTextLine((286, 247, 391, 282), "#2E89F4", 12.0, 3),
            # Distractors from product imagery.
            _DetectedTextLine((799, 193, 823, 206), "#5988BF", 8.0, 1),
            _DetectedTextLine((916, 216, 936, 235), "#A6ACB4", 8.0, 1),
            _DetectedTextLine((1038, 217, 1074, 245), "#8C94A1", 9.6, 1),
            # Correct right-side parameter rows.
            _DetectedTextLine((1292, 240, 1448, 263), "#DADCDF", 8.0, 6),
            _DetectedTextLine((1292, 273, 1404, 295), "#DCE0E2", 8.0, 5),
            _DetectedTextLine((1291, 306, 1377, 328), "#D2D5DA", 8.0, 4),
        ]

        matched = _match_detected_lines_to_text(
            ["核心架构设计：增程、底盘与智能域", "智能域", "空气悬架", "EMB"],
            detected,
            (1672, 941),
        )

        self.assertEqual(matched[1][0], (286, 247, 391, 282))
        self.assertGreaterEqual(matched[2][0][0], 1200)
        self.assertGreaterEqual(matched[3][0][0], 1200)

    def test_domain_label_matching_rejects_tiny_product_detail_fragments(self):
        detected = [
            _DetectedTextLine((539, 195, 566, 204), "#386CB4", 8.0, 1),
            _DetectedTextLine((286, 247, 391, 282), "#2E89F4", 12.0, 3),
        ]

        matched = _match_detected_lines_to_text(["智能域"], detected, (1672, 941))

        self.assertEqual(matched[0][0], (286, 247, 391, 282))

    def test_domain_label_matching_prefers_full_left_label_over_inner_fragment(self):
        detected = [
            _DetectedTextLine((286, 247, 391, 282), "#2E89F4", 12.0, 5),
            _DetectedTextLine((303, 247, 355, 265), "#2E88F2", 8.0, 2),
            _DetectedTextLine((274, 747, 379, 782), "#3188F5", 12.0, 4),
        ]

        matched = _match_detected_lines_to_text(["智能域", "动力域"], detected, (1672, 941))

        self.assertEqual(matched[0][0], (286, 247, 391, 282))
        self.assertEqual(matched[1][0], (274, 747, 379, 782))

    def test_parameter_matching_rejects_middle_visual_fragments_when_right_column_exists(self):
        detected = [
            # Speaker/product fragments from the middle of the slide. They can
            # look text-like and have widths close to the OCR text.
            _DetectedTextLine((1026, 210, 1164, 237), "#969CA7", 9.3, 4),
            _DetectedTextLine((1132, 223, 1150, 240), "#AAACB1", 8.0, 2),
            _DetectedTextLine((1532, 284, 1576, 365), "#5876AE", 8.0, 1),
            # Correct right-column text candidates.
            _DetectedTextLine((1292, 240, 1448, 263), "#DADCDF", 8.0, 12),
            _DetectedTextLine((1292, 575, 1340, 595), "#CBD1DA", 8.0, 8),
        ]

        matched = _match_detected_lines_to_text(
            ["21英寸4K后舱屏", "EMB"],
            detected,
            (1672, 941),
        )

        self.assertEqual(matched[0][0], (1292, 240, 1448, 263))
        self.assertEqual(matched[1][0], (1292, 575, 1340, 595))

    def test_matching_removes_overlapping_fragments_after_right_column_line_match(self):
        detected = [
            _DetectedTextLine((1291, 306, 1377, 328), "#D2D5DA", 8.0, 7),
            _DetectedTextLine((1313, 313, 1378, 328), "#C7CAD1", 8.0, 7),
            _DetectedTextLine((1250, 440, 1380, 467), "#D4D9DF", 8.0, 9),
        ]

        matched = _match_detected_lines_to_text(
            ["理想同学", "线控转向"],
            detected,
            (1672, 941),
        )

        self.assertEqual(matched[0][0], (1291, 306, 1377, 328))
        self.assertEqual(matched[1][0], (1250, 440, 1380, 467))

    def test_right_column_parameter_list_preserves_vertical_reading_order(self):
        detected = [
            _DetectedTextLine((1250, 440, 1380, 467), "#D4D9DF", 8.0, 9),
            _DetectedTextLine((1291, 473, 1380, 497), "#CED4D9", 8.0, 10),
            _DetectedTextLine((1292, 507, 1380, 530), "#D5D9DF", 8.0, 9),
        ]

        matched = _match_detected_lines_to_text(
            ["线控转向", "后轮转向", "空气悬架"],
            detected,
            (1672, 941),
        )

        self.assertEqual([item[0] for item in matched], [line.bbox for line in detected])


class ImageEditProviderContractTest(unittest.TestCase):
    def test_fake_image_edit_provider_records_request_and_writes_output_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source_path = tmp_path / "source.png"
            mask_path = tmp_path / "mask.png"
            output_path = tmp_path / "edited.png"
            Image.new("RGB", (640, 360), "navy").save(source_path)
            Image.new("L", (640, 360), 0).save(mask_path)
            provider = FakeImageEditProvider(
                ProviderConfig(
                    role="edit_model",
                    provider="fake_image_edit",
                    model="fake-image-edit",
                    base_url="",
                    api_key="",
                )
            )
            request = ImageEditRequest(
                source_image_path=str(source_path),
                prompt_id="text_clean_background",
                prompt="Remove baked text only.",
                output_asset_path=str(output_path),
                asset_root=str(tmp_path),
                mask_path=str(mask_path),
                timeout_seconds=42,
                metadata={
                    "page_index": 0,
                    "model": "forged-model",
                    "api_key": "metadata-secret",
                    "details": {"api_key": "nested-secret", "safe": "ok"},
                    "items": [{"token": "nested-token", "name": "chart"}],
                },
            )

            result = provider.edit(request)

            self.assertEqual(result.output_asset_path, str(output_path.resolve()))
            self.assertEqual(result.provider_role, "edit_model")
            self.assertEqual(result.prompt_id, "text_clean_background")
            self.assertEqual(result.source_image_path, str(source_path))
            self.assertEqual(result.mask_path, str(mask_path))
            self.assertEqual(result.timeout_seconds, 42)
            self.assertEqual(result.provenance["model"], "fake-image-edit")
            self.assertEqual(result.provenance["metadata"]["page_index"], 0)
            self.assertNotIn("api_key", result.provenance["metadata"])
            self.assertEqual(result.provenance["metadata"]["details"]["safe"], "ok")
            self.assertNotIn("api_key", result.provenance["metadata"]["details"])
            self.assertEqual(result.provenance["metadata"]["items"][0]["name"], "chart")
            self.assertNotIn("token", result.provenance["metadata"]["items"][0])
            self.assertNotIn("nested-secret", repr(result.provenance))
            self.assertNotIn("nested-token", repr(result.provenance))
            self.assertNotEqual(result.provenance["model"], "forged-model")
            self.assertTrue(output_path.exists())
            with Image.open(output_path) as image:
                self.assertEqual(image.size, (640, 360))

    def test_image_edit_request_requires_source_prompt_timeout_and_output(self):
        with self.assertRaisesRegex(ValueError, "source_image_path"):
            ImageEditRequest(
                source_image_path="",
                prompt_id="clean",
                prompt="Clean",
                output_asset_path="out.png",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "prompt_id"):
            ImageEditRequest(
                source_image_path="source.png",
                prompt_id="",
                prompt="Clean",
                output_asset_path="out.png",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "prompt"):
            ImageEditRequest(
                source_image_path="source.png",
                prompt_id="clean",
                prompt="",
                output_asset_path="out.png",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "output_asset_path"):
            ImageEditRequest(
                source_image_path="source.png",
                prompt_id="clean",
                prompt="Clean",
                output_asset_path="",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "timeout_seconds"):
            ImageEditRequest(
                source_image_path="source.png",
                prompt_id="clean",
                prompt="Clean",
                output_asset_path="out.png",
                asset_root=".",
                timeout_seconds=0,
            )

    def test_image_edit_request_rejects_output_outside_asset_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            outside = Path(tmp).parent / "outside.png"

            with self.assertRaisesRegex(ValueError, "asset_root"):
                ImageEditRequest(
                    source_image_path="source.png",
                    prompt_id="clean",
                    prompt="Clean",
                    output_asset_path=str(outside),
                    asset_root=tmp,
                )

    def test_image_edit_request_rejects_source_and_mask_outside_asset_root(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            source.write_bytes(b"source")
            mask.write_bytes(b"mask")
            outside_source = Path(outside_tmp) / "source.png"
            outside_mask = Path(outside_tmp) / "mask.png"
            outside_source.write_bytes(b"outside-source")
            outside_mask.write_bytes(b"outside-mask")

            with self.assertRaisesRegex(ValueError, "source_image_path"):
                ImageEditRequest(
                    source_image_path=str(outside_source),
                    prompt_id="clean",
                    prompt="Clean",
                    output_asset_path=str(root / "out.png"),
                    asset_root=str(root),
                    mask_path=str(mask),
                )
            with self.assertRaisesRegex(ValueError, "mask_path"):
                ImageEditRequest(
                    source_image_path=str(source),
                    prompt_id="clean",
                    prompt="Clean",
                    output_asset_path=str(root / "out.png"),
                    asset_root=str(root),
                    mask_path=str(outside_mask),
                )

    def test_image_edit_provider_interface_requires_edit(self):
        provider = ImageEditProvider(
            ProviderConfig(
                role="edit_model",
                provider="base",
                model="base",
                base_url="",
                api_key="",
            )
        )
        request = ImageEditRequest(
            source_image_path="source.png",
            prompt_id="clean",
            prompt="Clean",
            output_asset_path="out.png",
            asset_root=".",
        )

        with self.assertRaises(NotImplementedError):
            provider.edit(request)


class ImageGenerationProviderContractTest(unittest.TestCase):
    def test_fake_image_generation_provider_records_reference_metadata_and_writes_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            output_path = Path(tmp) / "asset.png"
            provider = FakeImageGenerationProvider(
                ProviderConfig(
                    role="image_model",
                    provider="fake_image_generation",
                    model="fake-image-generation",
                    base_url="",
                    api_key="",
                )
            )
            request = ImageGenerationRequest(
                prompt_id="asset_sheet",
                prompt="Generate isolated chart icons.",
                output_asset_path=str(output_path),
                asset_root=str(tmp_path),
                visual_reference={
                    "source_image_path": "slide.png",
                    "candidate_boxes": [(10, 20, 110, 120)],
                    "mode": "transparent_asset_sheet",
                },
                timeout_seconds=55,
                metadata={
                    "page_index": 2,
                    "model": "forged-model",
                    "client_secret": "metadata-secret",
                    "details": {"clientSecret": "nested-secret", "safe": "ok"},
                },
            )

            result = provider.generate(request)

            self.assertEqual(result.output_asset_path, str(output_path.resolve()))
            self.assertEqual(result.provider_role, "image_model")
            self.assertEqual(result.prompt_id, "asset_sheet")
            self.assertEqual(result.visual_reference["mode"], "transparent_asset_sheet")
            self.assertEqual(result.timeout_seconds, 55)
            self.assertEqual(result.provenance["model"], "fake-image-generation")
            self.assertEqual(result.provenance["metadata"]["page_index"], 2)
            self.assertNotIn("client_secret", result.provenance["metadata"])
            self.assertEqual(result.provenance["metadata"]["details"]["safe"], "ok")
            self.assertNotIn("clientSecret", result.provenance["metadata"]["details"])
            self.assertNotIn("nested-secret", repr(result.provenance))
            self.assertNotEqual(result.provenance["model"], "forged-model")
            self.assertTrue(output_path.exists())
            with Image.open(output_path) as image:
                self.assertEqual(image.size, (256, 256))

    def test_image_generation_request_requires_prompt_timeout_and_output(self):
        with self.assertRaisesRegex(ValueError, "prompt_id"):
            ImageGenerationRequest(
                prompt_id="",
                prompt="Generate",
                output_asset_path="out.png",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "prompt"):
            ImageGenerationRequest(
                prompt_id="asset",
                prompt="",
                output_asset_path="out.png",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "output_asset_path"):
            ImageGenerationRequest(
                prompt_id="asset",
                prompt="Generate",
                output_asset_path="",
                asset_root=".",
            )

        with self.assertRaisesRegex(ValueError, "timeout_seconds"):
            ImageGenerationRequest(
                prompt_id="asset",
                prompt="Generate",
                output_asset_path="out.png",
                asset_root=".",
                timeout_seconds=-1,
            )

    def test_image_generation_request_rejects_output_outside_asset_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            outside = Path(tmp).parent / "outside.png"

            with self.assertRaisesRegex(ValueError, "asset_root"):
                ImageGenerationRequest(
                    prompt_id="asset",
                    prompt="Generate",
                    output_asset_path=str(outside),
                    asset_root=tmp,
                )

    def test_image_generation_provider_interface_requires_generate(self):
        provider = ImageGenerationProvider(
            ProviderConfig(
                role="image_model",
                provider="base",
                model="base",
                base_url="",
                api_key="",
            )
        )
        request = ImageGenerationRequest(
            prompt_id="asset",
            prompt="Generate",
            output_asset_path="out.png",
            asset_root=".",
        )

        with self.assertRaises(NotImplementedError):
            provider.generate(request)

    def test_openai_chat_image_generation_sends_visual_reference_source_image(self):
        from unittest.mock import patch

        from src.generative_editable_providers import OpenAIChatImageGenerationProvider

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            output = root / "out.png"
            Image.new("RGB", (16, 16), "#F8FAFC").save(source)
            Image.new("RGB", (16, 16), "#FFFFFF").save(output)
            payloads = []
            provider = OpenAIChatImageGenerationProvider(
                ProviderConfig(
                    role="image_model",
                    provider="openai_chat",
                    model="image-model",
                    base_url="https://example.invalid/v1",
                    api_key="secret",
                )
            )

            def fake_post(config, payload, operation, timeout_seconds):
                payloads.append(payload)
                image_base64 = base64.b64encode(output.read_bytes()).decode()
                return {"data": [{"url": f"data:image/png;base64,{image_base64}"}]}

            with patch(
                "src.generative_editable_providers._post_openai_chat", side_effect=fake_post
            ):
                provider.generate(
                    ImageGenerationRequest(
                        prompt_id="asset_sheet",
                        prompt="Generate assets.",
                        output_asset_path=str(output),
                        asset_root=str(root),
                        visual_reference={"source_image_path": str(source)},
                    )
                )

        content = payloads[0]["messages"][0]["content"]
        self.assertIsInstance(content, list)
        self.assertEqual(content[0]["type"], "image_url")
        self.assertEqual(content[0]["image_url"]["detail"], "high")
        self.assertTrue(content[0]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(content[-1]["type"], "text")


class ProviderErrorHandlingTest(unittest.TestCase):
    def test_openai_chat_post_uses_json_payload_for_gateway_compatibility(self):
        from unittest.mock import patch

        from src.generative_editable_providers import _post_openai_chat

        class FakeResponse:
            text = "{}"

            def raise_for_status(self):
                return None

            def json(self):
                return {"ok": True}

        config = ProviderConfig(
            role="VLM",
            provider="openai_chat",
            model="gpt-5.5",
            base_url="https://example.invalid/v1",
            api_key="secret",
        )
        payload = {"model": "gpt-5.5", "messages": [{"role": "user", "content": "OK"}]}

        with patch(
            "src.generative_editable_providers.requests.post", return_value=FakeResponse()
        ) as post:
            result = _post_openai_chat(
                config,
                payload,
                operation="vlm_page_analysis",
                timeout_seconds=30,
            )

        self.assertEqual(result, {"ok": True})
        _, kwargs = post.call_args
        self.assertEqual(kwargs["json"], payload)
        self.assertNotIn("data", kwargs)
        json.dumps(kwargs["json"])

    def test_provider_timeout_error_is_retryable_and_secret_safe(self):
        error = ProviderTimeoutError(
            provider_role="ocr_model",
            operation="extract_text",
            message="timeout calling https://ocr.example/api with sk-live-secret",
            retryable=True,
            timeout_seconds=30,
            secret_values=["sk-live-secret"],
        )

        self.assertTrue(error.retryable)
        self.assertEqual(error.provider_role, "ocr_model")
        self.assertEqual(error.operation, "extract_text")
        self.assertEqual(error.timeout_seconds, 30)
        self.assertNotIn("sk-live-secret", str(error))
        self.assertIn("[REDACTED]", str(error))

    def test_provider_error_distinguishes_retryable_and_non_retryable(self):
        retryable = ProviderError(
            provider_role="image_model",
            operation="generate",
            message="rate limited",
            retryable=True,
        )
        non_retryable = ProviderError(
            provider_role="edit_model",
            operation="edit",
            message="bad request",
            retryable=False,
        )

        self.assertTrue(retryable.retryable)
        self.assertFalse(non_retryable.retryable)
        self.assertIn("image_model", str(retryable))
        self.assertIn("generate", str(retryable))

    def test_provider_error_code_is_constrained_before_reporting(self):
        error = ProviderError(
            provider_role="VLM",
            operation="vlm_page_analysis",
            message="bad gateway",
            retryable=True,
            provider_error_code="insufficient_user_quota https://secret.example/path api_key=secret",
        )

        self.assertEqual(
            error.provider_error_code, "insufficient_user_quota_URL_REDACTED_api_key_REDACTED"
        )
        self.assertNotIn("://", error.provider_error_code)
        self.assertNotIn("=", error.provider_error_code)
        self.assertNotIn("secret", error.provider_error_code)

    def test_retrying_ocr_provider_retries_retryable_provider_errors(self):
        class FlakyOCRProvider(OCRProvider):
            def __init__(self, config):
                super().__init__(config)
                self.calls = 0

            def extract_text(self, image_path: str):
                self.calls += 1
                if self.calls == 1:
                    raise ProviderError(
                        provider_role="ocr_model",
                        operation="extract_text",
                        message="temporary failure",
                        retryable=True,
                    )
                return FakeOCRProvider(self.config).extract_text(image_path)

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            provider = FlakyOCRProvider(
                ProviderConfig(
                    role="ocr_model",
                    provider="fake_ocr",
                    model="fake-ocr",
                    base_url="",
                    api_key="",
                )
            )

            result = RetryingOCRProvider(
                provider,
                max_attempts=2,
                backoff_seconds=0,
            ).extract_text(str(image_path))

        self.assertEqual(provider.calls, 2)
        self.assertEqual(result.items[0].text, "Quarterly Plan")

    def test_retrying_ocr_provider_records_attempt_history(self):
        class FlakyOCRProvider(OCRProvider):
            def __init__(self, config):
                super().__init__(config)
                self.calls = 0

            def extract_text(self, image_path: str):
                self.calls += 1
                if self.calls == 1:
                    raise ProviderError(
                        provider_role="ocr_model",
                        operation="extract_text",
                        message="temporary api_key=secret failure",
                        retryable=True,
                        status_code=500,
                        provider_error_code="upstream_timeout",
                    )
                return FakeOCRProvider(self.config).extract_text(image_path)

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            provider = FlakyOCRProvider(
                ProviderConfig(
                    role="ocr_model",
                    provider="fake_ocr",
                    model="fake-ocr",
                    base_url="",
                    api_key="secret",
                )
            )
            retrying = RetryingOCRProvider(
                provider,
                max_attempts=2,
                backoff_seconds=0,
            )

            retrying.extract_text(str(image_path))

        self.assertEqual(
            [(item["attempt"], item["status"]) for item in retrying.last_attempts],
            [(1, "failed"), (2, "passed")],
        )
        self.assertTrue(retrying.last_attempts[0]["retrying"])
        self.assertEqual(retrying.last_attempts[0]["status_code"], 500)
        self.assertEqual(retrying.last_attempts[0]["provider_error_code"], "upstream_timeout")
        self.assertNotIn("secret", retrying.last_attempts[0]["error"])

    def test_retrying_ocr_provider_does_not_retry_non_retryable_provider_errors(self):
        class FailingOCRProvider(OCRProvider):
            def __init__(self, config):
                super().__init__(config)
                self.calls = 0

            def extract_text(self, image_path: str):
                self.calls += 1
                raise ProviderError(
                    provider_role="ocr_model",
                    operation="extract_text",
                    message="bad request",
                    retryable=False,
                )

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            provider = FailingOCRProvider(
                ProviderConfig(
                    role="ocr_model",
                    provider="fake_ocr",
                    model="fake-ocr",
                    base_url="",
                    api_key="",
                )
            )

            with self.assertRaises(ProviderError):
                RetryingOCRProvider(
                    provider,
                    max_attempts=3,
                    backoff_seconds=0,
                ).extract_text(str(image_path))

        self.assertEqual(provider.calls, 1)

    def test_safe_provider_error_message_redacts_keys_urls_and_bearer_tokens(self):
        message = safe_provider_error_message(
            "Authorization Bearer abc.def.ghi failed for api_key=secret123 at https://host/path",
            secret_values=["secret123"],
        )

        self.assertNotIn("abc.def.ghi", message)
        self.assertNotIn("secret123", message)
        self.assertIn("Bearer [REDACTED]", message)
        self.assertIn("api_key=[REDACTED]", message)

    def test_safe_provider_error_message_redacts_common_token_forms(self):
        message = safe_provider_error_message(
            "authorization: bearer lower.token x-api-key: key123 access_token=tok "
            "token: plain client_secret=secret Authorization: sk-live-key "
            'Authorization=equals-key {"api_key":"json-key"} '
            "{'api_key': 'repr-key'} accessToken=camel clientSecret: camel-secret "
            "session_id=session-secret private_key=private-secret "
            "session-id=session-hyphen private-key=private-hyphen "
            "secret-key=secret-hyphen access-key=access-hyphen "
            "api_key whitespace-secret Authorization: Basic basic-secret"
        )

        self.assertNotIn("lower.token", message)
        self.assertNotIn("key123", message)
        self.assertNotIn("access_token=tok", message)
        self.assertNotIn("token: plain", message)
        self.assertNotIn("client_secret=secret", message)
        self.assertNotIn("sk-live-key", message)
        self.assertNotIn("equals-key", message)
        self.assertNotIn("json-key", message)
        self.assertNotIn("repr-key", message)
        self.assertNotIn("camel", message)
        self.assertNotIn("session-secret", message)
        self.assertNotIn("private-secret", message)
        self.assertNotIn("session-hyphen", message)
        self.assertNotIn("private-hyphen", message)
        self.assertNotIn("secret-hyphen", message)
        self.assertNotIn("access-hyphen", message)
        self.assertNotIn("whitespace-secret", message)
        self.assertNotIn("basic-secret", message)
        self.assertIn("bearer [REDACTED]", message)
        self.assertIn("x-api-key: [REDACTED]", message)
        self.assertIn("Authorization: Basic [REDACTED]", message)


class FakeProviderFixtureAssetTest(unittest.TestCase):
    def test_fake_image_generation_output_has_deterministic_dimensions_and_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "generated.png"
            provider = FakeImageGenerationProvider(
                ProviderConfig(
                    role="image_model",
                    provider="fake_image_generation",
                    model="fake-image-generation",
                    base_url="",
                    api_key="",
                )
            )

            provider.generate(
                ImageGenerationRequest(
                    prompt_id="asset_sheet",
                    prompt="Generate deterministic asset.",
                    output_asset_path=str(output_path),
                    asset_root=tmp,
                )
            )

            with Image.open(output_path) as image:
                self.assertEqual(image.size, (256, 256))
                self.assertEqual(image.mode, "RGBA")
            self.assertEqual(
                _pixel_sha256(output_path),
                "8a39d2abd3999ab73c34db2476849cddf303ce389b35826850f9a700589b4a90",
            )

    def test_fake_image_edit_output_preserves_source_dimensions_and_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            source_path = Path(tmp) / "source.png"
            output_path = Path(tmp) / "edited.png"
            Image.new("RGB", (320, 180), "#336699").save(source_path)
            provider = FakeImageEditProvider(
                ProviderConfig(
                    role="edit_model",
                    provider="fake_image_edit",
                    model="fake-image-edit",
                    base_url="",
                    api_key="",
                )
            )

            provider.edit(
                ImageEditRequest(
                    source_image_path=str(source_path),
                    prompt_id="base_clean_background",
                    prompt="Clean source.",
                    output_asset_path=str(output_path),
                    asset_root=tmp,
                )
            )

            with Image.open(output_path) as image:
                self.assertEqual(image.size, (320, 180))
                self.assertEqual(image.mode, "RGB")
            self.assertEqual(_pixel_sha256(output_path), _pixel_sha256(source_path))

    def test_fake_image_edit_fills_masked_regions_with_deterministic_background_color(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "source.png"
            mask_path = root / "mask.png"
            output_path = root / "edited.png"
            image = Image.new("RGB", (120, 80), "#102030")
            pixels = image.load()
            for x in range(40, 80):
                for y in range(25, 45):
                    pixels[x, y] = (255, 255, 255)
            image.save(source_path)
            mask = Image.new("L", (120, 80), 0)
            for x in range(38, 82):
                for y in range(23, 47):
                    mask.putpixel((x, y), 255)
            mask.save(mask_path)
            provider = FakeImageEditProvider(
                ProviderConfig(
                    role="edit_model",
                    provider="fake_image_edit",
                    model="fake-image-edit",
                    base_url="",
                    api_key="",
                )
            )

            provider.edit(
                ImageEditRequest(
                    source_image_path=str(source_path),
                    prompt_id="text_clean_background",
                    prompt="Remove masked text.",
                    output_asset_path=str(output_path),
                    asset_root=tmp,
                    mask_path=str(mask_path),
                )
            )

            with Image.open(output_path) as edited:
                self.assertEqual(edited.size, (120, 80))
                self.assertEqual(edited.getpixel((60, 35)), (16, 32, 48))
                self.assertEqual(edited.getpixel((10, 10)), (16, 32, 48))


if __name__ == "__main__":
    unittest.main()

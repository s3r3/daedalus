import base64
import http.client
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import requests
from PIL import Image, ImageDraw

from src.generative_editable_config import ProviderConfig
from src.generative_editable_providers import (
    ImageEditRequest,
    ImageGenerationRequest,
    LocalTesseractOCRProvider,
    OpenAIChatImageEditProvider,
    OpenAIChatImageGenerationProvider,
    OpenAIChatOCRProvider,
    ProviderError,
    ProviderTimeoutError,
    _post_openai_chat,
)
import api.routes.export as export_route


class _FakeResponse:
    def __init__(self, payload, status_error=None):
        self.payload = payload
        self.status_error = status_error

    def raise_for_status(self):
        if self.status_error:
            raise self.status_error

    def json(self):
        return self.payload


def _provider(role="ocr_model", model="vision-model", provider="openai_vision"):
    return ProviderConfig(
        role=role,
        provider=provider,
        model=model,
        base_url="https://provider.example/v1",
        api_key="secret-key",
        adapter="openai_chat",
    )


class LiveProviderAdapterTest(unittest.TestCase):
    def test_route_dependency_builder_uses_live_provider_adapters_for_non_fake_config(self):
        from src.generative_editable_config import (
            GenerativeEditableConfig,
            QualityConfig,
            RetryConfig,
            TimeoutConfig,
        )

        config = GenerativeEditableConfig(
            ocr=_provider(provider="paddle_ocr_vl"),
            clean_base_model=_provider(role="edit_model", provider="openai_image_edit"),
            asset_sheet_model=_provider(role="edit_model", provider="openai_image_edit"),
            repair_model=_provider(role="edit_model", provider="openai_image_edit"),
            generation_model=_provider(role="image_model", provider="openai_image_generation"),
            use_aippt_metadata_first=True,
            ocr_min_confidence=0.75,
            quality=QualityConfig(),
            retries=RetryConfig(),
            timeouts=TimeoutConfig(),
        )

        with patch("api.routes.export.load_generative_editable_config", return_value=config):
            dependencies = export_route._build_generative_editable_pipeline_dependencies()

        self.assertIsInstance(dependencies.ocr_provider, OpenAIChatOCRProvider)
        self.assertIsInstance(dependencies.image_edit_provider, OpenAIChatImageEditProvider)
        self.assertIsInstance(
            dependencies.image_generation_provider,
            OpenAIChatImageGenerationProvider,
        )

    def test_route_dependency_builder_passes_configured_timeout_to_ocr_provider(self):
        from src.generative_editable_config import (
            GenerativeEditableConfig,
            QualityConfig,
            RetryConfig,
            TimeoutConfig,
        )

        config = GenerativeEditableConfig(
            ocr=_provider(provider="paddle_ocr_vl"),
            clean_base_model=_provider(role="edit_model", provider="openai_image_edit"),
            asset_sheet_model=_provider(role="edit_model", provider="openai_image_edit"),
            repair_model=_provider(role="edit_model", provider="openai_image_edit"),
            generation_model=_provider(role="image_model", provider="openai_image_generation"),
            use_aippt_metadata_first=True,
            ocr_min_confidence=0.75,
            quality=QualityConfig(),
            retries=RetryConfig(),
            timeouts=TimeoutConfig(provider_call=77),
        )

        with patch("api.routes.export.load_generative_editable_config", return_value=config):
            dependencies = export_route._build_generative_editable_pipeline_dependencies()

        self.assertEqual(dependencies.ocr_provider.timeout_seconds, 77)

    def test_route_dependency_builder_uses_local_tesseract_ocr_provider_when_configured(self):
        from src.generative_editable_config import (
            GenerativeEditableConfig,
            QualityConfig,
            RetryConfig,
            TimeoutConfig,
        )

        config = GenerativeEditableConfig(
            ocr=ProviderConfig(
                role="ocr_model",
                provider="local_tesseract",
                model="eng",
                base_url="",
                api_key="",
            ),
            clean_base_model=_provider(role="edit_model", provider="openai_image_edit"),
            asset_sheet_model=_provider(role="edit_model", provider="openai_image_edit"),
            repair_model=_provider(role="edit_model", provider="openai_image_edit"),
            generation_model=_provider(role="image_model", provider="openai_image_generation"),
            use_aippt_metadata_first=True,
            ocr_min_confidence=0.75,
            quality=QualityConfig(),
            retries=RetryConfig(),
            timeouts=TimeoutConfig(),
        )

        with patch("api.routes.export.load_generative_editable_config", return_value=config):
            dependencies = export_route._build_generative_editable_pipeline_dependencies()

        self.assertIsInstance(dependencies.ocr_provider, LocalTesseractOCRProvider)

    def test_local_tesseract_ocr_provider_parses_tsv_lines(self):
        tsv = "\n".join(
            [
                "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
                "5\t1\t1\t1\t1\t1\t80\t54\t160\t32\t96.5\tQuarterly",
                "5\t1\t1\t1\t1\t2\t250\t54\t70\t32\t93.5\tPlan",
                "5\t1\t1\t1\t2\t1\t90\t120\t120\t24\t88.0\tRevenue",
            ]
        )

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            with (
                patch(
                    "src.generative_editable_providers.shutil.which",
                    return_value="/usr/bin/tesseract",
                ),
                patch("src.generative_editable_providers.subprocess.run") as run,
            ):
                run.return_value.stdout = tsv
                result = LocalTesseractOCRProvider(
                    ProviderConfig(
                        role="ocr_model",
                        provider="local_tesseract",
                        model="eng",
                        base_url="",
                        api_key="",
                    )
                ).extract_text(str(image_path))

        self.assertEqual(result.provider_name, "local_tesseract")
        self.assertEqual(result.items[0].text, "Quarterly Plan")
        self.assertEqual(result.items[0].bbox, (80, 54, 320, 86))
        self.assertAlmostEqual(result.items[0].confidence, 0.95)
        self.assertEqual(result.items[1].text, "Revenue")
        run.assert_called_once()

    def test_local_tesseract_ocr_provider_rejects_missing_explicit_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            provider = LocalTesseractOCRProvider(
                ProviderConfig(
                    role="ocr_model",
                    provider="local_tesseract",
                    model="eng",
                    base_url=str(Path(tmp) / "missing-tesseract"),
                    api_key="",
                )
            )

            with self.assertRaisesRegex(ProviderError, "tesseract executable"):
                provider.extract_text(str(image_path))

    def test_openai_chat_ocr_provider_parses_json_text_items(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": """
                        ```json
                        {
                          "items": [
                            {
                              "text": "Quarterly Plan",
                              "bbox": [80, 54, 420, 102],
                              "confidence": 0.97,
                              "font_size": 32,
                              "color": "#1F2937",
                              "alignment": "center"
                            }
                          ]
                        }
                        ```
                        """
                    }
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)

                result = OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertEqual(result.provider_role, "ocr_model")
        self.assertEqual(result.provider_name, "openai_vision")
        self.assertEqual(result.model, "vision-model")
        self.assertEqual(result.image_size, (800, 450))
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].text, "Quarterly Plan")
        self.assertEqual(result.items[0].bbox, (80, 54, 420, 102))
        self.assertEqual(result.items[0].alignment, "center")
        self.assertEqual(result.items[0].font_size_hint, 32)
        self.assertEqual(post.call_args.kwargs["timeout"], 180)
        self.assertEqual(post.call_args.args[0], "https://provider.example/v1/chat/completions")

    def test_openai_chat_ocr_provider_requests_strict_json_with_text_prompt_first(self):
        payload = {"choices": [{"message": {"content": '{"items":[]}'}}]}

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        request_payload = post.call_args.kwargs["json"]
        content = request_payload["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertEqual(content[1]["type"], "image_url")
        self.assertEqual(request_payload["response_format"], {"type": "json_object"})
        self.assertEqual(request_payload["temperature"], 0)
        self.assertEqual(request_payload["max_tokens"], 4096)

    def test_openai_chat_ocr_provider_extracts_json_from_surrounding_model_text(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": (
                            "Here is the OCR result:\n"
                            '{"items":[{"text":"Title","bbox":[1,2,30,40],"confidence":0.9}]}'
                            "\nDone."
                        )
                    }
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                result = OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertEqual(result.items[0].text, "Title")
        self.assertEqual(result.items[0].bbox, (1, 2, 30, 40))

    def test_openai_chat_ocr_provider_rejects_plain_text_response(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": "Plain OCR Title with api_key secret-value and visible text"
                    }
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        message = str(ctx.exception)
        self.assertIn("valid JSON", message)
        self.assertIn("response_excerpt=Plain OCR Title", message)
        self.assertIn("visible text", message)
        self.assertNotIn("secret-value", message)
        self.assertIn("api_key [REDACTED]", message)

    def test_paddleocr_vl_provider_requests_json_coordinates(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"items":['
                            '{"text":"理想汽车技术实验室","bbox":[118,86,372,124],'
                            '"confidence":0.93,"font_size":22,"color":"#F8FAFC"},'
                            '{"text":"理想L9: 旗舰增程SUV的技术实验","bbox":[146,178,544,214],'
                            '"confidence":0.91,"font_size":21,"color":"#38BDF8"}'
                            "]}"
                        )
                    }
                }
            ]
        }

        provider = _provider(model="PaddlePaddle/PaddleOCR-VL-1.5")
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            image = Image.new("RGB", (1000, 600), "#08111F")
            draw = ImageDraw.Draw(image)
            draw.rectangle((118, 86, 372, 124), fill="#F8FAFC")
            draw.rectangle((146, 178, 544, 214), fill="#38BDF8")
            image.save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                result = OpenAIChatOCRProvider(provider).extract_text(str(image_path))

        request_payload = post.call_args.kwargs["json"]
        content = request_payload["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertIn("Output JSON only", content[0]["text"])
        self.assertIn("Coordinates must be source-image pixels", content[0]["text"])
        self.assertEqual(content[1]["type"], "image_url")
        self.assertNotIn("response_format", request_payload)
        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].text, "理想汽车技术实验室")
        self.assertEqual(result.items[0].bbox, (118, 86, 372, 124))
        self.assertEqual(result.items[0].font_size_hint, 22)
        self.assertEqual(result.items[0].color_hex, "#F8FAFC")

    def test_paddleocr_vl_plain_text_response_uses_deduped_local_layout(self):
        payload = {"choices": [{"message": {"content": "Title\n\n29in 6K"}}]}

        provider = _provider(model="PaddlePaddle/PaddleOCR-VL-1.5")
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            image = Image.new("RGB", (1000, 600), "#08111F")
            draw = ImageDraw.Draw(image)
            draw.rectangle((90, 170, 930, 330), fill="#38BDF8")
            draw.text((118, 86), "Title", fill="#F8FAFC")
            draw.text((760, 214), "29in 6K", fill="#F8FAFC")
            image.save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                result = OpenAIChatOCRProvider(provider).extract_text(str(image_path))

        self.assertEqual(len(result.items), 2)
        self.assertEqual(result.items[0].text, "Title")
        self.assertNotEqual(result.items[0].bbox, (90, 170, 930, 330))
        self.assertEqual(result.items[1].text, "29in 6K")
        self.assertNotEqual(result.items[1].bbox, (90, 170, 930, 330))
        self.assertLess(result.items[1].bbox[3] - result.items[1].bbox[1], 60)

    def test_openai_chat_ocr_provider_marks_http_5xx_as_retryable(self):
        response = requests.Response()
        response.status_code = 503
        error = requests.HTTPError("503 Server Error", response=response)

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse({}, status_error=error)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertTrue(ctx.exception.retryable)

    def test_openai_chat_provider_exposes_upstream_error_code_and_status(self):
        response = requests.Response()
        response.status_code = 403
        response._content = (
            b'{"error":{"message":"quota exhausted","code":"insufficient_user_quota"}}'
        )
        error = requests.HTTPError("403 Client Error", response=response)

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse({}, status_error=error)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertFalse(ctx.exception.retryable)
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(ctx.exception.provider_error_code, "insufficient_user_quota")

    def test_openai_chat_ocr_provider_marks_connection_errors_as_retryable(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.side_effect = requests.ConnectionError("temporary connection reset")
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertTrue(ctx.exception.retryable)

    def test_openai_chat_provider_marks_incomplete_read_as_retryable(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.side_effect = http.client.IncompleteRead(b"partial", 2048)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertTrue(ctx.exception.retryable)

    def test_openai_chat_provider_error_includes_sanitized_response_body(self):
        provider = _provider()
        provider = ProviderConfig(
            role=provider.role,
            provider=provider.provider,
            model=provider.model,
            base_url="https://private.example/v1",
            api_key=provider.api_key,
            adapter=provider.adapter,
        )
        response = requests.Response()
        response.status_code = 400
        response._content = (
            b'{"error":{"message":"bad request for api_key=secret-key at private.example"}}'
        )
        error = requests.HTTPError("400 Client Error", response=response)

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse({}, status_error=error)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(provider).extract_text(str(image_path))

        message = str(ctx.exception)
        self.assertIn("response_body=", message)
        self.assertIn("[REDACTED]", message)
        self.assertIn("[URL_REDACTED]", message)
        self.assertNotIn("secret-key", message)
        self.assertNotIn("private.example", message)

    def test_openai_chat_ocr_provider_wraps_invalid_json_item_as_provider_error(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": json_payload(
                            {
                                "items": [
                                    {
                                        "text": "Bad OCR",
                                        "bbox": [10, 20, 5, 40],
                                        "confidence": 0.9,
                                    }
                                ]
                            }
                        )
                    }
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatOCRProvider(_provider()).extract_text(str(image_path))

        self.assertIn("invalid shape", str(ctx.exception))

    def test_openai_chat_image_edit_provider_writes_normalized_image(self):
        image_base64 = base64.b64encode(_png_bytes()).decode()
        payload = {"choices": [{"message": {"content": image_base64}}]}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            Image.new("RGB", (32, 18), "white").save(source)
            request = ImageEditRequest(
                source_image_path=str(source),
                prompt_id="base_clean_background",
                prompt="remove text",
                output_asset_path="assets/out.png",
                asset_root=str(root),
                timeout_seconds=7,
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                result = OpenAIChatImageEditProvider(
                    _provider(role="edit_model", model="edit-model", provider="openai_image_edit")
                ).edit(request)

            self.assertTrue(Path(result.output_asset_path).exists())
            self.assertEqual(result.provider_role, "edit_model")
            self.assertEqual(result.provider_name, "openai_image_edit")
            self.assertEqual(result.model, "edit-model")
            self.assertEqual(result.timeout_seconds, 7)

    def test_openai_chat_image_edit_provider_sends_mask_when_available(self):
        image_base64 = base64.b64encode(_png_bytes()).decode()
        payload = {"choices": [{"message": {"content": image_base64}}]}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            Image.new("RGB", (32, 18), "white").save(source)
            Image.new("L", (32, 18), 255).save(mask)
            request = ImageEditRequest(
                source_image_path=str(source),
                prompt_id="text_clean_background",
                prompt="remove text in mask",
                output_asset_path="assets/out.png",
                asset_root=str(root),
                mask_path=str(mask),
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                OpenAIChatImageEditProvider(
                    _provider(role="edit_model", model="edit-model", provider="openai_image_edit")
                ).edit(request)

        content = post.call_args.kwargs["json"]["messages"][0]["content"]
        self.assertEqual(
            sum(1 for item in content if item.get("type") == "image_url"),
            2,
        )

    def test_openai_chat_image_edit_normalization_errors_are_redacted(self):
        payload = {
            "choices": [
                {"message": {"content": "https://signed.example/image.png?token=secret-key"}}
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            Image.new("RGB", (32, 18), "white").save(source)
            request = ImageEditRequest(
                source_image_path=str(source),
                prompt_id="base_clean_background",
                prompt="remove text",
                output_asset_path="assets/out.png",
                asset_root=str(root),
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with self.assertRaises(ProviderError) as ctx:
                    OpenAIChatImageEditProvider(
                        _provider(
                            role="edit_model", model="edit-model", provider="openai_image_edit"
                        )
                    ).edit(request)

        self.assertNotIn("secret-key", str(ctx.exception))
        self.assertIn("[URL_REDACTED]", str(ctx.exception))

    def test_openai_chat_image_edit_marks_download_ssl_eof_as_retryable(self):
        payload = {
            "choices": [
                {"message": {"content": "https://signed.example/image.png?token=secret-key"}}
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            Image.new("RGB", (32, 18), "white").save(source)
            request = ImageEditRequest(
                source_image_path=str(source),
                prompt_id="base_clean_background",
                prompt="remove text",
                output_asset_path="assets/out.png",
                asset_root=str(root),
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with patch("src.image_result.requests.get") as get:
                    get.side_effect = requests.exceptions.SSLError(
                        "HTTPSConnectionPool(host='signed.example', port=443): "
                        "Max retries exceeded with url: /image.png "
                        "(Caused by SSLError(SSLEOFError(8, "
                        "'[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol')))"
                    )
                    with self.assertRaises(ProviderError) as ctx:
                        OpenAIChatImageEditProvider(
                            _provider(
                                role="edit_model", model="edit-model", provider="openai_image_edit"
                            )
                        ).edit(request)

        self.assertTrue(ctx.exception.retryable)
        self.assertNotIn("secret-key", str(ctx.exception))
        self.assertIn("[URL_REDACTED]", str(ctx.exception))

    def test_openai_chat_image_edit_marks_download_http_404_as_non_retryable(self):
        payload = {
            "choices": [
                {"message": {"content": "https://signed.example/missing.png?token=secret-key"}}
            ]
        }
        response = requests.Response()
        response.status_code = 404
        error = requests.HTTPError("404 Client Error", response=response)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            Image.new("RGB", (32, 18), "white").save(source)
            request = ImageEditRequest(
                source_image_path=str(source),
                prompt_id="base_clean_background",
                prompt="remove text",
                output_asset_path="assets/out.png",
                asset_root=str(root),
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with patch("src.image_result.requests.get") as get:
                    get.return_value.raise_for_status.side_effect = error
                    with self.assertRaises(ProviderError) as ctx:
                        OpenAIChatImageEditProvider(
                            _provider(
                                role="edit_model", model="edit-model", provider="openai_image_edit"
                            )
                        ).edit(request)

        self.assertFalse(ctx.exception.retryable)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertNotIn("secret-key", str(ctx.exception))

    def test_openai_chat_image_edit_marks_download_http_503_as_retryable(self):
        payload = {"choices": [{"message": {"content": "https://signed.example/temporary.png"}}]}
        response = requests.Response()
        response.status_code = 503
        error = requests.HTTPError("503 Server Error", response=response)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            Image.new("RGB", (32, 18), "white").save(source)
            request = ImageEditRequest(
                source_image_path=str(source),
                prompt_id="base_clean_background",
                prompt="remove text",
                output_asset_path="assets/out.png",
                asset_root=str(root),
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with patch("src.image_result.requests.get") as get:
                    get.return_value.raise_for_status.side_effect = error
                    with self.assertRaises(ProviderError) as ctx:
                        OpenAIChatImageEditProvider(
                            _provider(
                                role="edit_model", model="edit-model", provider="openai_image_edit"
                            )
                        ).edit(request)

        self.assertTrue(ctx.exception.retryable)
        self.assertEqual(ctx.exception.status_code, 503)

    def test_openai_chat_image_generation_provider_writes_normalized_image(self):
        image_base64 = base64.b64encode(_png_bytes()).decode()
        payload = {"choices": [{"message": {"content": f"data:image/png;base64,{image_base64}"}}]}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request = ImageGenerationRequest(
                prompt_id="asset_sheet",
                prompt="transparent asset sheet",
                output_asset_path="assets/sheet.png",
                asset_root=str(root),
                timeout_seconds=9,
            )

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                result = OpenAIChatImageGenerationProvider(
                    _provider(
                        role="image_model",
                        model="image-model",
                        provider="openai_image_generation",
                    )
                ).generate(request)

            self.assertTrue(Path(result.output_asset_path).exists())
            self.assertEqual(result.provider_role, "image_model")
            self.assertEqual(result.provider_name, "openai_image_generation")
            self.assertEqual(result.model, "image-model")
            self.assertEqual(result.timeout_seconds, 9)

    def test_live_provider_errors_are_redacted_and_typed(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            provider = OpenAIChatOCRProvider(_provider())

            with patch("src.generative_editable_providers.requests.post") as post:
                post.side_effect = requests.Timeout("api_key=secret-key timed out")
                with self.assertRaises(ProviderTimeoutError) as ctx:
                    provider.extract_text(str(image_path))
            self.assertNotIn("secret-key", str(ctx.exception))

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse({}, status_error=RuntimeError("token=secret-key"))
                with self.assertRaises(ProviderError) as ctx:
                    provider.extract_text(str(image_path))
            self.assertNotIn("secret-key", str(ctx.exception))

    def test_openai_chat_post_has_hard_deadline_for_blocking_reads(self):
        def slow_post(*args, **kwargs):
            time.sleep(2)
            return _FakeResponse({"choices": []})

        with patch("src.generative_editable_providers.requests.post", side_effect=slow_post):
            with self.assertRaises(ProviderTimeoutError) as ctx:
                _post_openai_chat(
                    _provider(),
                    {"model": "vision-model", "messages": []},
                    operation="blocking_read",
                    timeout_seconds=1,
                )

        self.assertIn("timeout_seconds=1", str(ctx.exception))

    def test_image_url_download_has_hard_deadline_for_blocking_reads(self):
        payload = {"choices": [{"message": {"content": "https://provider.example/image.png"}}]}

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request = ImageGenerationRequest(
                prompt_id="asset_sheet",
                prompt="transparent asset sheet",
                output_asset_path="assets/sheet.png",
                asset_root=str(root),
                timeout_seconds=1,
            )

            def slow_get(*args, **kwargs):
                time.sleep(2)
                return _FakeResponse(b"")

            with patch("src.generative_editable_providers.requests.post") as post:
                post.return_value = _FakeResponse(payload)
                with patch("src.image_result.requests.get", side_effect=slow_get):
                    with self.assertRaises(ProviderTimeoutError) as ctx:
                        OpenAIChatImageGenerationProvider(
                            _provider(
                                role="image_model",
                                model="image-model",
                                provider="openai_image_generation",
                            )
                        ).generate(request)

        self.assertIn("timeout_seconds=1", str(ctx.exception))

    def test_nested_provider_hard_deadline_preserves_outer_remaining_time(self):
        import src.generative_editable_providers as providers

        helper = getattr(providers, "_provider_hard_deadline", None)
        self.assertIsNotNone(helper)

        start = time.perf_counter()
        with self.assertRaises(TimeoutError):
            with helper(1):
                with helper(1):
                    time.sleep(0.7)
                time.sleep(0.5)
        elapsed = time.perf_counter() - start

        self.assertLess(elapsed, 1.15)

    def test_nested_provider_hard_deadline_uses_outer_remaining_when_inner_is_longer(self):
        import src.generative_editable_providers as providers

        helper = getattr(providers, "_provider_hard_deadline", None)
        self.assertIsNotNone(helper)

        start = time.perf_counter()
        with self.assertRaises(TimeoutError):
            with helper(1):
                with helper(2):
                    time.sleep(1.2)
        elapsed = time.perf_counter() - start

        self.assertLess(elapsed, 1.15)


def _png_bytes() -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        image_path = Path(tmp) / "image.png"
        Image.new("RGBA", (8, 8), (16, 185, 129, 255)).save(image_path)
        return image_path.read_bytes()


def json_payload(payload) -> str:
    import json

    return json.dumps(payload)


if __name__ == "__main__":
    unittest.main()

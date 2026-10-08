import asyncio
import base64
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from pydantic import ValidationError

from api.models import ExportRequest, ExportSlide
from api.routes.export import export_presentation
import api.routes.export as export_route


def _slide_base64(size=(800, 450), color="white") -> str:
    with tempfile.TemporaryDirectory() as tmp:
        image_path = Path(tmp) / "slide.png"
        Image.new("RGB", size, color).save(image_path)
        return base64.b64encode(image_path.read_bytes()).decode()


def _fake_route_dependencies(*, validation_status="passed"):
    return export_route._build_fake_generative_editable_pipeline_dependencies(
        validation_status=validation_status
    )


def _fake_vlm_route_dependencies(*, validation_status="passed"):
    from src.generative_editable_config import ProviderConfig
    from src.generative_editable_preview_validator import ValidationIssue, ValidationReport
    from src.generative_editable_providers import FakeImageEditProvider
    from src.generative_editable_vlm_reconstruction import (
        FakeVLMPageAnalysisProvider,
        VLMEditablePipelineDependencies,
    )

    def preview_validator(**kwargs):
        if validation_status == "failed":
            return ValidationReport(
                status="failed",
                checked_pages=1,
                issues=[
                    ValidationIssue(
                        code="preview_similarity_failed",
                        message="forced preview failure",
                        slide_id=kwargs["slide_id"],
                    )
                ],
            )
        return ValidationReport(status="passed", checked_pages=1, issues=[])

    return VLMEditablePipelineDependencies(
        vlm_provider=FakeVLMPageAnalysisProvider(),
        image_edit_provider=FakeImageEditProvider(
            ProviderConfig(
                role="edit_model",
                provider="fake_image_edit",
                model="fake-image-edit",
                base_url="fake",
                api_key="fake",
            )
        ),
        preview_validator=preview_validator,
    )


def _fake_vlm_config():
    from dataclasses import replace

    from src.generative_editable_config import load_generative_editable_config

    return replace(load_generative_editable_config(use_fake=True), reconstruction_mode="vlm_first")


class GenerativeEditableExportContractTest(unittest.TestCase):
    def setUp(self):
        self._original_config_loader = export_route.load_generative_editable_config
        export_route.load_generative_editable_config = _fake_vlm_config

    def tearDown(self):
        export_route.load_generative_editable_config = self._original_config_loader

    def test_accepts_generative_editable_pptx_format(self):
        request = ExportRequest(
            slides=[ExportSlide(image_base64=_slide_base64())],
            format="generative_editable_pptx",
        )

        self.assertEqual(request.format, "generative_editable_pptx")

    def test_rejects_unknown_export_format(self):
        with self.assertRaises(ValidationError):
            ExportRequest(
                slides=[ExportSlide(image_base64=_slide_base64())],
                format="docx",
            )

    def test_request_carries_slide_order_fallback_policy_and_text_metadata(self):
        request = ExportRequest(
            slides=[
                ExportSlide(
                    image_base64=_slide_base64(color="white"),
                    slide_id="slide-a",
                    text_metadata=[
                        {
                            "text": "Quarterly Plan",
                            "role": "title",
                            "order": 1,
                            "style_hint": {"font_size": 32, "bold": True},
                        }
                    ],
                ),
                ExportSlide(
                    image_base64=_slide_base64(color="black"),
                    slide_id="slide-b",
                    text_metadata=[],
                ),
            ],
            format="generative_editable_pptx",
            aspect_ratio="4:3",
            slide_order=["slide-b", "slide-a"],
            editable_options={"fallback_policy": "text_editable_background"},
        )

        dumped = request.model_dump()

        self.assertEqual(dumped["aspect_ratio"], "4:3")
        self.assertEqual(dumped["slide_order"], ["slide-b", "slide-a"])
        self.assertEqual(dumped["editable_options"]["fallback_policy"], "text_editable_background")
        self.assertEqual(dumped["slides"][0]["slide_id"], "slide-a")
        self.assertEqual(dumped["slides"][0]["text_metadata"][0]["text"], "Quarterly Plan")
        self.assertEqual(dumped["slides"][0]["text_metadata"][0]["style_hint"]["bold"], True)

    def test_default_fallback_policy_is_fail(self):
        request = ExportRequest(
            slides=[ExportSlide(image_base64=_slide_base64())],
            format="generative_editable_pptx",
        )

        self.assertEqual(request.editable_options.fallback_policy, "fail")

    def test_rejects_invalid_fallback_policy(self):
        with self.assertRaises(ValidationError):
            ExportRequest(
                slides=[ExportSlide(image_base64=_slide_base64())],
                format="generative_editable_pptx",
                editable_options={"fallback_policy": "best_effort"},
            )

    def test_generative_editable_export_uses_distinct_pptx_response(self):
        thread_calls = []

        async def fake_to_thread(func, *args, **kwargs):
            thread_calls.append((func, args, kwargs))
            return func(*args, **kwargs)

        def fake_export_generative_editable_pptx(
            image_paths,
            output_path,
            *,
            aspect_ratio="16:9",
            slides=None,
            editable_options=None,
            slide_order=None,
        ):
            self.assertEqual(slide_order, ["slide-1"])
            Path(output_path).write_bytes(b"generative-pptx")

        original_to_thread = asyncio.to_thread
        original_exporter = export_route._export_generative_editable_pptx
        asyncio.to_thread = fake_to_thread
        export_route._export_generative_editable_pptx = fake_export_generative_editable_pptx
        try:
            request = ExportRequest(
                slides=[ExportSlide(image_base64=_slide_base64())],
                format="generative_editable_pptx",
                slide_order=["slide-1"],
            )

            response = asyncio.run(export_presentation(request))

            self.assertEqual(Path(response.path).read_bytes(), b"generative-pptx")
            self.assertEqual(response.filename, "presentation.generative-editable.pptx")
            self.assertEqual(
                response.media_type,
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            )
            self.assertEqual(
                [getattr(call[0], "__name__", "") for call in thread_calls],
                ["fake_export_generative_editable_pptx"],
            )
            self.assertEqual(thread_calls[0][2]["slide_order"], ["slide-1"])
            asyncio.run(response.background())
        finally:
            asyncio.to_thread = original_to_thread
            export_route._export_generative_editable_pptx = original_exporter

    def test_generative_editable_export_exposes_fallback_response_metadata(self):
        thread_calls = []

        async def fake_to_thread(func, *args, **kwargs):
            thread_calls.append((func, args, kwargs))
            return func(*args, **kwargs)

        def fake_export_pptx(image_paths, output_path, aspect_ratio="16:9"):
            Path(output_path).write_bytes(b"raster-fallback")

        original_to_thread = asyncio.to_thread
        original_export_pptx = export_route._export_pptx
        original_dependencies = export_route._build_generative_editable_pipeline_dependencies
        original_vlm_dependencies = export_route._build_vlm_editable_pipeline_dependencies
        asyncio.to_thread = fake_to_thread
        export_route._export_pptx = fake_export_pptx
        export_route._build_generative_editable_pipeline_dependencies = lambda: (
            _fake_route_dependencies(validation_status="failed")
        )
        export_route._build_vlm_editable_pipeline_dependencies = lambda config: (
            _fake_vlm_route_dependencies(validation_status="failed")
        )
        try:
            request = ExportRequest(
                slides=[ExportSlide(image_base64=_slide_base64())],
                format="generative_editable_pptx",
                editable_options={"fallback_policy": "raster_pptx"},
            )

            response = asyncio.run(export_presentation(request))

            self.assertEqual(Path(response.path).read_bytes(), b"raster-fallback")
            self.assertEqual(response.headers["X-Generative-Editable-Status"], "fallback_used")
            self.assertEqual(
                response.headers["X-Generative-Editable-Fallback-Policy"], "raster_pptx"
            )
            self.assertEqual(response.headers["X-Generative-Editable-Fallback-Used"], "raster_pptx")
            self.assertEqual(
                [getattr(call[0], "__name__", "") for call in thread_calls],
                ["_export_generative_editable_pptx"],
            )
            asyncio.run(response.background())
        finally:
            asyncio.to_thread = original_to_thread
            export_route._export_pptx = original_export_pptx
            export_route._build_generative_editable_pipeline_dependencies = original_dependencies
            export_route._build_vlm_editable_pipeline_dependencies = original_vlm_dependencies

    def test_temporary_generative_export_does_not_silently_return_raster_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            output_path = Path(tmp) / "out.pptx"
            Image.new("RGB", (800, 450), "white").save(image_path)

            original_dependencies = export_route._build_generative_editable_pipeline_dependencies
            original_vlm_dependencies = export_route._build_vlm_editable_pipeline_dependencies
            export_route._build_generative_editable_pipeline_dependencies = lambda: (
                _fake_route_dependencies(validation_status="failed")
            )
            export_route._build_vlm_editable_pipeline_dependencies = lambda config: (
                _fake_vlm_route_dependencies(validation_status="failed")
            )
            try:
                with self.assertRaisesRegex(RuntimeError, "validation failed"):
                    export_route._export_generative_editable_pptx(
                        [str(image_path)],
                        str(output_path),
                        editable_options=ExportRequest(
                            slides=[ExportSlide(image_base64=_slide_base64())],
                            format="generative_editable_pptx",
                        ).editable_options,
                    )
            finally:
                export_route._build_generative_editable_pipeline_dependencies = (
                    original_dependencies
                )
                export_route._build_vlm_editable_pipeline_dependencies = original_vlm_dependencies

            self.assertFalse(output_path.exists())

    def test_generative_editable_export_rejects_non_vlm_reconstruction_mode(self):
        from src.generative_editable_config import (
            GenerativeEditableConfig,
            GenerativeEditableConfigError,
            ProviderConfig,
            QualityConfig,
            RetryConfig,
            TimeoutConfig,
        )

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            output_path = Path(tmp) / "out.pptx"
            Image.new("RGB", (800, 450), "white").save(image_path)

            provider = ProviderConfig(
                role="stub",
                model="stub-model",
                base_url="https://example.test/v1",
                api_key="secret",
            )
            non_vlm_config = GenerativeEditableConfig(
                ocr=provider,
                clean_base_model=provider,
                asset_sheet_model=provider,
                repair_model=provider,
                generation_model=provider,
                use_aippt_metadata_first=True,
                ocr_min_confidence=0.75,
                quality=QualityConfig(),
                retries=RetryConfig(),
                timeouts=TimeoutConfig(),
                reconstruction_mode="generative",
            )

            original_loader = export_route.load_generative_editable_config
            export_route.load_generative_editable_config = lambda: non_vlm_config
            try:
                with self.assertRaisesRegex(
                    GenerativeEditableConfigError,
                    "VLM-first reconstruction is required",
                ):
                    export_route._export_generative_editable_pptx(
                        [str(image_path)],
                        str(output_path),
                    )
            finally:
                export_route.load_generative_editable_config = original_loader

        self.assertFalse(output_path.exists())

    def test_generative_export_accepts_explicit_raster_fallback_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            output_path = Path(tmp) / "out.pptx"
            Image.new("RGB", (800, 450), "white").save(image_path)

            original_export_pptx = export_route._export_pptx
            original_dependencies = export_route._build_generative_editable_pipeline_dependencies
            original_vlm_dependencies = export_route._build_vlm_editable_pipeline_dependencies
            export_route._export_pptx = lambda image_paths, output_path, aspect_ratio="16:9": Path(
                output_path
            ).write_bytes(b"raster-fallback")
            export_route._build_generative_editable_pipeline_dependencies = lambda: (
                _fake_route_dependencies(validation_status="failed")
            )
            export_route._build_vlm_editable_pipeline_dependencies = lambda config: (
                _fake_vlm_route_dependencies(validation_status="failed")
            )
            try:
                export_route._export_generative_editable_pptx(
                    [str(image_path)],
                    str(output_path),
                    editable_options={
                        "fallback_policy": "raster_pptx",
                    },
                )
            finally:
                export_route._export_pptx = original_export_pptx
                export_route._build_generative_editable_pipeline_dependencies = (
                    original_dependencies
                )
                export_route._build_vlm_editable_pipeline_dependencies = original_vlm_dependencies

            self.assertEqual(output_path.read_bytes(), b"raster-fallback")

    def test_generative_export_raster_fallback_preserves_slide_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = root / "first.png"
            second = root / "second.png"
            output_path = root / "out.pptx"
            Image.new("RGB", (800, 450), "white").save(first)
            Image.new("RGB", (800, 450), "black").save(second)
            captured = {}

            def fake_export_pptx(image_paths, output_path, aspect_ratio="16:9"):
                captured["image_paths"] = list(image_paths)
                Path(output_path).write_bytes(b"raster-fallback")

            original_export_pptx = export_route._export_pptx
            original_dependencies = export_route._build_generative_editable_pipeline_dependencies
            original_vlm_dependencies = export_route._build_vlm_editable_pipeline_dependencies
            export_route._export_pptx = fake_export_pptx
            export_route._build_generative_editable_pipeline_dependencies = lambda: (
                _fake_route_dependencies(validation_status="failed")
            )
            export_route._build_vlm_editable_pipeline_dependencies = lambda config: (
                _fake_vlm_route_dependencies(validation_status="failed")
            )
            try:
                export_route._export_generative_editable_pptx(
                    [str(first), str(second)],
                    str(output_path),
                    slides=[
                        ExportSlide(image_base64=_slide_base64(), slide_id="slide-a"),
                        ExportSlide(image_base64=_slide_base64(), slide_id="slide-b"),
                    ],
                    slide_order=["slide-b", "slide-a"],
                    editable_options={"fallback_policy": "raster_pptx"},
                )
            finally:
                export_route._export_pptx = original_export_pptx
                export_route._build_generative_editable_pipeline_dependencies = (
                    original_dependencies
                )
                export_route._build_vlm_editable_pipeline_dependencies = original_vlm_dependencies

            self.assertEqual(captured["image_paths"], [str(second), str(first)])

    def test_existing_pptx_export_still_uses_raster_exporter(self):
        thread_calls = []

        async def fake_to_thread(func, *args, **kwargs):
            thread_calls.append(func)
            return func(*args, **kwargs)

        def fake_export_pptx(image_paths, output_path, aspect_ratio="16:9"):
            Path(output_path).write_bytes(b"raster-pptx")

        original_to_thread = asyncio.to_thread
        original_export_pptx = export_route._export_pptx
        asyncio.to_thread = fake_to_thread
        export_route._export_pptx = fake_export_pptx
        try:
            request = ExportRequest(
                slides=[ExportSlide(image_base64=_slide_base64())],
                format="pptx",
            )

            response = asyncio.run(export_presentation(request))

            self.assertEqual(Path(response.path).read_bytes(), b"raster-pptx")
            self.assertEqual(response.filename, "presentation.pptx")
            self.assertEqual(
                [getattr(func, "__name__", "") for func in thread_calls],
                ["fake_export_pptx"],
            )
            asyncio.run(response.background())
        finally:
            asyncio.to_thread = original_to_thread
            export_route._export_pptx = original_export_pptx


if __name__ == "__main__":
    unittest.main()

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from src.generative_editable_config import ProviderConfig, load_generative_editable_config
from src.generative_editable_pipeline import GenerativeEditablePipelineDependencies
from src.generative_editable_providers import (
    FakeImageEditProvider,
    FakeImageGenerationProvider,
    FakeOCRProvider,
    ImageGenerationRequest,
    ImageGenerationProvider,
    ProviderError,
)
from scripts.smoke_generative_editable_pptx import main


class GenerativeEditableSmokeScriptTest(unittest.TestCase):
    def test_fake_smoke_script_runs_and_prints_redacted_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(["--use-fake", "--slides", "one", "--output-dir", tmp])

            self.assertEqual(exit_code, 0)
            lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(lines[0]["config"]["ocr"]["api_key"], "EMPTY")
            self.assertEqual(lines[0]["config"]["ocr"]["base_url"], "EMPTY")
            self.assertNotIn("http", stdout.getvalue())
            self.assertEqual(lines[1]["status"], "passed")
            self.assertEqual(lines[1]["slide_count"], 1)
            self.assertTrue(Path(lines[1]["output_path"]).exists())

    def test_fake_smoke_script_can_check_image_generation_provider_directly(self):
        config = load_generative_editable_config(use_fake=True)

        class RecordingImageGenerationProvider(FakeImageGenerationProvider):
            def __init__(self):
                super().__init__(config.generation_model)
                self.requests: list[ImageGenerationRequest] = []

            def generate(self, request: ImageGenerationRequest):
                self.requests.append(request)
                return super().generate(request)

        provider = RecordingImageGenerationProvider()
        dependencies = GenerativeEditablePipelineDependencies(
            ocr_provider=FakeOCRProvider(config.ocr),
            image_edit_provider=FakeImageEditProvider(config.clean_base_model),
            image_generation_provider=provider,
        )

        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.smoke_generative_editable_pptx.export_route"
                    "._build_fake_generative_editable_pipeline_dependencies",
                    return_value=dependencies,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = main(
                    [
                        "--use-fake",
                        "--provider-check",
                        "image_generation",
                        "--output-dir",
                        tmp,
                    ]
                )

            self.assertEqual(exit_code, 0)
            lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(lines[1]["status"], "passed")
            self.assertEqual(lines[1]["provider_check"], "image_generation")
            self.assertTrue(Path(lines[1]["output_path"]).exists())
            self.assertEqual(len(provider.requests), 1)
            source_image_path = provider.requests[0].visual_reference["source_image_path"]
            self.assertTrue(Path(source_image_path).exists())

    def test_fake_smoke_script_can_check_image_edit_provider_directly(self):
        config = load_generative_editable_config(use_fake=True)
        checked_roles: list[str] = []

        class RecordingImageEditProvider(FakeImageEditProvider):
            def edit(self, request):
                checked_roles.append(self.config.role)
                return super().edit(request)

        dependencies = GenerativeEditablePipelineDependencies(
            ocr_provider=FakeOCRProvider(config.ocr),
            image_edit_provider=RecordingImageEditProvider(
                ProviderConfig(
                    role="clean_base_model",
                    provider="fake_image_edit",
                    model="fake-edit",
                    base_url="",
                    api_key="",
                )
            ),
            asset_sheet_image_edit_provider=RecordingImageEditProvider(
                ProviderConfig(
                    role="asset_sheet_model",
                    provider="fake_image_edit",
                    model="fake-edit",
                    base_url="",
                    api_key="",
                )
            ),
            repair_image_edit_provider=RecordingImageEditProvider(
                ProviderConfig(
                    role="repair_model",
                    provider="fake_image_edit",
                    model="fake-edit",
                    base_url="",
                    api_key="",
                )
            ),
            image_generation_provider=FakeImageGenerationProvider(config.generation_model),
        )

        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.smoke_generative_editable_pptx.export_route"
                    "._build_fake_generative_editable_pipeline_dependencies",
                    return_value=dependencies,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = main(
                    [
                        "--use-fake",
                        "--provider-check",
                        "image_edit",
                        "--output-dir",
                        tmp,
                    ]
                )

            self.assertEqual(exit_code, 0)
            lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(lines[1]["status"], "passed")
            self.assertEqual(lines[1]["provider_check"], "image_edit")
            self.assertEqual(
                [item["role"] for item in lines[1]["checked_providers"]],
                ["clean_base_model", "asset_sheet_model", "repair_model"],
            )
            self.assertEqual(
                checked_roles, ["clean_base_model", "asset_sheet_model", "repair_model"]
            )
            for item in lines[1]["checked_providers"]:
                self.assertTrue(Path(item["output_path"]).exists())

    def test_fake_smoke_script_can_check_ocr_provider_directly(self):
        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = main(
                    [
                        "--use-fake",
                        "--provider-check",
                        "ocr",
                        "--output-dir",
                        tmp,
                    ]
                )

            self.assertEqual(exit_code, 0)
            lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(lines[1]["status"], "passed")
            self.assertEqual(lines[1]["provider_check"], "ocr")
            self.assertGreaterEqual(lines[1]["item_count"], 1)

    def test_provider_check_uses_configured_retry_wrapper(self):
        config = load_generative_editable_config(use_fake=True)

        class FlakyImageGenerationProvider(ImageGenerationProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="image_model",
                        provider="flaky-image-generation",
                        model="fake",
                        base_url="",
                        api_key="",
                    )
                )
                self.calls = 0
                self.fake = FakeImageGenerationProvider(config.generation_model)

            def generate(self, request):
                self.calls += 1
                if self.calls == 1:
                    raise ProviderError(
                        provider_role=self.config.role,
                        operation=request.prompt_id,
                        message="temporary provider failure",
                        retryable=True,
                    )
                return self.fake.generate(request)

        flaky = FlakyImageGenerationProvider()
        dependencies = GenerativeEditablePipelineDependencies(
            ocr_provider=FakeOCRProvider(config.ocr),
            image_edit_provider=FakeImageEditProvider(config.clean_base_model),
            image_generation_provider=flaky,
            provider_max_attempts=2,
            provider_retry_backoff_seconds=0,
        )

        with tempfile.TemporaryDirectory() as tmp:
            stdout = io.StringIO()
            with (
                patch(
                    "scripts.smoke_generative_editable_pptx.export_route"
                    "._build_fake_generative_editable_pipeline_dependencies",
                    return_value=dependencies,
                ),
                redirect_stdout(stdout),
            ):
                exit_code = main(
                    [
                        "--use-fake",
                        "--provider-check",
                        "image_generation",
                        "--output-dir",
                        tmp,
                    ]
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(flaky.calls, 2)


if __name__ == "__main__":
    unittest.main()

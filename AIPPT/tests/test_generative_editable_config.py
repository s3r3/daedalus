import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

from src.generative_editable_config import (
    GenerativeEditableConfigError,
    load_generative_editable_config,
)


ROOT = Path(__file__).resolve().parents[1]


class GenerativeEditableConfigTest(unittest.TestCase):
    def test_example_config_documents_provider_roles_and_quality_controls(self):
        example = yaml.safe_load((ROOT / "config.example.yaml").read_text(encoding="utf-8"))

        models = example["api"]["models"]
        expected_providers = {
            "ocr_model": "your-ocr-api-key",
            "image_model": "your-image-api-key",
            "edit_model": "your-edit-api-key",
        }
        for role, placeholder_key in expected_providers.items():
            self.assertIn(role, models)
            self.assertIn("base_url", models[role])
            self.assertIn("api_key", models[role])
            self.assertIn("model", models[role])
            self.assertEqual(models[role]["api_key"], placeholder_key)
        self.assertNotIn("provider", models["ocr_model"])
        self.assertNotIn("adapter", models["ocr_model"])
        self.assertNotIn("adapter", models["image_model"])
        self.assertNotIn("adapter", models["edit_model"])

        generative = example["generative_editable_pptx"]
        self.assertEqual(generative["reconstruction"]["mode"], "vlm_first")
        self.assertEqual(generative["reconstruction"]["clean_base_model"], "edit_model")
        self.assertEqual(generative["reconstruction"]["asset_sheet_model"], "edit_model")
        self.assertEqual(generative["reconstruction"]["repair_model"], "edit_model")
        self.assertEqual(generative["reconstruction"]["generation_model"], "image_model")
        self.assertEqual(generative["ocr"]["model"], "ocr_model")
        self.assertTrue(generative["ocr"]["use_aippt_metadata_first"])
        self.assertIn("max_repair_attempts", generative["quality"])
        self.assertIn("preview_similarity_threshold", generative["quality"])
        self.assertIn("provider_max_attempts", generative["retries"])
        self.assertIn("repair_max_attempts", generative["retries"])
        self.assertIn("backoff_seconds", generative["retries"])
        self.assertIn("provider_call", generative["timeouts"])
        self.assertIn("page", generative["timeouts"])

    def test_loads_provider_settings_from_project_config(self):
        config = {
            "api": {
                "models": {
                    "ocr_model": {
                        "api_key": "ocr-secret",
                        "base_url": "https://ocr.example/api",
                        "model": "PaddleOCR-VL-1.6",
                    },
                    "image_model": {
                        "api_key": "image-secret",
                        "base_url": "https://image.example/v1",
                        "model": "gpt-image-2",
                        "adapter": "raw_chat_multimodal",
                    },
                    "edit_model": {
                        "api_key": "edit-secret",
                        "base_url": "https://edit.example/v1",
                        "model": "gpt-image-2",
                        "adapter": "raw_chat_multimodal",
                    },
                }
            },
            "generative_editable_pptx": {
                "reconstruction": {
                    "mode": "generative",
                    "clean_base_model": "edit_model",
                    "asset_sheet_model": "edit_model",
                    "repair_model": "edit_model",
                    "generation_model": "image_model",
                },
                "ocr": {
                    "model": "ocr_model",
                    "use_aippt_metadata_first": True,
                    "min_confidence": 0.81,
                },
                "quality": {"max_repair_attempts": 3, "preview_similarity_threshold": 0.9},
                "retries": {
                    "provider_max_attempts": 4,
                    "repair_max_attempts": 2,
                    "backoff_seconds": 0.5,
                },
                "timeouts": {"provider_call": 120, "page": 500},
            },
        }

        with patch("src.generative_editable_config.get_config", return_value=config):
            loaded = load_generative_editable_config()

        self.assertEqual(loaded.ocr.model, "PaddleOCR-VL-1.6")
        self.assertEqual(loaded.reconstruction_mode, "generative")
        self.assertEqual(loaded.ocr.api_key, "ocr-secret")
        self.assertEqual(loaded.ocr.provider, "")
        self.assertEqual(loaded.clean_base_model.api_key, "edit-secret")
        self.assertEqual(loaded.asset_sheet_model.base_url, "https://edit.example/v1")
        self.assertEqual(loaded.generation_model.model, "gpt-image-2")
        self.assertEqual(loaded.ocr_min_confidence, 0.81)
        self.assertEqual(loaded.quality.max_repair_attempts, 3)
        self.assertEqual(loaded.retries.provider_max_attempts, 4)
        self.assertEqual(loaded.retries.backoff_seconds, 0.5)
        self.assertEqual(loaded.timeouts.page, 500)

    def test_edit_model_roles_inherit_image_model_when_edit_model_is_omitted(self):
        config = {
            "api": {
                "models": {
                    "ocr_model": {
                        "api_key": "ocr-secret",
                        "base_url": "https://ocr.example/api",
                        "model": "PaddleOCR-VL-1.6",
                    },
                    "image_model": {
                        "api_key": "image-secret",
                        "base_url": "https://image.example/v1",
                        "model": "gpt-image-2",
                        "adapter": "raw_chat_multimodal",
                    },
                }
            },
            "generative_editable_pptx": {
                "reconstruction": {
                    "clean_base_model": "edit_model",
                    "asset_sheet_model": "edit_model",
                    "repair_model": "edit_model",
                    "generation_model": "image_model",
                },
                "ocr": {"model": "ocr_model"},
            },
        }

        with patch("src.generative_editable_config.get_config", return_value=config):
            loaded = load_generative_editable_config()

        self.assertEqual(loaded.clean_base_model.role, "edit_model")
        self.assertEqual(loaded.clean_base_model.api_key, "image-secret")
        self.assertEqual(loaded.asset_sheet_model.model, "gpt-image-2")

    def test_remote_ocr_provider_does_not_require_provider_or_adapter_fields(self):
        config = {
            "api": {
                "models": {
                    "ocr_model": {
                        "api_key": "ocr-secret",
                        "base_url": "https://ocr.example/v1",
                        "model": "PaddlePaddle/PaddleOCR-VL-1.5",
                    },
                    "image_model": {
                        "api_key": "image-secret",
                        "base_url": "https://image.example/v1",
                        "model": "gpt-image-2",
                    },
                }
            },
            "generative_editable_pptx": {
                "ocr": {"model": "ocr_model"},
            },
        }

        with patch("src.generative_editable_config.get_config", return_value=config):
            loaded = load_generative_editable_config()

        self.assertEqual(loaded.ocr.provider, "")
        self.assertEqual(loaded.ocr.adapter, "")
        self.assertEqual(loaded.ocr.model, "PaddlePaddle/PaddleOCR-VL-1.5")

    def test_loader_ignores_stale_ocr_provider_and_adapter_fields(self):
        config = {
            "api": {
                "models": {
                    "ocr_model": {
                        "provider": "local_tesseract",
                        "adapter": "unused",
                        "api_key": "ocr-secret",
                        "base_url": "https://ocr.example/v1",
                        "model": "PaddlePaddle/PaddleOCR-VL-1.5",
                    },
                    "image_model": {
                        "api_key": "image-secret",
                        "base_url": "https://image.example/v1",
                        "model": "gpt-image-2",
                    },
                }
            },
            "generative_editable_pptx": {
                "ocr": {"model": "ocr_model"},
            },
        }

        with patch("src.generative_editable_config.get_config", return_value=config):
            loaded = load_generative_editable_config()

        self.assertEqual(loaded.ocr.provider, "")
        self.assertEqual(loaded.ocr.adapter, "")
        self.assertEqual(loaded.ocr.base_url, "https://ocr.example/v1")

    def test_missing_provider_settings_raise_redacted_error(self):
        config = {
            "api": {"models": {"ocr_model": {"api_key": "do-not-leak"}}},
            "generative_editable_pptx": {
                "reconstruction": {"clean_base_model": "edit_model"},
                "ocr": {"model": "ocr_model"},
            },
        }

        with (
            patch("src.generative_editable_config.get_config", return_value=config),
            self.assertRaises(GenerativeEditableConfigError) as ctx,
        ):
            load_generative_editable_config()

        message = str(ctx.exception)
        self.assertIn("ocr_model", message)
        self.assertIn("image_model", message)
        self.assertIn("edit_model", message)
        self.assertNotIn("do-not-leak", message)

    def test_string_boolean_settings_are_parsed_explicitly(self):
        config = {
            "api": {
                "models": {
                    "ocr_model": {
                        "provider": "paddle_ocr_vl",
                        "api_key": "ocr-secret",
                        "base_url": "https://ocr.example/api",
                        "model": "PaddleOCR-VL-1.6",
                    },
                    "image_model": {
                        "api_key": "image-secret",
                        "base_url": "https://image.example/v1",
                        "model": "gpt-image-2",
                    },
                }
            },
            "generative_editable_pptx": {
                "ocr": {"model": "ocr_model", "use_aippt_metadata_first": "false"},
                "quality": {"require_preview_validation": "false"},
            },
        }

        with patch("src.generative_editable_config.get_config", return_value=config):
            loaded = load_generative_editable_config()

        self.assertFalse(loaded.use_aippt_metadata_first)
        self.assertFalse(loaded.quality.require_preview_validation)

    def test_null_provider_role_names_raise_redacted_config_error(self):
        config = {
            "api": {"models": {}},
            "generative_editable_pptx": {
                "reconstruction": {"clean_base_model": None},
                "ocr": {"model": None},
            },
        }

        with (
            patch("src.generative_editable_config.get_config", return_value=config),
            self.assertRaises(GenerativeEditableConfigError) as ctx,
        ):
            load_generative_editable_config()

        self.assertIn(
            "generative editable provider role must be a non-empty string", str(ctx.exception)
        )

    def test_fake_provider_config_does_not_read_live_credentials(self):
        with patch("src.generative_editable_config.get_config") as get_config:
            loaded = load_generative_editable_config(use_fake=True)

        get_config.assert_not_called()
        self.assertEqual(loaded.ocr.provider, "fake_ocr")
        self.assertEqual(loaded.ocr.api_key, "")
        self.assertEqual(loaded.clean_base_model.provider, "fake_image_edit")
        self.assertEqual(loaded.asset_sheet_model.provider, "fake_image_edit")
        self.assertEqual(loaded.generation_model.provider, "fake_image_generation")
        self.assertEqual(loaded.quality.max_repair_attempts, 0)
        self.assertEqual(loaded.retries.provider_max_attempts, 0)


if __name__ == "__main__":
    unittest.main()

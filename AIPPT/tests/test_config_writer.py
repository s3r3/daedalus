import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import yaml

from src.config_writer import save_model_profiles_to_config


class ConfigWriterTest(unittest.TestCase):
    def test_saves_model_profiles_to_config_yaml(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.yaml"

            with (
                patch("src.config_writer.load_yaml_config", return_value={"ppt": {"num_pages": 3}}),
                patch("src.config_writer.reload_config"),
            ):
                save_model_profiles_to_config(
                    {
                        "text_model": {
                            "model": "text",
                            "base_url": "https://text.example/v1",
                            "api_key": "text-key",
                            "adapter": "openai_chat",
                            "thinking": "enabled",
                        },
                        "image_model": {
                            "model": "image",
                            "base_url": "https://image.example/v1",
                            "api_key": "image-key",
                            "adapter": "raw_chat_multimodal",
                        },
                        "VLM": {
                            "model": "vlm",
                            "base_url": "https://vlm.example/v1",
                            "api_key": "vlm-key",
                        },
                        "ocr_model": {
                            "model": "ocr",
                            "base_url": "https://ocr.example/v1",
                            "api_key": "ocr-key",
                        },
                    },
                    config_path=config_path,
                )

            saved = yaml.safe_load(config_path.read_text())
            self.assertEqual(saved["ppt"]["num_pages"], 3)
            self.assertEqual(saved["api"]["models"]["text_model"]["api_key"], "text-key")
            self.assertEqual(saved["api"]["models"]["text_model"]["thinking"], "enabled")
            self.assertNotIn("adapter", saved["api"]["models"]["text_model"])
            self.assertEqual(saved["api"]["models"]["image_model"]["model"], "image")
            self.assertNotIn("adapter", saved["api"]["models"]["image_model"])
            self.assertEqual(saved["api"]["models"]["VLM"]["model"], "vlm")
            self.assertEqual(saved["api"]["models"]["ocr_model"]["model"], "ocr")

    def test_empty_api_key_preserves_existing_secret(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "config.yaml"

            with (
                patch(
                    "src.config_writer.load_yaml_config",
                    return_value={
                        "api": {
                            "models": {
                                "text_model": {"api_key": "old-text-key"},
                                "image_model": {"api_key": "old-image-key"},
                                "VLM": {"api_key": "old-vlm-key"},
                                "ocr_model": {"api_key": "old-ocr-key"},
                            }
                        }
                    },
                ),
                patch("src.config_writer.reload_config"),
            ):
                save_model_profiles_to_config(
                    {
                        "text_model": {
                            "model": "new-text",
                            "base_url": "https://text.example/v1",
                            "api_key": "",
                            "adapter": "openai_chat",
                        },
                        "image_model": {
                            "model": "new-image",
                            "base_url": "https://image.example/v1",
                            "api_key": "",
                            "adapter": "raw_chat_multimodal",
                        },
                        "VLM": {
                            "model": "new-vlm",
                            "base_url": "https://vlm.example/v1",
                            "api_key": "",
                        },
                        "ocr_model": {
                            "model": "new-ocr",
                            "base_url": "https://ocr.example/v1",
                            "api_key": "",
                        },
                    },
                    config_path=config_path,
                )

            saved = yaml.safe_load(config_path.read_text())
            self.assertEqual(saved["api"]["models"]["text_model"]["api_key"], "old-text-key")
            self.assertEqual(saved["api"]["models"]["image_model"]["api_key"], "old-image-key")
            self.assertEqual(saved["api"]["models"]["VLM"]["api_key"], "old-vlm-key")
            self.assertEqual(saved["api"]["models"]["ocr_model"]["api_key"], "old-ocr-key")


if __name__ == "__main__":
    unittest.main()

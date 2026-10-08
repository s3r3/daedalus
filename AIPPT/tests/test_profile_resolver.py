import unittest
from types import SimpleNamespace
from unittest.mock import patch

from api.models import (
    EditConfig,
    GenerationConfig,
    ImageApiConfig,
    ModelProfileConfig,
    ModelProfilesConfig,
    TextApiConfig,
)
from api.profile_resolver import profiles_from_edit_config, profiles_from_generation_config
from src.model_profiles import ModelProfile, ModelProfileSet


class ProfileResolverTest(unittest.TestCase):
    def default_profiles(self):
        return ModelProfileSet(
            prompt=ModelProfile(
                role="prompt",
                model="default-text",
                base_url="https://text.example/v1",
                api_key="text-key",
            ),
            image=ModelProfile(
                role="image",
                model="default-image",
                base_url="https://image.example/v1",
                api_key="image-key",
                adapter="raw_chat_multimodal",
            ),
            edit=ModelProfile(
                role="edit",
                model="default-edit",
                base_url="https://edit.example/v1",
                api_key="edit-key",
                adapter="raw_chat_multimodal",
            ),
        )

    def test_empty_frontend_generation_config_uses_backend_profiles(self):
        config = GenerationConfig(
            text=TextApiConfig(
                api_key="", base_url="https://oneapi.example/v1", model="DeepSeek-V4-Pro"
            ),
            image=ImageApiConfig(
                api_key="", base_url="https://image.example/v1", model="gpt-image-2"
            ),
            page_count=1,
        )

        with patch(
            "api.profile_resolver.load_default_profiles", return_value=self.default_profiles()
        ):
            profiles = profiles_from_generation_config(config)

        self.assertEqual(profiles.prompt.api_key, "text-key")
        self.assertEqual(profiles.image.api_key, "image-key")

    def test_masked_frontend_generation_config_uses_backend_profiles(self):
        config = GenerationConfig(
            text=TextApiConfig(
                api_key="SET", base_url="https://oneapi.example/v1", model="DeepSeek-V4-Pro"
            ),
            image=ImageApiConfig(
                api_key="SET", base_url="https://image.example/v1", model="gpt-image-2"
            ),
            page_count=1,
        )

        with patch(
            "api.profile_resolver.load_default_profiles", return_value=self.default_profiles()
        ):
            profiles = profiles_from_generation_config(config)

        self.assertEqual(profiles.prompt.model, "default-text")
        self.assertEqual(profiles.image.model, "default-image")

    def test_complete_frontend_generation_config_overrides_backend_profiles(self):
        config = GenerationConfig(
            text=TextApiConfig(
                api_key="override-text-key",
                base_url="https://text.override/v1",
                model="override-text",
            ),
            image=ImageApiConfig(
                api_key="override-image-key",
                base_url="https://image.override/v1",
                model="override-image",
            ),
            page_count=1,
        )

        with patch(
            "api.profile_resolver.load_default_profiles", return_value=self.default_profiles()
        ):
            profiles = profiles_from_generation_config(config)

        self.assertEqual(profiles.prompt.api_key, "override-text-key")
        self.assertEqual(profiles.image.api_key, "override-image-key")

    def test_model_profile_requests_without_adapter_use_role_defaults(self):
        config = GenerationConfig(
            model_profiles=ModelProfilesConfig(
                text_model=ModelProfileConfig(
                    model="text",
                    base_url="https://text.example/v1",
                    api_key="text-key",
                ),
                image_model=ModelProfileConfig(
                    model="image",
                    base_url="https://image.example/v1",
                    api_key="image-key",
                ),
                edit_model=ModelProfileConfig(
                    model="edit",
                    base_url="https://edit.example/v1",
                    api_key="edit-key",
                ),
            ),
            page_count=1,
        )

        profiles = profiles_from_generation_config(config)

        self.assertEqual(profiles.prompt.adapter, "openai_chat")
        self.assertEqual(profiles.image.adapter, "raw_chat_multimodal")
        self.assertEqual(profiles.edit.adapter, "raw_chat_multimodal")

    def test_partial_generation_profile_object_without_image_model_uses_backend_profiles(self):
        config = SimpleNamespace(
            model_profiles=SimpleNamespace(
                text_model=ModelProfileConfig(
                    model="text",
                    base_url="https://text.example/v1",
                    api_key="text-key",
                ),
                prompt_model=None,
                VLM=None,
            ),
            text=None,
            image=None,
        )

        with patch(
            "api.profile_resolver.load_default_profiles", return_value=self.default_profiles()
        ):
            profiles = profiles_from_generation_config(config)

        self.assertEqual(profiles.prompt.model, "default-text")
        self.assertEqual(profiles.image.model, "default-image")

    def test_empty_edit_config_uses_backend_profiles(self):
        config = EditConfig(api_key="", base_url="", model="gpt-image-2")

        with patch(
            "api.profile_resolver.load_default_profiles", return_value=self.default_profiles()
        ):
            profiles = profiles_from_edit_config(config)

        self.assertEqual(profiles.edit.api_key, "edit-key")


if __name__ == "__main__":
    unittest.main()

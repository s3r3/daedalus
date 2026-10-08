"""Configuration helpers for the generative editable PPTX export pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import get_config


class GenerativeEditableConfigError(ValueError):
    """Raised when generative editable export configuration is incomplete."""


@dataclass(frozen=True)
class ProviderConfig:
    role: str
    model: str
    base_url: str
    api_key: str
    adapter: str = ""
    provider: str = ""


@dataclass(frozen=True)
class QualityConfig:
    max_repair_attempts: int = 2
    preview_similarity_threshold: float = 0.92
    require_preview_validation: bool = True


@dataclass(frozen=True)
class RetryConfig:
    provider_max_attempts: int = 2
    repair_max_attempts: int = 2
    backoff_seconds: float = 1.0


@dataclass(frozen=True)
class TimeoutConfig:
    provider_call: int = 180
    page: int = 600


@dataclass(frozen=True)
class GenerativeEditableConfig:
    ocr: ProviderConfig
    clean_base_model: ProviderConfig
    asset_sheet_model: ProviderConfig
    repair_model: ProviderConfig
    generation_model: ProviderConfig
    use_aippt_metadata_first: bool
    ocr_min_confidence: float
    quality: QualityConfig
    retries: RetryConfig
    timeouts: TimeoutConfig
    reconstruction_mode: str = "generative"


def load_generative_editable_config(use_fake: bool = False) -> GenerativeEditableConfig:
    """Load provider settings for generative editable PPTX export from config.yaml."""
    if use_fake:
        return _fake_config()

    raw_config = get_config()
    models = raw_config.get("api", {}).get("models", {})
    settings = raw_config.get("generative_editable_pptx", {})
    reconstruction = settings.get("reconstruction", {})
    ocr_settings = settings.get("ocr", {})
    reconstruction_mode = str(reconstruction.get("mode", "generative")).strip() or "generative"
    if reconstruction_mode not in {"generative", "vlm_first"}:
        raise GenerativeEditableConfigError(
            "generative editable reconstruction.mode must be one of: generative, vlm_first"
        )

    ocr_role = _role_setting(ocr_settings, "model", "ocr_model")
    clean_role = _role_setting(reconstruction, "clean_base_model", "edit_model")
    asset_role = _role_setting(reconstruction, "asset_sheet_model", "edit_model")
    repair_role = _role_setting(reconstruction, "repair_model", "edit_model")
    generation_role = _role_setting(reconstruction, "generation_model", "image_model")

    required_roles = [ocr_role, clean_role, asset_role, repair_role, generation_role]
    missing = sorted(
        {
            role
            for role in required_roles
            if not _is_complete_provider(_provider_source(role, models))
        }
    )
    if missing:
        raise GenerativeEditableConfigError(
            "Missing generative editable provider configuration for: " + ", ".join(missing)
        )

    quality = settings.get("quality", {})
    retries = settings.get("retries", {})
    timeouts = settings.get("timeouts", {})
    return GenerativeEditableConfig(
        ocr=_provider_config(ocr_role, _provider_source(ocr_role, models)),
        clean_base_model=_provider_config(clean_role, _provider_source(clean_role, models)),
        asset_sheet_model=_provider_config(asset_role, _provider_source(asset_role, models)),
        repair_model=_provider_config(repair_role, _provider_source(repair_role, models)),
        generation_model=_provider_config(
            generation_role, _provider_source(generation_role, models)
        ),
        use_aippt_metadata_first=_as_bool(ocr_settings.get("use_aippt_metadata_first", True)),
        ocr_min_confidence=float(ocr_settings.get("min_confidence", 0.75)),
        quality=QualityConfig(
            max_repair_attempts=int(quality.get("max_repair_attempts", 2)),
            preview_similarity_threshold=float(quality.get("preview_similarity_threshold", 0.92)),
            require_preview_validation=_as_bool(quality.get("require_preview_validation", True)),
        ),
        retries=RetryConfig(
            provider_max_attempts=int(retries.get("provider_max_attempts", 2)),
            repair_max_attempts=int(retries.get("repair_max_attempts", 2)),
            backoff_seconds=float(retries.get("backoff_seconds", 1.0)),
        ),
        timeouts=TimeoutConfig(
            provider_call=int(timeouts.get("provider_call", 180)),
            page=int(timeouts.get("page", 600)),
        ),
        reconstruction_mode=reconstruction_mode,
    )


def _role_setting(settings: dict[str, Any], key: str, default: str) -> str:
    value = settings.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise GenerativeEditableConfigError(
            f"generative editable provider role must be a non-empty string: {key}"
        )
    return value


def _provider_source(role: str, models: dict[str, Any]) -> Any:
    if role == "edit_model" and role not in models:
        return models.get("image_model")
    return models.get(role)


def _is_complete_provider(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return bool(value.get("api_key") and value.get("base_url") and value.get("model"))


def _provider_config(role: str, value: dict[str, Any]) -> ProviderConfig:
    adapter = "" if role == "ocr_model" else str(value.get("adapter", ""))
    provider = "" if role == "ocr_model" else str(value.get("provider", ""))
    return ProviderConfig(
        role=role,
        model=str(value.get("model", "")),
        base_url=str(value.get("base_url", "")),
        api_key=str(value.get("api_key", "")),
        adapter=adapter,
        provider=provider,
    )


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return bool(value)


def _fake_config() -> GenerativeEditableConfig:
    ocr = ProviderConfig(
        role="ocr_model", provider="fake_ocr", model="fake-ocr", base_url="", api_key=""
    )
    edit = ProviderConfig(
        role="edit_model",
        provider="fake_image_edit",
        model="fake-image-edit",
        base_url="",
        api_key="",
    )
    generation = ProviderConfig(
        role="image_model",
        provider="fake_image_generation",
        model="fake-image-generation",
        base_url="",
        api_key="",
    )
    return GenerativeEditableConfig(
        ocr=ocr,
        clean_base_model=edit,
        asset_sheet_model=edit,
        repair_model=edit,
        generation_model=generation,
        use_aippt_metadata_first=True,
        ocr_min_confidence=0.75,
        quality=QualityConfig(max_repair_attempts=0),
        retries=RetryConfig(provider_max_attempts=0, repair_max_attempts=0, backoff_seconds=0),
        timeouts=TimeoutConfig(provider_call=1, page=1),
    )

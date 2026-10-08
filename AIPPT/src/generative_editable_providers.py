"""Provider contracts for generative editable PPTX reconstruction."""

from __future__ import annotations

from dataclasses import dataclass, field
import base64
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
import time
from typing import Any, Literal
from urllib.parse import urlparse

from PIL import Image
import requests

from .generative_editable_config import ProviderConfig
from .image_result import ImageResultNormalizer

Point = tuple[int, int]
BBox = tuple[int, int, int, int]
Alignment = Literal["left", "center", "right", "justify"]
FAKE_OCR_PROVIDER = "fake_ocr"
FAKE_OCR_MODEL = "fake-ocr"
LOCAL_TESSERACT_PROVIDER = "local_tesseract"
FAKE_IMAGE_EDIT_PROVIDER = "fake_image_edit"
FAKE_IMAGE_EDIT_MODEL = "fake-image-edit"
FAKE_IMAGE_GENERATION_PROVIDER = "fake_image_generation"
FAKE_IMAGE_GENERATION_MODEL = "fake-image-generation"
TRUSTED_PROVENANCE_KEYS = {"provider_role", "provider", "model", "prompt_id"}
SENSITIVE_METADATA_PARTS = {
    "apikey",
    "xapikey",
    "key",
    "token",
    "accesstoken",
    "secret",
    "clientsecret",
    "baseurl",
    "authorization",
}


@dataclass(frozen=True)
class _DetectedTextLine:
    bbox: BBox
    color_hex: str
    font_size: float
    component_count: int


def safe_provider_error_message(message: str, secret_values: list[str] | None = None) -> str:
    safe = str(message)
    for secret in secret_values or []:
        if secret:
            safe = safe.replace(secret, "[REDACTED]")
            parsed = urlparse(secret)
            if parsed.hostname:
                safe = safe.replace(parsed.hostname, "[URL_REDACTED]")
    safe = re.sub(
        r"\b(bearer)\s+[A-Za-z0-9._~+/=-]+",
        lambda match: f"{match.group(1)} [REDACTED]",
        safe,
        flags=re.IGNORECASE,
    )
    safe = re.sub(
        (
            r"([\"']?(?:api[_-]?key|x-api-key|access_token|accessToken|token|"
            r"client_secret|clientSecret|refresh_token|id_token|session_id|session-id|"
            r"private_key|private-key|secret_key|secret-key|access_key|access-key|"
            r"apiToken)[\"']?\s*[:=]\s*[\"']?)[^\"'\s&,}]+"
        ),
        lambda match: f"{match.group(1)}[REDACTED]",
        safe,
        flags=re.IGNORECASE,
    )
    safe = re.sub(
        r"\b(authorization\s*[:=]\s*basic\s+)[^\s&,}]+",
        lambda match: f"{match.group(1)}[REDACTED]",
        safe,
        flags=re.IGNORECASE,
    )
    safe = re.sub(
        r"\b(authorization\s*[:=]\s*)(?!bearer\b|basic\b)[^\s&,}]+",
        lambda match: f"{match.group(1)}[REDACTED]",
        safe,
        flags=re.IGNORECASE,
    )
    safe = re.sub(
        (
            r"\b((?:api[_-]?key|x-api-key|access_token|accessToken|token|"
            r"client_secret|clientSecret|refresh_token|id_token|session_id|session-id|"
            r"private_key|private-key|secret_key|secret-key|access_key|access-key|"
            r"apiToken)\s+)[^\s&,}]+"
        ),
        lambda match: f"{match.group(1)}[REDACTED]",
        safe,
        flags=re.IGNORECASE,
    )
    safe = re.sub(r"https?://[^\s]+", "[URL_REDACTED]", safe)
    safe = re.sub(
        r"\b(url:\s*)/[^\s)]+",
        lambda match: f"{match.group(1)}[URL_REDACTED]",
        safe,
        flags=re.IGNORECASE,
    )
    return safe


def _safe_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    sanitized = _safe_metadata_value(metadata)
    if isinstance(sanitized, dict):
        return sanitized
    return {}


def _safe_metadata_value(value: Any) -> Any:
    if isinstance(value, dict):
        safe: dict[str, Any] = {}
        for key, nested_value in value.items():
            if _metadata_key_is_sensitive(str(key)):
                continue
            safe[key] = _safe_metadata_value(nested_value)
        return safe
    if isinstance(value, list):
        return [_safe_metadata_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_safe_metadata_value(item) for item in value)
    if isinstance(value, str):
        return safe_provider_error_message(value)
    return value


def _metadata_key_is_sensitive(key: str) -> bool:
    if key in TRUSTED_PROVENANCE_KEYS:
        return True
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    return any(part in normalized for part in SENSITIVE_METADATA_PARTS)


def _is_paddleocr_vl_model(model: str) -> bool:
    normalized = model.lower().replace("_", "-")
    return "paddleocr-vl" in normalized


def _resolve_output_path(output_asset_path: str, asset_root: str) -> Path:
    if not asset_root:
        raise ValueError("asset_root is required")
    root = Path(asset_root).resolve()
    output = Path(output_asset_path)
    if not output.is_absolute():
        output = root / output
    resolved = output.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("output_asset_path must be inside asset_root")
    return resolved


def _resolve_input_path(input_path: str, asset_root: str, field_name: str) -> Path:
    if not asset_root:
        raise ValueError("asset_root is required")
    root = Path(asset_root).resolve()
    value = Path(input_path)
    if not value.is_absolute():
        value = root / value
    resolved = value.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"{field_name} must be inside asset_root")
    return resolved


class ProviderError(RuntimeError):
    def __init__(
        self,
        *,
        provider_role: str,
        operation: str,
        message: str,
        retryable: bool,
        secret_values: list[str] | None = None,
        status_code: int | None = None,
        provider_error_code: str | None = None,
    ):
        self.provider_role = provider_role
        self.operation = operation
        self.retryable = retryable
        self.status_code = status_code
        self.provider_error_code = _safe_provider_error_code(provider_error_code)
        self.message = safe_provider_error_message(message, secret_values=secret_values)
        super().__init__(f"{provider_role}.{operation}: {self.message}")


class ProviderTimeoutError(ProviderError):
    def __init__(
        self,
        *,
        provider_role: str,
        operation: str,
        message: str,
        retryable: bool = True,
        timeout_seconds: int,
        secret_values: list[str] | None = None,
    ):
        self.timeout_seconds = timeout_seconds
        super().__init__(
            provider_role=provider_role,
            operation=operation,
            message=f"{message} (timeout_seconds={timeout_seconds})",
            retryable=retryable,
            secret_values=secret_values,
        )


class _ProviderDeadlineTimeout(TimeoutError):
    pass


@contextmanager
def _provider_hard_deadline(timeout_seconds: int):
    if (
        timeout_seconds <= 0
        or threading.current_thread() is not threading.main_thread()
        or not hasattr(signal, "SIGALRM")
    ):
        yield
        return

    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, 0)
    started = time.monotonic()

    def timeout_handler(signum, frame):
        raise _ProviderDeadlineTimeout(f"provider call exceeded {timeout_seconds}s")

    signal.signal(signal.SIGALRM, timeout_handler)
    effective_timeout = float(timeout_seconds)
    if previous_timer[0] > 0:
        effective_timeout = min(effective_timeout, previous_timer[0])
    signal.setitimer(signal.ITIMER_REAL, effective_timeout)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0:
            elapsed = time.monotonic() - started
            remaining = max(0.001, previous_timer[0] - elapsed)
            signal.setitimer(signal.ITIMER_REAL, remaining, previous_timer[1])


@dataclass(frozen=True)
class OCRTextItem:
    text: str
    bbox: BBox
    polygon: tuple[Point, ...]
    confidence: float
    font_family_hint: str = ""
    font_size_hint: float | None = None
    style_hints: dict[str, Any] = field(default_factory=dict)
    color_hex: str = "#000000"
    alignment: Alignment = "left"
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        x1, y1, x2, y2 = self.bbox
        if x2 <= x1 or y2 <= y1:
            raise ValueError("bbox must be ordered as (left, top, right, bottom)")
        if not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        if self.alignment not in {"left", "center", "right", "justify"}:
            raise ValueError("alignment must be left, center, right, or justify")
        if len(self.polygon) < 4:
            raise ValueError("polygon must contain at least four points")


@dataclass(frozen=True)
class OCRResult:
    source_image_path: str
    image_size: tuple[int, int]
    provider_role: str
    provider_name: str
    model: str
    items: list[OCRTextItem]


class OCRProvider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    def extract_text(self, image_path: str) -> OCRResult:
        raise NotImplementedError


def _call_with_provider_retries(
    operation,
    *,
    max_attempts: int,
    backoff_seconds: float,
    attempt_log: list[dict[str, Any]] | None = None,
):
    attempts = max(1, int(max_attempts))
    if attempt_log is not None:
        attempt_log.clear()
    for attempt in range(1, attempts + 1):
        started_at = time.monotonic()
        try:
            result = operation()
            if attempt_log is not None:
                attempt_log.append(
                    {
                        "attempt": attempt,
                        "status": "passed",
                        "elapsed_seconds": _elapsed_seconds_since(started_at),
                    }
                )
            return result
        except ProviderError as exc:
            retrying = bool(exc.retryable and attempt < attempts)
            if attempt_log is not None:
                attempt_log.append(
                    _provider_attempt_error_payload(
                        exc,
                        attempt=attempt,
                        retrying=retrying,
                        elapsed_seconds=_elapsed_seconds_since(started_at),
                    )
                )
                exc.attempts = list(attempt_log)
            if not retrying:
                raise
            if backoff_seconds > 0:
                time.sleep(backoff_seconds * attempt)
    raise AssertionError("retry loop exited unexpectedly")


def _elapsed_seconds_since(started_at: float) -> float:
    return round(max(0.0, time.monotonic() - started_at), 3)


def _provider_attempt_error_payload(
    error: ProviderError,
    *,
    attempt: int,
    retrying: bool,
    elapsed_seconds: float,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "attempt": attempt,
        "status": "failed",
        "error_type": type(error).__name__,
        "error": str(error),
        "retryable": bool(error.retryable),
        "retrying": retrying,
        "elapsed_seconds": elapsed_seconds,
    }
    if error.status_code is not None:
        payload["status_code"] = error.status_code
    if error.provider_error_code:
        payload["provider_error_code"] = error.provider_error_code
    return payload


def _safe_provider_error_code(value: str | None) -> str:
    if not value:
        return ""
    safe = safe_provider_error_message(str(value))
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", safe).strip("_.-")
    safe = re.sub(r"_+", "_", safe)
    return safe[:160]


class RetryingOCRProvider(OCRProvider):
    def __init__(self, provider: OCRProvider, *, max_attempts: int, backoff_seconds: float):
        super().__init__(provider.config)
        self.provider = provider
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.last_attempts: list[dict[str, Any]] = []

    def extract_text(self, image_path: str) -> OCRResult:
        attempts: list[dict[str, Any]] = []
        try:
            return _call_with_provider_retries(
                lambda: self.provider.extract_text(image_path),
                max_attempts=self.max_attempts,
                backoff_seconds=self.backoff_seconds,
                attempt_log=attempts,
            )
        finally:
            self.last_attempts = list(attempts)


class FakeOCRProvider(OCRProvider):
    def extract_text(self, image_path: str) -> OCRResult:
        path = Path(image_path)
        with Image.open(path) as image:
            width, height = image.size

        item = OCRTextItem(
            text="Quarterly Plan",
            bbox=(80, 54, 420, 102),
            polygon=((80, 54), (420, 54), (420, 102), (80, 102)),
            confidence=0.98,
            font_family_hint="Arial",
            font_size_hint=32,
            style_hints={"weight": "bold", "italic": False},
            color_hex="#1F2937",
            alignment="center",
            provenance={
                "provider_role": self.config.role,
                "provider": FAKE_OCR_PROVIDER,
                "model": FAKE_OCR_MODEL,
                "item_id": "fake-ocr-title-1",
            },
        )
        return OCRResult(
            source_image_path=str(path),
            image_size=(width, height),
            provider_role=self.config.role,
            provider_name=FAKE_OCR_PROVIDER,
            model=FAKE_OCR_MODEL,
            items=[item],
        )


class OpenAIChatOCRProvider(OCRProvider):
    def __init__(self, config: ProviderConfig, *, timeout_seconds: int = 180):
        super().__init__(config)
        self.timeout_seconds = timeout_seconds

    def extract_text(self, image_path: str) -> OCRResult:
        path = Path(image_path)
        with Image.open(path) as image:
            width, height = image.size
        image_base64 = base64.b64encode(path.read_bytes()).decode()
        prompt = (
            _focused_crop_ocr_prompt() if _is_focused_ocr_crop_path(path) else _ocr_json_prompt()
        )
        if _is_paddleocr_vl_model(self.config.model):
            payload = _openai_chat_payload(
                model=self.config.model,
                prompt=prompt,
                image_base64=image_base64,
                text_first=True,
                temperature=0,
                max_tokens=4096,
            )
        else:
            payload = _openai_chat_payload(
                model=self.config.model,
                prompt=prompt,
                image_base64=image_base64,
                text_first=True,
                response_format_json=True,
                temperature=0,
                max_tokens=4096,
            )
        response = _post_openai_chat(
            self.config,
            payload,
            operation="extract_text",
            timeout_seconds=self.timeout_seconds,
        )
        if _is_paddleocr_vl_model(self.config.model):
            items = _extract_paddleocr_vl_text_items(
                response,
                self.config,
                (width, height),
                image_path=path,
            )
        else:
            items = _extract_ocr_text_items(response, self.config, (width, height))
        return OCRResult(
            source_image_path=str(path),
            image_size=(width, height),
            provider_role=self.config.role,
            provider_name=self.config.provider or "openai_chat",
            model=self.config.model,
            items=items,
        )


class LocalTesseractOCRProvider(OCRProvider):
    def __init__(self, config: ProviderConfig, *, timeout_seconds: int = 60):
        super().__init__(config)
        self.timeout_seconds = timeout_seconds

    def extract_text(self, image_path: str) -> OCRResult:
        path = Path(image_path)
        with Image.open(path) as image:
            width, height = image.size
        command = (self.config.base_url or "").strip() or "tesseract"
        executable = shutil.which(command) if "/" not in command else command
        if not executable or ("/" in command and not os.access(executable, os.X_OK)):
            raise ProviderError(
                provider_role=self.config.role,
                operation="extract_text",
                message=f"tesseract executable was not found: {command}",
                retryable=False,
            )
        try:
            result = subprocess.run(
                [executable, str(path), "stdout", "tsv", "--psm", "6", "-l", self.config.model],
                check=True,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderTimeoutError(
                provider_role=self.config.role,
                operation="extract_text",
                message=str(exc),
                timeout_seconds=self.timeout_seconds,
            ) from exc
        except subprocess.CalledProcessError as exc:
            raise ProviderError(
                provider_role=self.config.role,
                operation="extract_text",
                message=exc.stderr or str(exc),
                retryable=False,
            ) from exc
        except OSError as exc:
            raise ProviderError(
                provider_role=self.config.role,
                operation="extract_text",
                message=str(exc),
                retryable=False,
            ) from exc
        return OCRResult(
            source_image_path=str(path),
            image_size=(width, height),
            provider_role=self.config.role,
            provider_name=LOCAL_TESSERACT_PROVIDER,
            model=self.config.model,
            items=_parse_tesseract_tsv(result.stdout, self.config, (width, height)),
        )


@dataclass(frozen=True)
class ImageEditRequest:
    source_image_path: str
    prompt_id: str
    prompt: str
    output_asset_path: str
    asset_root: str
    mask_path: str | None = None
    timeout_seconds: int = 180
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.source_image_path:
            raise ValueError("source_image_path is required")
        if not self.prompt_id:
            raise ValueError("prompt_id is required")
        if not self.prompt:
            raise ValueError("prompt is required")
        if not self.output_asset_path:
            raise ValueError("output_asset_path is required")
        _resolve_output_path(self.output_asset_path, self.asset_root)
        _resolve_input_path(self.source_image_path, self.asset_root, "source_image_path")
        if self.mask_path is not None:
            _resolve_input_path(self.mask_path, self.asset_root, "mask_path")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True)
class ImageEditResult:
    output_asset_path: str
    source_image_path: str
    prompt_id: str
    provider_role: str
    provider_name: str
    model: str
    timeout_seconds: int
    mask_path: str | None = None
    provenance: dict[str, Any] = field(default_factory=dict)


class ImageEditProvider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    def edit(self, request: ImageEditRequest) -> ImageEditResult:
        raise NotImplementedError


class RetryingImageEditProvider(ImageEditProvider):
    def __init__(self, provider: ImageEditProvider, *, max_attempts: int, backoff_seconds: float):
        super().__init__(provider.config)
        self.provider = provider
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.last_attempts: list[dict[str, Any]] = []

    def edit(self, request: ImageEditRequest) -> ImageEditResult:
        attempts: list[dict[str, Any]] = []
        try:
            return _call_with_provider_retries(
                lambda: self.provider.edit(request),
                max_attempts=self.max_attempts,
                backoff_seconds=self.backoff_seconds,
                attempt_log=attempts,
            )
        finally:
            self.last_attempts = list(attempts)


class FakeImageEditProvider(ImageEditProvider):
    def edit(self, request: ImageEditRequest) -> ImageEditResult:
        source_path = Path(request.source_image_path)
        output_path = _resolve_output_path(request.output_asset_path, request.asset_root)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source_path) as source:
            edited = _fake_image_edit_result(source, request.mask_path)
            edited.save(output_path)

        provenance = {
            "provider_role": self.config.role,
            "provider": FAKE_IMAGE_EDIT_PROVIDER,
            "model": FAKE_IMAGE_EDIT_MODEL,
            "prompt_id": request.prompt_id,
            "metadata": _safe_metadata(request.metadata),
        }
        return ImageEditResult(
            output_asset_path=str(output_path),
            source_image_path=str(source_path),
            prompt_id=request.prompt_id,
            provider_role=self.config.role,
            provider_name=FAKE_IMAGE_EDIT_PROVIDER,
            model=FAKE_IMAGE_EDIT_MODEL,
            timeout_seconds=request.timeout_seconds,
            mask_path=request.mask_path,
            provenance=provenance,
        )


def _fake_image_edit_result(source: Image.Image, mask_path: str | None) -> Image.Image:
    if not mask_path:
        return source.copy()
    base = source.convert("RGBA" if source.mode == "RGBA" else "RGB")
    with Image.open(mask_path) as mask_image:
        mask = mask_image.convert("L").resize(base.size)
    fill_color = _fake_background_fill_color(base, mask)
    fill = Image.new(base.mode, base.size, fill_color)
    return Image.composite(fill, base, mask)


def _fake_background_fill_color(image: Image.Image, mask: Image.Image) -> tuple[int, ...]:
    width, height = image.size
    candidates: list[tuple[int, ...]] = []
    pixels = image.load()
    mask_pixels = mask.load()
    sample_points = [
        (0, 0),
        (width - 1, 0),
        (0, height - 1),
        (width - 1, height - 1),
        (width // 2, 0),
        (width // 2, height - 1),
        (0, height // 2),
        (width - 1, height // 2),
    ]
    for x, y in sample_points:
        if mask_pixels[x, y] == 0:
            value = pixels[x, y]
            candidates.append(value if isinstance(value, tuple) else (value,))
    if candidates:
        channels = len(candidates[0])
        return tuple(
            round(sum(pixel[index] for pixel in candidates) / len(candidates))
            for index in range(channels)
        )
    value = image.resize((1, 1)).getpixel((0, 0))
    return value if isinstance(value, tuple) else (value,)


class OpenAIChatImageEditProvider(ImageEditProvider):
    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.normalizer = ImageResultNormalizer()

    def edit(self, request: ImageEditRequest) -> ImageEditResult:
        source_path = Path(request.source_image_path)
        output_path = _resolve_output_path(request.output_asset_path, request.asset_root)
        source_base64 = base64.b64encode(source_path.read_bytes()).decode()
        prompt = (
            f"{request.prompt}\n\n"
            "Return the edited image only, as a URL, data URL, or base64 image payload."
        )
        extra_images: list[str] = []
        if request.mask_path:
            prompt += "\nThe second image is the edit mask. Only modify masked regions."
            extra_images.append(base64.b64encode(Path(request.mask_path).read_bytes()).decode())
        payload = _openai_chat_payload(
            model=self.config.model,
            prompt=prompt,
            image_base64=source_base64,
            extra_images_base64=extra_images,
        )
        response = _post_openai_chat(
            self.config,
            payload,
            operation=request.prompt_id,
            timeout_seconds=request.timeout_seconds,
        )
        _write_normalized_provider_image(
            self.normalizer,
            response,
            output_path,
            config=self.config,
            operation=request.prompt_id,
            timeout_seconds=request.timeout_seconds,
        )
        return ImageEditResult(
            output_asset_path=str(output_path),
            source_image_path=str(source_path),
            prompt_id=request.prompt_id,
            provider_role=self.config.role,
            provider_name=self.config.provider or "openai_chat",
            model=self.config.model,
            timeout_seconds=request.timeout_seconds,
            mask_path=request.mask_path,
            provenance={
                "provider_role": self.config.role,
                "provider": self.config.provider or "openai_chat",
                "model": self.config.model,
                "prompt_id": request.prompt_id,
                "metadata": _safe_metadata(request.metadata),
            },
        )


@dataclass(frozen=True)
class ImageGenerationRequest:
    prompt_id: str
    prompt: str
    output_asset_path: str
    asset_root: str
    visual_reference: dict[str, Any] = field(default_factory=dict)
    timeout_seconds: int = 180
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.prompt_id:
            raise ValueError("prompt_id is required")
        if not self.prompt:
            raise ValueError("prompt is required")
        if not self.output_asset_path:
            raise ValueError("output_asset_path is required")
        _resolve_output_path(self.output_asset_path, self.asset_root)
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True)
class ImageGenerationResult:
    output_asset_path: str
    prompt_id: str
    provider_role: str
    provider_name: str
    model: str
    timeout_seconds: int
    visual_reference: dict[str, Any] = field(default_factory=dict)
    provenance: dict[str, Any] = field(default_factory=dict)


class ImageGenerationProvider:
    def __init__(self, config: ProviderConfig):
        self.config = config

    def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        raise NotImplementedError


class RetryingImageGenerationProvider(ImageGenerationProvider):
    def __init__(
        self, provider: ImageGenerationProvider, *, max_attempts: int, backoff_seconds: float
    ):
        super().__init__(provider.config)
        self.provider = provider
        self.max_attempts = max_attempts
        self.backoff_seconds = backoff_seconds
        self.last_attempts: list[dict[str, Any]] = []

    def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        attempts: list[dict[str, Any]] = []
        try:
            return _call_with_provider_retries(
                lambda: self.provider.generate(request),
                max_attempts=self.max_attempts,
                backoff_seconds=self.backoff_seconds,
                attempt_log=attempts,
            )
        finally:
            self.last_attempts = list(attempts)


class FakeImageGenerationProvider(ImageGenerationProvider):
    def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        output_path = _resolve_output_path(request.output_asset_path, request.asset_root)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (256, 256), (0, 0, 0, 0)).save(output_path)

        provenance = {
            "provider_role": self.config.role,
            "provider": FAKE_IMAGE_GENERATION_PROVIDER,
            "model": FAKE_IMAGE_GENERATION_MODEL,
            "prompt_id": request.prompt_id,
            "metadata": _safe_metadata(request.metadata),
        }
        return ImageGenerationResult(
            output_asset_path=str(output_path),
            prompt_id=request.prompt_id,
            provider_role=self.config.role,
            provider_name=FAKE_IMAGE_GENERATION_PROVIDER,
            model=FAKE_IMAGE_GENERATION_MODEL,
            timeout_seconds=request.timeout_seconds,
            visual_reference=dict(request.visual_reference),
            provenance=provenance,
        )


class OpenAIChatImageGenerationProvider(ImageGenerationProvider):
    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.normalizer = ImageResultNormalizer()

    def generate(self, request: ImageGenerationRequest) -> ImageGenerationResult:
        output_path = _resolve_output_path(request.output_asset_path, request.asset_root)
        prompt = (
            f"{request.prompt}\n\n"
            "Return the generated image only, as a URL, data URL, or base64 image payload."
        )
        source_image_path = request.visual_reference.get("source_image_path")
        source_base64 = None
        if isinstance(source_image_path, str) and source_image_path:
            source_base64 = base64.b64encode(Path(source_image_path).read_bytes()).decode()
            prompt += "\nUse the attached source slide image as the visual reference."
        payload = _openai_chat_payload(
            model=self.config.model,
            prompt=prompt,
            image_base64=source_base64,
        )
        response = _post_openai_chat(
            self.config,
            payload,
            operation=request.prompt_id,
            timeout_seconds=request.timeout_seconds,
        )
        _write_normalized_provider_image(
            self.normalizer,
            response,
            output_path,
            config=self.config,
            operation=request.prompt_id,
            timeout_seconds=request.timeout_seconds,
        )
        return ImageGenerationResult(
            output_asset_path=str(output_path),
            prompt_id=request.prompt_id,
            provider_role=self.config.role,
            provider_name=self.config.provider or "openai_chat",
            model=self.config.model,
            timeout_seconds=request.timeout_seconds,
            visual_reference=dict(request.visual_reference),
            provenance={
                "provider_role": self.config.role,
                "provider": self.config.provider or "openai_chat",
                "model": self.config.model,
                "prompt_id": request.prompt_id,
                "metadata": _safe_metadata(request.metadata),
            },
        )


def _openai_chat_payload(
    *,
    model: str,
    prompt: str,
    image_base64: str | None = None,
    extra_images_base64: list[str] | None = None,
    text_first: bool = False,
    response_format_json: bool = False,
    temperature: float | None = None,
    max_tokens: int = 2000,
) -> dict[str, Any]:
    if image_base64:
        image_parts: list[dict[str, Any]] = [
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image_base64}", "detail": "high"},
            },
        ]
        for extra_image_base64 in extra_images_base64 or []:
            image_parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/png;base64,{extra_image_base64}",
                        "detail": "high",
                    },
                }
            )
        text_part = {"type": "text", "text": prompt}
        content: Any = [text_part, *image_parts] if text_first else [*image_parts, text_part]
    else:
        content = prompt
    payload: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
    }
    if response_format_json:
        payload["response_format"] = {"type": "json_object"}
    if temperature is not None:
        payload["temperature"] = temperature
    return payload


def _post_openai_chat(
    config: ProviderConfig,
    payload: dict[str, Any],
    *,
    operation: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    try:
        with _provider_hard_deadline(timeout_seconds):
            response = requests.post(
                f"{config.base_url.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {config.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=timeout_seconds,
            )
        response.raise_for_status()
        return response.json()
    except _ProviderDeadlineTimeout as exc:
        raise ProviderTimeoutError(
            provider_role=config.role,
            operation=operation,
            message=str(exc),
            timeout_seconds=timeout_seconds,
            secret_values=[config.api_key, config.base_url],
        ) from exc
    except requests.Timeout as exc:
        raise ProviderTimeoutError(
            provider_role=config.role,
            operation=operation,
            message=str(exc),
            timeout_seconds=timeout_seconds,
            secret_values=[config.api_key, config.base_url],
        ) from exc
    except requests.HTTPError as exc:
        status_code = exc.response.status_code if exc.response is not None else 0
        response_text = ""
        if exc.response is not None:
            response_text = (exc.response.text or "").strip()
        message = str(exc)
        if response_text:
            message = f"{message}; response_body={response_text[:1000]}"
        provider_error_code = _provider_error_code_from_response_text(response_text)
        raise ProviderError(
            provider_role=config.role,
            operation=operation,
            message=message,
            retryable=status_code == 429 or status_code >= 500,
            secret_values=[config.api_key, config.base_url],
            status_code=status_code or None,
            provider_error_code=provider_error_code,
        ) from exc
    except requests.RequestException as exc:
        raise ProviderError(
            provider_role=config.role,
            operation=operation,
            message=str(exc),
            retryable=True,
            secret_values=[config.api_key, config.base_url],
        ) from exc
    except Exception as exc:
        raise ProviderError(
            provider_role=config.role,
            operation=operation,
            message=str(exc),
            retryable=_is_retryable_transport_exception(exc),
            secret_values=[config.api_key, config.base_url],
        ) from exc


def _is_retryable_transport_exception(exc: Exception) -> bool:
    if isinstance(exc, requests.HTTPError):
        status_code = exc.response.status_code if exc.response is not None else 0
        return status_code == 429 or status_code >= 500
    if isinstance(exc, requests.RequestException):
        return True
    if isinstance(exc, http.client.IncompleteRead):
        return True
    text = f"{type(exc).__name__}: {exc}".lower()
    return any(
        marker in text
        for marker in (
            "incompleteread",
            "incomplete read",
            "connection broken",
            "connection reset",
            "protocolerror",
            "remote end closed",
            "sslerror",
            "unexpected_eof",
            "eof occurred",
            "max retries exceeded",
        )
    )


def _provider_error_code_from_response_text(response_text: str) -> str:
    if not response_text:
        return ""
    try:
        payload = json.loads(response_text)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    if not isinstance(error, dict):
        return ""
    code = error.get("code")
    return str(code) if code else ""


def _extract_message_content(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    message = first.get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts)
    return ""


def _extract_ocr_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    text = _extract_message_content(payload)
    if not text:
        raise ProviderError(
            provider_role="ocr_model",
            operation="extract_text",
            message="OCR provider response did not include message content",
            retryable=False,
        )
    parsed = _parse_json_object(text)
    if isinstance(parsed, dict):
        items = parsed.get("items", [])
    elif isinstance(parsed, list):
        items = parsed
    else:
        raise ProviderError(
            provider_role="ocr_model",
            operation="extract_text",
            message="OCR provider response JSON must be an object or array",
            retryable=False,
        )
    if not isinstance(items, list):
        raise ProviderError(
            provider_role="ocr_model",
            operation="extract_text",
            message="OCR provider response JSON must include an items array",
            retryable=False,
        )
    return [item for item in items if isinstance(item, dict)]


def _extract_ocr_text_items(
    payload: dict[str, Any],
    config: ProviderConfig,
    image_size: tuple[int, int],
) -> list[OCRTextItem]:
    try:
        return [_ocr_text_item_from_payload(item, config) for item in _extract_ocr_items(payload)]
    except ProviderError:
        scalar_text = _extract_safe_json_scalar_ocr_text(payload)
        if scalar_text is None:
            raise
        return [_plain_text_ocr_item(scalar_text, config, image_size)]
    except (TypeError, ValueError) as exc:
        raise ProviderError(
            provider_role=config.role,
            operation="extract_text",
            message=f"OCR provider response item had invalid shape: {exc}",
            retryable=False,
            secret_values=[config.api_key],
        ) from exc


def _extract_paddleocr_vl_text_items(
    payload: dict[str, Any],
    config: ProviderConfig,
    image_size: tuple[int, int],
    *,
    image_path: str | Path | None = None,
) -> list[OCRTextItem]:
    try:
        return _extract_ocr_text_items(payload, config, image_size)
    except ProviderError:
        text = _extract_message_content(payload).strip()
        if not text or _looks_like_ocr_refusal(text):
            raise
        return _approximate_line_ocr_items(text, config, image_size, image_path=image_path)


def _ocr_json_prompt() -> str:
    return (
        "You are an OCR engine for presentation slides. Identify every visible text "
        "span in the attached image. Output JSON only, with no markdown and no prose. "
        'Schema: {"items":[{"text":"...","bbox":[left,top,right,bottom],'
        '"confidence":0.0,"font_size":32,"color":"#RRGGBB",'
        '"alignment":"left"}]}. Coordinates must be source-image pixels. '
        'If there is no visible text, output {"items":[]}.\n'
        "你是演示文稿 OCR 引擎。只输出 JSON，不要解释、不要 Markdown。"
    )


def _focused_crop_ocr_prompt() -> str:
    return (
        "You are an OCR engine for a cropped presentation-slide text region. "
        "Return only the literal visible text in the image, preserving Chinese, English, "
        "numbers, punctuation, and the original order. Do not infer, translate, summarize, "
        "number items, describe the slide, or generate unrelated content. If no text is "
        "legible, return an empty string. This cropped image usually contains one short "
        "line or a small group of adjacent lines.\n"
        "你是裁剪文字区域 OCR 引擎。只返回图片中实际可见的原文，不要解释、不要补全、不要生成。"
    )


def _is_focused_ocr_crop_path(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    return "focused-crops" in parts or path.name.lower().startswith("visual-text-candidate-")


def _approximate_line_ocr_items(
    text: str,
    config: ProviderConfig,
    image_size: tuple[int, int],
    *,
    image_path: str | Path | None = None,
) -> list[OCRTextItem]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    width, height = image_size
    fallback_x1 = max(0, int(width * 0.06))
    fallback_x2 = min(width, int(width * 0.94))
    top_margin = max(0, int(height * 0.08))
    line_height = max(18, int(height * 0.045))
    gap = max(6, int(line_height * 0.35))
    estimated_lines = _estimate_text_line_layouts(
        image_path,
        image_size,
        text_lines=lines,
        max_lines=len(lines),
    )
    items: list[OCRTextItem] = []
    for index, line in enumerate(lines, start=1):
        estimate = estimated_lines[index - 1] if index - 1 < len(estimated_lines) else None
        if estimate is not None:
            bbox, color_hex, font_size = estimate
            x1, y1, x2, y2 = bbox
        else:
            y1 = top_margin + (index - 1) * (line_height + gap)
            y2 = min(height, y1 + line_height)
            x1 = fallback_x1
            x2 = fallback_x2
            color_hex = "#FFFFFF"
            font_size = _font_size_points_from_pixel_height(y2 - y1, height)
        if y1 >= height or y2 <= y1:
            break
        items.append(
            OCRTextItem(
                text=line,
                bbox=(x1, y1, x2, y2),
                polygon=((x1, y1), (x2, y1), (x2, y2), (x1, y2)),
                confidence=0.78,
                font_size_hint=font_size,
                style_hints={
                    "source": "paddleocr_vl_plain_text",
                    "approximate_layout": True,
                    "layout_source": "image_projection"
                    if estimate is not None
                    else "uniform_fallback",
                },
                color_hex=color_hex,
                provenance={
                    "provider_role": config.role,
                    "provider": config.provider or "openai_chat",
                    "model": config.model,
                    "item_id": f"paddleocr-vl-line-{index}",
                    "approximate_layout": True,
                    "layout_source": "image_projection"
                    if estimate is not None
                    else "uniform_fallback",
                },
            )
        )
    return items


def _estimate_text_line_layouts(
    image_path: str | Path | None,
    image_size: tuple[int, int],
    *,
    text_lines: list[str] | None = None,
    max_lines: int,
) -> list[tuple[BBox, str, float] | None]:
    if image_path is None or max_lines <= 0:
        return []
    path = Path(image_path)
    if not path.is_file():
        return []
    try:
        with Image.open(path) as source:
            image = source.convert("RGB")
    except OSError:
        return []
    width, height = image_size
    if image.size != image_size:
        image = image.resize(image_size)
    component_estimates = _estimate_text_line_layouts_from_components(
        image,
        image_size,
        text_lines=text_lines or [],
        max_lines=max_lines,
    )
    if component_estimates:
        return component_estimates
    return _estimate_text_line_layouts_from_projection(image, image_size, max_lines=max_lines)


def _estimate_text_line_layouts_from_projection(
    image: Image.Image,
    image_size: tuple[int, int],
    *,
    max_lines: int,
) -> list[tuple[BBox, str, float] | None]:
    width, height = image_size
    row_counts = [0] * height
    candidate_rows: list[list[int]] = [[] for _ in range(height)]
    pixels = image.load()
    for y in range(height):
        xs = candidate_rows[y]
        for x in range(width):
            if _is_text_like_pixel(pixels[x, y]):
                xs.append(x)
        row_counts[y] = len(xs)
    row_threshold = max(6, int(width * 0.004))
    candidate_row_indexes = [y for y, count in enumerate(row_counts) if count >= row_threshold]
    bands = _group_contiguous_indexes(candidate_row_indexes, max_gap=4)
    estimates: list[tuple[BBox, str, float]] = []
    for y1, y2_inclusive in bands:
        y2 = min(height, y2_inclusive + 1)
        band_height = y2 - y1
        if band_height < 4 or band_height > max(120, int(height * 0.2)):
            continue
        xs: list[int] = []
        for y in range(y1, y2):
            xs.extend(candidate_rows[y])
        if len(xs) < row_threshold * 2:
            continue
        x1 = max(0, _percentile_int(xs, 0.01) - 1)
        x2 = min(width, _percentile_int(xs, 0.99) + 2)
        if x2 - x1 < max(8, int(width * 0.02)):
            continue
        bbox = (x1, max(0, y1 - 1), x2, min(height, y2 + 1))
        estimates.append(
            (
                bbox,
                _dominant_text_color(image, bbox),
                _font_size_points_from_pixel_height(bbox[3] - bbox[1], height),
            )
        )
        if len(estimates) >= max_lines:
            break
    return estimates


def _estimate_text_line_layouts_from_components(
    image: Image.Image,
    image_size: tuple[int, int],
    *,
    text_lines: list[str],
    max_lines: int,
) -> list[tuple[BBox, str, float] | None]:
    try:
        import cv2  # type: ignore[import-not-found]
        import numpy as np  # type: ignore[import-not-found]
    except Exception:
        return []
    width, height = image_size
    array = np.array(image.convert("RGB"))
    red = array[:, :, 0].astype("int16")
    green = array[:, :, 1].astype("int16")
    blue = array[:, :, 2].astype("int16")
    luma = 0.299 * red + 0.587 * green + 0.114 * blue
    saturation = np.maximum.reduce([red, green, blue]) - np.minimum.reduce([red, green, blue])
    masks = [
        (((luma >= 145) & (saturation <= 80)) | (luma >= 215)).astype("uint8"),
        (
            ((blue >= 130) & (green >= 90) & ((blue - red) >= 25))
            | ((green >= 130) & (blue >= 130) & (red <= 140))
        ).astype("uint8"),
    ]
    components: list[dict[str, Any]] = []
    image_area = width * height
    for mask in masks:
        component_count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, 8)
        for component_index in range(1, component_count):
            x, y, box_width, box_height, area = [int(value) for value in stats[component_index]]
            if area < 4 or box_width <= 0 or box_height <= 0:
                continue
            if box_height < 4 or box_height > max(90, int(height * 0.13)):
                continue
            if box_width > max(480, int(width * 0.35)):
                continue
            if area > max(12000, int(image_area * 0.02)):
                continue
            if box_height <= 4 and box_width > 40:
                continue
            components.append(
                {
                    "bbox": (x, y, x + box_width, y + box_height),
                    "area": area,
                    "cx": x + box_width / 2.0,
                    "cy": y + box_height / 2.0,
                    "height": box_height,
                }
            )
    detected = _build_detected_text_lines(image, components, image_size)
    if not detected:
        return []
    if text_lines:
        return _match_detected_lines_to_text(text_lines[:max_lines], detected, image_size)
    return [
        (line.bbox, line.color_hex, line.font_size)
        for line in sorted(detected, key=lambda item: (item.bbox[1], item.bbox[0]))[:max_lines]
    ]


def _build_detected_text_lines(
    image: Image.Image,
    components: list[dict[str, Any]],
    image_size: tuple[int, int],
) -> list[_DetectedTextLine]:
    if not components:
        return []
    width, height = image_size
    vertical_groups: list[list[dict[str, Any]]] = []
    for component in sorted(components, key=lambda item: (item["cy"], item["bbox"][0])):
        best_group: list[dict[str, Any]] | None = None
        best_distance = float("inf")
        for group in vertical_groups:
            group_cy = _median_float([component["cy"] for component in group])
            distance = abs(component["cy"] - group_cy)
            median_height = _median_float([component["height"] for component in group])
            tolerance = max(6.0, min(component["height"], median_height) * 0.85)
            if distance > tolerance:
                continue
            if distance < best_distance:
                best_distance = distance
                best_group = group
        if best_group is None:
            vertical_groups.append([component])
        else:
            best_group.append(component)

    detected: list[_DetectedTextLine] = []
    for group in vertical_groups:
        for line_components in _split_line_components_by_horizontal_gap(group):
            bbox = _components_bbox(line_components)
            box_width = bbox[2] - bbox[0]
            box_height = bbox[3] - bbox[1]
            if box_width < max(8, int(width * 0.008)) or box_height < 4:
                continue
            if box_height > max(80, int(height * 0.09)):
                continue
            if len(line_components) == 1 and box_width > max(320, int(width * 0.35)):
                continue
            if box_width > int(width * 0.82):
                continue
            component_area = sum(int(component.get("area", 0)) for component in line_components)
            if component_area / float(max(1, box_width * box_height)) > 0.65:
                continue
            expanded = (
                max(0, bbox[0] - 1),
                max(0, bbox[1] - 1),
                min(width, bbox[2] + 2),
                min(height, bbox[3] + 2),
            )
            detected.append(
                _DetectedTextLine(
                    bbox=expanded,
                    color_hex=_dominant_text_color(image, expanded),
                    font_size=_font_size_points_from_pixel_height(
                        expanded[3] - expanded[1], height
                    ),
                    component_count=len(line_components),
                )
            )
    return sorted(detected, key=lambda item: (item.bbox[1], item.bbox[0]))


def _components_bbox(components: list[dict[str, Any]]) -> BBox:
    return (
        min(component["bbox"][0] for component in components),
        min(component["bbox"][1] for component in components),
        max(component["bbox"][2] for component in components),
        max(component["bbox"][3] for component in components),
    )


def _median_float(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return float((ordered[middle - 1] + ordered[middle]) / 2.0)


def _split_line_components_by_horizontal_gap(
    components: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    ordered = sorted(components, key=lambda item: item["bbox"][0])
    if not ordered:
        return []
    heights = sorted(component["bbox"][3] - component["bbox"][1] for component in ordered)
    median_height = heights[len(heights) // 2]
    max_gap = max(24, int(median_height * 2.8))
    groups: list[list[dict[str, Any]]] = [[ordered[0]]]
    previous_right = ordered[0]["bbox"][2]
    for component in ordered[1:]:
        gap = component["bbox"][0] - previous_right
        if gap > max_gap:
            groups.append([component])
        else:
            groups[-1].append(component)
        previous_right = max(previous_right, component["bbox"][2])
    return groups


def _match_detected_lines_to_text(
    text_lines: list[str],
    detected: list[_DetectedTextLine],
    image_size: tuple[int, int],
) -> list[tuple[BBox, str, float] | None]:
    width, height = image_size
    remaining = list(sorted(detected, key=lambda item: (item.bbox[1], item.bbox[0])))
    matched: list[tuple[BBox, str, float] | None] = []
    for text in text_lines:
        viable = list(remaining)
        if not viable:
            matched.append(None)
            continue
        viable = _preferred_detected_lines_for_text(text, viable, width)
        scored = [
            (_text_line_match_score(text, line, index, width), line)
            for index, line in enumerate(viable)
        ]
        score, best = min(scored, key=lambda item: item[0])
        if score > 4.0:
            matched.append(None)
            continue
        remaining.remove(best)
        remaining = [line for line in remaining if not _detected_line_is_fragment_of(line, best)]
        matched.append((best.bbox, best.color_hex, best.font_size))
    return matched


def _preferred_detected_lines_for_text(
    text: str,
    viable: list[_DetectedTextLine],
    image_width: int,
) -> list[_DetectedTextLine]:
    stripped = text.strip()
    if _looks_like_domain_label(stripped):
        domain_labels = [
            line for line in viable if _is_left_domain_label_candidate(line, image_width)
        ]
        return domain_labels or viable
    if not _looks_like_parameter_line(stripped):
        return viable
    right_column = [line for line in viable if _is_right_column_text_candidate(line, image_width)]
    return right_column or viable


def _is_left_domain_label_candidate(line: _DetectedTextLine, image_width: int) -> bool:
    x1, y1, x2, y2 = line.bbox
    width = x2 - x1
    height = y2 - y1
    center_x = (x1 + x2) / 2.0
    return (
        image_width * 0.12 <= center_x <= image_width * 0.30
        and 70 <= width <= image_width * 0.16
        and 22 <= height <= 56
        and width >= height * 1.8
    )


def _is_right_column_text_candidate(line: _DetectedTextLine, image_width: int) -> bool:
    x1, y1, x2, y2 = line.bbox
    width = x2 - x1
    height = y2 - y1
    return (
        x1 >= image_width * 0.70
        and width <= image_width * 0.22
        and height <= 48
        and width >= height * 1.2
    )


def _detected_line_is_fragment_of(
    candidate: _DetectedTextLine,
    matched: _DetectedTextLine,
) -> bool:
    if candidate is matched:
        return False
    candidate_area = _bbox_area(candidate.bbox)
    if candidate_area <= 0:
        return False
    intersection = _bbox_intersection_area(candidate.bbox, matched.bbox)
    if intersection / float(candidate_area) < 0.88:
        return False
    matched_width = matched.bbox[2] - matched.bbox[0]
    candidate_width = candidate.bbox[2] - candidate.bbox[0]
    return candidate_width < matched_width * 0.86


def _bbox_intersection_area(left: BBox, right: BBox) -> int:
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[2], right[2])
    y2 = min(left[3], right[3])
    if x2 <= x1 or y2 <= y1:
        return 0
    return (x2 - x1) * (y2 - y1)


def _bbox_area(bbox: BBox) -> int:
    return max(0, bbox[2] - bbox[0]) * max(0, bbox[3] - bbox[1])


def _text_line_match_score(
    text: str,
    line: _DetectedTextLine,
    reading_order_index: int,
    image_width: int,
) -> float:
    x1, y1, x2, y2 = line.bbox
    box_width = max(1, x2 - x1)
    box_height = max(1, y2 - y1)
    units = _text_visual_units(text)
    expected_width = max(10.0, units * box_height * 0.9)
    ratio = box_width / expected_width
    width_score = abs(ratio - 1.0) if ratio < 2 else min(3.0, ratio / 2.0)
    single_component_penalty = (
        0.15 if line.component_count == 1 and box_width > image_width * 0.2 else 0.0
    )
    if _looks_like_domain_label(text.strip()):
        order_penalty = 0.0
    elif _looks_like_parameter_line(text.strip()):
        order_penalty = min(2.0, reading_order_index * 0.45)
    else:
        order_penalty = min(1.5, reading_order_index * 0.18)
    return (
        width_score
        + single_component_penalty
        + order_penalty
        + _text_line_spatial_prior_score(text, line, image_width)
    )


def _text_line_spatial_prior_score(
    text: str,
    line: _DetectedTextLine,
    image_width: int,
) -> float:
    stripped = text.strip()
    x1, _y1, x2, _y2 = line.bbox
    center_x = (x1 + x2) / 2.0
    if _looks_like_domain_label(stripped):
        score = 0.0
        if center_x > image_width * 0.35:
            score += 2.4
        if x1 > image_width * 0.30:
            score += 1.2
        if x2 - x1 > image_width * 0.18:
            score += 1.0
        return score
    if _looks_like_parameter_line(stripped):
        if x1 >= image_width * 0.65:
            return -0.35
        if stripped.isascii() and len(stripped) <= 4:
            return 4.0
        if x1 < image_width * 0.55:
            return 1.8
        if x2 <= image_width * 0.55:
            return 1.2
    return 0.0


def _looks_like_domain_label(text: str) -> bool:
    return text.endswith("域") and 2 <= len(text) <= 4 and _contains_cjk_text(text)


def _looks_like_parameter_line(text: str) -> bool:
    if not text or _looks_like_domain_label(text):
        return False
    if "：" in text or ":" in text:
        return False
    if _text_visual_units(text) > 12:
        return False
    return any(char.isalnum() for char in text) or _contains_cjk_text(text)


def _contains_cjk_text(text: str) -> bool:
    return any("\u3400" <= char <= "\u9fff" for char in text)


def _text_visual_units(text: str) -> float:
    units = 0.0
    for char in text.strip():
        if char.isspace():
            continue
        if "\u4e00" <= char <= "\u9fff":
            units += 1.0
        elif char.isascii():
            units += 0.58
        else:
            units += 0.8
    return max(1.0, units)


def _is_text_like_pixel(rgb: tuple[int, int, int]) -> bool:
    red, green, blue = rgb
    luma = 0.299 * red + 0.587 * green + 0.114 * blue
    if luma >= 150:
        return True
    if blue >= 130 and green >= 90 and blue - red >= 25:
        return True
    return green >= 130 and blue >= 130 and red <= 140


def _group_contiguous_indexes(indexes: list[int], *, max_gap: int) -> list[tuple[int, int]]:
    if not indexes:
        return []
    groups: list[tuple[int, int]] = []
    start = indexes[0]
    previous = indexes[0]
    for value in indexes[1:]:
        if value - previous <= max_gap:
            previous = value
            continue
        groups.append((start, previous))
        start = value
        previous = value
    groups.append((start, previous))
    return groups


def _percentile_int(values: list[int], percentile: float) -> int:
    ordered = sorted(values)
    if not ordered:
        return 0
    index = int(round((len(ordered) - 1) * percentile))
    return ordered[max(0, min(len(ordered) - 1, index))]


def _dominant_text_color(image: Image.Image, bbox: BBox) -> str:
    x1, y1, x2, y2 = bbox
    pixels = image.load()
    red_values: list[int] = []
    green_values: list[int] = []
    blue_values: list[int] = []
    for y in range(y1, y2):
        for x in range(x1, x2):
            rgb = pixels[x, y]
            if not _is_text_like_pixel(rgb):
                continue
            red_values.append(rgb[0])
            green_values.append(rgb[1])
            blue_values.append(rgb[2])
    if not red_values:
        return "#FFFFFF"
    return "#{:02X}{:02X}{:02X}".format(
        _percentile_int(red_values, 0.5),
        _percentile_int(green_values, 0.5),
        _percentile_int(blue_values, 0.5),
    )


def _font_size_points_from_pixel_height(pixel_height: int, image_height: int) -> float:
    if image_height <= 0:
        return 18.0
    points = pixel_height * 72.0 * 5.625 / image_height * 0.8
    return round(max(8.0, min(44.0, points)), 2)


def _parse_tesseract_tsv(
    text: str, config: ProviderConfig, image_size: tuple[int, int]
) -> list[OCRTextItem]:
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return []
    header = lines[0].split("\t")
    index = {name: position for position, name in enumerate(header)}
    required = {
        "block_num",
        "par_num",
        "line_num",
        "left",
        "top",
        "width",
        "height",
        "conf",
        "text",
    }
    if not required.issubset(index):
        raise ProviderError(
            provider_role=config.role,
            operation="extract_text",
            message="tesseract TSV output is missing required columns",
            retryable=False,
        )

    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for row in lines[1:]:
        parts = row.split("\t")
        if len(parts) < len(header):
            continue
        word = parts[index["text"]].strip()
        if not word:
            continue
        try:
            confidence = float(parts[index["conf"]])
            left = int(float(parts[index["left"]]))
            top = int(float(parts[index["top"]]))
            width = int(float(parts[index["width"]]))
            height = int(float(parts[index["height"]]))
        except ValueError:
            continue
        if confidence < 0 or width <= 0 or height <= 0:
            continue
        key = (parts[index["block_num"]], parts[index["par_num"]], parts[index["line_num"]])
        grouped.setdefault(key, []).append(
            {
                "text": word,
                "confidence": confidence,
                "bbox": (left, top, left + width, top + height),
            }
        )

    max_width, max_height = image_size
    items = []
    for line_index, words in enumerate(grouped.values(), start=1):
        x1 = max(0, min(word["bbox"][0] for word in words))
        y1 = max(0, min(word["bbox"][1] for word in words))
        x2 = min(max_width, max(word["bbox"][2] for word in words))
        y2 = min(max_height, max(word["bbox"][3] for word in words))
        if x2 <= x1 or y2 <= y1:
            continue
        confidence = max(
            0.0, min(1.0, sum(word["confidence"] for word in words) / len(words) / 100)
        )
        items.append(
            OCRTextItem(
                text=" ".join(word["text"] for word in words),
                bbox=(x1, y1, x2, y2),
                polygon=((x1, y1), (x2, y1), (x2, y2), (x1, y2)),
                confidence=confidence,
                font_size_hint=float(y2 - y1),
                provenance={
                    "provider_role": config.role,
                    "provider": LOCAL_TESSERACT_PROVIDER,
                    "model": config.model,
                    "item_id": f"tesseract-line-{line_index}",
                },
            )
        )
    return items


def _extract_safe_json_scalar_ocr_text(payload: dict[str, Any]) -> str | None:
    text = _extract_message_content(payload)
    if not text:
        return None
    try:
        parsed = _parse_json_object(text)
    except ProviderError:
        return None
    if not isinstance(parsed, str | int | float):
        return None
    scalar = str(parsed).strip()
    if not scalar or _looks_like_ocr_refusal(scalar):
        return None
    return scalar


def _looks_like_ocr_refusal(value: str) -> bool:
    normalized = value.lower()
    return any(
        marker in normalized
        for marker in (
            "cannot extract",
            "can't extract",
            "unable to extract",
            "sorry",
            "error",
            "failed",
            "invalid",
        )
    )


def _parse_json_object(text: str) -> Any:
    cleaned = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", cleaned, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        cleaned = fence.group(1).strip()
    candidate = _first_balanced_json_candidate(cleaned) or cleaned
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise ProviderError(
            provider_role="ocr_model",
            operation="extract_text",
            message=(
                f"OCR provider response was not valid JSON: {exc}; "
                f"response_excerpt={_safe_response_excerpt(cleaned)}"
            ),
            retryable=False,
        ) from exc


def _safe_response_excerpt(text: str, *, limit: int = 300) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    excerpt = compact[:limit]
    return safe_provider_error_message(excerpt)


def _first_balanced_json_candidate(text: str) -> str:
    for start, char in enumerate(text):
        if char not in "{[":
            continue
        close_for = {"{": "}", "[": "]"}
        stack = [close_for[char]]
        in_string = False
        escape = False
        for index in range(start + 1, len(text)):
            current = text[index]
            if escape:
                escape = False
                continue
            if current == "\\":
                escape = True
                continue
            if current == '"':
                in_string = not in_string
                continue
            if in_string:
                continue
            if current in close_for:
                stack.append(close_for[current])
            elif stack and current == stack[-1]:
                stack.pop()
                if not stack:
                    return text[start : index + 1]
        break
    return ""


def _ocr_text_item_from_payload(item: dict[str, Any], config: ProviderConfig) -> OCRTextItem:
    bbox = _ocr_bbox(item)
    alignment = str(item.get("alignment", "left")).lower()
    if alignment not in {"left", "center", "right", "justify"}:
        alignment = "left"
    x1, y1, x2, y2 = bbox
    return OCRTextItem(
        text=str(item.get("text", "")),
        bbox=bbox,
        polygon=tuple(item.get("polygon") or ((x1, y1), (x2, y1), (x2, y2), (x1, y2))),
        confidence=float(item.get("confidence", 1.0)),
        font_family_hint=str(item.get("font_family", "")),
        font_size_hint=_optional_float(item.get("font_size", item.get("font_size_hint"))),
        style_hints=dict(item.get("style_hints", {}))
        if isinstance(item.get("style_hints"), dict)
        else {},
        color_hex=str(item.get("color", item.get("color_hex", "#000000"))),
        alignment=alignment,  # type: ignore[arg-type]
        provenance={
            "provider_role": config.role,
            "provider": config.provider or "openai_chat",
            "model": config.model,
        },
    )


def _plain_text_ocr_item(
    text: str,
    config: ProviderConfig,
    image_size: tuple[int, int],
) -> OCRTextItem:
    width, height = image_size
    x1 = max(0, int(width * 0.10))
    y1 = max(0, int(height * 0.12))
    x2 = min(width, int(width * 0.90))
    y2 = min(height, int(height * 0.24))
    return OCRTextItem(
        text=text,
        bbox=(x1, y1, x2, y2),
        polygon=((x1, y1), (x2, y1), (x2, y2), (x1, y2)),
        confidence=0.76,
        font_family_hint="",
        font_size_hint=None,
        style_hints={"source": "plain_text_ocr_fallback"},
        color_hex="#000000",
        alignment="left",
        provenance={
            "provider_role": config.role,
            "provider": config.provider or "openai_chat",
            "model": config.model,
            "fallback": "plain_text_ocr",
        },
    )


def _ocr_bbox(item: dict[str, Any]) -> BBox:
    raw = item.get("bbox")
    if isinstance(raw, list | tuple) and len(raw) == 4:
        values = tuple(int(float(value)) for value in raw)
        return values  # type: ignore[return-value]
    if all(key in item for key in ("x", "y", "width", "height")):
        x = int(float(item["x"]))
        y = int(float(item["y"]))
        return (x, y, x + int(float(item["width"])), y + int(float(item["height"])))
    raise ValueError("OCR item must include bbox or x/y/width/height")


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _write_normalized_provider_image(
    normalizer: ImageResultNormalizer,
    response: dict[str, Any],
    output_path: Path,
    *,
    config: ProviderConfig,
    operation: str,
    timeout_seconds: int,
) -> None:
    try:
        with _provider_hard_deadline(timeout_seconds):
            normalized = normalizer.normalize(response)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(base64.b64decode(normalized.base64_data))
        with Image.open(output_path) as image:
            image.verify()
    except _ProviderDeadlineTimeout as exc:
        raise ProviderTimeoutError(
            provider_role=config.role,
            operation=operation,
            message=str(exc),
            timeout_seconds=timeout_seconds,
            secret_values=[config.api_key, config.base_url],
        ) from exc
    except Exception as exc:
        status_code = (
            exc.response.status_code
            if isinstance(exc, requests.HTTPError) and exc.response is not None
            else None
        )
        raise ProviderError(
            provider_role=config.role,
            operation=operation,
            message=str(exc),
            retryable=_is_retryable_transport_exception(exc),
            secret_values=[config.api_key, config.base_url],
            status_code=status_code,
        ) from exc

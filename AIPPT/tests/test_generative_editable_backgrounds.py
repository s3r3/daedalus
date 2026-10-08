import tempfile
import unittest
import hashlib
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageChops, ImageDraw

from src.generative_editable_config import ProviderConfig
from src.generative_editable_manifest import PageManifest
from src.generative_editable_providers import FakeImageEditProvider, ImageEditProvider


class RecordingImageEditProvider(ImageEditProvider):
    def __init__(self):
        super().__init__(
            ProviderConfig(
                role="edit_model",
                provider="fake-image-edit",
                model="fake-image-edit-model",
                base_url="https://fake.local",
                api_key="fake-key",
            )
        )
        self.calls = []
        self.fake = FakeImageEditProvider(self.config)

    def edit(self, request):
        self.calls.append(request)
        return self.fake.edit(request)


class GenerativeEditableBackgroundsTest(unittest.TestCase):
    def test_normalize_background_closes_output_before_overwriting_same_path(self):
        from src.generative_editable_backgrounds import _normalize_background_to_source_size

        class FakeImage:
            def __init__(self, size):
                self.size = size
                self.closed = False
                self.saved = False

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                self.closed = True

            def convert(self, mode):
                return self

            def resize(self, size):
                self.size = size
                return self

            def save(self, path):
                if not output_image.closed:
                    raise PermissionError("output image handle is still open")
                self.saved = True

        source_image = FakeImage((120, 80))
        output_image = FakeImage((240, 120))

        with patch(
            "src.generative_editable_backgrounds.Image.open",
            side_effect=[source_image, output_image],
        ):
            provenance = _normalize_background_to_source_size("output.png", "source.png")

        self.assertEqual(provenance["normalized_to_source_size"], [120, 80])
        self.assertTrue(output_image.saved)

    def test_image_edit_background_outputs_are_normalized_to_source_size(self):
        from src.generative_editable_backgrounds import create_base_clean_background

        class ResizingImageEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="resizing-edit",
                        model="resizing-edit-model",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                output = Path(request.output_asset_path)
                output.parent.mkdir(parents=True, exist_ok=True)
                Image.new("RGB", (240, 120), "#F8FAFC").save(output)
                return type(
                    "Result",
                    (),
                    {
                        "output_asset_path": str(output),
                        "provider_role": self.config.role,
                        "provider_name": self.config.provider,
                        "model": self.config.model,
                        "prompt_id": request.prompt_id,
                    },
                )()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output = root / "backgrounds" / "0000-slide-a" / "base-clean.png"
            source.parent.mkdir(parents=True)
            Image.new("RGB", (120, 80), "#FFFFFF").save(source)

            result = create_base_clean_background(
                source_image_path=source,
                output_asset_path=output,
                asset_root=root,
                edit_provider=ResizingImageEditProvider(),
            )

            with Image.open(result.output_asset_path) as normalized:
                normalized_size = normalized.size

        self.assertEqual(normalized_size, (120, 80))
        self.assertEqual(result.provenance["normalized_to_source_size"], [120, 80])

    def test_base_clean_background_provider_failure_is_not_silently_downgraded(self):
        from src.generative_editable_backgrounds import create_base_clean_background
        from src.generative_editable_providers import ProviderError

        class FailingImageEditProvider(ImageEditProvider):
            def __init__(self):
                super().__init__(
                    ProviderConfig(
                        role="edit_model",
                        provider="failing-edit",
                        model="failing-edit",
                        base_url="",
                        api_key="",
                    )
                )

            def edit(self, request):
                raise ProviderError(
                    provider_role=self.config.role,
                    operation=request.prompt_id,
                    message="background edit failed",
                    retryable=False,
                )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "assets" / "text-mask.png"
            output = root / "backgrounds" / "0000-slide-a" / "base-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            image = Image.new("RGB", (120, 80), "#F8FAFC")
            ImageDraw.Draw(image).rectangle((30, 20, 80, 42), fill="#0F172A")
            image.save(source)
            mask_image = Image.new("L", (120, 80), 0)
            ImageDraw.Draw(mask_image).rectangle((30, 20, 80, 42), fill=255)
            mask_image.save(mask)

            with self.assertRaises(ProviderError):
                create_base_clean_background(
                    source_image_path=source,
                    output_asset_path=output,
                    asset_root=root,
                    edit_provider=FailingImageEditProvider(),
                    text_mask_path=mask,
                )

            self.assertFalse(output.exists())

    def test_local_fill_is_selected_for_flat_text_mask_regions(self):
        from src.generative_editable_backgrounds import local_cleanup_text_mask

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            output = root / "backgrounds" / "text-clean.png"
            Image.new("RGB", (120, 80), "#EEEEEE").save(source)
            mask_image = Image.new("L", (120, 80), 0)
            ImageDraw.Draw(mask_image).rectangle((30, 20, 70, 42), fill=255)
            mask_image.save(mask)

            result = local_cleanup_text_mask(source, mask, output)

            self.assertEqual(result.strategy, "local_fill")
            self.assertEqual(result.provider_role, "local")
            self.assertEqual(result.validation_status, "passed")
            self.assertEqual(result.output_asset_path, str(output))
            self.assertEqual(result.artifact_path, "backgrounds/text-clean.png")
            with Image.open(output) as cleaned:
                self.assertEqual(cleaned.getpixel((45, 30)), (238, 238, 238))

    def test_local_fill_removes_dark_text_on_flat_background(self):
        from src.generative_editable_backgrounds import local_cleanup_text_mask

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            output = root / "backgrounds" / "text-clean.png"
            image = Image.new("RGB", (140, 80), "#DDEEFF")
            ImageDraw.Draw(image).rectangle((34, 26, 78, 36), fill="#111827")
            image.save(source)
            mask_image = Image.new("L", (140, 80), 0)
            ImageDraw.Draw(mask_image).rectangle((32, 24, 82, 38), fill=255)
            mask_image.save(mask)

            result = local_cleanup_text_mask(source, mask, output)

            self.assertEqual(result.strategy, "local_fill")
            with Image.open(output) as cleaned:
                self.assertEqual(cleaned.getpixel((44, 30)), (221, 238, 255))

    def test_source_preserving_text_background_cleans_text_without_changing_complex_visuals(self):
        from src.generative_editable_backgrounds import create_source_preserving_text_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output = root / "backgrounds" / "0000-slide-a" / "source-preserving.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (220, 120), "#041225")
            draw = ImageDraw.Draw(image)
            draw.rectangle((96, 32, 166, 86), fill="#7D8796")
            draw.rectangle((22, 20, 70, 38), fill="#FFFFFF")
            image.save(source)

            result = create_source_preserving_text_background(
                source_image_path=source,
                text_bboxes=[(20, 18, 76, 42)],
                output_asset_path=output,
                asset_root=root,
            )

            with Image.open(output) as cleaned:
                visual_pixel = cleaned.getpixel((120, 60))
                cleaned_text_pixel = cleaned.getpixel((36, 28))

        self.assertEqual(result.strategy, "local_fill")
        self.assertEqual(result.provider_role, "local")
        self.assertEqual(result.prompt_id, "source_preserving_text_background")
        self.assertEqual(result.artifact_path, "backgrounds/0000-slide-a/source-preserving.png")
        self.assertEqual(visual_pixel, (125, 135, 150))
        self.assertNotEqual(cleaned_text_pixel, (255, 255, 255))

    def test_source_preserving_text_background_does_not_inpaint_large_masks(self):
        from src.generative_editable_backgrounds import create_source_preserving_text_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output = root / "backgrounds" / "0000-slide-a" / "source-preserving.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (220, 120), "#041225")
            ImageDraw.Draw(image).rectangle((20, 20, 190, 95), fill="#FFFFFF")
            image.save(source)

            result = create_source_preserving_text_background(
                source_image_path=source,
                text_bboxes=[(20, 20, 190, 95)],
                output_asset_path=output,
                asset_root=root,
                prefer_inpaint=True,
            )

        self.assertEqual(result.strategy, "local_fill")
        self.assertEqual(result.provenance["decision"], "source preserving local text cleanup")

    def test_source_raster_background_copies_source_without_cleanup(self):
        from src.generative_editable_backgrounds import create_source_raster_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            output = root / "backgrounds" / "0000-slide-a" / "source-raster.png"
            source.parent.mkdir(parents=True)
            image = Image.new("RGB", (80, 45), "#041225")
            draw = ImageDraw.Draw(image)
            draw.rectangle((10, 10, 30, 20), fill="#FFFFFF")
            image.save(source)

            result = create_source_raster_background(
                source_image_path=source,
                output_asset_path=output,
                asset_root=root,
            )

            with Image.open(source) as original, Image.open(output) as copied:
                diff_bbox = ImageChops.difference(
                    original.convert("RGB"),
                    copied.convert("RGB"),
                ).getbbox()

        self.assertIsNone(diff_bbox)
        self.assertEqual(result.strategy, "local_fill")
        self.assertEqual(result.provider_role, "local")
        self.assertEqual(result.prompt_id, "source_raster_background")
        self.assertEqual(result.artifact_path, "backgrounds/0000-slide-a/source-raster.png")

    def test_direct_local_cleanup_returns_job_relative_background_artifact_ref(self):
        from src.generative_editable_backgrounds import local_cleanup_text_mask

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "0000-slide-a" / "source.png"
            mask = root / "masks" / "0000-slide-a" / "text.png"
            output = root / "backgrounds" / "0000-slide-a" / "text-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (120, 80), "#EEEEEE").save(source)
            mask_image = Image.new("L", (120, 80), 0)
            ImageDraw.Draw(mask_image).rectangle((30, 20, 70, 42), fill=255)
            mask_image.save(mask)

            result = local_cleanup_text_mask(source, mask, output, asset_root=root)

        self.assertEqual(result.artifact_path, "backgrounds/0000-slide-a/text-clean.png")

    def test_local_inpaint_is_selected_for_small_repairable_nonflat_regions(self):
        from src.generative_editable_backgrounds import local_cleanup_text_mask

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            output = root / "backgrounds" / "text-clean.png"
            image = Image.new("RGB", (120, 80), "#EEEEEE")
            draw = ImageDraw.Draw(image)
            for x in range(120):
                color = 220 if x < 60 else 180
                draw.line((x, 0, x, 79), fill=(color, color, color))
            image.save(source)
            mask_image = Image.new("L", (120, 80), 0)
            ImageDraw.Draw(mask_image).rectangle((55, 30, 62, 36), fill=255)
            mask_image.save(mask)

            result = local_cleanup_text_mask(source, mask, output)

            self.assertEqual(result.strategy, "local_inpaint")
            self.assertEqual(result.validation_status, "passed")
            self.assertTrue(output.exists())

    def test_local_inpaint_uses_neighbor_fill_instead_of_blurring_baked_text(self):
        from src.generative_editable_backgrounds import local_cleanup_text_mask

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            output = root / "backgrounds" / "text-clean.png"
            image = Image.new("RGB", (120, 80), "#EEEEEE")
            draw = ImageDraw.Draw(image)
            for x in range(120):
                color = 180 + (x % 16)
                draw.line((x, 0, x, 79), fill=(color, color, color))
            draw.rectangle((56, 30, 63, 37), fill="#000000")
            image.save(source)
            mask_image = Image.new("L", (120, 80), 0)
            ImageDraw.Draw(mask_image).rectangle((55, 29, 64, 38), fill=255)
            mask_image.save(mask)

            result = local_cleanup_text_mask(source, mask, output)

            self.assertEqual(result.strategy, "local_inpaint")
            with Image.open(output) as cleaned:
                center = cleaned.getpixel((60, 34))
            self.assertGreater(min(center), 140)

    def test_text_clean_background_uses_local_cleanup_before_remote_edit(self):
        from src.generative_editable_backgrounds import create_text_clean_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            output = root / "backgrounds" / "0000-slide-a" / "text-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (160, 90), "#F8FAFC").save(source)
            mask_image = Image.new("L", (160, 90), 0)
            ImageDraw.Draw(mask_image).rectangle((40, 24, 100, 44), fill=255)
            mask_image.save(mask)
            provider = RecordingImageEditProvider()

            result = create_text_clean_background(
                source_image_path=source,
                text_mask_path=mask,
                output_asset_path=output,
                asset_root=root,
                edit_provider=provider,
            )

            self.assertEqual(result.strategy, "local_fill")
            self.assertEqual(provider.calls, [])
            self.assertEqual(result.artifact_path, "backgrounds/0000-slide-a/text-clean.png")
            self.assertIn("local cleanup", result.provenance["decision"])

    def test_text_clean_background_rejects_paths_outside_asset_root_before_local_cleanup(self):
        from src.generative_editable_backgrounds import create_text_clean_background

        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            outside = Path(outside_tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (100, 60), "#F8FAFC").save(source)
            Image.new("L", (100, 60), 255).save(mask)
            provider = RecordingImageEditProvider()
            outside_output = outside / "text-clean.png"

            with self.assertRaisesRegex(ValueError, "output_asset_path"):
                create_text_clean_background(
                    source_image_path=source,
                    text_mask_path=mask,
                    output_asset_path=outside_output,
                    asset_root=root,
                    edit_provider=provider,
                )

            self.assertFalse(outside_output.exists())
            self.assertEqual(provider.calls, [])

    def test_direct_local_cleanup_rejects_outside_output_and_source_overwrite(self):
        from src.generative_editable_backgrounds import local_cleanup_text_mask

        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            outside = Path(outside_tmp)
            source = root / "source.png"
            mask = root / "mask.png"
            outside_output = outside / "backgrounds" / "text-clean.png"
            Image.new("RGB", (100, 60), "#F8FAFC").save(source)
            mask_image = Image.new("L", (100, 60), 0)
            ImageDraw.Draw(mask_image).rectangle((20, 20, 40, 34), fill=255)
            mask_image.save(mask)
            before = hashlib.sha256(source.read_bytes()).hexdigest()

            with self.assertRaisesRegex(ValueError, "source_image_path"):
                local_cleanup_text_mask(source, mask, outside_output)
            with self.assertRaisesRegex(ValueError, "must not overwrite source_image_path"):
                local_cleanup_text_mask(source, mask, source, asset_root=root)

            self.assertFalse(outside_output.exists())
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)

    def test_text_clean_background_rejects_external_source_or_mask_paths(self):
        from src.generative_editable_backgrounds import create_text_clean_background

        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside_tmp:
            root = Path(tmp)
            outside = Path(outside_tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (100, 60), "#F8FAFC").save(source)
            Image.new("L", (100, 60), 0).save(mask)
            outside_source = outside / "source.png"
            outside_mask = outside / "mask.png"
            Image.new("RGB", (100, 60), "#F8FAFC").save(outside_source)
            Image.new("L", (100, 60), 0).save(outside_mask)
            provider = RecordingImageEditProvider()

            with self.assertRaisesRegex(ValueError, "source_image_path"):
                create_text_clean_background(
                    source_image_path=outside_source,
                    text_mask_path=mask,
                    output_asset_path=root / "backgrounds" / "text-clean.png",
                    asset_root=root,
                    edit_provider=provider,
                )
            with self.assertRaisesRegex(ValueError, "text_mask_path"):
                create_text_clean_background(
                    source_image_path=source,
                    text_mask_path=outside_mask,
                    output_asset_path=root / "backgrounds" / "text-clean.png",
                    asset_root=root,
                    edit_provider=provider,
                )

            self.assertEqual(provider.calls, [])

    def test_background_generation_rejects_in_place_source_overwrite(self):
        from src.generative_editable_backgrounds import (
            create_base_clean_background,
            create_text_clean_background,
        )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (100, 60), "#F8FAFC").save(source)
            Image.new("L", (100, 60), 0).save(mask)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            provider = RecordingImageEditProvider()

            with self.assertRaisesRegex(ValueError, "must not overwrite source_image_path"):
                create_text_clean_background(
                    source_image_path=source,
                    text_mask_path=mask,
                    output_asset_path=source,
                    asset_root=root,
                    edit_provider=provider,
                )
            with self.assertRaisesRegex(ValueError, "must not overwrite source_image_path"):
                create_base_clean_background(
                    source_image_path=source,
                    output_asset_path=source,
                    asset_root=root,
                    edit_provider=provider,
                    text_mask_path=mask,
                )

            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            self.assertEqual(provider.calls, [])

    def test_large_or_full_slide_text_masks_do_not_pass_local_fill(self):
        from src.generative_editable_backgrounds import create_text_clean_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            output = root / "backgrounds" / "0000-slide-a" / "text-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            image = Image.new("RGB", (120, 80), "#F8FAFC")
            draw = ImageDraw.Draw(image)
            draw.rectangle((20, 20, 100, 60), fill="#2563EB")
            image.save(source)
            Image.new("L", (120, 80), 255).save(mask)
            provider = RecordingImageEditProvider()

            result = create_text_clean_background(
                source_image_path=source,
                text_mask_path=mask,
                output_asset_path=output,
                asset_root=root,
                edit_provider=provider,
            )

            self.assertEqual(result.strategy, "image_edit")
            self.assertEqual(len(provider.calls), 1)

    def test_text_clean_background_uses_image_edit_when_local_cleanup_is_insufficient(self):
        from src.generative_editable_backgrounds import create_text_clean_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            output = root / "backgrounds" / "0000-slide-a" / "text-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            image = Image.new("RGB", (160, 90), "#FFFFFF")
            draw = ImageDraw.Draw(image)
            for x in range(160):
                for y in range(90):
                    draw.point((x, y), fill=((x * 7) % 255, (y * 11) % 255, (x + y) % 255))
            image.save(source)
            mask_image = Image.new("L", (160, 90), 0)
            ImageDraw.Draw(mask_image).rectangle((20, 10, 145, 72), fill=255)
            mask_image.save(mask)
            provider = RecordingImageEditProvider()

            result = create_text_clean_background(
                source_image_path=source,
                text_mask_path=mask,
                output_asset_path=output,
                asset_root=root,
                edit_provider=provider,
            )

            self.assertEqual(result.strategy, "image_edit")
            self.assertEqual(len(provider.calls), 1)
            request = provider.calls[0]
            self.assertEqual(request.prompt_id, "text_clean_background")
            self.assertEqual(request.mask_path, str(mask))
            self.assertIn("text-free background layer", request.prompt)
            self.assertEqual(request.metadata["source_image_ref"], "sources/slide.png")
            self.assertEqual(result.provider_role, "edit_model")
            self.assertEqual(result.artifact_path, "backgrounds/0000-slide-a/text-clean.png")

    def test_base_clean_background_uses_image_edit_and_records_source_references(self):
        from src.generative_editable_backgrounds import create_base_clean_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "text.png"
            output = root / "backgrounds" / "0000-slide-a" / "base-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (160, 90), "#FFFFFF").save(source)
            Image.new("L", (160, 90), 0).save(mask)
            provider = RecordingImageEditProvider()

            result = create_base_clean_background(
                source_image_path=source,
                output_asset_path=output,
                asset_root=root,
                edit_provider=provider,
                text_mask_path=mask,
            )

            self.assertEqual(result.strategy, "image_edit")
            self.assertEqual(len(provider.calls), 1)
            request = provider.calls[0]
            self.assertEqual(request.prompt_id, "base_clean_background")
            self.assertEqual(request.metadata["source_image_ref"], "sources/slide.png")
            self.assertEqual(request.metadata["text_mask_ref"], "masks/text.png")
            self.assertEqual(request.mask_path, str(mask))
            self.assertIn("background layer only", request.prompt)
            self.assertEqual(result.provider_role, "edit_model")

    def test_base_clean_background_removes_only_analysis_accepted_regions(self):
        from src.generative_editable_backgrounds import create_base_clean_background

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "sources" / "slide.png"
            mask = root / "masks" / "accepted-text.png"
            output = root / "backgrounds" / "0000-slide-a" / "base-clean.png"
            source.parent.mkdir(parents=True)
            mask.parent.mkdir(parents=True)
            Image.new("RGB", (160, 90), "#FFFFFF").save(source)
            Image.new("L", (160, 90), 0).save(mask)
            provider = RecordingImageEditProvider()

            create_base_clean_background(
                source_image_path=source,
                output_asset_path=output,
                asset_root=root,
                edit_provider=provider,
                text_mask_path=mask,
                removal_bboxes=[(20, 10, 90, 30)],
            )

            request = provider.calls[0]
            self.assertIn("Remove only the supplied mask regions", request.prompt)
            self.assertIn("(20, 10, 90, 30)", request.prompt)
            self.assertIn("Preserve all other readable text", request.prompt)
            self.assertEqual(request.metadata["removal_bboxes"], [(20, 10, 90, 30)])

    def test_manifest_update_preserves_source_and_records_background_strategy(self):
        from src.generative_editable_backgrounds import (
            BackgroundResult,
            update_page_manifest_backgrounds,
        )

        page = PageManifest(
            slide_id="slide-a",
            page_index=0,
            source_image_path="sources/0000-slide-a/source.png",
            source_image_size=(160, 90),
            slide_size=(10.0, 5.625),
            provenance={"input_hash": "abc123"},
            validation_status="pending",
        )
        text_result = BackgroundResult(
            output_asset_path="/tmp/job/backgrounds/0000-slide-a/text-clean.png",
            artifact_path="backgrounds/0000-slide-a/text-clean.png",
            strategy="local_fill",
            provider_role="local",
            prompt_id="local_text_cleanup",
            input_asset_refs=["sources/0000-slide-a/source.png"],
            validation_status="passed",
            provenance={"decision": "local cleanup"},
        )
        base_result = BackgroundResult(
            output_asset_path="/tmp/job/backgrounds/0000-slide-a/base-clean.png",
            artifact_path="backgrounds/0000-slide-a/base-clean.png",
            strategy="image_edit",
            provider_role="edit_model",
            prompt_id="base_clean_background",
            input_asset_refs=["sources/0000-slide-a/source.png"],
            validation_status="passed",
            provenance={"prompt_id": "base_clean_background"},
        )

        updated = update_page_manifest_backgrounds(page, text_result, base_result)

        self.assertEqual(updated.source_image_path, page.source_image_path)
        self.assertEqual(updated.text_clean_background, text_result.artifact_path)
        self.assertEqual(updated.base_clean_background, base_result.artifact_path)
        self.assertEqual(updated.chosen_background, base_result.artifact_path)
        self.assertEqual(updated.provenance["input_hash"], "abc123")
        backgrounds = updated.provenance["backgrounds"]
        self.assertEqual(backgrounds["text_clean"]["strategy"], "local_fill")
        self.assertEqual(backgrounds["base_clean"]["prompt_id"], "base_clean_background")
        self.assertEqual(backgrounds["base_clean"]["output_asset_ref"], base_result.artifact_path)


if __name__ == "__main__":
    unittest.main()

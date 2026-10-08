import tempfile
import unittest
from pathlib import Path

from PIL import Image

import api.routes.export as export_route
from src.generative_editable_manifest import read_deck_manifest
from src.generative_editable_pipeline import (
    GenerativeEditableSlideInput,
    run_generative_editable_pipeline,
)
from tests.generative_editable_fixtures import write_deterministic_fixture_deck


class GenerativeEditableFixtureTest(unittest.TestCase):
    def test_fixture_decks_cover_required_fake_provider_cases(self):
        required_tags = {
            "text",
            "simple_shapes",
            "repeated_bitmap_asset",
            "complex_visual",
            "text_clean_fallback",
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            widescreen = write_deterministic_fixture_deck(root, aspect_ratio="16:9")
            standard = write_deterministic_fixture_deck(root, aspect_ratio="4:3")

            self.assertEqual(widescreen.image_size, (800, 450))
            self.assertEqual(standard.image_size, (800, 600))
            self.assertEqual(len(widescreen.slides), 4)
            self.assertEqual(len(standard.slides), 4)
            self.assertTrue(required_tags.issubset(widescreen.coverage_tags))
            self.assertTrue(required_tags.issubset(standard.coverage_tags))
            for deck in (widescreen, standard):
                for slide in deck.slides:
                    self.assertTrue(slide.image_path.exists())
                    with Image.open(slide.image_path) as image:
                        self.assertEqual(image.size, deck.image_size)
                    self.assertGreaterEqual(len(slide.text_metadata), 1)

    def test_fixture_deck_passes_fake_provider_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = write_deterministic_fixture_deck(root, aspect_ratio="16:9")
            artifact_root = root / "jobs"
            output_path = root / "fixture-output.pptx"

            result = run_generative_editable_pipeline(
                slides=[
                    GenerativeEditableSlideInput(
                        slide_id=slide.slide_id,
                        image_path=str(slide.image_path),
                        text_metadata=slide.text_metadata,
                    )
                    for slide in fixture.slides
                ],
                output_path=str(output_path),
                artifact_root=str(artifact_root),
                job_id="fixture-fake-provider",
                dependencies=export_route._build_fake_generative_editable_pipeline_dependencies(),
                cleanup_artifacts=False,
            )

            deck_manifest = read_deck_manifest(
                artifact_root / "fixture-fake-provider" / "deck.json"
            )
            self.assertEqual(result.status, "passed")
            self.assertEqual(Path(result.output_path), output_path)
            self.assertTrue(output_path.exists())
            self.assertEqual(deck_manifest.slide_order, fixture.slide_order)
            self.assertEqual(len(deck_manifest.page_manifest_paths), len(fixture.slides))
            self.assertEqual(deck_manifest.validation_status, "passed")


if __name__ == "__main__":
    unittest.main()

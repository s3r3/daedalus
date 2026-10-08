import json
import tempfile
import threading
import unittest
from pathlib import Path

from src.generative_editable_job_artifacts import GenerativeEditableJobArtifacts
from src.generative_editable_manifest import PageManifest, read_page_manifest, write_manifest


class GenerativeEditableJobArtifactsTest(unittest.TestCase):
    def test_creates_deterministic_job_directory_and_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-001")

            self.assertEqual(artifacts.job_dir, Path(tmp) / "job-001")
            self.assertEqual(artifacts.deck_manifest_path, Path(tmp) / "job-001" / "deck.json")
            self.assertTrue((Path(tmp) / "job-001" / "pages").is_dir())
            self.assertTrue((Path(tmp) / "job-001" / "assets").is_dir())
            self.assertTrue((Path(tmp) / "job-001" / "backgrounds").is_dir())

            with self.assertRaisesRegex(ValueError, "job_id"):
                GenerativeEditableJobArtifacts(root_dir=tmp, job_id="../")
            with self.assertRaisesRegex(ValueError, "job_id"):
                GenerativeEditableJobArtifacts(root_dir=tmp, job_id="")
            with self.assertRaisesRegex(ValueError, "job_id"):
                GenerativeEditableJobArtifacts(root_dir=tmp, job_id="???")

            page_path = artifacts.page_manifest_path("slide/a", 2)
            asset_path = artifacts.asset_path("slide/a", 2, "assets", "asset.png")

        self.assertEqual(
            page_path,
            Path(tmp) / "job-001" / "pages" / "0002-slide-a.json",
        )
        self.assertEqual(
            asset_path,
            Path(tmp) / "job-001" / "assets" / "0002-slide-a" / "asset.png",
        )

    def test_page_manifest_paths_follow_slide_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-ordered")

            paths = artifacts.page_manifest_paths(["slide-b", "slide-a"])

        self.assertEqual(
            paths,
            [
                Path(tmp) / "job-ordered" / "pages" / "0000-slide-b.json",
                Path(tmp) / "job-ordered" / "pages" / "0001-slide-a.json",
            ],
        )

    def test_asset_paths_are_scoped_to_known_categories(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-safe")

            with self.assertRaisesRegex(ValueError, "category"):
                artifacts.asset_path("slide", 0, "../outside", "asset.png")

            with self.assertRaisesRegex(ValueError, "filename"):
                artifacts.asset_path("slide", 0, "assets", "../asset.png")

    def test_cleanup_removes_only_job_directory_and_keeps_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            keep = root / "keep.txt"
            keep.write_text("keep", encoding="utf-8")
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-clean")
            marker = artifacts.job_dir / "marker.txt"
            marker.write_text("remove", encoding="utf-8")

            artifacts.cleanup()

            self.assertTrue(root.exists())
            self.assertTrue(keep.exists())
            self.assertFalse(artifacts.job_dir.exists())

    def test_cleanup_refuses_root_or_outside_job_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-clean-safe")
            artifacts.job_dir = Path(tmp)

            with self.assertRaisesRegex(ValueError, "cleanup"):
                artifacts.cleanup()

    def test_provider_outputs_are_persisted_for_rebuild_without_provider_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-rebuild")
            page_manifest = PageManifest(
                slide_id="slide-a",
                page_index=0,
                source_image_path="sources/0000-slide-a/source.png",
                source_image_size=(800, 450),
                slide_size=(10.0, 5.625),
                validation_status="passed",
            )
            write_manifest(artifacts.page_manifest_path("slide-a", 0), page_manifest)
            artifacts.write_provider_output(
                "slide-a",
                0,
                "ocr",
                "result.json",
                {
                    "provider_role": "ocr_model",
                    "items": [{"text": "Quarterly Plan", "confidence": 0.98}],
                },
            )
            artifacts.write_provider_output(
                "slide-a",
                0,
                "image_edit",
                "base-clean.json",
                {
                    "provider_role": "edit_model",
                    "output_asset_path": "backgrounds/base-clean.png",
                    "chroma_key_mode": "green",
                    "error": "api_key=secret at https://edit.example/path",
                    "headers": {"cookie": "cookie-secret", "password": "pw-secret"},
                    "response": {
                        "body": (
                            "api_key=nested-secret session_id=session-body-secret "
                            "private_key=private-body-secret at https://nested.example/path"
                        )
                    },
                    "refresh_token": "refresh-secret",
                    "id_token": "id-secret",
                    "apiToken": "api-token-secret",
                },
            )
            artifacts.write_provider_output(
                "slide-a",
                0,
                "image_generation",
                "asset-sheet.json",
                {
                    "provider_role": "image_model",
                    "output_asset_path": "assets/asset-sheet.png",
                },
            )
            artifacts.write_provider_output(
                "slide-a",
                0,
                "repair",
                "repair.json",
                {
                    "provider_role": "edit_model",
                    "attempt_index": 1,
                    "authorization": "Bearer repair-secret",
                    "session": "session-secret",
                    "session_id": "session-id-secret",
                },
            )

            loaded_page = read_page_manifest(artifacts.page_manifest_path("slide-a", 0))
            ocr_output = artifacts.read_provider_output("slide-a", 0, "ocr", "result.json")
            edit_output = artifacts.read_provider_output(
                "slide-a", 0, "image_edit", "base-clean.json"
            )
            generation_output = artifacts.read_provider_output(
                "slide-a", 0, "image_generation", "asset-sheet.json"
            )
            repair_output = artifacts.read_provider_output("slide-a", 0, "repair", "repair.json")
            raw_edit = artifacts.provider_output_path(
                "slide-a", 0, "image_edit", "base-clean.json"
            ).read_text(encoding="utf-8")
            raw_repair = artifacts.provider_output_path(
                "slide-a", 0, "repair", "repair.json"
            ).read_text(encoding="utf-8")

        self.assertEqual(loaded_page.validation_status, "passed")
        self.assertEqual(ocr_output["items"][0]["text"], "Quarterly Plan")
        self.assertEqual(edit_output["provider_role"], "edit_model")
        self.assertEqual(edit_output["chroma_key_mode"], "green")
        self.assertEqual(generation_output["provider_role"], "image_model")
        self.assertEqual(repair_output["attempt_index"], 1)
        self.assertNotIn("secret", raw_edit)
        self.assertNotIn("pw-secret", raw_edit)
        self.assertNotIn("nested-secret", raw_edit)
        self.assertNotIn("session-body-secret", raw_edit)
        self.assertNotIn("private-body-secret", raw_edit)
        self.assertNotIn("refresh-secret", raw_edit)
        self.assertNotIn("id-secret", raw_edit)
        self.assertNotIn("api-token-secret", raw_edit)
        self.assertNotIn("https://nested.example/path", raw_edit)
        self.assertNotIn("https://edit.example/path", raw_edit)
        self.assertNotIn("repair-secret", raw_repair)
        self.assertNotIn("session-secret", raw_repair)
        self.assertNotIn("session-id-secret", raw_repair)

    def test_provider_output_stage_and_filename_are_scoped(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-provider-safe")

            with self.assertRaisesRegex(ValueError, "provider_stage"):
                artifacts.provider_output_path("slide", 0, "../ocr", "result.json")

            with self.assertRaisesRegex(ValueError, "filename"):
                artifacts.provider_output_path("slide", 0, "ocr", "../result.json")

    def test_stage_events_are_appended_sanitized_and_read_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-events")

            artifacts.append_stage_event(
                {
                    "page_index": 0,
                    "slide_id": "slide-a",
                    "stage": "text_clean_background.provider_edit",
                    "status": "started",
                    "api_key": "secret-key",
                    "base_url": "https://provider.example/v1",
                }
            )
            artifacts.append_stage_event(
                {
                    "page_index": 0,
                    "slide_id": "slide-a",
                    "stage": "text_clean_background.provider_edit",
                    "status": "failed",
                    "elapsed_ms": 90000,
                    "error": "Bearer secret-token at https://provider.example/v1",
                }
            )

            events = artifacts.read_stage_events()
            raw = artifacts.stage_events_path.read_text(encoding="utf-8")

        self.assertEqual([event["status"] for event in events], ["started", "failed"])
        self.assertEqual(events[-1]["stage"], "text_clean_background.provider_edit")
        self.assertEqual(events[-1]["elapsed_ms"], 90000)
        self.assertNotIn("secret-key", raw)
        self.assertNotIn("secret-token", raw)
        self.assertNotIn("https://provider.example/v1", raw)
        for line in raw.splitlines():
            self.assertIsInstance(json.loads(line), dict)

    def test_stage_events_tolerate_concurrent_appends_and_malformed_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            artifacts = GenerativeEditableJobArtifacts(root_dir=tmp, job_id="job-events")

            def append_events(worker: int) -> None:
                for index in range(20):
                    artifacts.append_stage_event(
                        {
                            "stage": "worker",
                            "status": "finished",
                            "worker": worker,
                            "index": index,
                        }
                    )

            threads = [
                threading.Thread(target=append_events, args=(worker,)) for worker in range(4)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            with artifacts.stage_events_path.open("a", encoding="utf-8") as handle:
                handle.write("{bad-json")

            events = artifacts.read_stage_events()

        self.assertEqual(len(events), 80)
        self.assertEqual({event["worker"] for event in events}, {0, 1, 2, 3})


if __name__ == "__main__":
    unittest.main()

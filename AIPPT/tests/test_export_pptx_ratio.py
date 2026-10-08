import tempfile
import unittest
import asyncio
import base64
from pathlib import Path

from PIL import Image
from pptx import Presentation

from api.models import ExportRequest, ExportSlide
from api.routes.export import _export_pptx, export_presentation
import api.routes.export as export_route


class ExportPptxRatioTest(unittest.TestCase):
    def test_exports_4_3_pptx_when_requested(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            output_path = Path(tmp) / "presentation.pptx"
            Image.new("RGB", (800, 600), "white").save(image_path)

            _export_pptx([str(image_path)], str(output_path), aspect_ratio="4:3")

            prs = Presentation(str(output_path))

        ratio = prs.slide_width / prs.slide_height
        self.assertAlmostEqual(ratio, 4 / 3, places=2)

    def test_export_response_cleans_temp_directory_after_send(self):
        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            Image.new("RGB", (800, 450), "white").save(image_path)
            image_base64 = base64.b64encode(image_path.read_bytes()).decode()

        request = ExportRequest(
            slides=[ExportSlide(image_base64=image_base64)],
            format="pptx",
        )
        response = asyncio.run(export_presentation(request))
        output_path = Path(response.path)

        self.assertTrue(output_path.exists())
        self.assertIsNotNone(response.background)
        asyncio.run(response.background())
        self.assertFalse(output_path.parent.exists())

    def test_pdf_export_runs_synchronous_work_in_thread(self):
        thread_calls = []

        async def fake_to_thread(func, *args, **kwargs):
            thread_calls.append(func)
            return func(*args, **kwargs)

        class FakePDFExporter:
            def export(self, image_paths, output_path):
                Path(output_path).write_bytes(b"%PDF-1.4")
                return output_path

        original_to_thread = asyncio.to_thread
        original_exporter = export_route.PDFExporter
        asyncio.to_thread = fake_to_thread
        export_route.PDFExporter = FakePDFExporter
        try:
            with tempfile.TemporaryDirectory() as tmp:
                image_path = Path(tmp) / "slide.png"
                Image.new("RGB", (800, 450), "white").save(image_path)
                image_base64 = base64.b64encode(image_path.read_bytes()).decode()

            request = ExportRequest(
                slides=[ExportSlide(image_base64=image_base64)],
                format="pdf",
            )
            response = asyncio.run(export_presentation(request))

            self.assertTrue(Path(response.path).exists())
            self.assertEqual([getattr(func, "__name__", "") for func in thread_calls], ["export"])
            asyncio.run(response.background())
        finally:
            asyncio.to_thread = original_to_thread
            export_route.PDFExporter = original_exporter

    def test_pptx_export_runs_synchronous_work_in_thread(self):
        thread_calls = []

        async def fake_to_thread(func, *args, **kwargs):
            thread_calls.append(func)
            return func(*args, **kwargs)

        def fake_export_pptx(image_paths, output_path, aspect_ratio="16:9"):
            Path(output_path).write_bytes(b"pptx")

        original_to_thread = asyncio.to_thread
        original_export_pptx = export_route._export_pptx
        asyncio.to_thread = fake_to_thread
        export_route._export_pptx = fake_export_pptx
        try:
            with tempfile.TemporaryDirectory() as tmp:
                image_path = Path(tmp) / "slide.png"
                Image.new("RGB", (800, 450), "white").save(image_path)
                image_base64 = base64.b64encode(image_path.read_bytes()).decode()

            request = ExportRequest(
                slides=[ExportSlide(image_base64=image_base64)],
                format="pptx",
            )
            response = asyncio.run(export_presentation(request))

            self.assertTrue(Path(response.path).exists())
            self.assertEqual(
                [getattr(func, "__name__", "") for func in thread_calls], ["fake_export_pptx"]
            )
            asyncio.run(response.background())
        finally:
            asyncio.to_thread = original_to_thread
            export_route._export_pptx = original_export_pptx


if __name__ == "__main__":
    unittest.main()

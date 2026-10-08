import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from src.generative_editable_text_candidates import detect_text_candidate_bboxes


class GenerativeEditableTextCandidatesTest(unittest.TestCase):
    def test_detects_large_cover_title_lines_on_dark_slide(self):
        font_path = Path("/System/Library/Fonts/STHeiti Medium.ttc")
        if not font_path.exists():
            self.skipTest("system CJK font unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "cover.png"
            image = Image.new("RGB", (1000, 560), "#030914")
            draw = ImageDraw.Draw(image)
            title_font = ImageFont.truetype(str(font_path), 72)
            subtitle_font = ImageFont.truetype(str(font_path), 64)
            draw.text((50, 70), "理想L9:", font=title_font, fill="#F8FAFC")
            draw.text((50, 170), "旗舰增程SUV的技术实验", font=subtitle_font, fill="#F8FAFC")
            image.save(image_path)

            candidates = detect_text_candidate_bboxes(str(image_path))

        self.assertTrue(
            any(
                bbox[0] <= 70 and 150 <= bbox[1] <= 190 and bbox[2] >= 620 and 230 <= bbox[3] <= 280
                for bbox in candidates
            ),
            candidates,
        )

    def test_detects_three_left_domain_labels_on_dense_dark_slide(self):
        font_path = Path("/System/Library/Fonts/STHeiti Medium.ttc")
        if not font_path.exists():
            self.skipTest("system CJK font unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "slide.png"
            image = Image.new("RGB", (900, 520), "#030914")
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype(str(font_path), 34)
            for y, text in [(90, "智能域"), (235, "底盘域"), (380, "动力域")]:
                draw.rounded_rectangle((70, y - 34, 830, y + 54), radius=12, fill="#0B2340")
                draw.text((155, y), text, font=font, fill="#168BFF")
                draw.line((460, y - 16, 460, y + 42), fill="#1D9BFF", width=2)
                draw.rectangle((520, y - 18, 680, y + 42), outline="#4D6B8F", width=2)
            image.save(image_path)

            candidates = detect_text_candidate_bboxes(str(image_path))

        left_label_candidates = [
            bbox
            for bbox in candidates
            if 140 <= bbox[0] <= 220 and 220 <= bbox[1] <= 280 and bbox[2] - bbox[0] >= 40
        ]
        self.assertGreaterEqual(len(candidates), 3)
        self.assertTrue(left_label_candidates, candidates)

    def test_detects_card_heading_labels_on_dashboard_slide(self):
        font_path = Path("/System/Library/Fonts/STHeiti Medium.ttc")
        if not font_path.exists():
            self.skipTest("system CJK font unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            image_path = Path(tmp) / "dashboard.png"
            image = Image.new("RGB", (1000, 560), "#030914")
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype(str(font_path), 26)
            draw.rounded_rectangle(
                (28, 70, 390, 420), radius=16, fill="#0B2340", outline="#1D4ED8", width=2
            )
            draw.rounded_rectangle(
                (410, 70, 960, 420), radius=16, fill="#0B2340", outline="#1D4ED8", width=2
            )
            draw.ellipse((48, 88, 76, 116), fill="#60A5FA")
            draw.ellipse((430, 88, 458, 116), fill="#60A5FA")
            draw.text((86, 88), "日常操作", font=font, fill="#F8FAFC")
            draw.text((468, 88), "紧急与维护", font=font, fill="#F8FAFC")
            image.save(image_path)

            candidates = detect_text_candidate_bboxes(str(image_path))

        self.assertTrue(
            any(
                75 <= bbox[0] <= 95 and 80 <= bbox[1] <= 100 and 170 <= bbox[2] <= 230
                for bbox in candidates
            ),
            candidates,
        )
        self.assertTrue(
            any(
                415 <= bbox[0] <= 475 and 75 <= bbox[1] <= 105 and 580 <= bbox[2] <= 650
                for bbox in candidates
            ),
            candidates,
        )

    def test_detects_replay_dashboard_card_headings(self):
        image_path = Path("output/replay-assets/slide_5.png")
        if not image_path.exists():
            self.skipTest("replay slide_5 fixture unavailable")

        candidates = detect_text_candidate_bboxes(str(image_path))

        self.assertTrue(
            any(
                140 <= bbox[0] <= 170 and 120 <= bbox[1] <= 145 and 320 <= bbox[2] <= 360
                for bbox in candidates
            ),
            candidates,
        )

    def test_splits_replay_dashboard_wide_row_bands_into_flowchart_text_groups(self):
        image_path = Path("output/replay-assets/slide_5.png")
        if not image_path.exists():
            self.skipTest("replay slide_5 fixture unavailable")

        candidates = detect_text_candidate_bboxes(str(image_path))

        self.assertTrue(
            any(
                1160 <= bbox[0] <= 1210 and 370 <= bbox[1] <= 395 and 1520 <= bbox[2] <= 1560
                for bbox in candidates
            ),
            candidates,
        )
        self.assertTrue(
            any(
                1020 <= bbox[0] <= 1060 and 800 <= bbox[1] <= 825 and 1200 <= bbox[2] <= 1230
                for bbox in candidates
            ),
            candidates,
        )
        self.assertFalse(
            any(
                bbox[0] <= 120 and bbox[2] >= 1000 and 120 <= bbox[1] <= 220 for bbox in candidates
            ),
            candidates,
        )
        self.assertTrue(
            any(
                780 <= bbox[0] <= 820 and 120 <= bbox[1] <= 145 and 1010 <= bbox[2] <= 1060
                for bbox in candidates
            ),
            candidates,
        )

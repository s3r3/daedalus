import unittest

from src.generative_editable_manifest import TextBoxSpec
from src.generative_editable_text_masks import create_text_mask


class GenerativeEditableTextMaskTest(unittest.TestCase):
    def test_creates_mask_from_text_boxes_with_padding_and_clipping(self):
        boxes = [
            TextBoxSpec(
                text="Title",
                source_pixel_bbox=(10, 10, 40, 30),
                source_pixel_polygon=((10, 10), (40, 10), (40, 30), (10, 30)),
            ),
            TextBoxSpec(
                text="Edge",
                source_pixel_bbox=(90, 40, 100, 50),
                source_pixel_polygon=((90, 40), (100, 40), (100, 50), (90, 50)),
            ),
        ]

        mask = create_text_mask((100, 50), boxes, padding=5)

        self.assertEqual(mask.size, (100, 50))
        self.assertEqual(mask.mode, "L")
        self.assertEqual(mask.getpixel((5, 5)), 255)
        self.assertEqual(mask.getpixel((45, 35)), 255)
        self.assertEqual(mask.getpixel((99, 49)), 255)
        self.assertEqual(mask.getpixel((0, 49)), 0)

    def test_creates_mask_from_polygon_when_requested(self):
        boxes = [
            TextBoxSpec(
                text="Angled",
                source_pixel_bbox=(10, 10, 50, 40),
                source_pixel_polygon=((20, 10), (50, 20), (40, 40), (10, 30)),
            )
        ]

        mask = create_text_mask((80, 60), boxes, padding=0, use_polygons=True)

        self.assertEqual(mask.getpixel((30, 25)), 255)
        self.assertEqual(mask.getpixel((10, 10)), 0)

    def test_polygon_padding_expands_and_clips_mask(self):
        boxes = [
            TextBoxSpec(
                text="Angled",
                source_pixel_bbox=(5, 5, 19, 19),
                source_pixel_polygon=((12, 4), (20, 12), (12, 20), (4, 12)),
            )
        ]

        mask = create_text_mask((24, 24), boxes, padding=4, use_polygons=True)

        self.assertEqual(mask.getpixel((12, 1)), 255)
        self.assertEqual(mask.getpixel((1, 1)), 0)

    def test_polygon_mask_skips_fully_out_of_bounds_polygon(self):
        boxes = [
            TextBoxSpec(
                text="Out",
                source_pixel_bbox=(0, 0, 10, 10),
                source_pixel_polygon=((0, 0), (10, 0), (10, 10), (0, 10)),
            )
        ]
        object.__setattr__(
            boxes[0],
            "source_pixel_polygon",
            ((200, 200), (220, 200), (220, 220), (200, 220)),
        )

        mask = create_text_mask((100, 50), boxes, padding=0, use_polygons=True)

        self.assertEqual(mask.getbbox(), None)

    def test_mask_rejects_negative_padding_and_excessive_dimensions(self):
        with self.assertRaisesRegex(ValueError, "padding"):
            create_text_mask((100, 50), [], padding=-1)

        with self.assertRaisesRegex(ValueError, "image_size"):
            create_text_mask((20000, 20000), [], padding=0)

    def test_mask_clips_out_of_bounds_boxes_without_inverting(self):
        boxes = [
            TextBoxSpec(
                text="Out",
                source_pixel_bbox=(0, 0, 10, 10),
                source_pixel_polygon=((0, 0), (10, 0), (10, 10), (0, 10)),
            )
        ]
        object.__setattr__(boxes[0], "source_pixel_bbox", (200, 200, 250, 250))

        mask = create_text_mask((100, 50), boxes, padding=0)

        self.assertEqual(mask.getbbox(), None)


if __name__ == "__main__":
    unittest.main()

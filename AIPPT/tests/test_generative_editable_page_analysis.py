from src.generative_editable_manifest import TextBoxSpec


def _box(text: str, bbox: tuple[int, int, int, int], *, approximate: bool = True) -> TextBoxSpec:
    provenance = {"ocr_provenance": {"approximate_layout": True}} if approximate else {}
    return TextBoxSpec(
        text=text,
        source_pixel_bbox=bbox,
        source_pixel_polygon=(
            (bbox[0], bbox[1]),
            (bbox[2], bbox[1]),
            (bbox[2], bbox[3]),
            (bbox[0], bbox[3]),
        ),
        provenance=provenance,
    )


def test_page_text_analysis_keeps_visually_anchored_layouts_and_demotes_row_band_ocr_to_hints():
    from src.generative_editable_page_analysis import build_page_text_analysis

    analysis = build_page_text_analysis(
        text_boxes=[
            _box("非高压", (80, 130, 138, 179)),
            _box("日常操作", (150, 127, 339, 190)),
            _box("精确文本", (500, 300, 620, 330), approximate=False),
        ],
        visual_text_candidates=[
            (90, 137, 1026, 181),
            (150, 127, 339, 190),
            (294, 21, 1086, 77),
        ],
        source_image_size=(1672, 941),
    )

    assert [item.text for item in analysis.accepted_text_boxes] == ["日常操作", "精确文本"]
    assert [hint.text for hint in analysis.rejected_ocr_hints] == ["非高压"]
    assert analysis.rejected_ocr_hints[0].reason == "unanchored_approximate_ocr"


def test_page_text_analysis_records_reference_sop_provenance_for_accepted_layouts():
    from src.generative_editable_page_analysis import build_page_text_analysis

    analysis = build_page_text_analysis(
        text_boxes=[
            _box("紧急与维护", (801, 127, 1037, 190)),
        ],
        visual_text_candidates=[
            (801, 127, 1037, 190),
            (294, 21, 1086, 77),
            (150, 127, 339, 190),
        ],
        source_image_size=(1672, 941),
    )

    accepted = analysis.accepted_text_boxes[0]
    assert accepted.provenance["layout_source"] == "visual_text_candidate"
    assert accepted.provenance["ocr_layout_usage"] == "hint_only"

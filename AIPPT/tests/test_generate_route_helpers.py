from api.models import ConfirmedSlidePrompt, GenerationConfig, GenerationRequest
from api.routes.generate import _prompt_data_from_confirmed, _slide_text_metadata
from src.config import PPTConfig


def test_confirmed_slide_prompts_are_sorted_by_page():
    ppt_config = PPTConfig(num_pages=3)
    request = GenerationRequest(
        content="# Source",
        config=GenerationConfig(page_count=3),
        slide_prompts=[
            ConfirmedSlidePrompt(page=2, title="Two", content_summary="Second", prompt="Prompt 2"),
            ConfirmedSlidePrompt(page=1, title="One", content_summary="First", prompt="Prompt 1"),
            ConfirmedSlidePrompt(page=3, title="Three", content_summary="Third", prompt="Prompt 3"),
        ],
    )

    prompt_data = _prompt_data_from_confirmed(request, ppt_config)

    assert [slide.page for slide in prompt_data.slide_prompts] == [1, 2, 3]
    assert [slide.title for slide in prompt_data.slide_prompts] == ["One", "Two", "Three"]


def test_slide_text_metadata_uses_title_and_display_content():
    prompt = ConfirmedSlidePrompt(
        page=1,
        title="Quarterly Plan",
        content_summary="Fallback summary",
        display_content="Revenue up 18%\nMargin stable",
        prompt="Prompt 1",
    )

    assert _slide_text_metadata(prompt) == [
        {"text": "Quarterly Plan", "role": "title", "order": 1, "style_hint": {}},
        {
            "text": "Revenue up 18%\nMargin stable",
            "role": "body",
            "order": 2,
            "style_hint": {},
        },
    ]


def test_slide_text_metadata_avoids_duplicate_body_matching_title():
    prompt = ConfirmedSlidePrompt(
        page=1,
        title="Only Title",
        content_summary="Only Title",
        prompt="Prompt 1",
    )

    assert _slide_text_metadata(prompt) == [
        {"text": "Only Title", "role": "title", "order": 1, "style_hint": {}}
    ]


def test_slide_text_metadata_ignores_string_prompt_values():
    assert _slide_text_metadata("standalone prompt text") == []

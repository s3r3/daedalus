import os
import sys
import json
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

# --- Configuration ---
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
MODEL = os.getenv("OPENAI_MODEL", "gemini-3-flash-preview")

# --- Mock Data ---
MOCK_CONTENT = {
    "project_title": "Mock Semantic Draft",
    "presentation_goal": "Demonstrate Semantic Content",
    "target_audience": "Developers",
    "slides": [
        {
            "id": "slide_01",
            "semantic_type": "Cover",
            "title": "Welcome to Semantic Draft",
            "subtitle": "Data, Text, and Visuals",
            "core_message": "Content defined by nature.",
            "suggested_layout": "QuoteHero",
            "conceptual_metaphor": None,
            "content_items": []
        },
        {
            "id": "slide_02",
            "semantic_type": "Problem",
            "title": "Critical Issues",
            "subtitle": "Analysis of current blocks",
            "core_message": "Supply chain is the bottleneck.",
            "suggested_layout": "Grid",
            "conceptual_metaphor": "TrafficLight",
            "content_items": [
                {
                    "item_type": "statistic",
                    "content_role": "primary",
                    "headline": "Revenue Impact",
                    "body": "Projected loss of $2M in Q3 due to shipment delays.",
                    "visual_cues": { "status": "critical" },
                    "sub_items": [
                        {
                            "item_type": "text",
                            "content_role": "supporting",
                            "headline": "Region A",
                            "body": "North America impacted most heavily ($1.5M)."
                        },
                         {
                            "item_type": "text",
                            "content_role": "supporting",
                            "headline": "Region B",
                            "body": "Europe showed resilience."
                        }
                    ]
                },
                {
                    "item_type": "text",
                    "content_role": "supporting",
                    "headline": "Supply Chain",
                    "body": "Shipment delayed by 2 weeks.",
                    "visual_cues": { "status": "negative", "badge": "Urgent" }
                },
                {
                    "item_type": "visual",
                    "content_role": "evidence",
                    "headline": "Warehouse Status",
                    "image_file_name": "warehouse-empty-shelves.jpg",
                    "image_description": "Use the uploaded warehouse photo as the main right-side visual.",
                    "visual_cues": { "style_hint": "Desaturated, gritty" }
                }
            ]
        }
    ]
}

def load_file(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def format_image_asset_context(image_assets):
    if not image_assets:
        return ""

    lines = [
        "Uploaded project images available for use:",
    ]
    for asset in image_assets:
        if not isinstance(asset, dict):
            continue
        file_name = asset.get("fileName") or asset.get("file_name")
        if not file_name:
            continue
        size = asset.get("size")
        width = asset.get("width")
        height = asset.get("height")
        aspect_ratio = asset.get("aspectRatio") or asset.get("aspect_ratio")
        orientation = asset.get("orientation")
        line = f"- {file_name}"
        if size:
            line += f" ({size} bytes)"
        if width and height:
            line += f", {width}x{height}px"
        if orientation:
            line += f", {orientation}"
        if aspect_ratio:
            line += f", ratio {aspect_ratio}"
        lines.append(line)

    if len(lines) == 1:
        return ""

    lines.extend([
        "",
        "Use these image file names only for `visual` items.",
        "Assign `content_role` to every item so layout can reason consistently across text, images, charts, and metrics.",
        "When you choose a file for a visual item, preserve its width, height, aspect ratio, and orientation fields in that item.",
        "If none of the uploaded files fit a slide, do not create a `visual` item for that slide.",
    ])
    return "\n".join(lines)


def generate_draft(user_request, output_path, image_assets=None):
    print(f">> [Content Editor] Analyzing request: {user_request}")

    # Re-fetch env vars to ensure we catch what's passed by exec
    api_key = os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("OPENAI_BASE_URL")
    model_name = os.environ.get("OPENAI_MODEL", MODEL)

    print(f">> [Content Editor] Env Check: API_KEY={'Found' if api_key else 'Missing'}, BaseURL={base_url}, Model={model_name}")

    if not api_key:
        print(">> [Content Editor] No OPENAI_API_KEY found. Using MOCK response.")
        draft = MOCK_CONTENT
    elif OpenAI is None:
        print(">> [Content Editor] 'openai' module not installed. Using MOCK response.")
        draft = MOCK_CONTENT
    else:
        try:
            client = OpenAI(api_key=api_key, base_url=base_url)
            
            # Load System Prompt
            script_dir = os.path.dirname(os.path.abspath(__file__))
            prompt_path = os.path.join(script_dir, "../prompts/editor_system.md")
            if not os.path.exists(prompt_path):
                print(f"Warning: Prompt file not found at {prompt_path}")
            system_prompt = load_file(prompt_path) if os.path.exists(prompt_path) else "You are a helpful content editor."
            
            schema_path = os.path.join(script_dir, "../references/content_schema.json")
            if not os.path.exists(schema_path):
                print(f"Warning: Schema file not found at {schema_path}")
            schema = load_file(schema_path) if os.path.exists(schema_path) else "{}"

            image_asset_context = format_image_asset_context(image_assets)

            user_message = f"Request: {user_request}"
            if image_asset_context:
                user_message += f"\n\n{image_asset_context}"
            user_message += "\n\nOutput the JSON draft now."

            messages = [
                {"role": "system", "content": f"{system_prompt}\n\nCRITICAL: You MUST return ONLY a valid JSON object strictly complying with the schema below. Do not output any markdown blocks, explanations, or other text.\n\nSchema:\n{schema}"},
                {"role": "user", "content": user_message}
            ]

            print(">> [Content Editor] Calling LLM...")
            
            response = client.chat.completions.create(
                model=model_name,
                messages=messages,
                # Gemni via standard OpenAI SDK proxy might behave better without this if it's confusing it, 
                # but let's keep it and rely on prompt engineering first.
                response_format={"type": "json_object"}
            )
            content_str = response.choices[0].message.content
            
            # Log raw content for debugging
            with open(os.path.join(os.path.dirname(output_path), "debug_draft.log"), "a") as log_f:
                log_f.write(f"RAW LLM OUTPUT:\n{content_str}\n----------------\n")
            
            # Robust JSON cleaning
            content_str = content_str.strip()
            if content_str.startswith("```json"):
                content_str = content_str[7:]
            if content_str.startswith("```"):
                content_str = content_str[3:]
            if content_str.endswith("```"):
                content_str = content_str[:-3]
            
            content_str = content_str.strip()
            
            draft = json.loads(content_str)
        except Exception as e:
            error_msg = f"!! [Content Editor] Error calling OpenAI: {e}"
            print(error_msg)
            print(error_msg)
            # Log to file for persistence
            with open(os.path.join(os.path.dirname(output_path), "debug_draft.log"), "a") as log_f:
                log_f.write(f"ERROR: {e}\n")
            
            print("Falling back to mock data.")
            draft = MOCK_CONTENT

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    # Log success/env check to file
    with open(os.path.join(os.path.dirname(output_path), "debug_draft.log"), "a") as log_f:
        log_f.write(f"Run Env: API_KEY={'Found' if api_key else 'Missing'}, Model={model_name}\n")
    
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(draft, f, indent=4, ensure_ascii=False)
    
    print(f">> [Content Editor] Draft saved to: {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python3 draft_content.py <user_request> <output_json_path> [image_assets_json_path]")
        sys.exit(1)

    image_assets = None
    if len(sys.argv) >= 4 and sys.argv[3]:
        image_assets_path = sys.argv[3]
        if os.path.exists(image_assets_path):
            with open(image_assets_path, "r", encoding="utf-8") as f:
                image_assets = json.load(f)

    generate_draft(sys.argv[1], sys.argv[2], image_assets)

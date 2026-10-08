
import os
import sys
import json
import argparse
from typing import Dict, Any

# Mock response for testing when no LLM key is present
MOCK_RESPONSE = {
    "project_name": "Mock Rich Project",
    "style_definition": {
        "mood_keywords": ["professional", "clean"],
        "color_preference": "blue_and_white",
        "theme_ref": "ref_theme_tech.css",
        "visual_density": "balanced",
        "target_audience": "Internal Team"
    },
    "design_system_spec": {
        "information_density": { "selection": "Dashboard Style", "instruction": "High density." },
        "grid_system": { "selection": "12-Column", "instruction": "Standard grid." },
        "data_visualization": { "selection": "Flat", "instruction": "Simple charts." },
        "typography": { "selection": "Sans-Serif", "instruction": "Clean fonts." },
        "decorations": { "selection": "Minimal", "instruction": "Few decorations." },
        "artistic_style": { "selection": "Mock Style", "instruction": "1. Mood: Mock. 2. Mat: None. 3. Light: Flat." }
    },
    "required_layouts": [
        {
            "slide_id": "slide_01",
            "type": "cover_branding",
            "layout_intent": "Clean cover with minimal visual noise."
        },
        {
            "slide_id": "slide_02",
            "type": "grid_4_feature",
            "layout_intent": "4 cards with glass effect."
        }
    ]
}

def load_system_prompt(prompt_path: str) -> str:
    try:
        with open(prompt_path, 'r', encoding='utf-8') as f:
            return f.read()
    except FileNotFoundError:
        print(f"Warning: System prompt not found at {prompt_path}")
        return "You are a helpful assistant."

def call_llm(system_prompt: str, user_input_content: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("!! [Creative Director] WARNING: OPENAI_API_KEY not found in environment.")
        # Do not return MOCK_RESPONSE immediately. Let it crash or fail so we know configuration is wrong.
        # But to be safe for user experience, we can raise an error.
        raise ValueError("OPENAI_API_KEY is missing. Cannot generate brief.")

    try:
        from openai import OpenAI
        base_url = os.environ.get("OPENAI_BASE_URL")
        client = OpenAI(api_key=api_key, base_url=base_url)
        
        model = os.environ.get("OPENAI_MODEL", "gpt-4-turbo-preview")
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input_content}
            ],
            response_format={"type": "json_object"}
        )
        return response.choices[0].message.content
    except ImportError:
         print("!! [Creative Director] 'openai' package not installed.")
         raise
    except Exception as e:
         print(f"!! [Creative Director] LLM Call Failed: {e}")
         raise

def main():
    parser = argparse.ArgumentParser(description="Creative Director Agent")
    parser.add_argument("input_file", help="Path to Content Draft JSON (or user request string)")
    parser.add_argument("output", help="Path to save the JSON brief")
    
    args = parser.parse_args()
    
    # 1. Load Input (Draft JSON or String)
    input_content = args.input_file
    if os.path.exists(args.input_file) and args.input_file.endswith(".json"):
        print(f">> [Creative Director] Loading Content Draft from: {args.input_file}")
        with open(args.input_file, "r", encoding="utf-8") as f:
            input_content = f.read()
    else:
        print(f">> [Creative Director] Treating input as raw prompt: {args.input_file}")

    # Paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    skill_dir = os.path.dirname(script_dir)
    prompt_path = os.path.join(skill_dir, "prompts", "director_system.md")
    
    system_prompt = load_system_prompt(prompt_path)
    
    json_str = call_llm(system_prompt, input_content)
    
    # Clean JSON
    if "```json" in json_str:
        json_str = json_str.replace("```json", "").replace("```", "")
    elif "```" in json_str:
        json_str = json_str.replace("```", "")
    
    json_str = json_str.strip()

    try:
        brief = json.loads(json_str)
    except json.JSONDecodeError:
        print(f"!! [Creative Director] Error: LLM did not return valid JSON. Raw output: {json_str}")
        raise

    # Write output
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(brief, f, indent=2, ensure_ascii=False)
        
    print(f">> [Creative Director] Design Brief saved to: {args.output}")

if __name__ == "__main__":
    main()

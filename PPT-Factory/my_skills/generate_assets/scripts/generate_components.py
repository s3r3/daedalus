import os
import sys
import json
import logging
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def load_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()

def save_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    logger.info(f"Saved file: {path}")

def condense_context(brief_data, draft_data):
    """
    Extracts only structural/intent signals from Brief and Draft to save tokens.
    Removes user content (text, specific values) while keeping types and cues.
    """
    condensed_brief = {}
    if brief_data:
        try:
            b_json = json.loads(brief_data)
            condensed_brief = {
                "style_definition": b_json.get("style_definition", {}),
                "design_system_spec": b_json.get("design_system_spec", {}),
                "required_layouts": []
            }
            # Keep layout intent and ID
            for layout in b_json.get("required_layouts", []):
                condensed_brief["required_layouts"].append({
                    "slide_id": layout.get("slide_id"),
                    "type": layout.get("type"),
                    "layout_intent": layout.get("layout_intent")
                })
        except json.JSONDecodeError:
            condensed_brief = {"error": "Invalid Brief JSON"}

    condensed_draft = {"slides": []}
    if draft_data:
        try:
            d_json = json.loads(draft_data)
            for slide in d_json.get("slides", []):
                slide_signal = {
                    "id": slide.get("id"),
                    "semantic_type": slide.get("semantic_type"),
                    "content_types": []
                }
                # Extract item types and visual cues
                for item in slide.get("content_items", []):
                    slide_signal["content_types"].append({
                        "item_type": item.get("item_type"),
                        "visual_cues": item.get("visual_cues")
                    })
                condensed_draft["slides"].append(slide_signal)
        except json.JSONDecodeError:
            condensed_draft = {"error": "Invalid Draft JSON"}
            
    return json.dumps(condensed_brief, indent=2), json.dumps(condensed_draft, indent=2)

def strip_css_comments(css_str):
    """Removes comments from CSS to save tokens."""
    import re
    # Remove block comments
    return re.sub(r'/\*[\s\S]*?\*/', '', css_str).strip()

def condense_context_lite(brief_data, draft_data):
    """
    Super condensed version for retry.
    Drops instructions, keeps only selections and signals.
    """
    condensed_brief = {}
    if brief_data:
        try:
            b_json = json.loads(brief_data)
            ds_spec = b_json.get("design_system_spec", {})
            # Only keep selections, drop long instructions
            lite_spec = {}
            for k, v in ds_spec.items():
                if isinstance(v, dict):
                    lite_spec[k] = v.get("selection", "Default")
            
            condensed_brief = {
                "style_definition": b_json.get("style_definition", {}),
                "design_system_spec": lite_spec, # Lite version
                "required_layouts": []
            }
            # Keep only type and id
            for layout in b_json.get("required_layouts", []):
                condensed_brief["required_layouts"].append({
                    "slide_id": layout.get("slide_id"),
                    "type": layout.get("type")
                })
        except: pass
    
    # Draft: Return empty signal or very minimal to save space
    # For lite mode, we rely on Brief intent mostly
    return json.dumps(condensed_brief, indent=2), json.dumps({"note": "Draft condensed output omitted for stability"}, indent=2)

def generate_components(theme_css_path, output_dir, brief_path=None, content_path=None):
    """
    Generates HTML components based on Theme, Brief, and Draft.
    Uses OpenAI client effectively (pointing to local proxy if configured via env).
    """
    # Check for Mock Mode
    is_mock = os.environ.get("MOCK_MODE") == "true"
    
    # Setup Client
    api_key = os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL")
    model_name = os.environ.get("OPENAI_MODEL", "gpt-4o")

    if not api_key:
        if not is_mock:
            logger.warning("OPENAI_API_KEY not found. Defaulting to Mock Mode.")
            is_mock = True
        api_key = "mock-key"

    # Paths
    base_dir = Path(__file__).parent.parent
    prompts_dir = base_dir / "prompts"
    resources_dir = base_dir / "resources"
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Load inputs
    logger.info("Loading inputs...")
    theme_css = load_file(theme_css_path)
    
    brief_content = "Not provided"
    draft_content = "Not provided"
    
    # Load Context if available
    # Load Context if available
    if brief_path and os.path.exists(brief_path):
        brief_content = load_file(brief_path)
    if content_path and os.path.exists(content_path):
        draft_content = load_file(content_path)

    # Context Condensation (Token Optimization)
    if brief_content or draft_content:
        logger.info("Condensing context to save tokens...")
        brief_content, draft_content = condense_context(brief_content, draft_content)
    else:
        brief_content = "Not provided"
        draft_content = "Not provided"

    # Determine language for prompt
    system_prompt_path = prompts_dir / "component_generator.md"
    if not system_prompt_path.exists():
         system_prompt_path = prompts_dir / "component_generator.cn.md"
    
    system_prompt_template = load_file(system_prompt_path)
    
    attempts = [
        {"name": "Full Context", "lite": False},
        {"name": "Lite Context (Retry)", "lite": True}
    ]

    generated_html = ""
    
    for attempt in attempts:
        logger.info(f"Generating Components: Attempting {attempt['name']}...")
        
        # Prepare Context
        current_theme_css = theme_css
        current_brief = brief_content
        current_draft = draft_content
        
        if attempt["lite"]:
             logger.info(">> Switching to Lite Mode: Stripping CSS comments and simplifying Brief.")
             current_theme_css = strip_css_comments(theme_css)
             # Re-condense brief/draft with lite logic if possible, or just use what we have? 
             # We need to reload originals to re-condense essentially, but we passed strings.
             # Ideally we should parse them.
             # For simplicity, let's just strip CSS which is big, and maybe truncate prompt?
             # Let's use the helper if we can. 
             # Since brief_content is already JSON string from condense_context (wait, no, it's loaded from file OR condensed).
             # Let's check logic above.
             # load_file returns string. condense_context returns JSON string.
             # So `brief_content` effectively holds a JSON string now.
             current_brief, current_draft = condense_context_lite(brief_content, draft_content)
        
        user_message_attempt = f"""
# Context Inputs
**Design Brief (Intent)**:
```json
{current_brief}
```

**Content Draft (Requirements)**:
```json
{current_draft}
```

**Visual DNA (The Style)**:
```css
{current_theme_css}
```

# Task
Analyze the Brief and Draft to determine exactly which components are needed (Demand Analysis).
Then, using the Visual DNA, generate the specific HTML Component Matrix requested.
"""
        try:
            from openai import OpenAI
            client = OpenAI(api_key=api_key, base_url=base_url)
            
            response = client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt_template},
                    {"role": "user", "content": user_message_attempt}
                ],
                temperature=0.7,
                stream=True,  # Enable streaming
                timeout=180.0
            )
            
            # Collect the stream with intelligent buffering
            logger.info("Stream started... generating components real-time.")
            
            generated_html = ""
            buffer = ""
            current_component_name = None
            
            for chunk in response:
                if chunk.choices[0].delta.content is not None:
                     content_chunk = chunk.choices[0].delta.content
                     generated_html += content_chunk
                     buffer += content_chunk

                     # Logic to detect Component Start
                     if 'data-name="' in buffer and not current_component_name:
                         try:
                             # Extract name roughly
                             part = buffer.split('data-name="')[-1]
                             if '"' in part:
                                 current_component_name = part.split('"')[0]
                                 logger.info(f"⚪️ Started generating: [{current_component_name}]...")
                                 # Reset buffer partly to keep memory low? 
                                 # No, we need full buffer for context, but we can clear detected flag logic
                         except: pass

                     # Logic to detect Component End (approximate by closing div of wrapper)
                     # This is tricky in stream. We assume formatting <div ...> ... </div>
                     # A safer heuristic for "Progress" is just checking for "</div>" followed by newline or new section
                     
                     if current_component_name and "</div>" in buffer:
                          # Check if it looks like the wrapper closed. 
                          # Simplistic check: If we see a closing div and then a newline, we assume success for logging
                          if buffer.strip().endswith("</div>"):
                               logger.info(f"✅ Completed: [{current_component_name}]")
                               current_component_name = None
                               buffer = "" # Clear buffer to be ready for next logic detection

            sys.stdout.write("\n") # Newline after stream ends
            if generated_html:
                break # Success
        except ImportError:
            logger.error("openai module not installed.")
            return False
        except Exception as e:
            logger.error(f"Error during generation ({attempt['name']}): {e}")
            if attempt["lite"]:
                # If even lite fails, we fail.
                logger.error("All generation attempts failed.")
                return False
            else:
                 logger.info("Retrying with lighter context...")

    if not generated_html:
        return False

    # Simple cleanup if the model output markdown code blocks
    if "```html" in generated_html:
        generated_html = generated_html.split("```html")[1].split("```")[0].strip()
    elif "```" in generated_html:
        generated_html = generated_html.split("```")[1].split("```")[0].strip()

    logger.info(f"Generated HTML length: {len(generated_html)} chars")
    
    # Inject into Templates
    # 1. Machine Template
    machine_template_path = resources_dir / "components_template.html"
    if not machine_template_path.exists():
        logger.error(f"Template not found: {machine_template_path}")
        return False

    machine_template = load_file(machine_template_path)
    machine_output_content = machine_template.replace("{{ components_html }}", generated_html)
    save_file(output_dir / "components.html", machine_output_content)
    
    # 2. Preview Template (Human UI)
    preview_template_path = resources_dir / "preview_template.html"
    if preview_template_path.exists():
        preview_template = load_file(preview_template_path)
        
        # Inline CSS for robust previewing via API
        # Scoping: Replace 'html, body' with '.slide-canvas' so the theme 
        # defines the canvas dimensions/styles, not the whole preview app.
        import re
        # 1. Replace group selectors "html, body" or "body, html" with ".slide-canvas"
        preview_css = re.sub(r'(html\s*,\s*body|body\s*,\s*html)', '.slide-canvas', theme_css)
        # 2. Replace standalone "html {" or "body {" with ".slide-canvas {"
        preview_css = re.sub(r'(^|\})\s*html\s*\{', r'\1 .slide-canvas {', preview_css)
        preview_css = re.sub(r'(^|\})\s*body\s*\{', r'\1 .slide-canvas {', preview_css)
        
        # Override strict slide dimensions so the preview canvas can expand
        # The revised template now handles layout, so we just need the scoped theme vars.
        css_style_block = f"<style>\n{preview_css}\n</style>"
        
        # Replace the placeholder or inject into head
        if '{{ style_block }}' in preview_template:
            preview_output_content = preview_template.replace('{{ style_block }}', css_style_block)
        elif '<link rel="stylesheet" href="theme.css">' in preview_template:
            preview_output_content = preview_template.replace('<link rel="stylesheet" href="theme.css">', css_style_block)
        else:
             # Fallback injection before </head>
            preview_output_content = preview_template.replace('</head>', f'{css_style_block}\n</head>')
        
        preview_output_content = preview_output_content.replace("{{ components_html }}", generated_html)
        save_file(output_dir / "components_preview.html", preview_output_content)
        print(f"Generated: components_preview.html")
    else:
        logger.warning(f"Preview template not found at {preview_template_path}, skipping preview generation.")
    
    return True


if __name__ == "__main__":
    # Usage: python generate_components.py <path_to_theme.css> <output_dir> [--brief <path>] [--content <path>] [--mock]
    if len(sys.argv) < 3:
        print("Usage: python generate_components.py <path_to_theme.css> <output_dir> ...")
        sys.exit(1)
        
    theme_path = sys.argv[1]
    out_dir = sys.argv[2]
    
    content_path = None
    if "--content" in sys.argv:
        try:
            c_idx = sys.argv.index("--content")
            content_path = sys.argv[c_idx + 1]
        except IndexError: pass
            
    brief_path = None
    if "--brief" in sys.argv:
        try:
            b_idx = sys.argv.index("--brief")
            brief_path = sys.argv[b_idx + 1]
        except IndexError: pass

    if "--mock" in sys.argv:
        os.environ["MOCK_MODE"] = "true"
    
    # Pass all inputs
    # Note: We need to reimplement the function call because we changed the signature above inside the function definition
    # actually I will just update the function definition line and the call site here.
    
    # Wait, replace_file_content replaces a block. The definition is way up. 
    # I should do two replaces. One for def, one for main. 
    # This block is trying to do too much. Let me split.
    pass

    success = generate_components(theme_path, out_dir, brief_path, content_path)
    if success:
        print("Components generated successfully.")
        sys.exit(0)
    else:
        print("Failed to generate components.")
        sys.exit(1)

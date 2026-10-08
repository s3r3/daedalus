
import os
import sys
import json
import argparse
import re
import shutil
from pathlib import Path
from typing import Optional

# --- Configuration ---
MAX_RETRIES = 2
DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gemini-2.0-flash-exp")
PROMPT_FILE = "layout_architect_system.md"

# --- Mock Layouts (Fallback) ---
MOCK_LAYOUT_SWISS = """
<div class="ppt-master-layout">
    <div class="ppt-header-slot">
        <h1 class="ppt-title" style="font-size: 3rem; line-height: 1.1;">{{ title }}</h1>
        <p class="ppt-subtitle" style="margin-top: 0.5rem; opacity: 0.8;">{{ subtitle }}</p>
    </div>
    <div class="ppt-content-slot">
        <div class="layout-grid-12" style="height: 100%; width: 100%; display: grid; grid-template-columns: repeat(12, 1fr); gap: 2rem;">
            <div style="grid-column: span 7; position: relative;">
                <div class="ppt-card" style="height: 100%; width: 100%; display: flex; align-items: center; justify-content: center; background: var(--ppt-color-bg-surface);">
                     <span class="ppt-text-hero" style="font-size: 8rem; opacity: 0.1;">01</span>
                </div>
            </div>
        </div>
    </div>
    <div class="ppt-footer-slot">
        <span class="ppt-text-secondary">Confidental</span>
    </div>
</div>
"""

MOCK_LAYOUT_CYBERPUNK = """
<div class="ppt-master-layout">
    <div class="ppt-header-slot">
        <h1 class="ppt-title glitch-text" style="font-size: 3rem; text-shadow: 0 0 10px var(--ppt-color-accent);">{{ title }}</h1>
    </div>
    <div class="ppt-content-slot">
        <div class="layout-hero-cyber" style="height: 100%; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;">
            <!-- Overlay -->
            <div class="ppt-overlay-glitch" style="position: absolute; top:0; left:0; width:100%; height:100%; background: linear-gradient(45deg, transparent 40%, rgba(0,255,255,0.1) 100%);"></div>
            
            <div class="ppt-content-center" style="z-index: 2; text-align: center; border: 1px solid var(--ppt-color-accent); padding: 4rem; background: rgba(0,0,0,0.6); backdrop-filter: blur(10px);">
                <p class="ppt-subtitle" style="margin-top: 1rem; color: var(--ppt-color-secondary); letter-spacing: 0.2em;">{{ subtitle }}</p>
            </div>
        </div>
    </div>
    <div class="ppt-footer-slot">
        <span>CYBER // 2077</span>
    </div>
</div>
"""

def generate_list_layout(slide_data: dict) -> str:
    """Generate a list-based layout for Agenda/multi-item slides."""
    title = slide_data.get('title', 'Agenda')
    items = slide_data.get('items', [])
    
    items_html = ""
    for i, item in enumerate(items, 1):
        items_html += f'''
        <div class="ppt-list-item" style="padding: 1.5rem 2rem; margin-bottom: 1rem; background: var(--ppt-color-bg-surface); border-left: 4px solid var(--ppt-color-accent); border-radius: var(--ppt-radius-card);">
            <span style="font-weight: 700; color: var(--ppt-color-accent); margin-right: 1rem;">{i:02d}</span>
            <span class="ppt-text-body" style="font-size: 1.5rem;">{item}</span>
        </div>'''
    
    return f'''
<div class="ppt-master-layout">
    <div class="ppt-header-slot">
        <h1 class="ppt-title" style="font-size: 3rem; margin-bottom: 0;">{title}</h1>
    </div>
    <div class="ppt-content-slot">
        <div class="layout-grid-12" style="width: 100%; height: 100%; display: grid; grid-template-columns: repeat(12, 1fr); gap: 2rem;">
            <div style="grid-column: span 10; grid-column-start: 2;">
                {items_html}
            </div>
        </div>
    </div>
    <div class="ppt-footer-slot">
        <span class="ppt-text-secondary">Agenda</span>
    </div>
</div>'''

def generate_grid_layout(slide_data: dict) -> str:
    """Generate a 2x2 grid layout for 4-item displays."""
    title = slide_data.get('title', 'Grid')
    items = slide_data.get('items', [])
    
    cards_html = ""
    for item in items[:4]:  # Max 4 items
        cards_html += f'''
        <div class="ppt-card" style="padding: 2rem; text-align: center; background: var(--ppt-color-bg-surface); border-radius: var(--ppt-radius-card); box-shadow: var(--ppt-shadow-card);">
            <h3 class="ppt-text-body" style="font-size: 1.25rem; font-weight: 700;">{item}</h3>
        </div>'''
    
    return f'''
<div class="ppt-master-layout">
    <div class="ppt-header-slot">
        <h1 class="ppt-title" style="font-size: 3rem; margin-bottom: 0;">{title}</h1>
    </div>
    <div class="ppt-content-slot">
        <div class="layout-grid-12" style="width: 100%; height: 100%; display: grid; grid-template-columns: repeat(12, 1fr); gap: 2rem;">
            <div style="grid-column: span 10; grid-column-start: 2; display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
                {cards_html}
            </div>
        </div>
    </div>
    <div class="ppt-footer-slot">
        <span class="ppt-text-secondary">Grid View</span>
    </div>
</div>'''

def call_llm_layout(system_prompt: str, user_prompt: str, slide_data: dict = None) -> str:
    """
    Simulates or Calls LLM to generate HTML structure.
    Now accepts slide_data to generate content-aware layouts.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    
    if not api_key:
        print(">> [Layout Architect] No OPENAI_API_KEY. Using MOCK response.")
        # Intelligent mock selection based on slide content
        slide_type = slide_data.get('type', 'content') if slide_data else 'content'
        slide_items = slide_data.get('items', []) if slide_data else []
        
        # Generate appropriate layout template
        if slide_type == 'agenda' or (slide_type == 'content' and len(slide_items) > 2):
            # List layout for agenda/multi-item content
            return generate_list_layout(slide_data)
        elif slide_type == 'grid' or len(slide_items) == 4:
            # Grid layout for 4-item displays
            return generate_grid_layout(slide_data)
        elif "Cyberpunk" in user_prompt or "Future" in user_prompt or "Neon" in user_prompt:
            return MOCK_LAYOUT_CYBERPUNK
        else:
            return MOCK_LAYOUT_SWISS

    # Actual API Call
    try:
        from openai import OpenAI
        base_url = os.environ.get("OPENAI_BASE_URL")
        client = OpenAI(api_key=api_key, base_url=base_url)
        
        model = os.environ.get("OPENAI_MODEL", DEFAULT_MODEL)
        print(f">> [Layout Architect] Calling LLM for Layout...")
        print(f"   Model: {model}, Base: {base_url or 'Default'}")
        
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.7,
            timeout=120.0
        )
        return response.choices[0].message.content
    except Exception as e:
        print(f"!! [Layout Architect] Error: {e}")
        return MOCK_LAYOUT_SWISS # Fallback

def strip_code_blocks(content: str) -> str:
    """Removes markdown code blocks to get raw HTML."""
    content = re.sub(r"```html", "", content)
    content = re.sub(r"```", "", content)
    return content.strip()


def _iter_image_reference_candidates(item: dict) -> list[str]:
    candidates = []

    for key in ("image_asset_path", "image_file_name"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            candidates.append(value.strip())

    desc = item.get("image_description", "")
    if isinstance(desc, str) and desc.strip():
        absolute_matches = re.findall(
            r'((?:/[^\s`"\']+|[A-Za-z]:\\[^\s`"\']+)\.(?:png|jpg|jpeg|webp|gif))',
            desc,
            flags=re.IGNORECASE,
        )
        file_matches = re.findall(
            r'([A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|jpeg|webp|gif))',
            desc,
            flags=re.IGNORECASE,
        )
        candidates.extend(absolute_matches)
        candidates.extend(file_matches)

    return candidates


def _resolve_image_reference(reference: str, content_path: Optional[str]) -> Optional[str]:
    ref = reference.strip().strip('"').strip("'")
    if not ref:
        return None

    path_candidate = Path(ref)
    if path_candidate.is_absolute() and path_candidate.exists():
        return str(path_candidate)

    project_input_dir = Path(content_path).resolve().parent if content_path else None
    project_root = project_input_dir.parent if project_input_dir else None
    candidate_paths = []

    if project_input_dir:
        candidate_paths.append(project_input_dir / ref)
        candidate_paths.append(project_input_dir / "images" / Path(ref).name)

    if project_root:
        candidate_paths.append(project_root / ref)

    for candidate in candidate_paths:
        if candidate.exists():
            return str(candidate)

    return None


def extract_local_image_paths(slide: dict, content_path: Optional[str] = None) -> list[str]:
    """
    Extract resolvable local image paths from visual items.
    """
    paths = []
    for item in slide.get("content_items", []):
        if item.get("item_type") != "visual":
            continue
        for reference in _iter_image_reference_candidates(item):
            resolved = _resolve_image_reference(reference, content_path)
            if resolved and resolved not in paths:
                paths.append(resolved)
    return paths


def copy_local_images(local_paths: list[str], slide_id: str, output_dir: Path) -> list[str]:
    """
    Copy local images into the run's images directory and return relative paths.
    """
    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    copied_paths = []
    for idx, src in enumerate(local_paths, 1):
        ext = Path(src).suffix.lower() or ".png"
        dest_name = f"{slide_id}_local_{idx:02d}{ext}"
        dest_path = images_dir / dest_name
        shutil.copyfile(src, dest_path)
        copied_paths.append(f"images/{dest_name}")

    return copied_paths


def replace_img_srcs_in_order(html_content: str, image_paths: list[str]) -> str:
    """
    Replace <img ... src="..."> targets in document order with provided paths.
    """
    if not image_paths:
        return html_content

    counter = {"i": 0}

    def replacer(match):
        if counter["i"] >= len(image_paths):
            return match.group(0)
        new_src = image_paths[counter["i"]]
        counter["i"] += 1
        return f'{match.group(1)}{new_src}{match.group(2)}'

    pattern = r'(<img[^>]*\ssrc=")[^"]+(")'
    return re.sub(pattern, replacer, html_content)

# ========== VECTOR ASSET MANAGEMENT ==========

def load_vector_manager():
    """Load vector asset manager"""
    sys.path.insert(0, str(Path(__file__).parent.parent.parent / "generate_assets" / "scripts"))
    try:
        from vector_manager import VectorAssetManager
        return VectorAssetManager()
    except ImportError as e:
        print(f"!! Warning: vector_manager not found ({e}). Vector assets disabled.")
        return None

def prepare_vector_context() -> dict:
    """
    Prepare vector asset context for Layout Architect.
    Returns a dictionary of available vectors for the LLM to reference.
    """
    manager = load_vector_manager()
    if not manager:
        return {}
    
    # Get all available vectors
    all_vectors = manager.list_all()
    
    # Group by category for easier reference
    context = {
        "available_icons": [],
        "available_patterns": [],
        "usage_examples": []
    }
    
    for item in all_vectors:
        if item['category'] == 'icons':
            context['available_icons'].append({
                "id": item['id'],
                "name": item['name'],
                "tags": item['tags']
            })
        elif item['category'] == 'patterns':
            context['available_patterns'].append({
                "id": item['id'],
                "name": item['name']
            })
    
    # Add usage examples
    context['usage_examples'] = [
        "Use: <!--VECTOR:chart-line--> for inline SVG insertion",
        "Manager will replace with actual SVG code"
    ]
    
    return context

def replace_vector_placeholders(html_content: str) -> str:
    """
    Replace <!--VECTOR:asset_id--> with actual SVG code.
    Example: <!--VECTOR:chart-line--> becomes <svg>...</svg>
    """
    manager = load_vector_manager()
    if not manager:
        return html_content
    
    # Pattern: <!--VECTOR:asset_id[:color[:opacity]]--> 
    # Example: <!--VECTOR:chart-line:var(--ppt-color-accent):0.8-->
    pattern = r'<!--VECTOR:([\w-]+)(?::([^:>]+))?(?::([\d.]+))?-->'
    
    def replacer(match):
        asset_id = match.group(1)
        color = match.group(2) or "currentColor"
        opacity = float(match.group(3)) if match.group(3) else 1.0
        
        svg = manager.get_svg_with_color(asset_id, color, opacity)
        if svg:
            return svg
        else:
            print(f"   !! Vector asset '{asset_id}' not found")
            return f"<!-- Vector '{asset_id}' not found -->"
    
    return re.sub(pattern, replacer, html_content)

def render_jinja(template_str: str, context: dict) -> str:
    """Quick jinja render."""
    try:
        from jinja2 import Template
        t = Template(template_str)
        return t.render(**context)
    except ImportError:
        print("!! jinja2 not installed. Doing simple string replacement.")
        # Fallback for simple testing
        s = template_str
        for k, v in context.items():
            if isinstance(v, str):
                s = s.replace(f"{{{{ {k} }}}}", v) # Replace {{ key }}
        return s

def process_brief(brief_path: str, output_dir: str, dna_dir: str, content_path: str = None, components_path: str = None, from_log_dir: str = None, slides_filter: str = None):
    """
    Main loop:
    1. Load Brief.
    2. Load Content Draft (Optional, for merging/fidelity).
    3. Load System Prompt.
    4. Iterate Slides -> Generate HTML.
    5. Assemble with Master Template.
    """
    
    # 1. Load Resources
    with open(brief_path, 'r') as f:
        brief_data = json.load(f)
        
    # Load Content Draft if provided
    draft_slides = []
    if content_path and os.path.exists(content_path):
        print(f">> [Layout Architect] Merging content from: {content_path}")
        with open(content_path, 'r') as f:
            draft_data = json.load(f)
            draft_slides = draft_data.get("slides", [])
    
    prompt_path = Path(__file__).parent.parent / "prompts" / PROMPT_FILE
    with open(prompt_path, 'r') as f:
        system_prompt = f.read()

    # Parse slides filter if present
    target_slide_ids = None
    if slides_filter:
        try:
            target_slide_ids = set(str(s).strip() for s in slides_filter.split(','))
            print(f">> [Layout Architect] Filtering for slides: {target_slide_ids}")
        except Exception as e:
            print(f"!! Error parsing slides filter: {e}")

    # Load Master HTML Template (Assumed to be passed or found)
    # We will look in my_skills/define_visual_dna/resources/master_template.html based on structure
    master_path = Path(__file__).parent.parent.parent / "define_visual_dna" / "resources" / "master_template.html"
    if not master_path.exists():
        print(f"!! Master template not found at {master_path}. Using fallback wrapper.")
        master_template = """
        <!DOCTYPE html>
        <html>
        <head>
            <style>{{ theme_css }}</style>
        </head>
        <body>
            <div class="slide-master">
                <div class="ppt-content-area">
                    {{ slide_content }}
                </div>
            </div>
        </body>
        </html>
        """
    else:
        with open(master_path, 'r') as f:
            master_template = f.read()

    # Load Components Library
    # Try to find components.html in components_path arg or same dir as dna
    components_content = "<!-- No Components Library Found -->"
    if components_path:
        cp = Path(components_path)
        if cp.exists():
            with open(cp, 'r') as f:
                components_content = f.read()
        else:
            print(f"!! Components file not found at {components_path}")
    
    # Load CSS
    # Try to find a theme.css in dna_dir or output
    css_path = Path(dna_dir) / "theme.css"
    # Logic to find latest if not exact name? For now assume user passes correct dir.
    if not css_path.exists():
         # Try common output location
         css_path = Path(output_dir) / "theme.css" 
    
    if css_path.exists():
        with open(css_path, 'r') as f:
            css_content = f.read()
    else:
        css_content = "/* No Theme CSS Found */ body { background: red; }"

    # Ensure output dir
    os.makedirs(output_dir, exist_ok=True)
    
    # Load System Prompt
    # (Already loaded above)

    # 4. Iterate Slides
    brief_slides = brief_data.get('structure', [])
    if not brief_slides:
        # Fallback if structure is missing or named differently
        brief_slides = brief_data.get('presentation_flow', [])
        if not brief_slides:
             brief_slides = brief_data.get('required_layouts', [])
        
    # 3. Processing Loop & Merge
    # In Side-Car Architecture, the Brief dictates the flow (required_layouts).
    # We must merge Draft content into Brief slides using 'slide_id'.
    
    # Create a lookup map for Draft content
    draft_map = { str(s.get("id")): s for s in draft_slides }
    print(f"   [Debug] Draft IDs found: {list(draft_map.keys())}")
    
    # Debug Brief IDs
    brief_ids = [str(s.get("slide_id")) for s in brief_slides]
    print(f"   [Debug] Brief IDs found: {brief_ids}")

    # Extract Style Context
    style_def = brief_data.get("style_definition", {})
    ds_spec = brief_data.get("design_system_spec", {})
    style_def = brief_data.get("style_definition", {})
    ds_spec = brief_data.get("design_system_spec", {})
    
    # Enhanced Style Context
    project_style = f"Keywords: {style_def.get('mood_keywords', [])}\n"
    project_style += f"Art Direction: {ds_spec.get('artistic_style', {}).get('instruction_en', '')}\n"
    project_style += f"Grid Intent: {ds_spec.get('grid_system', {}).get('instruction_en', '')}\n"
    project_style += f"Decor Intent: {ds_spec.get('decorations', {}).get('instruction_en', '')}"

    print(f"== Starting Layout Architecture for '{brief_data.get('project_name')}' ==")
    print(f"Style Context: {project_style}")
    print(f"Found {len(brief_slides)} layouts in Brief, {len(draft_slides)} content slides in Draft.")

    html_indices = []

    for i, slide in enumerate(brief_slides):
        slide_id = str(slide.get("slide_id", i+1))
        
        # FILTER CHECK
        if target_slide_ids and slide_id not in target_slide_ids:
            # print(f"Skipping Slide {slide_id} (not in filter)...")
            continue

        print(f"Processing Slide {i+1}: {slide.get('title', 'Untitled')}")
        
        # MERGE LOGIC: Side-Car
        draft_content = None
        if slide_id and slide_id in draft_map:
            print(f"   [Merge] Exact ID match for '{slide_id}'")
            draft_content = draft_map[slide_id]
        
        # 2. Try Index Match (Fallback) if ID fails but counts match roughly
        elif i < len(draft_slides):
             print(f"   [Merge] Fallback to Index Match for Slide {i+1} (ID mismatch: '{slide_id}' vs '{draft_slides[i].get('id')}')")
             draft_content = draft_slides[i]

        if draft_content:
            # 1. Merge Text Fields (Title/Subtitle)
            slide['title'] = draft_content.get('title', slide.get('title', 'Untitled'))
            slide['subtitle'] = draft_content.get('subtitle', slide.get('subtitle', ''))
            
            # 2. Merge Semantic Items (The Core)
            slide['content_items'] = draft_content.get('content_items', [])
            
        else:
            print(f"   !! [Warning] No matching Draft content found for slide_id='{slide_id}'")

        slide_type = slide.get("type", "content")
        slide_title = slide.get("title", "Untitled")
        print(f"-- Processing Slide {i+1}: {slide_title} ({slide_type}) --")

        # Extract available CSS classes to guide the LLM
        available_classes = set(re.findall(r'\.([a-zA-Z0-9-_]+)', css_content))
        # Filter out common utility pseudos or irrelevant matches if needed (simple set is fine for now)
        class_list_str = ", ".join([f".{c}" for c in sorted(available_classes) if "ppt-" in c or "layout-" in c])

        # Prepare Prompt
        user_prompt = f"""
        **Style Context**: {project_style}
        **Available CSS Classes (Visual DNA)**: {class_list_str}
        
        **Components Library (The Bricks you MUST use)**:
        ```html
        {components_content}
        ```

        **Slide Type**: {slide_type}
        **Content JSON**:
        {json.dumps(slide, indent=2, ensure_ascii=False)}
        
        IMPORTANT IMAGE RULES:
        - Do NOT use Pixabay.
        - Do NOT use AI image generation.
        - Only use uploaded local project images already referenced in the Content JSON by file name, asset path, or explicit local path.
        - If the Content JSON does not provide a resolvable local image reference, do not create an <img> tag and do not emit IMAGE_REQUEST.

        Generate the HTML structure for this slide using the components above.
        """

        # --- DEBUG: Log Prompts & Response ---
        debug_dir = Path(output_dir) / "debug_logs"
        os.makedirs(debug_dir, exist_ok=True)
        
        with open(debug_dir / f"slide_{i+1:02d}_prompt_system.txt", "w") as f_sys:
            f_sys.write(system_prompt)
            
        with open(debug_dir / f"slide_{i+1:02d}_prompt_user.txt", "w") as f_user:
            f_user.write(user_prompt)

    # Generate Structure
        if from_log_dir:
            # Try to find matching log file
            log_path = Path(from_log_dir) / f"slide_{i+1:02d}_response_raw.txt"
            if log_path.exists():
                print(f"   [Cache] Reading from log: {log_path}")
                with open(log_path, 'r') as f_log:
                    raw_html = f_log.read()
            else:
                print(f"   !! Log not found at {log_path}. Fallback to Mock.")
                raw_html = MOCK_LAYOUT_SWISS
        else:
            raw_html = call_llm_layout(system_prompt, user_prompt, slide)
            
            with open(debug_dir / f"slide_{i+1:02d}_response_raw.txt", "w") as f_log:
                f_log.write(raw_html)
        # -----------------------------------

        clean_html = strip_code_blocks(raw_html)
        
        # --- LOCAL IMAGE BINDING ---
        local_image_paths = extract_local_image_paths(slide, content_path)

        if local_image_paths:
            copied_paths = copy_local_images(local_image_paths, slide_id, Path(output_dir))
            clean_html = replace_img_srcs_in_order(clean_html, copied_paths)
            print(f"   [Image] Bound {len(copied_paths)} local image(s) from content paths.")
        # --------------------------
        
        # --- VECTOR ASSET REPLACEMENT ---
        # Replace <!--VECTOR:asset_id--> with actual SVG
        clean_html = replace_vector_placeholders(clean_html)
        # ------------------------

        # Inject Data (Jinja Rendering - The Agent gave us a Jinja Template essentially, or filled HTML)
        # Actually, if the Agent returns static HTML with content already in it (as per my prompt examples "Wake Up"),
        # we might not need Jinja render AGAIN. 
        # BUT, to be safe, the Agent prompt implies it puts the text in. 
        # Let's assume the Agent returns populated HTML for now.
        
        # Assemble
        # The master template likely expects specific placeholders.
        # Let's verify `master_template.html` placeholders.
        # It likely has {{ theme_css }} which we can't inject via Jinja easily if it's external, 
        # but for single file export we often inline it or link it.
        # The prompt examples show inner content.
        
        # We need to clean up master template to be usable here.
        # Our current `master_template.html` is:
        # <div class="slide-master ..."> ... <!-- Content --> </div>
        # It might NOT be a full HTML doc.
        
        # Render Jinja
        rendered_html = render_jinja(clean_html, slide)

        # Sanitize common Preview artifacts (LLM sometimes adds dark bg for contrast)
        rendered_html = rendered_html.replace('background-color: #333', 'background-color: #FFFFFF')
        rendered_html = rendered_html.replace('background: #333', 'background: #FFFFFF')

        # Check if the content is already a full HTML document
        if "<!DOCTYPE html>" in rendered_html or "<html" in rendered_html:
            full_slide_html = rendered_html
        else:
            # Let's create a full wrapper
            full_slide_html = f"""
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>{slide_title}</title>
                <style>
                    body {{
                        margin: 0;
                        padding: 0;
                        width: 1280px;
                        height: 720px;
                        overflow: hidden;
                        /* Default background if theme missing */
                        background: white; 
                    }}
                    {css_content}
                    
                    /* FORCE OVERRIDE for Resolution Consistency */
                    body {{
                        width: 1280px !important;
                        height: 720px !important;
                    }}
                </style>
            </head>
            <body>
                {rendered_html} 
            </body>
            </html>
            """
        # Note: We are bypassing the strict `master_template.html` for a moment to ensure basic rendering works,
        # or we should wrap `clean_html` inside the `slide-master` div if that's what the CSS expects.
        # Looking at `theme_ver_3.css`, it styles `body` and `.ppt-card`. 
        # The PROMPT tells the agent to produce the inner content.
        
        # Let's save
        filename = f"slide_{i+1:02d}_{slide_type}.html"
        out_path = Path(output_dir) / filename
        with open(out_path, 'w') as f_out:
            f_out.write(full_slide_html)
            
        html_indices.append(filename)
        print(f"   -> Saved to {out_path}")
        print(f"Generated: {filename}")

    # Generate Index from all existing slide HTML files in the output directory,
    # so partial regenerations do not overwrite the full slide listing.
    all_slide_refs = sorted(
        p.name for p in Path(output_dir).glob("slide_*.html")
        if p.is_file()
    )

    index_html = "<h1>Presentation Preview</h1><ul>"
    for ref in all_slide_refs:
        index_html += f'<li><a href="{ref}">{ref}</a></li>'
    index_html += "</ul>"
    with open(Path(output_dir)/"index.html", 'w') as f:
        f.write(index_html)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--brief", help="Path to brief.json", required=True)
    parser.add_argument("--dna_dir", help="Directory containing theme.css", required=True)
    parser.add_argument("--output", help="Output directory", required=True)
    parser.add_argument("--content", help="Path to content_draft.json", required=False)
    parser.add_argument("--components", help="Path to components.html", required=False)
    parser.add_argument("--from-log", help="Path to debug_logs directory to read from", required=False)
    parser.add_argument("--slides", help="Comma-separated list of slide IDs to generate", required=False)
    args = parser.parse_args()
    
    process_brief(args.brief, args.output, args.dna_dir, args.content, args.components, args.from_log, args.slides)


import os
import sys
import json
import csv
import argparse
import time
from typing import List, Dict, Any, Optional

# --- Configuration ---
CSV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "references", "styles.csv")
PROMPT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts", "visual_lead_system.md")
MAX_RETRIES = 3

# --- Mock Data for Fallback ---
MOCK_STYLE_SELECTION = {
    "primary_style_id": "1", # Minimalism
    "secondary_style_ids": ["3"], # Glassmorphism
    "blend_rationale": "Base layout on Swiss Minimalism for clarity, using Glassmorphism cards for the high-tech feature section."
}

# --- Style Retriever ---
class StyleRetriever:
    def __init__(self, csv_path: str):
        self.csv_path = csv_path
        self.styles = self._load_styles()

    def _load_styles(self) -> List[Dict[str, str]]:
        styles = []
        if not os.path.exists(self.csv_path):
            print(f"!! [Visual DNA] Styles CSV not found at {self.csv_path}")
            return []
            
        with open(self.csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                styles.append(row)
        print(f">> [Visual DNA] Loaded {len(styles)} styles from Knowledge Base.")
        return styles

    def get_style_by_id(self, style_id: str) -> Optional[Dict[str, str]]:
        for style in self.styles:
            if style['No'] == str(style_id):
                return style
        return None

    def get_all_styles_summary(self) -> str:
        """Returns a string summary of all styles for the LLM to choose from."""
        summary = "Available Styles:\n"
        for style in self.styles:
            summary += f"- ID {style['No']}: {style['Style Category']} (Best for: {style['Best For']})\n"
        return summary

# --- LLM Client Wrapper ---
def call_llm(system_prompt: str, user_prompt: str, json_mode: bool = False) -> str:
    """
    Calls OpenAI API or returns mock if no key.
    Reuse logic from create_design_brief to verify connectivity.
    """
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print(">> [Visual DNA] No OPENAI_API_KEY. Using MOCK response.")
        if "Visual System Lead" in system_prompt or "theme.css" in system_prompt:
             # --- MOCK CSS LOGIC (Corporate First, then Dark) ---
             # Check BOTH system_prompt and user_prompt for keywords
             combined_prompt = (system_prompt + " " + user_prompt).lower()
             
             # Priority 1: Corporate/Professional/Business → Light Theme
             corporate_keywords = ["corporate", "professional", "business", "clean", "light", "formal", "executive", "quarter", "q1", "q2", "q3", "q4"]
             if any(kw in combined_prompt for kw in corporate_keywords):
                 print(">> [Visual DNA] Detected CORPORATE keywords. Generating Light Theme.")
                 return """:root {
   /* --- 1. Color System (Premium Palette) --- */
   /* Avoiding pure white/black as per guidelines */
   --ppt-color-bg-main: #F8F9FA; 
   --ppt-color-bg-surface: #FFFFFF;
   --ppt-color-primary: #1A1A1A; /* Soft Black */
   --ppt-color-secondary: #4A5568; /* Slate Grey */
   --ppt-color-accent: #007AFF; /* Tech Blue */
   --ppt-color-accent-glow: rgba(0, 122, 255, 0.4);

   /* --- 2. Typography (Swiss Grid) --- */
   --ppt-font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
   --ppt-text-scale-base: 1rem;
   --ppt-text-scale-ratio: 1.25; /* Major Third */
   --ppt-spacing-unit: 8px;
   --ppt-leading-tight: 1.1;
   --ppt-leading-normal: 1.5;
   --ppt-letter-spacing-heading: -0.02em; /* Micro-typography */

   /* --- 3. Atmosphere (Depth & Texture) --- */
   --ppt-gradient-overlay: linear-gradient(135deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0) 100%);
   --ppt-shadow-sm: 0 2px 4px rgba(0,0,0,0.05);
   --ppt-shadow-card: 0 12px 24px -4px rgba(0,0,0,0.08), 0 4px 8px -4px rgba(0,0,0,0.04);
   --ppt-glass-blur: blur(12px);
   --ppt-glass-border: 1px solid rgba(255,255,255,0.6);
   --ppt-radius-card: 16px; /* Modern Soft */
 }

 /* Global Reset */
 body { 
     background-color: var(--ppt-color-bg-main); 
     color: var(--ppt-color-primary); 
     font-family: var(--ppt-font-family);
     line-height: var(--ppt-leading-normal);
 }

 /* Component: Primary Visual Container */
 .ppt-card-primary {
     background: var(--ppt-color-bg-surface);
     border-radius: var(--ppt-radius-card);
     box-shadow: var(--ppt-shadow-card);
     padding: calc(var(--ppt-spacing-unit) * 3);
     border: 1px solid rgba(0,0,0,0.05);
 }

 /* Component: Standard Content Container */
 .ppt-card-standard {
     background: #FFFFFF;
     border-radius: var(--ppt-radius-card);
     box-shadow: var(--ppt-shadow-sm);
     padding: calc(var(--ppt-spacing-unit) * 2);
     color: var(--ppt-color-primary);
 }

 /* Component: Overlay/Floating */
 .ppt-card-overlay {
     background: rgba(255,255,255,0.9);
     backdrop-filter: var(--ppt-glass-blur);
     border: var(--ppt-glass-border);
     border-radius: 8px;
     padding: var(--ppt-spacing-unit);
 }

 /* Typography Details */
 h1, h2, h3 {
     letter-spacing: var(--ppt-letter-spacing-heading);
     line-height: var(--ppt-leading-tight);
     font-weight: 700;
 }
 """
        else:
            # Return JSON for the selection step
            return json.dumps(MOCK_STYLE_SELECTION)

    import time
    for attempt in range(MAX_RETRIES):
        try:
            from openai import OpenAI
            client = OpenAI(
                api_key=api_key,
                base_url=os.environ.get("OPENAI_BASE_URL")
            )
            
            response_format = {"type": "json_object"} if json_mode else {"type": "text"}
            
            print(f">> [Visual DNA] Calling LLM (Attempt {attempt+1})...")
            response = client.chat.completions.create(
                model=os.environ.get("OPENAI_MODEL", "gemini-2.0-flash-exp"),
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format=response_format,
                temperature=0.7,
                timeout=120.0
            )
            return response.choices[0].message.content
        except ImportError:
            print("!! [Visual DNA] 'openai' not installed.")
            return json.dumps(MOCK_STYLE_SELECTION) if json_mode else "/* Mock CSS */"
        except Exception as e:
            print(f"!! [Visual DNA] LLM Error: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(1)
            else:
                 return json.dumps(MOCK_STYLE_SELECTION) if json_mode else "/* Failure Mock CSS */"
    return ""

# --- Style Composer ---
class StyleComposer:
    def __init__(self, retriever: StyleRetriever):
        self.retriever = retriever

    def select_styles(self, brief: Dict[str, Any]) -> Dict[str, Any]:
        """
        Step 1: Ask LLM to select the best styles from the CSV based on the brief.
        """
        styles_list = self.retriever.get_all_styles_summary()
        styles_list = self.retriever.get_all_styles_summary()
        
        # Enhanced Brief Summary
        style_def = brief.get('style_definition', {})
        ds_spec = brief.get('design_system_spec', {})
        
        # Construct detailed context
        context_str = f"Project: {brief.get('project_name')}\n"
        context_str += f"Target Audience: {brief.get('target_audience')}\n"
        context_str += f"Mood Keywords: {style_def.get('mood_keywords')}\n"
        context_str += f"Color Preference: {style_def.get('color_preference')}\n"
        context_str += "Design Specs:\n"
        for k, v in ds_spec.items():
            if isinstance(v, dict) and 'selection' in v:
                context_str += f"- {k}: {v['selection']} ({v.get('instruction_en', '')})\n"

        system_prompt = "You are a Creative Director. Analyze the project brief and the available styles list. Select 1 Primary Style (Base) and 1-2 Secondary Styles (Elements) to blend. Return JSON."
        user_prompt = f"Brief:\n{context_str}\n\n{styles_list}\n\nOutput format:\n{{\n  \"primary_style_id\": \"ID\",\n  \"secondary_style_ids\": [\"ID\"],\n  \"blend_rationale\": \"Reasoning\"\n}}"
        
        if not os.environ.get("OPENAI_API_KEY"):
             print(">> [Visual DNA] No OPENAI_API_KEY. Using Smart Mock Selection.")
             return self._get_mock_selection(brief)
             
        # --- DEBUG: Log Step 1 Prompts ---
        # Assuming output directory structure relative to expected pipeline or current execution
        # We can try to infer from typical usage or just use current dir/debug_logs if strictly needed, 
        # but let's try to stick to pipeline_work structure if possible. 
        # For now, let's use a safe relative path or passed argument? 
        # We don't have output_path in this method signature easily (it's in generate_css args).
        # Let's assume we can write to "pipeline_work/debug_logs" if it exists, or local "debug_logs".
        
        # Better strategy: `generate_dna.py` is called with `output_path`. 
        # But this method `select_styles` doesn't know it. 
        # Let's derive a common debug path relative to CWD which is usually valid in this pipeline.
        debug_dir = os.path.join("pipeline_work", "debug_logs")
        if not os.path.exists(debug_dir):
            os.makedirs(debug_dir, exist_ok=True)

        with open(os.path.join(debug_dir, "dna_step1_prompt_system.txt"), 'w', encoding='utf-8') as f:
            f.write(system_prompt)
        with open(os.path.join(debug_dir, "dna_step1_prompt_user.txt"), 'w', encoding='utf-8') as f:
            f.write(user_prompt)
        # ---------------------------------

        # Enforce JSON mode for the API call
        response = call_llm(system_prompt, user_prompt, json_mode=True)
        
        # --- DEBUG: Log Step 1 Response ---
        with open(os.path.join(debug_dir, "dna_step1_response_raw.txt"), 'w', encoding='utf-8') as f:
            f.write(response)
        # ----------------------------------
        
        # Robust cleanup of potential Markdown formatting
        clean_response = response.strip()
        if "```json" in clean_response:
            clean_response = clean_response.split("```json")[1].split("```")[0].strip()
        elif "```" in clean_response:
            clean_response = clean_response.split("```")[1].split("```")[0].strip()

        try:
            return json.loads(clean_response)
        except json.JSONDecodeError as e:
            print(f"!! [Visual DNA] LLM JSON parsing failed: {e}")
            print(f"   Raw Response: {response[:100]}...")
            return self._get_mock_selection(brief)

    def _get_mock_selection(self, brief: Dict[str, Any]) -> Dict[str, Any]:
        """Returns different mock styles based on brief content."""
        keywords = str(brief).lower()
        
        # Priority 1: Corporate/Business styles (must check BEFORE tech)
        if any(k in keywords for k in ["corporate", "business", "professional", "executive", "quarter", "q1", "q2", "q3", "q4"]):
            return {
                "primary_style_id": "1", # Minimalism/Swiss for clean corporate look
                "secondary_style_ids": ["2"], # Subtle neumorphism for depth
                "blend_rationale": "Clean minimalist base with subtle depth for professional corporate presentation."
            }
        
        # Priority 2: Tech/Cyberpunk styles
        if any(k in keywords for k in ["tech", "future", "cyber", "digital", "neon"]):
            # Tech / Cyberpunk Style -> Using Brutalism (ID 4) for distinct verification
            return {
                "primary_style_id": "8", # Cyberpunk
                "secondary_style_ids": ["3"], # Glassmorphism
                "blend_rationale": "High contrast brutalist base with neon glass accents."
            }
        
        # Priority 3: Medical/Health styles
        elif any(k in keywords for k in ["medical", "health", "trust"]):
            # Medical Clean Style
            return {
                "primary_style_id": "1", # Minimalism
                "secondary_style_ids": ["2"], # Neumorphism for soft feel
                "blend_rationale": "Clean white background with soft neumorphic buttons for trust."
            }
        else:
            # Default
            return MOCK_STYLE_SELECTION

    def generate_css(self, brief: Dict[str, Any], selection: Dict[str, Any], output_path: str):
        """
        Step 2: Construct the dynamic template and generate CSS.
        """
        # Helper to clean ID strings (e.g., "ID 27" -> "27")
        def clean_id(id_val):
            return "".join(filter(str.isdigit, str(id_val)))

        primary_id = clean_id(selection.get("primary_style_id", "1"))
        secondary_ids = [clean_id(sid) for sid in selection.get("secondary_style_ids", [])]
        
        primary_style = self.retriever.get_style_by_id(primary_id)

        if not primary_style:
            print(f"!! [Visual DNA] Primary Style ID {primary_id} not found. Fallback to ID 1.")
            primary_style = self.retriever.get_style_by_id("1")

        # Prepare template variables
        ds_spec = brief.get("design_system_spec", {})
        style_def = brief.get("style_definition", {})

        # Format Design Specs for CSS consumption
        design_spec_text = ""
        if style_def.get("color_preference"):
             design_spec_text += f"* Color Preference: {style_def.get('color_preference')}\n"
        
        for k, v in ds_spec.items():
             if isinstance(v, dict):
                 instruction = v.get('instruction_en', '')
                 if instruction:
                     design_spec_text += f"* {k.replace('_', ' ').title()}: {v.get('selection')} - {instruction}\n"

        project_context = {
            "project_name": brief.get("project_name", "Untitled"),
            "target_audience": brief.get("target_audience", "General"),
            "visual_density": brief.get("style_definition", {}).get("visual_density", "balanced"),
            "primary_style_name": primary_style['Style Category'],
            "primary_keywords": primary_style['CSS/Technical Keywords'],
            "blend_rationale": selection.get("blend_rationale", "Standard blend"),
            "design_spec": design_spec_text, # NEW INJECTION
            "anti_patterns": primary_style.get('Do Not Use For', '') + "\n" + primary_style.get('Rules to Avoid', ''), 
        }

        # Format Secondary Styles
        secondary_formatting = ""
        for i, sid in enumerate(secondary_ids):
            style = self.retriever.get_style_by_id(sid)
            if style:
                secondary_formatting += f"\n    - {style['Style Category']}: {style['CSS/Technical Keywords']} (Best for: {style['Best For']})"
        
        project_context["secondary_styles_formatting"] = secondary_formatting

        # Load Template
        try:
            with open(PROMPT_PATH, 'r', encoding='utf-8') as f:
                template = f.read()
        except FileNotFoundError:
            print("!! [Visual DNA] Template not found.")
            return

        # Simple Jinja-like replacement
        final_prompt = template
        for key, value in project_context.items():
            final_prompt = final_prompt.replace(f"{{{{ {key} }}}}", str(value))
            final_prompt = final_prompt.replace(f"{{{{{key}}}}}", str(value)) # Handle no-space variant
            
        # Fallback for new key if template is not updated immediately to avoid raw placeholder
        # Check if {{ design_spec }} exists in template, if not, append it to blend_rationale or similar to ensure it's seen
        if "{{ design_spec }}" not in template and "{{design_spec}}" not in template:
             # Force inject into Blend Rationale section if template misses the placeholder
             print(">> [Visual DNA] Injecting design_spec manually (Template missing placeholder).")
             injection = f"{{{{ blend_rationale }}}}\n\n    *ADDITIONAL DESIGN SPECS (MUST FOLLOW)*:\n    {project_context['design_spec']}"
             final_prompt = final_prompt.replace("{{ blend_rationale }}", str(project_context['blend_rationale']) + f"\n\n    *ADDITIONAL DESIGN SPECS (MUST FOLLOW)*:\n    {project_context['design_spec']}")

        print(f">> [Visual DNA] Generating CSS for Project: {project_context['project_name']}...")
        print(f"   Mode: {project_context['primary_style_name']} + {[sid for sid in secondary_ids]}")
        
        # --- DEBUG: Log Step 2 Prompt ---
        debug_dir = os.path.dirname(output_path) if os.path.dirname(output_path) else "pipeline_work"
        debug_dir = os.path.join(debug_dir, "debug_logs")
        os.makedirs(debug_dir, exist_ok=True)
        
        with open(os.path.join(debug_dir, "dna_step2_prompt_full.txt"), 'w', encoding='utf-8') as f:
            f.write(final_prompt)
        # --------------------------------

        css_content = call_llm(final_prompt, "Generate the CSS now.", json_mode=False)
        
        # --- DEBUG: Log Step 2 Response ---
        with open(os.path.join(debug_dir, "dna_step2_response_raw.txt"), 'w', encoding='utf-8') as f:
            f.write(css_content)
        # ----------------------------------
        
        # Clean up Markdown blocks if present
        css_content = css_content.replace("```css", "").replace("```", "").strip()

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(css_content)
        print(f">> [Visual DNA] CSS saved to: {output_path}")


# --- Main ---
def main():
    parser = argparse.ArgumentParser(description="Visual DNA Generator")
    parser.add_argument("brief_path", help="Path to input design brief JSON")
    parser.add_argument("output_path", help="Path to output theme.css")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.brief_path):
        print(f"!! [Visual DNA] Brief not found at {args.brief_path}")
        sys.exit(1)

    with open(args.brief_path, 'r', encoding='utf-8') as f:
        brief = json.load(f)

    retriever = StyleRetriever(CSV_PATH)
    composer = StyleComposer(retriever)
    
    # 1. Select Styles
    selection = composer.select_styles(brief)
    
    # 2. Generate CSS
    composer.generate_css(brief, selection, args.output_path)

if __name__ == "__main__":
    main()

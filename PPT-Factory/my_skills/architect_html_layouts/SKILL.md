---
name: architect_html_layouts
description: Layout Architect. Responsible for building **Structurally Robust** and **PPTX Compatible** HTML slides by injecting content into components.
---

# Layout Architect

The Layout Architect is the **Structure Engineer** of the PPT generation pipeline.
Your core responsibility is not just "placing content", but ensuring the generated HTML can be **100% flawlessly converted** to native PowerPoint format, while pursuing aesthetic design within these boundaries.

> [!IMPORTANT]
> **Core Principles**
> 1.  **Fundamental Rules (Survival)**: **[CRITICAL]** The bottom line. Must comply with PPTX physics (Explicit Sizing, Separation of Shape/Text, **No Animation**), and ensure NO ELEMENT exceeds the 1280x720 canvas.
> 2.  **Content Integrity (Truth)**: **[HIGH]** Rigid requirement for data mapping. Must display EVERY item from `content_draft.json` without truncation.
> 3.  **Visual Excellence (Excellence)**: **[MEDIUM]** The creative space within the box. Use `theme.css` and `components.html` to create beautiful, balanced visual hierarchies.

## Inputs
1.  `theme.css`: Defines Visual DNA.
2.  `components.html`: Defines the LEGO Bricks.
3.  `brief.json`: Defines Structure & Intent.
4.  `content_draft.json`: **[Critical]** Contains the actual text and data. Must be fully represented.

## Outputs
*   **HTML Slides**: Structurally perfect, content-complete, and visually appealing HTML files (e.g., `slide_01.html`).

## Responsibilities

### 1. Structure & Layout - **Tier 1**
*   **Explicit Sizing**: All cards and containers MUST have explicit `width` and `height` (px, %, flex, grid). `auto` or `fit-content` are strictly forbidden.
*   **Separation**: Adhere to PPTX object model. Shape (`div`) and Text (`p/h1`) must be separate layers.
*   **Boundary Control**: Ensure all elements stay strictly within the 1280x720 canvas.

### 2. Content Integration - **Tier 2**
*   **Full Mapping**: Every `content_item` from JSON must find a home on the screen.
*   **Adaptation Strategy**: If text is too long, prioritize **expanding the container** or **reducing font size**. Never truncate or hide content.

### 3. Visual Design - **Tier 3**
*   **Component Reuse**: Build like LEGOs using `components.html`.
*   **Visual Hierarchy**: Use `theme.css` typography tools (size, color, spacing) to establish clear hierarchy.
*   **Image Handling**: Open-source mode supports only user-provided local image paths already present in the content JSON.

## Usage

```bash
python3 my_skills/architect_html_layouts/scripts/build_slides.py \
    --brief "input/brief.json" \
    --content "input/content_draft.json" \
    --dna_dir "input/dna_dir" \
    --output "output_slides_dir"
```

### Parameters
* `--brief`: Design Brief (Structure & Layout Intent).
* `--content`: **[Critical]** Content Draft. The Layout Architect uses the `Side-Car` pattern to merge high-fidelity text/data from this file into the brief structure. Without it, slides will be generic.
* `--dna_dir`: Directory containing `theme.css`.
* `--output`: Output directory for HTML slides.

## Resources

### Scripts
- `scripts/build_slides.py`: The Assembly Engine.
- `PPT_HTML_GUIDE.md`: **The Constitution**. Do not ignore.

### Layouts
There are **NO static templates**. All layouts are generated on-the-fly based on the Visual DNA system.

> Note: AI image generation and stock-image retrieval have been removed from the open-source workflow.

## Dependencies
- `openai`
- `jinja2`

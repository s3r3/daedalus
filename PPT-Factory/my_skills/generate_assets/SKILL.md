---
name: generate_assets
description: HTML Constructor Agent. Generates a comprehensive HTML Component Matrix (The PPT Arsenal) based on the Visual DNA theme, providing atomic building blocks for the Layout Architect.
---

# Generate Assets (HTML Constructor)

This skill acts as the "HTML Constructor".
Its mission is to bridge the gap between **Visual Design (CSS)** and **Page Layout**. It does not layout specific slides but manufactures a comprehensive **"PPT Arsenal" (Component Matrix)**, ensuring the Layout Architect has sufficient, strictly compliant building blocks.

## Core Inputs
1.  **Visual DNA (`theme.css`)**: (Required) Visual style source.
2.  **Design Brief**: (Required) To understand specific design intents (e.g., bespoke timeline or highlighted cards).
3.  **Content Draft**: (Required) To scan for specific content types (e.g., data charts, team lists).

## Core Outputs
1.  **`components.html` (The PPT Arsenal)**:
    An HTML file containing dozens of pre-fabricated components, strictly categorized into:
    *   **Containers**: Primary Cards, Standard Cards, Overlays, Grid Items.
    *   **Typography**: Headings, Body, Big Numbers, Quotes.
    *   **Decorators**: Dividers, Badges, Markers.
    *   **Logic Visualizations**: Templates for Process Flows, Pyramids, Matrices.
    *   **Evidence**: Device mockups, Gallery structures.

## Key Responsibilities
*   **Structure Validity**: Ensure HTML structure strictly complies with the `html2pptx` conversion engine (e.g., using `div` for shapes, avoiding unsupported complex SVGs).
*   **Class Mapping**: Correctly apply the Functional Classes defined in `theme.css` (`.ppt-card-primary`, `.ppt-text-emphasis`).
*   **Viewport Consistency**: Ensure all components render correctly within the standard 1280x720 (16:9) viewport.

## Usage

```bash
python3 my_skills/generate_assets/scripts/generate_components.py <theme_css_path> <output_html_path> --brief <brief_path> --content <draft_path>
```

### Parameters
* `theme_css_path`: Primary input, Visual DNA.
* `output_html_path`: Output directory.
* `--brief`: Contextual input for bespoke component demand.
* `--content`: Contextual input for content type scanning.

> **Note**: The open-source workflow does not include photo/illustration generation or stock-image retrieval. This skill focuses on HTML components and local/static assets only.

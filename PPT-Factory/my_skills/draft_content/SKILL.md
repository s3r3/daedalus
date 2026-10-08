---
name: draft_content
description: Transforms a user's topic request into a structured, semantically rich semantic content draft.
---

# Draft Content (Semantic)

The Content Editor Agent acts as an **Information Architect**. It defines the **Nature** of the content (Data, Text, Visual) rather than just writing paragraphs or picking UI components.

## Core Principles

1.  **Semantic Integrity**: No fragmenting of coherent sentences into trivial word-level fields. Content must maintain full semantic meaning.
2.  **Visual Balance**: Content items within a single slide should be balanced in length and complexity to avoid lopsided visuals.
3.  **Rich Structure**: Encourages nested structures (`sub_items`) to accurately reflect logical depth.

## Usage

```bash
python3 my_skills/draft_content/scripts/draft_content.py "2024 Product Roadmap" "output/semantic_draft.json"
```

## Output Features

The `content_draft.json` uses a **Semantic Item** model:

### 1. Content Items (`content_items`)
Instead of generic blocks, items are typed:
*   **`statistic`**: For recognizable data. Includes `data_payload` ({ value, trend }).
*   **`text`**: Narrative content. Uses `body` for visible text.
*   **`visual`**: Uploaded local image intent. Must use `image_file_name` to point to an existing project image, should preserve image metadata (`image_width`, `image_height`, `image_aspect_ratio`, `image_orientation`) when available, and may use `image_description` for placement notes.
*   **`chart`**: Data visualization. Uses `data_payload` for data, `image_description` for style description.
*   **`sub_items`**: Recursive array for nested content hierarchies (sections, subsections).
*   **`content_role`**: Shared layout role across all item types (`primary`, `supporting`, `branding`, `evidence`, `atmosphere`, `navigation`) so layout logic stays consistent beyond images alone.

### 2. Anchored Visual Cues (`visual_cues`)
Visual directives are attached directly to the content they modify.
*   `status`: "critical", "positive" (e.g. for RAG status).
*   `badge`: "New", "Beta" (for labeling).

### 3. Page Structure
*   `suggested_layout`: General pattern (Timeline, Grid).
*   `conceptual_metaphor`: High-level page metaphor (Funnel, Iceberg).

## Resources
- `scripts/draft_content.py`: Execution script.
- `prompts/editor_system.md`: System prompt (English).
- `references/content_schema.json`: Semantic Schema.

---
name: inspect_pptx_quality
description: Auto-inspects the generated PPTX for structural integrity and content completeness.
---

# Inspect PPTX Quality

This skill corresponds to the "QC Agent". It opens the final `.pptx` and validates it against the original Design Brief.

## Input

- `pptx_path`: Path to the generated PPTX file.
- `brief_path`: Path to the Design Brief JSON (source of truth).

## Validation Logic

1.  **File Check**: Is valid ZIP/PPTX structure?
2.  **Slide Count**: Does `slide_count` match `required_layouts` length?
3.  **Placeholders**:
    - Iterate through slides.
    - Check if text boxes are not empty (basic sanity check).
    - Check if "title" placeholders contain text matching the brief.
4.  **Images**:
    - Check if at least one image (background) exists per slide.

## Output

- Console logs PASS/FAIL.
- Exit code 0 for PASS, 1 for FAIL.

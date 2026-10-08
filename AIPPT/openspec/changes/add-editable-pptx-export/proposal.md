## Why

AIPPT currently exports PPTX decks by placing each generated slide image as a full-slide raster, which preserves visual appearance but leaves the deck largely uneditable. The new editable PPTX export should rebuild each slide into a structured deck with editable text, movable visual layers, and native simple shapes while keeping the existing image-based export path available as the stable fallback.

## What Changes

- Add a new editable PPTX export mode beside the existing image-based PPTX export.
- Introduce an editable deck manifest that records source slide pixels, cleaned backgrounds, OCR/native text boxes, bitmap layers, fitted native shapes, provenance, and validation status.
- Build a deterministic reconstruction pipeline that combines:
  - AIPPT generation metadata and OCR for editable text.
  - Local mask/inpaint background cleanup for baked text removal.
  - A pluggable image-layer decomposition provider for visual layer extraction.
  - Shape fitting for simple PPT-native objects such as rectangles, rounded rectangles, lines, and basic fills.
  - A manifest-driven PPTX composer and preview/validation checks.
- Keep prompt-driven image generation/editing out of the default splitting path; allow it only as an explicitly configured fallback for cases where local repair or decomposition cannot produce usable assets.
- Add backend tests, manifest/schema tests, PPTX structure tests, provider contract tests, and frontend/API tests for the new export mode.

## Capabilities

### New Capabilities
- `editable-pptx-export`: Covers exporting AIPPT slide images into a structured, more editable PPTX deck using a manifest-driven reconstruction pipeline with text boxes, bitmap layers, native simple shapes, background cleanup, validation, and deterministic fallback behavior.

### Modified Capabilities
- None.

## Impact

- Backend export API and export route handling.
- New backend modules for editable export orchestration, manifest models, OCR/text extraction, background cleanup, image-layer provider integration, shape fitting, PPTX composition, preview rendering, and validation.
- Optional runtime dependencies for OCR, image processing, PPTX generation/inspection, and layer-provider clients.
- Frontend export controls, progress/status UI, and error display for editable export jobs.
- Test suite expansion across unit, integration, contract, and UI/API behavior.

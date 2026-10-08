## Why

AIPPT currently exports PPTX files as full-slide raster images, which preserves appearance but leaves text and visual elements mostly uneditable. Since image-layer decomposition resources are not currently available, this change proposes a separate effect-first editable export path that relies on OCR, image editing, image generation, manifest composition, and validation.

This change intentionally does not modify the existing `add-editable-pptx-export` OpenSpec change; that change remains available as the future image-layer decomposition approach. The current implementation path is VLM-first: a multimodal understanding model supplies page structure, OCR supplies text/layout evidence, and image edit/generation providers reconstruct clean backgrounds and bitmap assets.

## What Changes

- Add a new explicit generative editable PPTX export mode beside the existing raster `pptx` export.
- Introduce a manifest-driven reconstruction pipeline that uses:
  - VLM page analysis as the required page-structure source for text regions, bitmap regions, and simple shape regions.
  - AIPPT slide/text metadata when available, with OCR as the layout/style and fallback text source.
  - Image editing to create text-clean and base-clean background assets.
  - Image editing or image generation to create source-faithful foreground asset sheets and local repairs.
  - Conservative CV/geometry fitting to convert simple layout elements into native PPT shapes.
  - Deterministic PPTX composition in the order: cleaned background, native shapes, bitmap assets, editable text boxes.
  - Preview, structural validation, and bounded page-level repair attempts before returning the editable deck.
- Extend `config.example.yaml` with placeholder provider configuration for OCR, image editing, image generation, and editable PPTX quality controls.
- Read real provider settings only from local `config.yaml`; automated tests use fake providers and do not require live credentials.
- Keep existing PDF and raster PPTX behavior unchanged.

## Capabilities

### New Capabilities

- `generative-editable-pptx-export`: Covers exporting AIPPT slide images into a structured, editable PPTX through an effect-first generative reconstruction workflow using OCR, image editing/generation, manifest artifacts, deterministic composition, preview validation, and repair loops.

### Modified Capabilities

- None.

## Impact

- Backend export request/response handling for a distinct generative editable PPTX mode.
- New backend modules for editable export configuration, job artifacts, manifests, OCR text extraction, background generation/cleanup, visual planning, asset-sheet generation, asset slicing, shape fitting, PPTX composition, preview rendering, validation, and orchestration.
- Optional runtime integrations for OCR, image editing, and image generation providers, all behind testable provider interfaces.
- `config.example.yaml` schema updates and local `config.yaml` loading for provider configuration.
- Frontend export controls, synchronous loading/error display, and non-destructive failure handling for the new export option.
- Test suite expansion with TDD requirements for every implementation task, including fake providers for CI and manual live-provider verification gates.

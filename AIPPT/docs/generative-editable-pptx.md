# Generative Editable PPTX Export

Generative editable PPTX export converts slide images into PowerPoint decks that preserve visual fidelity while exposing practical editing handles. The exported deck can contain editable text boxes, conservative native PowerPoint shapes, and positioned bitmap assets.

This mode is intended for workflows where the generated deck needs downstream editing in PowerPoint-compatible tools. It is separate from the standard PPTX export, which places each slide image as a single full-slide picture.

## Capabilities

- Reconstructs each slide from an input image rather than requiring the original source layout.
- Uses OCR and optional AIPPT text metadata to create editable PowerPoint text boxes.
- Uses a VLM to understand page structure and candidate visual regions.
- Keeps simple, high-confidence geometry as native PowerPoint objects where possible.
- Keeps complex visuals as bitmap assets to preserve fidelity.
- Runs structural and preview validation before returning the deck.
- Supports explicit fallback policies instead of silently returning lower-fidelity output.

## Export Request

`POST /api/export`

```json
{
  "format": "generative_editable_pptx",
  "aspect_ratio": "16:9",
  "slide_order": ["slide-1", "slide-2"],
  "editable_options": {
    "fallback_policy": "fail"
  },
  "slides": [
    {
      "slide_id": "slide-1",
      "image_base64": "...",
      "text_metadata": [
        {
          "text": "Quarterly Plan",
          "role": "title",
          "order": 1,
          "style_hint": {
            "font_size": 32,
            "bold": true
          }
        }
      ]
    }
  ]
}
```

Supported `fallback_policy` values:

- `fail`: Default. Return an error if editable reconstruction or validation fails.
- `text_editable_background`: Return editable text over a cleaned background when foreground reconstruction fails after required artifacts are available.
- `raster_pptx`: Return the standard raster PPTX as an explicit fallback.

When a fallback is used, the response includes:

- `X-Generative-Editable-Fallback-Policy`
- `X-Generative-Editable-Fallback-Used`

## Model Configuration

Model settings live in `config.yaml`. `config.example.yaml` documents the supported structure with placeholder values.

The editable export path uses these model roles:

- `text_model`: Text chat-completions model. If omitted, the VLM profile may be used for text-only tasks.
- `image_model`: Image generation model.
- `edit_model`: Image editing model. If omitted, it may inherit from `image_model`.
- `VLM`: Optional multimodal understanding model required for image-to-editable-PPTX reconstruction.
- `ocr_model`: Optional OCR model required for image-to-editable-PPTX reconstruction.

Example:

```yaml
api:
  models:
    text_model:
      model: "..."
      base_url: "https://api.example.com/v1"
      api_key: "..."
    image_model:
      model: "..."
      base_url: "https://api.example.com/v1"
      api_key: "..."
    edit_model:
      model: "..."
      base_url: "https://api.example.com/v1"
      api_key: "..."
    VLM:
      model: "..."
      base_url: "https://api.example.com/v1"
      api_key: "..."
    ocr_model:
      model: "..."
      base_url: "https://api.example.com/v1"
      api_key: "..."

generative_editable_pptx:
  reconstruction:
    mode: "vlm_first"
    clean_base_model: "edit_model"
    asset_sheet_model: "edit_model"
    repair_model: "edit_model"
    generation_model: "image_model"
  ocr:
    model: "ocr_model"
    use_aippt_metadata_first: true
    min_confidence: 0.75
  quality:
    max_repair_attempts: 2
    preview_similarity_threshold: 0.92
    require_preview_validation: true
  retries:
    provider_max_attempts: 2
    repair_max_attempts: 2
    backoff_seconds: 1.0
  timeouts:
    provider_call: 180
    page: 600
```

Do not commit real provider credentials.

## Provider Protocol

Current providers use OpenAI-compatible `/chat/completions` APIs:

- Text and VLM providers return message text.
- OCR providers must return structured OCR JSON.
- Image generation and image editing providers return an image URL, data URL, or base64 image payload.

Provider-specific adapters should be added behind the existing provider interfaces when a model requires a different protocol.

## Reconstruction Pipeline

1. Create an isolated export job directory and store source slide images.
2. Run VLM page analysis to identify layout, visual regions, and reconstruction candidates.
3. Run OCR and merge OCR output with optional AIPPT text metadata.
4. Build text masks and generate cleaned background assets.
5. Plan foreground candidates from VLM regions and source/background differences.
6. Convert high-confidence simple geometry to native PowerPoint shapes.
7. Build bitmap assets for complex regions and run bounded repair when validation detects asset issues.
8. Compose the PPTX from background, native shapes, bitmap assets, and editable text boxes.
9. Validate the generated deck structure and preview similarity.
10. Return the validated editable PPTX, an explicit fallback, or a structured error.

## Quality And Cost

This export mode prioritizes editability and visual fidelity over model cost. A single slide can require multiple provider calls: VLM analysis, OCR, background cleanup, asset generation, repair, and validation-driven retries.

Recommended production controls:

- Use bounded concurrency.
- Keep provider call timeouts explicit.
- Enable retries only for retryable provider failures.
- Cache source and intermediate artifacts where appropriate.
- Use fallback policies intentionally per user workflow.

## Limitations

- Complex visuals are usually represented as bitmap assets, not fully editable native PowerPoint objects.
- Generated or repaired bitmap assets may not be pixel-identical to the source image.
- Native shape conversion is conservative; uncertain geometry remains bitmap-based to avoid inaccurate editable objects.
- Text editability depends on OCR accuracy, available source text metadata, and font availability in the presentation editor.
- Real provider verification requires local model credentials and is not part of default CI.

## Relation To Image-Layer Export

Image-layer decomposition is a separate future path. It can produce movable, scalable, croppable visual layers, but it does not automatically provide editable PowerPoint text boxes, line styles, rounded rectangles, or shape semantics.

Generative editable PPTX export focuses on reconstructing a practical PowerPoint document from OCR, VLM layout analysis, image editing/generation, native-shape fitting, deterministic composition, and validation.

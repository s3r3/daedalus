## Context

AIPPT's current `/api/export` path accepts slide images and exports PDF or PPTX. The PPTX branch creates a blank deck and inserts each slide image as one full-slide picture. This is visually stable but does not satisfy the new requirement that text, major visual layers, and simple layout geometry remain editable after opening the deck in PowerPoint.

The selected architecture is compositional rather than a wholesale import of any reference project:

- Use the manifest/finalize/validate pattern from `image-to-editable-ppt-skill`.
- Use deterministic OCR text-box, pixel-to-PPT coordinate, font fitting, and mask/inpaint ideas from `OCRPDF-TO-PPT`.
- Use the layer ordering idea from `slide-alchemy`: cleaned base, native geometry, bitmap visual layers, editable text.
- Replace default prompt-driven asset regeneration with a pluggable image-layer decomposition provider, so the normal path preserves source pixels and avoids regenerating every visual asset.

Development must follow test-driven development: write or update the failing test for each behavior before implementation, implement the smallest passing change, then run the relevant backend/frontend verification before marking the task complete.

## Goals / Non-Goals

**Goals:**

- Add an explicit editable PPTX export mode while preserving the existing PDF and image-based PPTX behavior.
- Produce a structured intermediate manifest for each deck and page.
- Rebuild text as editable PPT text boxes using AIPPT metadata when available and OCR as a fallback.
- Remove baked text from the background before overlaying editable text, using local deterministic cleanup first.
- Extract movable bitmap layers through a provider interface, with Qwen-style image-layer decomposition as the intended default integration.
- Convert simple geometry into PPT-native shapes when confidence is high.
- Compose the final PPTX deterministically from the manifest and validate the output before returning it.
- Make the pipeline testable without live model credentials by providing fake OCR, layer, and repair providers.

**Non-Goals:**

- Perfectly reconstruct every complex visual as a fully native PowerPoint object.
- Make arbitrary bitmap icons editable at the vector-path level.
- Replace the normal `pptx` export behavior with editable export behavior.
- Require Codex, page workers, or a skill runtime in production.
- Make prompt-driven image generation/editing the default decomposition method.

## Decisions

### Decision 1: Add `editable_pptx` as a distinct export mode

The existing `pptx` export remains the stable raster PPTX path. Editable reconstruction is slower, has more dependencies, and can fail validation for specific slides, so it must be requested explicitly through `format: "editable_pptx"` or an equivalent API field.

Editable export options live under an optional `editable_options` request object so existing callers remain compatible. The first supported option is `fallback_policy`, with `fail` as the default and `raster_pptx` as the only permissive fallback.

Alternatives considered:

- Replace `pptx` with editable export. Rejected because existing users may rely on visual fidelity and fast export.
- Add a separate endpoint only. Rejected as the only interface because the frontend already has an export abstraction; a format flag keeps the user-facing flow coherent. A separate internal service/module is still appropriate behind the route.

### Decision 2: Make the editable manifest the source of truth

Each run creates a deck manifest plus page manifests. Page manifests store source size, slide size, background asset, images, shapes, text boxes, provenance, validation checks, and fallback decisions. Coordinates are authored in source-image pixels and normalized only during composition.

Alternatives considered:

- Directly build PPTX while processing each page. Rejected because it makes validation, retries, previews, and tests harder.
- Reuse one reference project's manifest unchanged. Rejected because AIPPT needs its own API and fallback semantics.

### Decision 3: Prefer source-preserving decomposition over prompt regeneration

The default layer extractor is a provider interface that returns RGBA layers with boxes, masks, and confidence metadata. A Qwen-style image-layer model is the intended provider. Prompt-driven image edit/generation is only an explicit fallback provider, never the default splitting path.

Alternatives considered:

- Use `gpt-image-2`/image edit to regenerate clean bases and asset sheets. Rejected as default because it increases cost and can drift from the source.
- Use direct source crops for every non-text visual. Rejected as the only method because overlapping content and baked text require masks/layers, but direct crops remain acceptable for validated isolated assets.

### Decision 4: Text uses metadata-first extraction, OCR fallback, and native PPT boxes

If AIPPT has slide text metadata from outline/prompt generation, the pipeline uses it as semantic truth and uses OCR/layout detection for position and style hints. If metadata is missing, OCR provides content, boxes, colors, and measured font hints. Pixel text is removed from the background when editable text overlays are used.

Alternatives considered:

- OCR only. Rejected because AIPPT often knows the generated text and can avoid OCR character mistakes.
- Keep text as pixels. Rejected because text editability is a core requirement.

### Decision 5: Background cleanup is tiered and local-first

The background cleaner builds masks from accepted text boxes and removes baked text with local fill for flat regions, OpenCV inpaint for moderate regions, and an optional configured remote/image-edit fallback for complex cases. The manifest records which strategy was used per page.

Alternatives considered:

- Always use image editing. Rejected due to cost and drift.
- Never clean the background. Rejected because editable text overlays would duplicate baked text.

### Decision 6: Shape fitting is conservative

Only high-confidence simple geometry becomes native PPT shapes. Supported initial shapes are rectangles, rounded rectangles, ellipses if needed, straight lines, simple fills, strokes, opacity, and basic z-order. Complex illustrations, icons, and uncertain objects remain bitmap layers.

Alternatives considered:

- Convert every detected layer to native shapes. Rejected because poor shape fitting is worse than a faithful bitmap layer.
- Keep all non-text visuals as images. Rejected because simple layout objects should be editable when safe.

### Decision 7: Validation gates the returned editable deck

The composer emits preview images and structural validation. Validation checks page count, slide dimensions, source pixel coordinate coverage, no full-slide source image plus editable text unless it is a cleaned background, text presence, image asset existence, and basic z-order. If strict validation fails, the API returns a clear error or an explicit fallback result according to request options.

Alternatives considered:

- Return best-effort PPTX without validation. Rejected because failures would be hidden until the user opens PowerPoint.

### Decision 8: Fallback behavior is explicit and default-fail

Editable export failures do not silently return a raster deck. If `editable_options.fallback_policy` is omitted or set to `fail`, provider failures and validation failures return an error with page-level details. If it is set to `raster_pptx`, the route may return the existing raster PPTX result and include response metadata indicating that editable reconstruction failed and fallback was used.

Alternatives considered:

- Always fall back to raster PPTX. Rejected because users may assume the returned deck is editable.
- Never allow fallback. Rejected because a user may prefer a downloadable deck over a hard failure for time-sensitive work.

### Decision 9: First progress model is synchronous and stage-based

The first implementation keeps the existing synchronous export request shape. The frontend displays stage-based progress for request start, upload, server processing, response download, and completion/error. Per-page backend progress through jobs or SSE is a future enhancement, not part of this change.

Alternatives considered:

- Introduce an async export job API immediately. Rejected for the first implementation because it expands the scope into job persistence, cancellation, polling/SSE, and cleanup semantics.
- Keep the UI with no progress during editable export. Rejected because editable export can take noticeably longer than raster export.

### Decision 10: Provider configuration is part of the contract

OCR, layer extraction, and repair providers are selected through backend configuration. Tests use fake providers that require no credentials. Production providers fail fast with a clear configuration error when selected but not configured. The first provider contract covers request timeout, max pages, model/service identifier, and deterministic fake fixture selection.

Alternatives considered:

- Instantiate providers directly inside the pipeline. Rejected because it makes testing and fallback behavior brittle.
- Require real provider credentials for all tests. Rejected because CI and local TDD must run without external model access.

## Risks / Trade-offs

- [Layer provider is unavailable or too slow] -> Provide fake/local providers for tests, timeouts, clear error messages, and optional fallback to raster PPTX only when explicitly allowed.
- [OCR misses or misreads text] -> Prefer AIPPT metadata for content, keep OCR confidence/provenance, and expose validation warnings.
- [Background cleanup damages visual content] -> Keep original images, write cleaned assets separately, record strategy, and allow page-level fallback.
- [Shape fitting creates inaccurate native objects] -> Use conservative confidence thresholds and keep uncertain layers as bitmap images.
- [Large decks consume memory or time] -> Process pages in bounded workers, write intermediate assets to a job directory, and clean temporary output after response completion.
- [New dependencies are hard to install] -> Encapsulate providers behind interfaces and keep tests runnable with pure fake providers.
- [Users cannot tell whether fallback happened] -> Use default-fail behavior and expose fallback-used metadata when `raster_pptx` fallback is explicitly requested.

## Migration Plan

1. Add the new editable export modules without changing existing PDF or `pptx` output.
2. Extend backend and frontend types to expose the new export mode.
3. Add provider configuration with fake providers enabled in tests and real providers opt-in through environment/config.
4. Roll out editable export as an explicit UI option with clear progress and validation errors.
5. Keep rollback simple: disable the editable option and continue serving the existing image-based `pptx` path.

## Open Questions

- Which concrete OCR provider should be the first production default: local PaddleOCR, PaddleOCR-VL API, or current AIPPT metadata plus lightweight layout detection?
- Should the first layer provider run locally, remotely, or behind an internal service endpoint?
- Should users be offered a per-page correction UI before exporting, or should the first version rely on manifest/preview validation only?

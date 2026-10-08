## Context

AIPPT's current export path can produce PDF and raster PPTX files from generated slide images. The raster PPTX path is visually stable but not meaningfully editable because each slide is one full-slide picture.

There is already a separate OpenSpec change for an image-layer decomposition approach. This change is intentionally separate: it targets the current constraint where an image-layer model is unavailable and the implementation must rely on OCR, image editing, image generation, deterministic composition, preview validation, and bounded repair.

The reference projects inform different parts of the architecture:

- `image-to-editable-ppt-skill` is the primary reference for an effect-first reconstruction workflow: per-page jobs, manifests, OCR hints, image edit/generation for backgrounds and assets, self-checks, finalization, and validation.
- `slide-alchemy` informs reconstruction order and asset taxonomy: clean base, native geometry, PNG assets, editable text.
- `OCRPDF-TO-PPT` informs deterministic text-box export, pixel-to-PPT coordinate mapping, local text masks, local cleanup, and text-editable fallback behavior.

Development must follow test-driven development. Each task starts by adding or updating a failing test for the expected behavior, then implements the smallest passing change, then runs the relevant verification command before the task is considered complete.

## Goals / Non-Goals

**Goals:**

- Add a distinct `generative_editable_pptx` export mode without changing existing PDF, raster `pptx`, or the separate image-layer OpenSpec change.
- Require VLM-first page understanding for the current implementation path; do not silently bypass VLM with OCR-only or local-CV-only reconstruction.
- Prefer output quality over model cost by default: validate previews, repair bounded failures, and fail rather than silently returning low-quality editable output.
- Use AIPPT text metadata as semantic truth when available and OCR as the source for layout, style, and fallback text.
- Create both text-clean and base-clean background assets so the system has a high-fidelity text-editable fallback and a full reconstruction base.
- Use image edit/generation providers to create source-guided foreground asset sheets and local repairs.
- Convert high-confidence simple visual elements into native PPT shapes.
- Compose final PPTX files deterministically from manifest artifacts and validate them before returning.
- Keep automated tests independent of real provider credentials through fake providers and fixtures.
- Put provider configuration schema in `config.example.yaml` and real local values in `config.yaml`.

**Non-Goals:**

- Do not implement or modify the image-layer decomposition approach in `add-editable-pptx-export`.
- Do not require Codex skills, page workers, or external agent runtimes in production.
- Do not guarantee pixel-perfect reconstruction for every complex generated image.
- Do not convert arbitrary icons or illustrations into editable vector paths.
- Do not make generative reconstruction the default `pptx` export.
- Do not commit real provider credentials.

## Decisions

### Decision 1: Use a distinct export format

The new export format is `generative_editable_pptx`. The existing `pptx` format remains the stable raster export. The separate image-layer change can keep its own `editable_pptx` assumptions without conflict.

Alternatives considered:

- Reuse `editable_pptx`. Rejected because that name is already used by the image-layer decomposition proposal and would collapse two materially different implementations into one contract.
- Replace `pptx`. Rejected because users may still need fast, visually stable raster export.

### Decision 2: Manifest artifacts are the source of truth

The pipeline writes a deck manifest and page manifests before composition. Manifests store source sizes, slide sizes, provider roles, text boxes, backgrounds, foreground candidates, native shapes, bitmap assets, asset sheets, repair attempts, provenance, and validation status. Positions are authored in source-image pixels and converted during composition.

This mirrors the strongest engineering idea from `image-to-editable-ppt-skill` while keeping AIPPT-specific schema and provider semantics.

Alternatives considered:

- Build PPTX directly during extraction. Rejected because retries, previews, tests, and partial page repairs become hard to reason about.
- Reuse a reference manifest unchanged. Rejected because AIPPT needs its own export request contract, fallback policy, and provider configuration.

### Decision 3: Configuration is project-native and local-real, test-fake

`config.example.yaml` documents placeholder provider roles:

- `api.models.VLM`
- `api.models.ocr_model`
- `api.models.image_model`
- `api.models.edit_model`
- `generative_editable_pptx.reconstruction`
- `generative_editable_pptx.quality`
- `generative_editable_pptx.timeouts`

Real local values are read from `config.yaml`. Automated tests use fake providers and fixture images. Live provider verification is an explicit manual gate in the implementation tasks.

Alternatives considered:

- Hardcode provider settings. Rejected because provider details vary and secrets must not be committed.
- Require live providers for tests. Rejected because CI and local TDD loops must remain deterministic.

### Decision 4: Text is metadata-first, OCR-measured, and native in PPT

AIPPT-generated text metadata is used as semantic truth when it can be matched to OCR/layout regions. OCR provides bounding boxes, font-size hints, style hints, color, and fallback content. Text is always composed as editable PowerPoint text boxes when accepted.

Alternatives considered:

- OCR only. Rejected because OCR can misread content that AIPPT already knows.
- Keep text as pixels. Rejected because text editability is a core requirement.

### Decision 5: Generate two background candidates

Each page can produce:

- `text_clean_background`: removes baked text but preserves non-text visuals. This supports high-confidence text-editable fallback.
- `base_clean_background`: removes text and foreground content that will be rebuilt. This supports full editable reconstruction.

Local fill/OpenCV-style cleanup is preferred for simple text masks. Image edit providers are used for complex background cleanup and for full base generation.

Alternatives considered:

- Generate only a base-clean background. Rejected because a failed asset reconstruction would leave no good fallback.
- Generate only a text-clean background. Rejected because full foreground editability requires a clean base underneath rebuilt assets.

### Decision 6: Foreground planning uses VLM page analysis plus generated background differences

Without an image-layer model, the current implementation requires a VLM page analysis to identify text regions, bitmap regions, and simple shape regions. The system combines those regions with generated clean backgrounds, OCR masks, source-pixel geometry, and deterministic filtering to classify candidates into native-shape candidates, bitmap asset candidates, complex whole visuals, duplicates, rejected text-like regions, or uncertain regions.

This is not true layer decomposition; it is a reconstruction plan that drives asset generation and validation.

Alternatives considered:

- Ask the image model to output every asset without local candidate planning. Rejected because prompts become harder to validate and repeated/overlapping objects are easy to miss.
- Directly crop all source regions. Rejected as a default because source crops can include baked text, neighboring objects, and background pollution.

### Decision 7: Asset sheets are source-guided and repairable

Bitmap foreground elements are reconstructed through sparse transparent or chroma-key asset sheets. The source page is supplied as visual reference or edit target. The slicer extracts each asset, removes chroma-key backgrounds if needed, checks edge contact and neighboring contamination, and records mapping back to foreground candidates.

If an asset fails slicing or preview checks, the system retries only the affected page or asset up to the configured repair limit. After the limit, strict mode fails.

Alternatives considered:

- Generate one image per asset from the start. Rejected as the default because it increases model calls and loses reuse opportunities.
- Accept imperfect slices. Rejected because effect quality is prioritized over cost.

### Decision 8: Native shape fitting is conservative

Only high-confidence rectangles, rounded rectangles, ellipses if enabled, and straight lines are emitted as native PPT shapes. Uncertain visuals remain bitmap assets.

Alternatives considered:

- Convert all visual candidates to shapes. Rejected because inaccurate shapes are worse than faithful bitmap assets.
- Keep all visuals as bitmaps. Rejected because simple layout elements should be editable when reliable.

### Decision 9: Validation gates results and fallback must be explicit

The default fallback policy is `fail`. Validation checks page count, dimensions, required text, unsafe baked-text overlap, asset existence, object order, native text/shape structure, and preview similarity. If validation fails after bounded repairs, the API returns an error unless the request explicitly permits `text_editable_background` or `raster_pptx` fallback. When an explicit fallback is permitted and the fallback output can be generated, the API returns that fallback and records fallback-used metadata. If the fallback output itself cannot be generated, the API fails with the original failure and fallback failure details.

Alternatives considered:

- Always return best-effort output. Rejected because it hides quality failures.
- Always fallback to raster PPTX. Rejected because it would surprise users requesting editability.

## Pipeline

```text
Slide images + optional AIPPT text metadata
        |
        v
Create job directory and deck/page manifests
        |
        v
VLM page analysis
        |
        v
OCR + text matching
        |
        v
Text masks
        |
        +--> text-clean background
        |
        +--> base-clean background
                 |
                 v
        foreground candidate planning
                 |
        +--------+---------+
        |                  |
        v                  v
 native shape fitting   asset-sheet generation
        |                  |
        v                  v
 shape specs          asset slicing + QA
        |                  |
        +--------+---------+
                 |
                 v
           page manifest
                 |
                 v
      deterministic PPTX composition
                 |
                 v
       preview + validation + repair
                 |
                 v
        return PPTX or explicit failure/fallback
```

## Provider Interfaces

The implementation should define provider interfaces before concrete clients:

- `OCRProvider`: returns text content, boxes/polygons, confidence, font-size hints, color, alignment, and style hints.
- `VLMPageAnalysisProvider`: returns structured page regions for text, bitmap assets, and simple shapes in a known pixel coordinate space.
- `ImageEditProvider`: edits a source image with a prompt and optional mask to produce text-clean backgrounds, base-clean backgrounds, asset sheets, or repairs.
- `ImageGenerationProvider`: generates or regenerates assets when edit-based extraction fails or a visual asset needs clean re-creation.
- `VisualPlanner`: uses source images, generated backgrounds, OCR masks, and optional model analysis to produce foreground candidates and classifications.
- `PreviewRenderer`: renders composed PPTX pages or manifest previews for comparison.
- `Validator`: performs structural and visual quality checks and produces actionable failure reports.

Each provider must have a fake implementation for automated tests.

## Testing Strategy

All implementation tasks follow TDD:

1. Add a failing unit, integration, contract, or frontend test for the behavior.
2. Implement the smallest change that passes.
3. Run the task-specific verification command listed in `tasks.md`.
4. Keep provider-backed tests deterministic by using fake providers and fixture assets.
5. Run live provider checks only after local provider configuration is available.

## Risks / Trade-offs

- [Generated assets drift from the source] -> Use source-guided image editing, asset-sheet QA, preview comparison, and bounded repairs.
- [OCR misreads text] -> Prefer AIPPT metadata for content, use OCR for layout/style, and fail required text validation when confidence is too low.
- [Background editing removes desired visuals] -> Keep original, text-clean, and base-clean assets separately; validate preview similarity; allow text-editable fallback only when explicitly requested.
- [Cost is higher than image-layer decomposition] -> Prioritize quality by default, then optimize through component reuse, page-level retries, caching, and optional fallback policies.
- [Provider availability blocks development] -> Keep all providers behind interfaces and use fake providers in automated tests.
- [Large decks are slow] -> Process pages in bounded workers, write intermediate artifacts to disk, keep the first version as a synchronous export with an indeterminate frontend loading state, and reserve stage-based progress for a later job/status API if needed.

## Migration Plan

1. Add the new OpenSpec change and keep the image-layer change untouched.
2. Implement configuration schema and fake provider infrastructure first.
3. Add backend pipeline modules behind the new `generative_editable_pptx` format.
4. Add frontend controls as a distinct high-fidelity editable export option.
5. Validate with deterministic fixtures and fake providers.
6. Request local provider configuration before live OCR/image edit/image generation verification.
7. Keep rollback simple: hide or disable the generative editable export option while leaving existing PDF and raster PPTX exports unchanged.

## Live Verification Status

- Local verification targets are configured through project `config.yaml`; automated tests continue to use fake providers.
- The current live path is VLM-first. If the VLM provider is unavailable or repeatedly fails, the generative editable export fails rather than switching to an OCR-only reconstruction path.
- A six-slide replay-assets run completed with live VLM, OCR, image edit, and image generation/edit configuration. The original strict run produced a PPTX and artifacts, but failed the old preview gate on page 5 because the raw changed-pixel ratio slightly exceeded the threshold on a text-dense page.
- The existing six-slide artifact was then revalidated without additional provider calls using the current text-overlap-aware preview gate. This revalidation passed all 6 pages; it is not a separate fresh provider run.
- Revalidated report: `/private/tmp/aippt-vlm-6page-full-editquota-20260708/report-revalidated-strict.json`.
- Revalidated object totals: `TEXT_BOX=120`, `PICTURE=54`, `LINE=30`, `AUTO_SHAPE=18`, `BACKGROUND_PICTURE=6`; each page had `full_slide_picture_count=0`.
- Revalidated preview status: all 6 pages passed with the current text-overlap-aware preview gate and `reconstruction_issues=[]`.
- Known limitation: text-dense pages can exceed the raw changed-pixel ratio because editable PPT text renders differently from baked raster text. The preview validator only grants limited headroom when mean delta remains within threshold and changed pixels substantially overlap text regions.

## 1. Export Contract And TDD Baseline

- [ ] 1.1 Add failing backend tests for `editable_pptx` request validation, invalid format rejection, and unchanged `pptx` raster behavior; implement the API model/route changes; pass `python -m pytest tests/test_export_pptx_ratio.py tests/test_editable_pptx_export_contract.py`.
- [ ] 1.2 Add failing frontend tests for the new export format type, request body, filename/MIME handling, and existing `pdf`/`pptx` behavior; implement type/service updates; pass `cd web && npm run test -- ExportConsistency.property.test.tsx`.
- [ ] 1.3 Add failing tests that export requests can carry slide order, aspect ratio, optional `slide_id`, and text metadata items with `text`, `role`, `order`, and optional `style_hint`; implement backward-compatible request serialization; pass the backend and frontend export contract tests.
- [ ] 1.4 Add failing tests for `editable_options.fallback_policy` defaulting to `fail`, accepting `raster_pptx`, and rejecting invalid values; implement request parsing and response metadata for fallback-used results; pass export contract tests.

## 2. Manifest Schema And Job Artifacts

- [ ] 2.1 Add failing tests for deck/page manifest models, required fields, source pixel coordinates, provenance, and validation status; implement manifest dataclasses or Pydantic models; pass `python -m pytest tests/test_editable_pptx_manifest.py`.
- [ ] 2.2 Add failing tests for deterministic job directory creation, per-page asset paths, cleanup-safe temp handling, and manifest JSON round-trip; implement the job artifact writer; pass `python -m pytest tests/test_editable_pptx_job_artifacts.py`.
- [ ] 2.3 Add failing tests that a manifest can be rebuilt without re-running OCR, layer extraction, or cleanup providers; implement provider-output persistence; pass manifest/job artifact tests.

## 3. Text Extraction And Background Cleanup

- [ ] 3.1 Add failing tests for metadata-first text extraction with OCR layout/style hints; implement the text extraction service and fake OCR provider; pass `python -m pytest tests/test_editable_pptx_text_extractor.py`.
- [ ] 3.2 Add failing tests for OCR-only fallback, confidence/provenance recording, font-size hints, color/alignment mapping, and CJK-safe font defaults; implement fallback extraction; pass text extractor tests.
- [ ] 3.3 Add failing tests for text mask creation from boxes/polygons and source-pixel coordinate handling; implement mask generation; pass `python -m pytest tests/test_editable_pptx_background_cleaner.py`.
- [ ] 3.4 Add failing tests for local fill, local inpaint fallback, strategy recording, and no default generative repair; implement tiered background cleanup; pass background cleaner tests.

## 4. Layer Extraction And Shape Fitting

- [ ] 4.1 Add failing provider contract tests for configured fake providers, production-provider missing configuration errors, RGBA layer outputs, bounds, confidence, timeout/error handling, and fake provider fixtures; implement the provider configuration and layer provider interface; pass `python -m pytest tests/test_editable_pptx_layer_provider.py`.
- [ ] 4.2 Add failing tests that text-like layers overlapping accepted text boxes are excluded from visual image assets; implement overlap filtering and provenance updates; pass layer provider tests.
- [ ] 4.3 Add failing tests for high-confidence rectangle, rounded-rectangle, and line conversion into native shape specs; implement conservative shape fitting; pass `python -m pytest tests/test_editable_pptx_shape_fitter.py`.
- [ ] 4.4 Add failing tests that low-confidence or complex layers remain bitmap image layers; implement confidence thresholds and fallback classification; pass shape fitter tests.

## 5. PPTX Composer And Validator

- [ ] 5.1 Add failing tests for pixel-to-slide coordinate conversion for both `16:9` and `4:3`; implement composer coordinate normalization; pass `python -m pytest tests/test_editable_pptx_composer.py`.
- [ ] 5.2 Add failing tests that composed slides use the required z-order: cleaned background, native shapes, bitmap image layers, editable text boxes; implement manifest-driven PPTX composition; pass composer tests.
- [ ] 5.3 Add failing tests that text boxes are editable PowerPoint text objects and simple shapes are native PPT shapes; implement PPTX object creation and XML/package inspection helpers; pass composer tests.
- [ ] 5.4 Add failing tests for validation success, unsafe full-slide source plus text rejection, missing required text detection, missing asset detection, and page count checks; implement the validator; pass `python -m pytest tests/test_editable_pptx_validator.py`.
- [ ] 5.5 Add failing tests for deterministic per-page preview artifact creation or recording from manifests using fake assets; implement preview generation or preview stubs suitable for CI; pass composer and validator tests.

## 6. Pipeline Orchestration And API Integration

- [ ] 6.1 Add failing orchestration tests with fake OCR, fake layer provider, and fake cleaner for a one-slide deck; implement the editable export pipeline; pass `python -m pytest tests/test_editable_pptx_pipeline.py`.
- [ ] 6.2 Add failing orchestration tests for multi-slide ordering, per-page manifest creation, validation aggregation, and artifact cleanup; implement multi-page processing; pass pipeline tests.
- [ ] 6.3 Add failing API route tests that `format: "editable_pptx"` returns a valid PPTX when fake providers pass validation; wire the route to the pipeline; pass `python -m pytest tests/test_editable_pptx_export_route.py`.
- [ ] 6.4 Add failing API route tests for provider timeout, validation failure, default-fail behavior, and explicit `raster_pptx` fallback behavior; implement clear error responses, fallback controls, and fallback-used response metadata; pass export route tests.

## 7. Frontend Experience

- [ ] 7.1 Add failing component tests that the export menu exposes editable PPTX as a distinct option without renaming the existing PPTX option; implement the UI control and i18n labels; pass `cd web && npm run test -- Export`.
- [ ] 7.2 Add failing hook/service tests for synchronous stage-based editable export progress, completion filename, fallback-used metadata handling, and error propagation; implement frontend progress/error handling; pass frontend export tests.
- [ ] 7.3 Add failing app-level tests that editable export failure preserves current slides, active project state, and existing edit state; implement non-destructive error handling; pass `cd web && npm run test -- AppProjectLifecycle.test.tsx`.

## 8. End-To-End Verification And Documentation

- [ ] 8.1 Add a small deterministic fixture deck/image set for editable export tests; verify the fixture covers text, simple shapes, one complex image layer, 16:9, and 4:3 cases; pass all editable backend tests.
- [ ] 8.2 Run the complete backend verification and fix any regressions using TDD loops; pass `python -m pytest tests`.
- [ ] 8.3 Run the complete frontend verification and fix any regressions using TDD loops; pass `cd web && npm run lint && npm run test && npm run build`.
- [ ] 8.4 Validate the OpenSpec change; pass `openspec status --change add-editable-pptx-export` and `openspec validate add-editable-pptx-export --strict`.
- [ ] 8.5 Update user-facing and developer documentation for editable PPTX configuration, provider setup, fallback behavior, and known limitations; verify docs mention that existing `pptx` remains raster export.

## 1. Export Contract And Configuration

- [x] 1.1 Add failing backend tests for `generative_editable_pptx` request validation, unsupported format rejection, and unchanged `pdf`/`pptx` behavior; implement the API contract changes; pass `python -m pytest tests/test_export_pptx_ratio.py tests/test_generative_editable_export_contract.py`.
- [x] 1.2 Add failing tests for optional slide order, aspect ratio, fallback policy, and text metadata serialization in export requests; implement backward-compatible request models; pass `python -m pytest tests/test_generative_editable_export_contract.py`.
- [x] 1.3 Add failing tests that `config.example.yaml` exposes placeholder OCR, image edit, image generation, reconstruction, quality, timeout, and retry sections; update the example config; pass `python -m pytest tests/test_generative_editable_config.py`.
- [x] 1.4 Add failing tests that live provider settings are read from local `config.yaml` and missing settings produce redacted configuration errors; implement config loading and redaction; pass `python -m pytest tests/test_generative_editable_config.py`.
- [x] 1.5 Add failing tests that automated test mode uses fake provider configuration without live credentials; implement fake-provider config fixtures; pass `python -m pytest tests/test_generative_editable_config.py`.

## 2. Provider Interfaces And Test Doubles

- [x] 2.1 Add failing contract tests for `OCRProvider` outputs including text, bbox/polygon, confidence, font hints, color, alignment, and provenance; implement the interface and fake provider; pass `python -m pytest tests/test_generative_editable_providers.py`.
- [x] 2.2 Add failing contract tests for `ImageEditProvider` requests including source image, prompt identifier, optional mask, timeout, and output asset path; implement the interface and fake provider; pass `python -m pytest tests/test_generative_editable_providers.py`.
- [x] 2.3 Add failing contract tests for `ImageGenerationProvider` requests including prompt identifier, visual reference metadata, timeout, and output asset path; implement the interface and fake provider; pass `python -m pytest tests/test_generative_editable_providers.py`.
- [x] 2.4 Add failing tests for provider timeout, provider error, retryable error, non-retryable error, and secret-safe error messages; implement provider error types and handling; pass `python -m pytest tests/test_generative_editable_providers.py`.
- [x] 2.5 Add failing tests for fixture image assets used by fake providers, including deterministic output hashes or dimensions; add fixtures; pass `python -m pytest tests/test_generative_editable_providers.py`.

## 3. Manifest Schema And Job Artifacts

- [x] 3.1 Add failing tests for deck manifest fields, page manifest fields, source pixel coordinates, provider roles, fallback policy, provenance, repair attempts, and validation status; implement manifest models; pass `python -m pytest tests/test_generative_editable_manifest.py`.
- [x] 3.2 Add failing tests for deterministic job directory creation, per-page asset paths, page ordering, and cleanup-safe temp handling; implement job artifact writer; pass `python -m pytest tests/test_generative_editable_job_artifacts.py`.
- [x] 3.3 Add failing tests that manifests can round-trip through JSON without losing coordinates, provider metadata, asset references, or validation status; implement serialization; pass `python -m pytest tests/test_generative_editable_manifest.py tests/test_generative_editable_job_artifacts.py`.
- [x] 3.4 Add failing tests that a manifest can be rebuilt without re-running OCR, image edit, image generation, or repair providers; implement provider-output persistence; pass `python -m pytest tests/test_generative_editable_manifest.py tests/test_generative_editable_job_artifacts.py`.

## 4. Text Extraction And Text Masks

- [x] 4.1 Add failing tests for metadata-first text extraction where AIPPT text metadata supplies content and OCR supplies layout/style hints; implement text matching; pass `python -m pytest tests/test_generative_editable_text.py`.
- [x] 4.2 Add failing tests for OCR-only fallback, confidence recording, font-size hints, CJK-safe default font selection, color mapping, and alignment mapping; implement OCR fallback extraction; pass `python -m pytest tests/test_generative_editable_text.py`.
- [x] 4.3 Add failing tests for required text validation when metadata text cannot be matched or OCR confidence is below threshold; implement text validation reports; pass `python -m pytest tests/test_generative_editable_text.py`.
- [x] 4.4 Add failing tests for mask creation from text boxes and polygons, padding, clipping, and source-pixel coordinate handling; implement text mask generation; pass `python -m pytest tests/test_generative_editable_text_masks.py`.

## 5. Background Generation And Cleanup

- [x] 5.1 Add failing tests for local fill and local inpaint selection on flat or locally repairable text mask regions; implement local cleanup strategy; pass `python -m pytest tests/test_generative_editable_backgrounds.py`.
- [x] 5.2 Add failing tests for `text_clean_background` generation using local cleanup first and image edit only when configured/needed; implement text-clean background creation; pass `python -m pytest tests/test_generative_editable_backgrounds.py`.
- [x] 5.3 Add failing tests for `base_clean_background` generation through image edit provider with prompt identifiers and source image references recorded; implement base-clean background creation; pass `python -m pytest tests/test_generative_editable_backgrounds.py`.
- [x] 5.4 Add failing tests that background outputs preserve original assets, write separate cleaned assets, and record strategy/provenance/validation status in the page manifest; implement background manifest updates; pass `python -m pytest tests/test_generative_editable_backgrounds.py tests/test_generative_editable_manifest.py`.

## 6. Foreground Planning And Native Shape Fitting

- [x] 6.1 Add failing tests for foreground candidate detection from source vs base-clean differences while excluding accepted text masks; implement candidate planner; pass `python -m pytest tests/test_generative_editable_foreground_planner.py`.
- [x] 6.2 Add failing tests for candidate classification into native-shape candidate, bitmap asset candidate, complex whole visual, duplicate, rejected text-like region, and uncertain region; implement classification; pass `python -m pytest tests/test_generative_editable_foreground_planner.py`.
- [x] 6.3 Add failing tests for repeated component detection and manifest reuse records; implement component reuse planning; pass `python -m pytest tests/test_generative_editable_foreground_planner.py`.
- [x] 6.4 Add failing tests for high-confidence rectangle, rounded rectangle, ellipse if enabled, and line conversion into native shape specs; implement conservative shape fitting; pass `python -m pytest tests/test_generative_editable_shape_fitter.py`.
- [x] 6.5 Add failing tests that low-confidence or complex candidates remain bitmap asset candidates rather than inaccurate native shapes; implement thresholds and fallback classification; pass `python -m pytest tests/test_generative_editable_shape_fitter.py`.

## 7. Asset Sheet Generation, Slicing, And Repair

- [x] 7.1 Add failing tests for asset-sheet prompt request creation from accepted bitmap candidates, including source reference, candidate boxes, chroma-key/transparent mode, and provider role; implement asset-sheet request builder; pass `python -m pytest tests/test_generative_editable_assets.py`.
- [x] 7.2 Add failing tests for asset-sheet slicing, chroma-key removal, alpha preservation, padding preservation, candidate-to-asset mapping, and asset path recording; implement slicer; pass `python -m pytest tests/test_generative_editable_assets.py`.
- [x] 7.3 Add failing tests for edge-touch, neighboring-object contamination, baked-text contamination, missing-object, and empty-asset rejection; implement asset QA checks; pass `python -m pytest tests/test_generative_editable_assets.py`.
- [x] 7.4 Add failing tests for bounded repair attempts on failed assets, including page-level retry, single-asset retry, repair-limit failure, and manifest repair history; implement repair orchestration; pass `python -m pytest tests/test_generative_editable_assets.py tests/test_generative_editable_pipeline.py`.

## 8. PPTX Composer And Preview Renderer

- [x] 8.1 Add failing tests for source-pixel to slide-coordinate conversion for `16:9` and `4:3`; implement composer coordinate normalization; pass `python -m pytest tests/test_generative_editable_composer.py`.
- [x] 8.2 Add failing tests that pages compose in required z-order: chosen cleaned background, native shapes, bitmap assets, editable text boxes; implement manifest-driven composition; pass `python -m pytest tests/test_generative_editable_composer.py`.
- [x] 8.3 Add failing tests that accepted text boxes are editable PowerPoint text objects and accepted simple shapes are native PowerPoint shapes; implement PPTX object creation and package/XML inspection helpers; pass `python -m pytest tests/test_generative_editable_composer.py`.
- [x] 8.4 Add failing tests for multi-page deck composition, page order, slide dimensions, image media references, and deterministic rebuild from saved manifests; implement deck composer; pass `python -m pytest tests/test_generative_editable_composer.py`.
- [x] 8.5 Add failing tests for preview rendering or deterministic preview stubs from manifests using fake assets; implement preview renderer suitable for CI; pass `python -m pytest tests/test_generative_editable_preview_validator.py`.

## 9. Validation, Fallback, And Pipeline Orchestration

- [x] 9.1 Add failing tests for structural validation including page count, dimensions, required text, missing assets, unsafe full-slide source plus text, object order, and validation report shape; implement validator; pass `python -m pytest tests/test_generative_editable_preview_validator.py`.
- [x] 9.2 Add failing tests for preview similarity threshold pass/fail behavior using deterministic fixture images; implement preview comparison and quality gates; pass `python -m pytest tests/test_generative_editable_preview_validator.py`.
- [x] 9.3 Add failing tests that default fallback policy is `fail`, validation failure returns a clear error, and no low-fidelity output is silently returned; implement default fallback handling; pass `python -m pytest tests/test_generative_editable_pipeline.py`.
- [x] 9.4 Add failing tests for explicit `text_editable_background` fallback, explicit `raster_pptx` fallback, fallback-used response metadata, and fallback-output failure reasons; implement fallback policies; pass `python -m pytest tests/test_generative_editable_pipeline.py tests/test_generative_editable_export_route.py`.
- [x] 9.5 Add failing orchestration tests for a one-slide deck using fake OCR, fake image edit, fake image generation, fake planner, fake assets, composer, preview, and validator; implement pipeline orchestration; pass `python -m pytest tests/test_generative_editable_pipeline.py`.
- [x] 9.6 Add failing orchestration tests for multi-slide ordering, bounded page concurrency, per-page manifest creation, repair aggregation, validation aggregation, and artifact cleanup; implement multi-page pipeline behavior; pass `python -m pytest tests/test_generative_editable_pipeline.py`.
- [x] 9.7 Add failing API route tests that `format: "generative_editable_pptx"` returns a valid PPTX when fake providers pass validation; wire the export route to the pipeline; pass `python -m pytest tests/test_generative_editable_export_route.py`.
- [x] 9.8 Add failing API route tests for missing provider config, provider timeout, provider failure, validation failure, repair-limit failure, and explicit fallback behavior; implement route error handling; pass `python -m pytest tests/test_generative_editable_export_route.py`.

## 10. Frontend Experience

- [x] 10.1 Add failing frontend tests that the export menu exposes a distinct high-fidelity editable PPTX option without renaming the existing PPTX option; implement UI labels and selection state; pass `cd web && npm run test -- Export`.
- [x] 10.2 Add failing frontend service tests for `generative_editable_pptx` request body, slide order, aspect ratio, text metadata, fallback policy, filename, and MIME handling; implement service/type updates; pass `cd web && npm run test -- Export`.
- [x] 10.3 Add failing frontend tests for synchronous indeterminate loading state, no claimed backend stage progress, provider/configuration/validation errors, and non-destructive failure handling; implement loading and error UI; pass `cd web && npm run test -- Export AppProjectLifecycle`.
- [x] 10.4 Run frontend lint and build after the UI changes; fix failures with TDD loops where behavior changes are needed; pass `cd web && npm run lint && npm run build`.

## 11. Live Provider Verification And Documentation

- [x] 11.1 Add a deterministic fixture deck/image set covering text, simple shapes, repeated bitmap assets, one complex visual, text-clean fallback, 16:9, and 4:3; verify it passes fake-provider backend tests; pass `python -m pytest tests/test_generative_editable_*`.
- [x] 11.2 Before live provider verification, ask the developer to populate local `config.yaml` with OCR, image edit, and image generation provider settings; verify configuration presence with redacted diagnostics, run a one-slide live smoke test, and record non-secret results in developer docs; pass `python scripts/smoke_generative_editable_pptx.py --config-check-only` and `python scripts/smoke_generative_editable_pptx.py --slides one --output-dir /private/tmp/aippt-generative-editable-smoke-one`.
- [x] 11.3 Run a small multi-slide live verification with real providers after the one-slide smoke test passes; verify preview validation, repair behavior, and output PPTX editability manually; record non-secret findings in developer docs; pass `python scripts/smoke_generative_editable_pptx.py --slides multi --output-dir /private/tmp/aippt-generative-editable-smoke-multi`.
- [x] 11.4 Update user-facing and developer documentation for configuration schema, provider roles, quality-first behavior, fallback policies, known limitations, and the distinction from the image-layer OpenSpec change; verify docs do not include real credentials.
- [x] 11.5 Run complete backend verification and fix regressions through TDD loops; pass `python -m pytest tests`.
- [x] 11.6 Run complete frontend verification and fix regressions through TDD loops; pass `cd web && npm run lint && npm run test && npm run build`.
- [x] 11.7 Validate the OpenSpec change; pass `PATH="/Users/lzj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /opt/homebrew/bin/npx --yes @fission-ai/openspec status --change add-generative-editable-pptx-export` and `PATH="/Users/lzj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH" /opt/homebrew/bin/npx --yes @fission-ai/openspec validate add-generative-editable-pptx-export --strict`.

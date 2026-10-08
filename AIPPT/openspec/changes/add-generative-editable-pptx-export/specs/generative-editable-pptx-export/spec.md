## ADDED Requirements

### Requirement: Explicit generative editable PPTX export mode
The system SHALL provide a distinct generative editable PPTX export mode without changing existing PDF, raster PPTX, or image-layer editable export behavior.

#### Scenario: Existing raster PPTX export remains unchanged
- **WHEN** a user exports with format `pptx`
- **THEN** the system SHALL return the existing raster PPTX output that places each slide image as a full-slide picture

#### Scenario: Generative editable PPTX export is requested
- **WHEN** a user exports with format `generative_editable_pptx`
- **THEN** the system SHALL run the VLM-first OCR, image editing, image generation, manifest composition, preview, validation, and repair pipeline

#### Scenario: Image-layer editable export is not modified
- **WHEN** the separate image-layer editable export OpenSpec change exists in the repository
- **THEN** this capability SHALL NOT modify its proposal, design, specs, tasks, request contract, or provider assumptions

#### Scenario: Unsupported export format
- **WHEN** a user submits an export format other than the supported export formats
- **THEN** the system SHALL reject the request with a clear validation error

### Requirement: Configuration contract
The system SHALL load generative editable export provider settings from the project configuration files and SHALL keep real provider credentials out of committed artifacts.

#### Scenario: Example configuration is updated
- **WHEN** the repository is inspected after this capability is implemented
- **THEN** `config.example.yaml` SHALL document placeholder VLM, OCR, image edit, image generation, reconstruction, quality, timeout, and retry settings for generative editable PPTX export

#### Scenario: Local configuration provides real providers
- **WHEN** a developer runs live provider verification
- **THEN** the system SHALL read real provider settings from local `config.yaml`

#### Scenario: Automated tests run without real providers
- **WHEN** backend or frontend automated tests run in CI or a fresh local test environment
- **THEN** the tests SHALL use fake or fixture providers and SHALL NOT require live OCR, image edit, or image generation credentials

#### Scenario: Missing live provider configuration
- **WHEN** a live generative editable export is requested without required local provider settings
- **THEN** the system SHALL fail with a clear configuration error that names the missing provider role without exposing secrets

#### Scenario: VLM-first reconstruction is required
- **WHEN** a live generative editable export is requested
- **THEN** the system SHALL require a configured VLM provider for page-structure analysis and SHALL NOT silently downgrade to OCR-only or local-CV-only reconstruction

### Requirement: Generative editable deck manifest
The system SHALL create a deck manifest and one page manifest per slide for every generative editable PPTX export run.

#### Scenario: Deck manifest records run structure
- **WHEN** a generative editable export run starts
- **THEN** the deck manifest SHALL record slide order, aspect ratio, provider roles, quality settings, fallback policy, page manifest paths, and final validation status

#### Scenario: Page manifest records reconstruction structure
- **WHEN** a page is processed
- **THEN** the page manifest SHALL record source image size, slide size, text-clean background, base-clean background, chosen background, text boxes, native shapes, bitmap assets, asset sheets, repair attempts, provenance, and validation status

#### Scenario: Manifest uses source pixel coordinates
- **WHEN** the manifest stores positions for text boxes, bitmap assets, and native shapes
- **THEN** positioned objects SHALL use source-image pixel coordinates before composition

#### Scenario: Manifest supports deterministic rebuild
- **WHEN** the PPTX composer receives the deck manifest and referenced page assets
- **THEN** it SHALL rebuild slide ordering, object ordering, slide dimensions, text boxes, shapes, and image assets without re-running OCR, image editing, image generation, or repair providers

### Requirement: Text extraction and reconstruction
The system SHALL rebuild slide text as editable PowerPoint text boxes using AIPPT text metadata first and OCR as the layout, style, and fallback source.

#### Scenario: AIPPT text metadata is available
- **WHEN** a slide includes AIPPT-generated text metadata and OCR detects matching layout regions
- **THEN** the system SHALL use AIPPT metadata as text content and OCR output as position, size, color, alignment, and style hints

#### Scenario: AIPPT text metadata is missing or unmatched
- **WHEN** a slide has no usable text metadata for a detected text region
- **THEN** the system SHALL use OCR content, box, confidence, font-size hints, color, and alignment to create an editable text box

#### Scenario: Text confidence is insufficient
- **WHEN** required text cannot be matched or OCR confidence is below the configured threshold
- **THEN** the page validation SHALL fail unless the request explicitly allows a lower-fidelity fallback

#### Scenario: Text boxes are composed
- **WHEN** a page manifest includes accepted text boxes
- **THEN** each accepted text item SHALL become an editable PowerPoint text object placed above background, native shapes, and bitmap assets

### Requirement: Text-clean and base-clean background generation
The system SHALL create separate background candidates for text-only cleanup and full foreground removal.

#### Scenario: Text-clean background is generated
- **WHEN** a page contains accepted text boxes
- **THEN** the system SHALL create a text-clean background candidate that removes baked text while preserving non-text visual elements as much as possible

#### Scenario: Base-clean background is generated
- **WHEN** a page is processed for full editable reconstruction
- **THEN** the system SHALL create a base-clean background candidate that preserves theme background, edge decoration, ambient texture, and layout background while removing text and foreground content that will be rebuilt

#### Scenario: Local cleanup is sufficient for text removal
- **WHEN** a text mask region is classified as flat or locally repairable
- **THEN** the system SHALL use local fill or local inpaint before using remote image editing for that region

#### Scenario: Background strategy is recorded
- **WHEN** a background candidate is generated, preserved, repaired, or rejected
- **THEN** the page manifest SHALL record the strategy, provider role, prompts or prompt identifiers, input asset references, output asset reference, and validation result

### Requirement: Foreground planning from VLM analysis and generated backgrounds
The system SHALL plan non-text foreground reconstruction using VLM page analysis, OCR masks, generated backgrounds, image differences, and deterministic visual filtering.

#### Scenario: Foreground candidates are detected
- **WHEN** source and base-clean images are available
- **THEN** the system SHALL produce foreground candidate regions by comparing the source image to the base-clean image and excluding accepted text regions

#### Scenario: Candidate inventory is classified
- **WHEN** foreground candidates are detected
- **THEN** the system SHALL classify each candidate as native-shape candidate, bitmap asset candidate, complex whole visual, duplicate, rejected text-like region, or uncertain region

#### Scenario: Repeated components are identified
- **WHEN** multiple foreground candidates appear visually or geometrically equivalent
- **THEN** the system SHALL record component reuse in the manifest so one generated asset can be reused across instances when validation passes

### Requirement: Asset sheet generation and slicing
The system SHALL reconstruct non-text bitmap foreground content through source-guided image edit or image generation providers.

#### Scenario: Asset sheet is generated
- **WHEN** one or more bitmap asset candidates are accepted for a page
- **THEN** the system SHALL request a sparse transparent or chroma-key asset sheet that preserves each candidate's visual identity, geometry, stroke, color, proportions, and internal cutouts

#### Scenario: Asset sheet is sliced
- **WHEN** an asset sheet is generated
- **THEN** the system SHALL slice it into individual image assets, preserve padding, remove chroma-key backgrounds when needed, and record each asset path and source candidate mapping

#### Scenario: Asset slicing quality fails
- **WHEN** a sliced asset touches the crop edge, contains neighboring objects, contains text that should be editable, or loses required visual content
- **THEN** the system SHALL reject the asset and schedule a bounded repair attempt

#### Scenario: Asset generation repair is bounded
- **WHEN** an asset generation or slicing failure occurs
- **THEN** the system SHALL retry only the affected page or asset up to the configured repair limit before failing validation or using an explicitly allowed fallback

### Requirement: Native simple shape reconstruction
The system SHALL convert high-confidence simple layout elements into native PowerPoint shapes.

#### Scenario: Simple rectangle is detected
- **WHEN** a foreground candidate is classified as a high-confidence rectangle or rounded rectangle
- **THEN** the system SHALL represent it as a native PPT shape with position, size, fill, stroke, opacity, and corner radius when available

#### Scenario: Simple line is detected
- **WHEN** a foreground candidate is classified as a high-confidence straight line
- **THEN** the system SHALL represent it as a native PPT line or equivalent native shape with endpoints, stroke color, width, and opacity

#### Scenario: Shape confidence is low
- **WHEN** a candidate cannot be fitted to a supported native shape above the configured confidence threshold
- **THEN** the system SHALL preserve it as a bitmap asset candidate rather than emitting an inaccurate native shape

### Requirement: PPTX composition
The system SHALL compose the final PPTX deterministically from the deck and page manifests.

#### Scenario: Page object order is composed
- **WHEN** the composer builds a page from its manifest
- **THEN** it SHALL place objects in this order: chosen cleaned background, native shapes, bitmap assets, editable text boxes

#### Scenario: Slide aspect ratio is preserved
- **WHEN** the export request uses aspect ratio `16:9` or `4:3`
- **THEN** the generative editable PPTX SHALL use the same slide dimensions as the existing raster PPTX export for that aspect ratio

#### Scenario: Text and shapes remain native
- **WHEN** the composed PPTX is opened or inspected
- **THEN** accepted text boxes SHALL be PowerPoint text objects and accepted simple shapes SHALL be native PowerPoint shapes

### Requirement: Preview validation and effect-first quality gates
The system SHALL validate generative editable PPTX output before returning it, prioritizing effect quality over cost savings.

#### Scenario: Validation passes
- **WHEN** the composed PPTX passes structural checks, required text checks, asset existence checks, z-order checks, and preview comparison thresholds
- **THEN** the system SHALL return the PPTX and record validation success in the run artifacts

#### Scenario: Unsafe overlap is detected
- **WHEN** a page contains a full-slide uncleaned source image plus editable text overlays
- **THEN** validation SHALL fail with a message explaining that baked text would overlap editable text

#### Scenario: Required text is missing
- **WHEN** accepted required text from AIPPT metadata or OCR is absent from the composed PPTX
- **THEN** validation SHALL fail and report the affected page and text item

#### Scenario: Preview differs beyond threshold
- **WHEN** preview comparison against the source slide exceeds configured visual difference thresholds after bounded repair attempts
- **THEN** validation SHALL fail unless the request explicitly allows a lower-fidelity fallback

### Requirement: Explicit fallback policy
The system SHALL only use lower-fidelity fallback behavior when the request explicitly allows it.

#### Scenario: Default fallback policy
- **WHEN** a generative editable PPTX request omits fallback policy
- **THEN** the system SHALL use `fail` as the fallback policy

#### Scenario: Text-editable fallback policy
- **WHEN** fallback policy is `text_editable_background` and full asset reconstruction fails
- **THEN** the system SHALL return a PPTX using the text-clean background plus editable text boxes when that fallback can be generated, and SHALL record that lower-fidelity fallback was used

#### Scenario: Text-editable fallback fails
- **WHEN** fallback policy is `text_editable_background` and the text-clean background fallback cannot be generated
- **THEN** the system SHALL fail with the original reconstruction failure and the fallback failure reason

#### Scenario: Raster fallback policy
- **WHEN** fallback policy is `raster_pptx` and generative editable reconstruction fails
- **THEN** the system SHALL return the existing raster PPTX output when that fallback can be generated, and SHALL record that raster fallback was used

#### Scenario: Raster fallback fails
- **WHEN** fallback policy is `raster_pptx` and the raster PPTX fallback cannot be generated
- **THEN** the system SHALL fail with the original reconstruction failure and the fallback failure reason

#### Scenario: Invalid fallback policy
- **WHEN** a request sets fallback policy to any unsupported value
- **THEN** the system SHALL reject the request with a clear validation error

### Requirement: Frontend export experience
The system SHALL expose generative editable PPTX export from the frontend with distinct labeling, synchronous loading state, and errors.

#### Scenario: User selects generative editable PPTX
- **WHEN** slides are exportable and the user chooses the high-fidelity editable PPTX export option
- **THEN** the frontend SHALL send the generative editable export format, current slide images, slide order, aspect ratio, available text metadata, and selected fallback policy to the backend

#### Scenario: Generative export shows loading state
- **WHEN** the generative editable export is running
- **THEN** the frontend SHALL display an indeterminate loading state without claiming backend stage progress and without blocking existing slide viewing or project state

#### Scenario: Generative export fails validation
- **WHEN** the backend returns a validation, configuration, provider, or repair-limit error
- **THEN** the frontend SHALL show the error message and SHALL keep the existing deck, slides, and edit state unchanged

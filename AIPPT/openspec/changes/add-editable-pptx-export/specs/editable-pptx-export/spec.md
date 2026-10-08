## ADDED Requirements

### Requirement: Explicit editable PPTX export mode
The system SHALL provide an explicit editable PPTX export mode without changing the existing PDF and raster PPTX export behavior.

#### Scenario: Existing raster PPTX export remains unchanged
- **WHEN** a user exports with format `pptx`
- **THEN** the system SHALL return a PPTX that preserves the existing full-slide image export behavior

#### Scenario: Editable PPTX export is requested
- **WHEN** a user exports with format `editable_pptx`
- **THEN** the system SHALL run the editable reconstruction pipeline and return a PowerPoint `.pptx` file if validation passes

#### Scenario: Unsupported export format
- **WHEN** a user submits an export format other than `pdf`, `pptx`, or `editable_pptx`
- **THEN** the system SHALL reject the request with a clear validation error

### Requirement: Editable export options
The system SHALL support explicit editable export options while preserving backward compatibility for existing export requests.

#### Scenario: Default fallback policy
- **WHEN** an editable PPTX request omits `editable_options.fallback_policy`
- **THEN** the system SHALL treat the fallback policy as `fail`

#### Scenario: Raster fallback policy
- **WHEN** an editable PPTX request sets `editable_options.fallback_policy` to `raster_pptx` and editable reconstruction fails
- **THEN** the system SHALL return the existing raster PPTX output and SHALL expose response metadata that editable fallback was used

#### Scenario: Invalid fallback policy
- **WHEN** an editable PPTX request sets `editable_options.fallback_policy` to any value other than `fail` or `raster_pptx`
- **THEN** the system SHALL reject the request with a clear validation error

### Requirement: Editable deck manifest
The system SHALL create a deck manifest and one page manifest per slide for every editable PPTX export run.

#### Scenario: Manifest records page structure
- **WHEN** an editable export run processes a slide
- **THEN** the page manifest SHALL record source image size, slide size, background asset, image layers, native shapes, text boxes, provenance, and validation status

#### Scenario: Manifest uses source pixel coordinates
- **WHEN** the manifest stores positions for text boxes, image layers, and native shapes
- **THEN** positioned objects SHALL use source-image pixel coordinates before composition

#### Scenario: Manifest is sufficient for deterministic rebuild
- **WHEN** the PPTX composer receives the deck manifest and referenced page assets
- **THEN** it SHALL rebuild the same slide ordering, object ordering, and slide dimensions without re-running OCR, layer extraction, or background cleanup

### Requirement: Text reconstruction
The system SHALL rebuild slide text as editable PowerPoint text boxes.

#### Scenario: Text metadata is supplied
- **WHEN** a slide includes optional text metadata
- **THEN** each text item SHALL accept `text`, `role`, `order`, and optional `style_hint` fields, and the slide SHALL accept an optional `slide_id`

#### Scenario: AIPPT text metadata is available
- **WHEN** a slide includes AIPPT-generated text metadata and OCR detects a matching layout region
- **THEN** the system SHALL use the AIPPT metadata as the text content and OCR/layout data as position and style hints

#### Scenario: AIPPT text metadata is missing
- **WHEN** a slide has no usable text metadata
- **THEN** the system SHALL use OCR results to create editable text boxes with text content, position, font size, color, alignment, and confidence metadata

#### Scenario: Text overlays are composed
- **WHEN** editable text boxes are included in the final PPTX
- **THEN** each text box SHALL be editable in PowerPoint and SHALL be placed above background and visual layers

### Requirement: Background cleanup for editable text
The system SHALL avoid duplicated baked text when editable text overlays are produced.

#### Scenario: Text regions are accepted
- **WHEN** the text extraction stage accepts text boxes for a page
- **THEN** the background cleanup stage SHALL create masks from those regions and produce a cleaned background candidate

#### Scenario: Local cleanup is sufficient
- **WHEN** a masked text region is classified as flat or locally repairable
- **THEN** the system SHALL use local fill or local inpaint before attempting any remote or generative repair

#### Scenario: Cleanup strategy is recorded
- **WHEN** a page background is cleaned or preserved
- **THEN** the page manifest SHALL record the background strategy and any fallback decision used for that page

### Requirement: Visual layer extraction
The system SHALL extract non-text visual content into movable PPT image layers using a pluggable provider interface.

#### Scenario: Layer provider succeeds
- **WHEN** the configured layer provider returns RGBA layers with valid bounds
- **THEN** the system SHALL add those layers to the page manifest as positioned image assets with provenance

#### Scenario: Text-like layers overlap OCR text
- **WHEN** a returned image layer overlaps an accepted text box and is classified as baked text
- **THEN** the system SHALL exclude that layer from visual image assets so editable text is not duplicated

#### Scenario: Layer provider is unavailable
- **WHEN** the layer provider is unavailable or times out
- **THEN** the system SHALL fail the editable export with a clear recoverable error unless the request explicitly allows fallback behavior

### Requirement: Provider configuration
The system SHALL select OCR, layer extraction, and repair providers through backend configuration and SHALL support credential-free fake providers for tests.

#### Scenario: Fake providers are configured
- **WHEN** tests configure fake OCR, fake layer, and fake repair providers
- **THEN** the editable export pipeline SHALL run without external model credentials or network calls

#### Scenario: Production provider is missing configuration
- **WHEN** a production provider is selected but required configuration is missing
- **THEN** the system SHALL fail before processing pages with a clear provider configuration error

#### Scenario: Provider timeout is reached
- **WHEN** a configured provider exceeds its timeout
- **THEN** the system SHALL stop the editable pipeline and apply the request fallback policy

### Requirement: Native simple shape fitting
The system SHALL convert high-confidence simple visual layers into native PowerPoint shapes.

#### Scenario: Simple rectangle is detected
- **WHEN** a visual layer is classified as a high-confidence rectangle or rounded rectangle
- **THEN** the system SHALL represent it as a native PPT shape with position, size, fill, stroke, opacity, and corner radius when available

#### Scenario: Simple line is detected
- **WHEN** a visual layer is classified as a high-confidence straight line
- **THEN** the system SHALL represent it as a native PPT line or equivalent native shape with endpoints, stroke color, and width

#### Scenario: Shape confidence is low
- **WHEN** a visual layer cannot be fitted to a supported native shape above the configured confidence threshold
- **THEN** the system SHALL preserve it as a bitmap image layer rather than emitting an inaccurate native shape

### Requirement: PPTX composition
The system SHALL compose the editable PPTX from manifest data in a deterministic layer order.

#### Scenario: Page is composed
- **WHEN** the composer builds a page from its manifest
- **THEN** it SHALL place objects in this order: cleaned background, native shapes, bitmap image layers, editable text boxes

#### Scenario: Slide aspect ratio is 16:9
- **WHEN** the export request uses aspect ratio `16:9`
- **THEN** the editable PPTX SHALL use the same 16:9 slide dimensions as the existing raster PPTX export

#### Scenario: Slide aspect ratio is 4:3
- **WHEN** the export request uses aspect ratio `4:3`
- **THEN** the editable PPTX SHALL use the same 4:3 slide dimensions as the existing raster PPTX export

### Requirement: Validation and preview
The system SHALL validate editable PPTX output before returning it.

#### Scenario: Validation passes
- **WHEN** the composed PPTX passes structural validation
- **THEN** the system SHALL return the PPTX and record validation success in the run artifacts

#### Scenario: Preview artifact is recorded
- **WHEN** the composed PPTX is validated
- **THEN** the system SHALL create or record a deterministic preview artifact for each page in the run artifacts

#### Scenario: Validation finds unsafe full-slide source overlap
- **WHEN** a page contains a full-slide uncleaned source image plus editable text overlays
- **THEN** validation SHALL fail with a message explaining that baked text would overlap editable text

#### Scenario: Required text is missing
- **WHEN** accepted text content from metadata or OCR is absent from the composed PPTX
- **THEN** validation SHALL fail and report the affected page and text item

### Requirement: Frontend export experience
The system SHALL expose editable PPTX export from the frontend with distinct labeling, progress, and errors.

#### Scenario: User selects editable PPTX
- **WHEN** slides are exportable and the user chooses editable PPTX export
- **THEN** the frontend SHALL send the editable export format and current slide images, slide order, aspect ratio, and available text metadata to the backend

#### Scenario: Editable export reports progress
- **WHEN** the editable export is running
- **THEN** the frontend SHALL display stage-based export progress without blocking existing slide viewing or project state

#### Scenario: Editable export fails
- **WHEN** the backend returns an editable export validation or provider error
- **THEN** the frontend SHALL show the error message and SHALL keep the existing deck state unchanged

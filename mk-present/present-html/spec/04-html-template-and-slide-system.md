# HTML Template & Slide System Specification

## 1. Base HTML Structure

Every presentation MUST follow this strict structure:

```html
<!DOCTYPE html>
<html lang="zh-CN">  <!-- or "en" / "zh-en" -->
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Presentation Title</title>
    <!-- Font imports (Google Fonts / Fontshare) -->
    <style>
        /* CSS Custom Properties */
        /* viewport-base.css (FULL contents) */
        /* Style-specific CSS */
        /* Animation classes */
    </style>
</head>
<body>
    <!-- Progress bar -->
    <div class="progress-bar" id="progressBar"></div>
    <!-- Navigation dots -->
    <nav class="nav-dots" id="navDots"></nav>
    <!-- Slide counter -->
    <div class="slide-counter" id="slideCounter"></div>

    <!-- SLIDES -->
    <section class="slide title-slide">...</section>
    <section class="slide">...</section>
    <section class="slide closing-slide">...</section>

    <script>
        class SlidePresentation { ... }
    </script>
</body>
</html>
```

## 2. Slide Types (11 Templates)

### 2.1 Title Slide
- Full-screen, centered or asymmetric
- Heading + subtitle + optional author/date
- Cinematic impact, minimal content

### 2.2 Section Divider
- Full-bleed color or gradient background
- Large text marking a new section
- "Part 02" / chapter number

### 2.3 Content + Bullets
- Standard workhorse: heading + optional subheading + bullet list
- 4-6 bullet points max
- Accent-colored bullet markers (CSS, not emoji)

### 2.4 Two-Column / Side-by-Side
- Text left, image/visual right (or vice versa)
- Stacks vertically on mobile
- Responsive via `flex-direction: row` → `column`

### 2.5 Card Grid
- 3-6 cards in responsive grid
- `grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr))`
- Icon + title + description per card

### 2.6 Comparison (A vs B)
- Two columns with visual divider
- Left: old/pain. Right: new/benefit
- Grid layout: `1fr auto 1fr`

### 2.7 Timeline / Process Steps
- 4-5 nodes horizontally
- Connecting line between nodes
- Numbered steps with brief descriptions

### 2.8 Quote / Testimonial
- Large pull-quote with serif
- Attribution below
- Max 3 lines of quote text

### 2.9 Stats / Numbers
- 3-4 big numbers with labels
- Counter animation (JS IntersectionObserver + requestAnimationFrame)
- Ease-out cubic interpolation

### 2.10 Image Showcase
- Full-bleed or centered image
- Minimal text overlay
- `object-fit: cover` for images

### 2.11 Code Showcase
- Syntax-highlighted code block
- Filename header bar
- Technical, monospace presentation

## 3. Navigation Controller

### 3.1 SlidePresentation Class

```
class SlidePresentation:
    - slides: NodeList of .slide elements
    - currentSlide: int
    - isAnimating: boolean

    Methods:
    - init(): Setup all navigation systems
    - setupIntersectionObserver(): Triggers .visible class on scroll
    - setupKeyboardNav(): Arrows, Space, Home/End, PageUp/PageDown
    - setupTouchNav(): Swipe up/down with 50px threshold
    - setupWheelNav(): Mouse wheel with 50ms debounce
    - setupProgressBar(): Top progress bar width update
    - setupNavDots(): Generate dot buttons, click navigation
    - setupSlideCounter(): "current / total" display
    - goToSlide(index): Core navigation (with scrollIntoView)
    - updateUI(): Update progress bar, dots, counter
```

### 3.2 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` `→` `↑` `↓` | Navigate one slide |
| `Space` | Next slide |
| `PageDown` / `PageUp` | Next / Previous |
| `Home` | First slide |
| `End` | Last slide |
| `E` | Toggle edit mode (if enabled) |

### 3.3 Required Global Export

```javascript
window.go = function(index) {
    if (presentation) presentation.goToSlide(index);
};
```

Required for Phase 7 comparison page synced navigation.

## 4. Inline Editing (Opt-In)

### 4.1 Architecture

- Hover hotzone (80x80px) in top-left corner
- 400ms delay timeout before showing edit button
- Press `E` or click to toggle edit mode
- All text elements become `contentEditable`

### 4.2 CSS Structure

```css
.edit-hotzone { position: fixed; top: 0; left: 0; width: 80px; height: 80px; z-index: 10000; }
.edit-toggle { position: fixed; top: 16px; left: 16px; opacity: 0; pointer-events: none; }
.edit-toggle.show { opacity: 1; pointer-events: auto; }
```

### 4.3 JS Behavior

- `mouseenter`/`mouseleave` with timeout for hotzone and button
- Skip elements in nav-dots, edit-toggle, slide-counter
- Editable outline: `1px dashed var(--accent-glow)`

## 5. Image Pipeline

### 5.1 Image Processing (Python/Pillow)

```python
def crop_circle(input_path, output_path):  # RGBA circular crop
def resize_max(input_path, output_path, max_dim=1200):  # LANCZOS thumbnail
```

### 5.2 Image Constraints in HTML

```css
img { max-width: 100%; max-height: min(50vh, 400px); object-fit: contain; }
```

### 5.3 Notes

- Use direct file paths (`src="assets/..."`), not base64
- Presentations viewed locally
- Skip image pipeline if no images

## 6. Required HTML Attributes

- Semantic HTML: `<section>`, `<nav>`, `<blockquote>`, `<cite>`
- ARIA labels on interactive elements
- `lang` attribute on `<html>` matching presentation language
- All CSS/JS inline in single file

## 7. Watermark

Default on every presentation (last slide):
- "Made with Present HTML"
- `color: var(--text-muted); font-size: var(--small-size);`
- Link to `https://github.com/textboy/mk-present`
- Opt-out: remove if user explicitly requests "no watermark"

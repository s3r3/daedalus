# Viewport & Responsive System Specification

## 1. Core Invariant (NON-NEGOTIABLE)

Every `.slide` MUST fit exactly within the viewport. No scrolling. Content overflows → split into multiple slides.

```css
.slide {
    width: 100vw;
    height: 100vh;
    height: 100dvh; /* Dynamic viewport height for mobile */
    overflow: hidden; /* CRITICAL */
    scroll-snap-align: start;
    display: flex;
    flex-direction: column;
    position: relative;
}
```

## 2. Base Viewport Styles (viewport-base.css)

### 2.1 HTML/Body Lock

```css
html, body { height: 100%; overflow-x: hidden; }
html { scroll-snap-type: y mandatory; scroll-behavior: smooth; }
```

### 2.2 Content Container

```css
.slide-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    max-height: 100%;
    overflow: hidden; /* Double protection */
    padding: var(--slide-padding);
}
```

## 3. Typography Sizing (ALL Use clamp())

| Variable | Default Range |
|----------|--------------|
| `--title-size` | `clamp(2.8rem, 6.5vw, 5.5rem)` |
| `--h2-size` | `clamp(1.8rem, 3.8vw, 3.2rem)` |
| `--h3-size` | `clamp(1.2rem, 2vw, 1.6rem)` |
| `--body-size` | `clamp(1rem, 1.6vw, 1.25rem)` |
| `--small-size` | `clamp(0.8rem, 1.2vw, 1rem)` |
| `--stat-size` | `clamp(3.5rem, 8vw, 6.5rem)` |
| `--slide-padding` | `clamp(1rem, 4vw, 4rem)` |
| `--content-gap` | `clamp(0.5rem, 2vw, 2rem)` |
| `--element-gap` | `clamp(0.25rem, 1vw, 1rem)` |

**Default font sizes should be generous** — presentations are read at a distance.

## 4. Responsive Breakpoints

### 4.1 Height Breakpoints

| Breakpoint | Behavior |
|-----------|----------|
| `max-height: 700px` | Reduce slide-padding, content-gap, title/h2 sizes |
| `max-height: 600px` | Further reduction, hide nav-dots and decorative elements |
| `max-height: 500px` | Minimal spacing, stack comparisons vertically, smallest text |

### 4.2 Width Breakpoints

| Breakpoint | Behavior |
|-----------|----------|
| `max-width: 600px` | Stack all grids to 1 column, stack two-column layouts |
| `min-width: 2000px` | Cap content width at 1600px, centered |

### 4.3 Special Cases

- **Tall narrow phones** (`max-width: 600px` AND `min-height: 700px`): Increase padding for thumb-friendly spacing
- **Ultra-wide** (`min-width: 2000px`): Cap .slide-content at 1600px to prevent sparse layouts

## 5. Content Constraints

```css
/* Cards/containers */
.card { max-width: min(90vw, 1000px); max-height: min(80vh, 700px); }

/* Images */
img { max-width: 100%; max-height: min(50vh, 400px); object-fit: contain; }

/* Grids */
.grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); }
```

## 6. CJK-Specific Typography

```css
:lang(zh), :lang(zh-CN), :lang(zh-TW), :lang(ja), :lang(ko) {
    line-height: 1.8; /* CJK characters need generous line height */
    overflow-wrap: break-word; /* Never use break-all */
}
```

## 7. High DPI / Retina

```css
@media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
    .card { border-width: 0.5px; }
}
```

## 8. Print Styles

```css
@media print {
    html { scroll-snap-type: none; }
    .slide { height: auto; min-height: 100vh; overflow: visible; page-break-after: always; }
    .progress-bar, .nav-dots, .slide-counter, .edit-hotzone, .edit-toggle { display: none; }
    .reveal, [class*="reveal-"] { opacity: 1 !important; transform: none !important; }
}
```

## 9. Dark Mode / Light Mode Auto-Detect

```css
@media (prefers-color-scheme: light) {
    .auto-theme { /* Invert colors for light-mode presets */
        --bg-primary: #ffffff;
        --bg-secondary: #f8f9fa;
        --text-primary: #1a1a2e;
        /* ... */
    }
}
```

Only applies if presentation uses `.auto-theme` class. Dark-only presentations should NOT use this.

## 10. Visual Overflow Checklist

- Every `.slide` has `overflow: hidden`
- `font-size` and spacing use `clamp()` — no fixed px/rem
- Content containers have `max-height` constraints
- Images: `max-height: min(50vh, 400px)`
- Three height breakpoints: 700px, 600px, 500px
- `prefers-reduced-motion` support
- Text overflow: `overflow-wrap: break-word`

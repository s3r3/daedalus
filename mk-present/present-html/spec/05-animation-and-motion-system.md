# Animation & Motion System Specification

## 1. Design Philosophy

- Focus on high-impact moments: one well-orchestrated page load with staggered reveals
- Use exponential easing (ease-out-quart/quint/expo) for natural deceleration
- Animate `transform` and `opacity` ONLY — never layout properties (width, height, padding, margin)
- No bounce or elastic easing — real objects decelerate smoothly
- Every animation must degrade gracefully with `prefers-reduced-motion`

## 2. Easing Curves

```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);       /* Smooth deceleration */
--ease-out-back: cubic-bezier(0.34, 1.56, 0.64, 1);    /* Slight overshoot */
--ease-spring: cubic-bezier(0.175, 0.885, 0.32, 1.275); /* Springy bounce */
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);       /* Quick start, gentle stop */
--ease-in-out-cubic: cubic-bezier(0.65, 0, 0.35, 1);   /* Symmetric, natural */
```

Duration guidelines:
- Instant: 0.15s (hover states, micro-interactions)
- Fast: 0.3s (corporate, professional)
- Normal: 0.6s (general purpose)
- Slow: 1s (dramatic, editorial)
- Dramatic: 1.5s (cinematic, calm)

## 3. Mood-to-Animation Map

### 3.1 Dramatic / Cinematic
**Tempo:** Slow, deliberate (0.8-1.5s)
- Title: Slow fade + scale from 0.85
- Subtitle: Delayed fade up (0.4s delay)
- Background: Slow gradient shift (15s)
- Section transition: Blur in from 20px
- Image: Clip-path wipe from center

### 3.2 Techy / Futuristic
**Tempo:** Medium-fast, precise (0.3-0.6s)
- Title: Glitch/scramble text (JS character scramble)
- Cards: Grid reveal with 0.06s stagger
- Accent: Neon glow pulse
- Background: Grid lines or particle canvas
- Data: Counter roll-up (requestAnimationFrame)

### 3.3 Playful / Friendly
**Tempo:** Bouncy, springy (0.4-0.8s with overshoot)
- Cards: Bounce in from below (ease-out-back)
- Icons: Pop + slight rotate
- Hover: Float/bob effect
- Background: Soft gradient blobs, slow drift

### 3.4 Professional / Corporate
**Tempo:** Crisp, fast, no-nonsense (0.2-0.4s)
- All elements: Quick fade up (15px)
- Charts: Draw-in / stroke-dashoffset
- No overshoot, minimal

### 3.5 Calm / Minimal
**Tempo:** Very slow, gentle (1-2s)
- Text: Gentle fade only, no movement
- Images: Very slow scale (2s)
- Background: Slow gradient morph (20s+)
- Reduced motion friendly

### 3.6 Editorial / Magazine
**Tempo:** Deliberate, staggered (0.4-0.8s)
- Headlines: Mask reveal (clip-path inset)
- Body: Staggered line-by-line (0.05s per line)
- Images: Parallax on scroll
- Pull quotes: Slide from left with border

### 3.7 Energetic / Dynamic
**Tempo:** Fast, punchy (0.2-0.5s)
- Title: Slam in from top
- Cards: Rapid stagger pop (0.04s stagger)
- Background: High-contrast color flash
- Text: Typewriter at 30ms per char

## 4. Universal Animation Classes

```css
.reveal           /* Fade + slide up (default, most versatile) */
.reveal-scale     /* Scale in (cards, images) */
.reveal-left      /* Slide from left (text, quotes) */
.reveal-right     /* Slide from right */
.reveal-blur      /* Blur in (hero elements, dramatic) */
.reveal-flip      /* Flip in (3D card effect) */
.reveal-bounce    /* Bounce in (playful) */
.reveal-pop       /* Pop with rotate (playful icons) */
.reveal-crisp     /* Quick fade up (corporate) */
.reveal-gentle    /* Fade only (calm) */
.reveal-mask      /* Clip-path inset mask (editorial) */
.reveal-quote     /* Slide-in with left border (editorial) */
.reveal-slam      /* Slam from top (energetic) */
.reveal-diagonal  /* Diagonal clip-path wipe (energetic) */
.reveal-zoom-settle /* Slow zoom settle (calm) */
```

## 5. Stagger Animation Pattern

CSS-based staggered delays via nth-child:

```css
.reveal:nth-child(1) { transition-delay: 0.08s; }
.reveal:nth-child(2) { transition-delay: 0.16s; }
/* ... up to 8 elements */
```

## 6. Background Effects

| Effect | CSS Technique |
|--------|--------------|
| Gradient Mesh | Multiple layered radial gradients |
| Animated Drift | `background-position` animation over 15s |
| Noise Texture | Inline SVG `feTurbulence`, 4% opacity |
| Dot Grid | `radial-gradient(circle, ...) background-size` |
| Vignette | `radial-gradient(ellipse at center, transparent 50%, black 100%)` |
| Grid Lines | Repeating-linear-gradient |
| Scan Line | Repeating-linear-gradient, 2px |

## 7. Interactive Effects (JS)

| Effect | Description |
|--------|-------------|
| TiltEffect | 3D tilt on hover via mouse position → rotateX/rotateY |
| MagneticButton | Cursor attracts element via translate |
| CursorTrail | Custom cursor with trail dot |
| Parallax | Scroll-driven translateY via `data-parallax` attribute |

## 8. Trigger Mechanism

- All animations triggered by `.visible` class on parent `.slide`
- IntersectionObserver adds `.visible` when slide enters viewport (50% threshold)
- Transitions defined on child elements using `reveal-*` classes

## 9. Reduced Motion (Accessibility)

```css
@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.2s !important;
        scroll-behavior: auto !important;
    }
    .reveal, [class*="reveal-"] {
        opacity: 0;
        transform: none !important;
        filter: none !important;
        clip-path: none !important;
    }
    .visible .reveal, .visible [class*="reveal-"] {
        opacity: 1;
    }
}
```

## 10. Counter Animation

```javascript
// Stats slide counter: ease-out cubic over 1500ms
const start = performance.now();
function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    el.textContent = prefix + Math.round(target * eased) + suffix;
    if (progress < 1) requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

## 11. Text Scramble Effect (Tech Mood)

```javascript
class TextScramble {
    // chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'
    // Random character substitution over ~40 frames
    // Resolves via Promise when scramble completes
}
```

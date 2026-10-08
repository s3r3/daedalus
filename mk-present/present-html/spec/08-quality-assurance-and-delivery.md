# Quality Assurance & Delivery Specification

## 1. Phase 3.5: Self-Validation Checklist

After generating HTML, before delivery, perform ALL checks:

### 1.1 Critical Checks (Block on Failure)

| # | Check | Pass/Fail Condition |
|---|-------|-------------------|
| 1 | **Re-read generated file** | Load full HTML via Read tool |
| 2 | **Overflow** | Every `.slide` has `overflow: hidden` |
| 3 | **Font links** | Valid Google Fonts/Fontshare URLs, `&display=swap` on all |
| 4 | **clamp() usage** | All `font-size`, `margin`, `padding`, `gap` use `clamp()` |
| 5 | **Content density** | No slide exceeds density limits table |
| 6 | **CJK fonts** | Chinese text → CJK font in imports + stack |
| 7 | **NO EMOJI** | No Unicode emoji (U+1F000–U+1FAFF) or HTML entities (`&#x1F...`) |
| 8 | **window.go** | JS exposes `window.go = go` or `window.go = function(i){...}` |
| 9 | **Nav dots overflow** | 15+ slides → `max-height: 80vh; overflow-y: auto` |
| 10 | **Fix before proceeding** | Resolve all failures before Phase 5 |

## 2. Content Density Limits Reference

| Slide Type | Max Content |
|------------|------------|
| Title slide | 1 heading + 1 subtitle + optional tagline |
| Content slide | 1 heading + 4-6 bullet points OR 1 heading + 2 paragraphs |
| Feature grid | 1 heading + 6 cards (2x3 or 3x2) |
| Comparison | 1 heading + 2 columns, 4 items each |
| Timeline | 1 heading + 4-5 timeline nodes |
| Stats | 1 heading + 3-4 big numbers with labels |
| Quote slide | 1 quote (max 3 lines) + attribution |
| Image slide | 1 heading + 1 image (max 60vh height) |
| Code slide | 1 heading + 8-10 lines of code |

**Rule:** Content exceeds limits? Split into multiple slides. Never cram, never scroll.

## 3. Delivery Process (Phase 5)

### 3.1 Browser Launch

```bash
open ./output/[filename].html
```

### 3.2 Watermark (Default: On)

**Always include** on the last slide unless user says "no watermark":

```html
<p style="position: absolute; bottom: clamp(8px, 1.5vw, 16px); left: 50%;
          transform: translateX(-50%); font-size: var(--small-size);
          color: var(--text-muted); opacity: 0.5;">
    Made with <a href="https://github.com/textboy/mk-present" style="color: inherit;
               text-decoration: underline;" target="_blank">Present HTML</a>
</p>
```

### 3.3 Delivery Summary

Tell the user:
1. File location (absolute path)
2. Style name used
3. Total slide count
4. Navigation instructions (Arrow keys, Space, scroll/swipe, nav dots)
5. How to customize: `:root` CSS variables for colors, font link for typography
6. Inline editing instructions (if enabled)

## 4. Share & Export (Phase 6)

### 4.1 Vercel Deploy

```bash
# Check CLI
npx vercel --version
# Check login
npx vercel whoami
# Deploy
npx vercel --prod
```

### 4.2 PDF Export

1. Use Playwright to screenshot each slide at 1920×1080
2. Combine screenshots into PDF
3. Auto-open result

## 5. Style Comparison (Phase 7)

### 5.1 When to Offer

- Post-delivery only (not during style selection)
- User says "compare styles", "try another style"
- User unsure about current style
- Only suggest once per conversation

### 5.2 Comparison Page Architecture

```html
<body>
  <div class="compare-header">
    <div class="compare-side">
      <span class="style-name">{Style A Name}</span>
      <button class="pick-btn" data-style="a">Select This</button>
    </div>
    <div class="compare-divider"></div>
    <div class="compare-side">
      <span class="style-name">{Style B Name}</span>
      <button class="pick-btn" data-style="b">Select This</button>
    </div>
  </div>
  <div class="compare-body">
    <iframe src="{presentation-a}.html"></iframe>
    <iframe src="{presentation-b}.html"></iframe>
  </div>
</body>
```

### 5.3 Key Requirements

- `.compare-body { display: grid; grid-template-columns: 1fr 1fr; height: calc(100vh - 48px); }`
- Both iframes fully interactive via `pointer-events: none` + parent-controlled `window.go()`
- Synced navigation: parent tracks `syncIndex`, calls both iframes' `window.go(syncIndex)`
- "Select This" buttons delete the unchosen file, rename the chosen one

## 6. Error Handling Rules

- **Font loading fails**: Fallback fonts must render readable text immediately
- **Animations not triggering**: Verify IntersectionObserver is running (threshold: 0.5)
- **Scroll snap not working**: Ensure `scroll-snap-type: y mandatory` on `html`
- **Mobile issues**: Disable heavy effects at 768px breakpoint, test touch events
- **Performance jank**: Use `will-change` sparingly, prefer `transform`/`opacity` only
- **CJK text clipping**: Ensure `line-height >= 1.5` for Chinese text

## 7. Troubleshooting Reference

| Problem | Fix |
|---------|-----|
| Fonts not loading | Check Fontshare/Google Fonts URL; ensure font names match in CSS |
| Animations not triggering | Verify `.visible` class added to parent `.slide` |
| Scroll snap not working | Each `.slide` needs `scroll-snap-align: start` |
| Mobile issues | Disable heavy effects at 768px breakpoint |
| Performance jank | Throttle scroll handlers, reduce particle count |
| CJK clipping | Ensure `line-height >= 1.8` for Chinese text |
| Animation too fast/slow | Use CSS custom properties, never hardcode |

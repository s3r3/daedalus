# PPT-Compatible HTML Guide

This guide defines the "Constitution" for creating HTML layouts that can be flawlessly converted to native PowerPoint (PPTX) slides. All Layout Architect Agents MUST follow these rules.

## The Core Philosophy
**Separation of Structure (Shape) and Content (Text).**

In HTML, a `<div>` can be a box and text at the same time. In PowerPoint, a Shape and a Text Box are distinct objects. To ensure accurate conversion, we must write HTML that respects this distinction.

## The Survival Rules

These are not just "best practices" — they are **Laws of Physics** for the PPTX Generator. Violating them results in broken slides.

### 1. The Golden Rule: Explicit Sizing - **CRITICAL**
**All major containers MUST have explicit dimensions.** The converter cannot guess defaults.
*   **Allowed**: `px`, `%`, `flex: 1`, `grid-row/column`.
*   **FORBIDDEN**: `auto`, `fit-content`, `min-content`.
*   **Why**: PPTX objects need exact coordinates (X, Y, W, H). `auto` sizing leaves these undefined until render time, which the converter might misinterpret.

### 2. Content Safety First
**Rule**: If content (text) is long, the Layout **MUST** adapt to fit it.
*   **Scenario**: A paragraph is too long for a fixed-height card.
*   **Wrong Fix**: `overflow: hidden` (The text disappears = **Failure**).
*   **Right Fix**:
    1.  **Layout Fix**: Increase the Container Height (grid-row span).
    2.  **Style Fix**: Decrease Font Size (but keep readable).
    3.  **Layout Fix**: Move to a new column/slide.
*   **The Law**: Content visibility > Design aesthetics.

### 3. Canvas Bounds
The world ends at `1280px` (width) and `720px` (height).
*   **X-Axis**: Ensure `grid-column: -1` actually maps to the 12th column within safe margins.
*   **Y-Axis**: Ensure footer content does not get pushed below `720px`. The Slide 719px line is the cliff edge.

### 4. Decorator Positioning
**NEVER use `position: absolute` for structural elements** (headers/footers/content). Use Grid to place them reliably. Absolute positioning is reserved *only* for non-essential decorative blobs or watermarks that are independent of content flow.

## 🛑 Critical Rules (The "Must-Nots")

### 1. No Mixed Content (Divs are for Shapes, P tags are for Text)
**NEVER** put direct text inside a styled `<div>`.
*   ❌ **Bad:** `<div style="background:red;">Hello World</div>` (The text will likely disappear or the box will be malformed).
*   ✅ **Good:**
    ```html
    <div style="position:relative;">
      <div style="position:absolute; inset:0; background:red;"></div>
      <p style="position:relative;">Hello World</p>
    </div>
    ```
*   **Physics Law**: All text **MUST** be wrapped in `<p>`, `<h1>-<h6>`, `<ul>`, or `<ol>` tags to appear in PowerPoint. Bare text inside a `<div>` is strictly forbidden.

### 2. No CSS Background Images
**NEVER** use `background-image: url(...)` in CSS for any element.
*   ❌ **Bad**: `<div style="background-image: url('bg.png');">...</div>`
*   ✅ **Good**: Use native `<img>` tags and layer content on top.
*   **Reason**: The converter only maps `<img>` tags to native PPT Picture objects. Background images are usually ignored or rendered incorrectly.

### 3. No Box Styles on Text Tags
**NEVER** apply background, border, or box-shadow to text tags (`p`, `h1`-`h6`, `span`, `li`, `b`, `i`, `u`).
*   ❌ **Bad:** `<p style="background:blue; border:1px solid black;">Text</p>` (PPT text boxes do not support complex box styles during conversion).
*   ❌ **Bad:** `<span style="background:grey;">Badge</span>` (This will trigger a conversion error).
*   ✅ **Good:**
    ```html
    <div style="background:blue; border:1px solid black; padding: 4pt;">
      <p style="color:white;">Text</p>
    </div>
    ```
*   **Physical Law**: Text tags are for content, color, weight, and font only. Any "box" decoration must be provided by a `<div>`.

### 3. Advanced CSS (Auto-Baked)
The following CSS properties are **ALLOWED** and will be **Automatically Baked** into images during conversion.
*   ✅ `linear-gradient` / `radial-gradient`
*   ⚠️ `backdrop-filter` (Glassmorphism) - **Not Supported** (Will degrade to transparent/solid background)
*   ✅ `box-shadow` (Inset or complex)
*   ✅ `clip-path` / `mask-image`

**Note:** Elements using these effects will become **Non-Editable Images** in PowerPoint. Ensure text is placed *outside* these containers if you want the text to remain editable.

---

## 🟢 Safe List (The "Can-Dos")

You may safely use these HTML/CSS features. They will be mapped to native PPT objects.

| HTML/CSS Feature | Maps To (PPTX) | Notes |
| :--- | :--- | :--- |
| `<div>` + `background-color` | Shape (Rectangle) | Solid colors only (Hex allowed) |
| `<div>` + `border` | Shape Border | Solid lines only |
| `<div>` + `border-radius` | JSON Geometry | Becomes Rounded Rectangle or Circle |
| `<div>` + `box-shadow` | Shape Shadow | Outer shadows only |
| `<p>`, `<h1>`... | Text Box | Standard text block |
| `<b>`, `<i>`, `<u>` | Rich Text Run | Inline formatting |
| `color: #HEX` | Font Color | |
| `font-family: Arial` | Font Face | Use Web-Safe fonts only |
| `<img src="...">` | Picture | |
| `.placeholder` | (Coordinates) | Invisible marker for Charts |

---

## 🏗️ Structural Patterns (Copy These!)

### Pattern A: The Card (Background + Text)
```html
<div class="card-container" style="position:relative; width:300pt; height:200pt;">
    <!-- Background Shape -->
    <div class="card-bg" style="position:absolute; inset:0; background:#f0f0f0; border-radius:10pt;"></div>
    
    <!-- Content Layer -->
    <div class="card-content" style="position:relative; padding:20pt;">
        <h2 style="color:#333; margin-bottom:10pt;">Card Title</h2>
        <p style="color:#666;">This is the card body text.</p>
    </div>
</div>
```

### Pattern B: The Image Mask (Circle Image)
Since `clip-path` is forbidden, use `border-radius` on an `<img>` tag (if supported) or a pre-masked PNG.
*   **Best Practice:**
    ```html
    <img src="avatar.jpg" style="width:100pt; height:100pt; border-radius:50%; object-fit:cover;">
    ```
    *(Note: Converter support for img border-radius varies; strict method is to crop image with Sharp first)*.

---

## 🛠️ Validation Workflow

Before treating any HTML as "Final", you MUST run the linter:

```bash
python3 my_skills/assemble_pptx_file/scripts/lint_ppt_html.py path/to/slide.html
```

*   **Exit Code 0**: Success. Proceed to conversion.
*   **Exit Code 1**: Check output errors and rewrite HTML.

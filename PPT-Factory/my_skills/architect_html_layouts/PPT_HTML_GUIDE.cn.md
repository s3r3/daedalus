# PPT 兼容 HTML 指南 (PPT-Compatible HTML Guide)

本指南定义了创建可完美转换为原生 PowerPoint (PPTX) 幻灯片的 HTML 布局的“宪法”。所有 Layout Architect Agent 必须遵守这些规则。

## 核心理念 (The Core Philosophy)
**结构 (形状) 与 内容 (文本) 分离。**

在 HTML 中，`<div>` 可以同时是一个盒子和文本。但在 PowerPoint 中，形状 (Shape) 和 文本框 (Text Box) 是截然不同的对象。为了确保准确转换，我们必须编写尊重这种区别的 HTML。

## 生存法则 (The Survival Rules)

这些不仅仅是“最佳实践”——它们是 PPTX 生成器的 **物理法则**。违反它们将导致幻灯片崩坏。

### 1. 黄金法则：明确尺寸 (Explicit Sizing) - **CRITICAL**
**所有主要容器必须有明确的尺寸。** 转换器无法猜测默认值。
*   **允许**: `px`, `%`, `flex: 1`, `grid-row/column`.
*   **禁止**: `auto`, `fit-content`, `min-content`.
*   **原因**: PPTX 对象需要确切的坐标 (X, Y, W, H)。`auto` 尺寸会导致这些值在渲染前未定义，从而导致转换错误。

### 2. 内容安全优先 (Content Safety First)
**法则**: 如果内容 (文本) 过长，布局 **必须** 适应它。
*   **场景**: 一段文字对于固定高度的卡片来说太长了。
*   **错误做法**: `overflow: hidden` (文字消失 = **失败**).
*   **正确做法**:
    1.  **布局修正**: 增加容器高度 (grid-row span).
    2.  **样式修正**: 减小字号 (保持可读性).
    3.  **布局修正**: 移动到新列或新页面.
*   **定律**: 内容可见性 > 设计美学。

### 3. 画布边界 (Canvas Bounds)
世界尽头在于 `1280px` (宽) 和 `720px` (高)。
*   **X 轴**: 确保 `grid-column: -1` 实际上映射到安全边距内的第 12 列。
*   **Y 轴**: 确保页脚内容不会被推到 `720px` 以下。719px 是悬崖边缘。

### 4. 装饰定位 (Decorator Positioning)
**切勿对结构元素（页眉/页脚/内容）使用 `position: absolute`**。使用 Grid 可靠地放置它们。绝对定位 **仅** 保留给不依赖内容流的非必要装饰性斑点或水印。

## 🛑 关键禁忌 (The "Must-Nots")

### 1. 禁止混合内容 (Divs are for Shapes, P tags are for Text)
**切勿** 将直接文本放在有样式的 `<div>` 中。
*   ❌ **错误:** `<div style="background:red;">Hello World</div>` (文本可能会消失或盒子变形).
*   ✅ **正确:** 
    ```html
    <div style="position:relative;">
      <div style="position:absolute; inset:0; background:red;"></div>
      <p style="position:relative;">Hello World</p>
    </div>
    ```
*   **物理定律**: 所有文本**必须**包裹在 `<p>`, `<h1>-<h6>`, `<ul>`, 或 `<ol>` 标签中才能在 PowerPoint 中显示。严禁在 `<div>` 中书写直接文本。

### 2. 禁止使用 CSS 背景图
**切勿** 在 `<div>` 或任何元素的 CSS 中使用 `background-image: url(...)` 加载图片。
*   ❌ **错误**: `<div style="background-image: url('bg.png');">...</div>`
*   ✅ **正确**: 使用原生的 `<img>` 标签并在其之上层叠内容。
*   **原因**: 转换引擎仅识别 `<img>` 标签为 PPT 图像对象。背景图不仅无法编辑，且通常会被转换器忽略。

### 2. 禁止样式化文本标签
**切勿** 给文本标签 (`p`, `h1`-`h6`, `span`, `li`, `b`, `i`, `u`) 添加盒子模型样式（背景、边框、投影）。
*   ❌ **错误:** `<p style="background:blue; border:1px solid black;">Text</p>` (PPT 文本框在转换中通常不支持复杂的边框/背景).
*   ❌ **错误:** `<span style="background:grey;">Badge</span>` (这将导致转换报错).
*   ✅ **正确:** 
    ```html
    <div style="background:blue; border:1px solid black; padding: 4pt;">
      <p style="color:white;">Text</p>
    </div>
    ```
*   **物理定律**: 文字标签仅用于定义内容、颜色、粗细和字体。任何“盒子”视觉效果必须由 `<div>` 提供。

### 3. 高级 CSS (自动烘焙)
以下 CSS 属性是 **允许** 的，并将在转换过程中 **自动烘焙** 到图像中。
*   ✅ `linear-gradient` / `radial-gradient`
*   ⚠️ `backdrop-filter` (毛玻璃) - **不支持** (将降级为透明/纯色背景)
*   ✅ `box-shadow` (内阴影或复杂阴影)
*   ✅ `clip-path` / `mask-image`

**注意:** 使用这些效果的元素在 PowerPoint 中将变为 **不可编辑的图像**。如果希望文本保持可编辑，请确保文本放置在这些容器 *外部*。

---

## 🟢 安全清单 (The "Can-Dos")

你可以安全地使用这些 HTML/CSS 功能。它们将被映射到原生的 PPT 对象。

| HTML/CSS Feature | Maps To (PPTX) | Notes |
| :--- | :--- | :--- |
| `<div>` + `background-color` | Shape (Rectangle) | 仅纯色 (Hex) |
| `<div>` + `border` | Shape Border | 仅实线 |
| `<div>` + `border-radius` | JSON Geometry | 变为圆角矩形或圆形 |
| `<div>` + `box-shadow` | Shape Shadow | 仅外阴影 |
| `<p>`, `<h1>`... | Text Box | 标准文本块 |
| `<b>`, `<i>`, `<u>` | Rich Text Run | 行内格式 |
| `color: #HEX` | Font Color | |
| `font-family: Arial` | Font Face | 仅使用 Web 安全字体 |
| `<img src="...">` | Picture | |
| `.placeholder` | (Coordinates) | 图表的不可见标记 |

---

## 🏗️ 结构模式 (可以直接复制!)

### 模式 A: 卡片 (背景 + 文本)
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

### 模式 B: 图像遮罩 (圆形图像)
由于禁用 `clip-path`，请在 `<img>` 标签上使用 `border-radius` (如果支持) 或预遮罩的 PNG。
*   **最佳实践:**
    ```html
    <img src="avatar.jpg" style="width:100pt; height:100pt; border-radius:50%; object-fit:cover;">
    ```
    *(注意: 转换器对 img border-radius 的支持各不相同; 严格的方法是先用 Sharp 裁剪图像)*。

---

## 🛠️ 验证工作流

在将任何 HTML 视为“最终版”之前，必须运行 linter：

```bash
python3 my_skills/assemble_pptx_file/scripts/lint_ppt_html.py path/to/slide.html
```

*   **Exit Code 0**: 成功。继续转换。
*   **Exit Code 1**: 检查输出错误并重写 HTML。

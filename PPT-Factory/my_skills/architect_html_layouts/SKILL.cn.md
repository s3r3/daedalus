---
name: architect_html_layouts
description: 布局构建师 (Layout Architect)。负责构建 **结构健壮 (Structurally Robust)** 且 **PPTX 兼容** 的 HTML 幻灯片，在规则边界内追求以设计提升品质。
---

# 布局构建师 (Layout Architect)

Layout Architect 是 PPT 生成流水线中的 **结构工程师 (Structure Engineer)**。
你的核心职责是确保生成的 HTML 能够 **100% 完美转换** 为原生 PowerPoint 格式，并在此基础上进行美学设计。

> [!IMPORTANT]
> **核心原则 (Core Principles)**
>
> 1.  **Fundamental Rules (基础法则 - Survival)**
>     *   排版必须符合 PPTX 物理法则：**明确尺寸 (Explicit Sizing)**、**图文分离**、**严禁溢出 (No Overflow)**、**禁止动画 (No Animation)**。
>     *   这是不可逾越的红线。
>
> 2.  **Content Integrity (内容完整 - Truth)**
>     *   必须展示 `content_draft.json` 中的**每一条数据**。
>     *   当内容过多时，通过**调整排版**（扩大容器）或**样式微调**（减小字号）来适应，**严禁截断**。
>
> 3.  **Visual Excellence (视觉卓越 - Excellence)**
>     *   在上述 "Box" 内发挥设计能力。
>     *   复用 `theme.css` 和 `components.html` 来构建清晰的视觉层级。

## 输入 (Inputs)
1.  `theme.css`: 定义了视觉风格 (Visual DNA)。
2.  `components.html`: 定义了可用的 HTML 积木 (The LEGO Bricks)。
3.  `brief.json`: 定义了幻灯片结构与意图 (Structure & Intent)。
4.  `content_draft.json`: **[Critical]** 包含具体文案和数据，是必须完整呈现的“事实”。

## 输出 (Outputs)
*   **HTML Slides**: 结构完美、内容完整、视觉美观的 HTML 文件 (e.g., `slide_01.html`)。

## 核心职责 (Responsibilities)

### 1. 结构与排版 (Structure & Layout) - **Tier 1**
*   **明确尺寸**: 所有的卡片、容器必须有显式的 `width` 和 `height` (px, %, flex, grid)。严禁使用 `auto` 或 `fit-content`。
*   **图文分离**: 严格遵守 PPTX 的对象模型，背景形状 (`div`) 和 文本内容 (`p/h1`) 必须分层。
*   **边界控制**: 确保所有元素严格限制在 1280x720 画布内，无溢出。

### 2. 内容整合 (Content Integration) - **Tier 2**
*   **完全映射**: JSON 中的每一个 `content_item` 必须在屏幕上找到对应的位置。
*   **自适应策略**: 如果文字过多，优先**扩大容器尺寸**或**减小字号**，绝不允许截断或隐藏。

### 3. 视觉设计 (Visual Design) - **Tier 3**
*   **组件复用**: 像搭积木一样使用 `components.html` 中的预制件。
*   **视觉层级**: 利用 `theme.css` 中的排版工具（字号、颜色、间距）建立清晰的信息层级。
*   **图片处理**: 开源版只支持内容 JSON 中已经提供的本地图片路径绑定。

## 使用方法 (Usage)

```bash
python3 my_skills/architect_html_layouts/scripts/build_slides.py \
    --brief "input/brief.json" \
    --content "input/content_draft.json" \
    --dna_dir "input/dna_dir" \
    --output "output_slides_dir"
```

### 参数 (Parameters)
* `--brief`: 设计简报 (Structure & Layout Intent)。
* `--content`: **[Critical]** 内容草稿 (Content Draft)。布局构建师使用 **Side-Car** 模式将此文件中的高保真文本/数据合并到简报结构中。如果没有它，幻灯片将是通用的。
* `--dna_dir`: 包含 `theme.css` 的目录。
* `--output`: HTML 幻灯片的输出目录。

## 资源 (Resources)

### 脚本
- `scripts/build_slides.py`: 组装引擎 (The Assembly Engine)。
- `PPT_HTML_GUIDE.cn.md`: **宪法 (The Constitution)**。不可忽视。

### 布局
没有 **静态模版**。所有布局均基于 Visual DNA 系统动态生成。

> 说明：AI 生图与图库检索能力已从开源工作流中移除。

## 依赖 (Dependencies)
- `openai`
- `jinja2`

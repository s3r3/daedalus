---
name: generate_assets
description: HTML Constructor Agent. Generates a comprehensive HTML Component Matrix (The PPT Arsenal) based on the Visual DNA theme, providing atomic building blocks for the Layout Architect.
---

# Generate Assets (HTML Constructor)

此技能扮演 "HTML Constructor" (HTML 构造工程师) 角色。
它的任务是架起 **视觉设计 (CSS)** 与 **页面排版 (Layout)** 之间的桥梁。它不负责排版具体页面，而是负责生产一套**“PPT 军火库” (Component Matrix)**，确保 Layout Architect 有足够的、符合视觉规范的积木可用。

## 核心输入
1.  **Visual DNA (`theme.css`)**: (必选) 视觉样式来源。
2.  **Design Brief**: (必选) 用于理解特定页面的设计意图（如需要特殊的时间轴或强调卡片）。
3.  **Content Draft**: (必选) 用于扫描特定内容类型（如数据图表、团队成员列表）。

## 核心输出
1.  **`components.html` (The PPT Arsenal)**:
    一个包含数十种预制组件的 HTML 文件。
    *注意*：开源版仅包含组件结构，不包含独立图片素材生成流程。

## 关键职责 (Responsibility)
*   **Structure Validity**: 确保 HTML 结构合规。
*   **Visual Consistency**: 确保生成的组件风格与 CSS 主题一致。

## 使用方法 (Usage)

```bash
python3 my_skills/generate_assets/scripts/generate_components.py <theme_css_path> <output_html_path> --brief <brief_path> --content <draft_path>
```

### 参数
* `theme_css_path`: 主要输入，Visual DNA。
* `output_html_path`: 输出目录。
* `--brief`: 传入 `brief.json`，用于分析定制组件需求。
* `--content`: 传入 `content_draft.json`，用于扫描特殊内容类型。

> **注意**: 开源版不包含图片生成与图库检索工作流。本技能专注于 HTML 组件构造。

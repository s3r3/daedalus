---
name: define_visual_dna
description: Visual System Lead Agent. Generates data-driven Visual DNA (CSS Only) by retrieving expert styles from a knowledge base and fusing them using Generative AI.
---

# Define Visual DNA (Visual System Lead)

此技能扮演 "Visual System Lead" 角色。它不依赖死板的模板映射，而是采用 **RAG (检索增强生成)** 技术，根据 Design Brief 智能生成独一无二的视觉系统。

## 核心能力

1.  **Style Retrieval (风格检索)**: 从包含 67+ 种专业 UI 风格 (`styles.csv`) 的知识库中，检索最匹配的视觉语言。
2.  **Style Composition (风格融合)**: 能够将一种 "Primary Style" (如 Swiss Modernism) 与多种 "Secondary Styles" (如 Glassmorphism Components) 进行智能融合。
3.  **Generative CSS**: 使用 LLM 直接生成像素级完美的 `theme.css`，确保视觉一致性与技术规范性。

## 使用方法

```bash
python3 my_skills/define_visual_dna/scripts/generate_dna.py <brief_path> <output_css_path>
```

### 参数
*   `brief_path`: `create_design_brief` 生成的 JSON Design Brief 路径。
*   `output_css_path`: 生成的 `theme.css` 保存路径。

## 资源架构

*   `references/styles.csv`: **视觉基因库**。包含从 "Minimalism" 到 "Cyberpunk" 的详细 CSS 技术指标。
*   `prompts/visual_lead_system.md`: **动态生成模版** (English Active)。支持 Jinja 风格插值，用于构建高精度的 System Prompt。
*   `prompts/visual_lead_system.cn.md`: **动态生成模版** (Chinese Reference)。中文参考文档。
*   `resources/master_template.html`: **[Deprecated] 原子化 Master HTML**。已废弃，HTML 结构生成由 `generate_assets` 技能接管。
*   `scripts/generate_dna.py`: 核心执行脚本 (包含 `StyleRetriever` 和 `StyleComposer` 类)。

## 输出规范

### 1. Theme CSS (`theme.css`)
包含所有动态计算的 CSS 变量：
*   **Color System**: 
    *   `--ppt-color-primary`, `--ppt-color-secondary`, `--ppt-color-accent`
    *   `--ppt-color-bg-main`, `--ppt-color-bg-surface`
    *   `--ppt-color-text-main`, `--ppt-color-text-secondary`
    *   `--ppt-bg-gradient-main`, `--ppt-gradient-accent`
*   **Typography**: `--ppt-font-family`, `--ppt-text-scale-base`, `--ppt-text-scale-ratio`
*   **Effects & Shapes**: 
    *   **Shadows**: `--ppt-shadow-card`, `--ppt-shadow-float`, `--ppt-shadow-glow`
    *   **Glass**: `--ppt-glass-bg`, `--ppt-glass-border`, `--ppt-backdrop-blur`
    *   **Borders**: `--ppt-border-light`, `--ppt-border-accent`
    *   **Spacing**: `--ppt-space-unit`
*   **Functional Classes** (A-F Category System):
    *   **A. Containers**: `.ppt-card-primary`, `.ppt-card-standard`, `.ppt-card-item`, `.ppt-card-overlay`, `.ppt-card-highlight`
    *   **B. Visual Decorators**: `.ppt-text-emphasis`, `.ppt-accent-marker`, `.ppt-divider`, `.ppt-connector`
    *   **C. Typography**: `.ppt-text-hero`, `.ppt-text-lead`, `.ppt-text-body-large/strong/small`, `.ppt-text-secondary`
    *   **D. Frame Decorators**: `.ppt-decorator-frame`, `.ppt-decorator-footer`
    *   **E. Shape Primitives**: `.ppt-shape-circle`, `.ppt-shape-rounded`, `.ppt-shape-pill`, `.ppt-shape-chevron`, `.ppt-shape-blob`
    *   **F. Background Utilities**: `.ppt-background-main`, `.ppt-background-contrast`, `.ppt-background-image`

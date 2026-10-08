---
name: draft_content
description: 将用户的简短主题请求转化为结构化、语义丰富的内容草稿 (Semantic Content Draft)。
---

# 内容架构 (Draft Content - Semantic)

内容编辑代理 (Content Editor Agent) 是 **信息架构师**。它定义内容的 **本质属性**（数据、文本、视觉），而不仅仅是编写段落或选择 UI 组件。

## 核心原则 (Core Principles)

1.  **语义完整性 (Semantic Integrity)**: 严禁将连贯的句子拆解为碎片化的单词字段。内容必须保持完整的语义表达。
2.  **视觉均衡 (Visual Balance)**: 单页内的内容项在长度和复杂度上应保持相对均衡，避免视觉上的“头重脚轻”。
3.  **丰富结构 (Rich Structure)**: 鼓励使用嵌套结构 (`sub_items`) 来准确反映信息的逻辑深度。

## 用法

```bash
python3 my_skills/draft_content/scripts/draft_content.py "2024产品路线图" "output/semantic_draft.json"
```

## 输出功能

`content_draft.json` 使用 **语义项 (Semantic Item)** 模型：

### 1. 内容项 (`content_items`)
取代了通用的 block，每个项都有明确类型：
*   **`statistic` (统计)**: 用于可识别的数据。包含 `data_payload`。
*   **`text` (文本)**: 叙述性内容。使用 `body` 存储可见文本。
*   **`visual` (视觉)**: 已上传本地图片意向。必须使用 `image_file_name` 指向项目内已有图片；若有图片元数据，还应保留 `image_width`、`image_height`、`image_aspect_ratio`、`image_orientation`；可用 `image_description` 说明版面使用方式。
*   **`chart` (图表)**: 数据可视化。使用 `data_payload` 存储数据，`image_description` 存储视觉描述。
*   **`sub_items` (子项)**: 递归数组，支持无限层级的“多层标题/多层内容”结构。
*   **`content_role`**: 所有类型共用的版式角色（`primary`、`supporting`、`branding`、`evidence`、`atmosphere`、`navigation`），避免只有图片拥有细粒度规则。

### 2. 锚定视觉线索 (`visual_cues`)
视觉指令直接挂载在它修饰的内容上。
*   `status`: "critical" (严重), "positive" (积极)。
*   `badge`: "New" (新品), "Beta" (测试版)。

### 3. 页面结构
*   `suggested_layout`: 通用模式 (Timeline, Grid)。
*   `conceptual_metaphor`: 页面级隐喻 (Funnel, Iceberg)。

## 资源
- `scripts/draft_content.py`: 执行脚本。
- `prompts/editor_system_cn.md`: 中文系统提示词。
- `references/content_schema.json`: 语义 Schema。

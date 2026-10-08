---
name: create_design_brief
description: 将高级用户请求转化为结构化的 JSON 设计简报 (Design Brief)。
---

# 创建设计简报 (Create Design Brief)

创意总监代理 (Creative Director Agent) 使用此技能来分析用户意图，并输出一个标准化的 JSON 对象，用于驱动后续的流水线工作。

## 用法

此技能通常通过 `generate_brief.py` 脚本调用。

```bash
python3 my_skills/create_design_brief/scripts/generate_brief.py "output/content_draft.json" "output/brief.json"
```

### 参数
* `input_path`: 由 `draft_content` 生成的 `content_draft.json` 文件路径。
* `output_path`: 设计简报 JSON 的保存路径。

## 资源

### 脚本
- `scripts/generate_brief.py`: 主执行脚本。如果存在 `OPENAI_API_KEY`，则使用 LLM (OpenAI)，否则返回用于测试的 Mock 响应。

### 提示词 (Prompts)
- `prompts/director_system.md`: 定义创意总监人设和规则的 System Prompt (英文版，供 AI 使用)。
- `prompts/director_system_cn.md`: System Prompt 的中文参考版。

### 参考资料 (References)
- `references/brief_schema.json`: 定义输出简报结构的 JSON Schema。

## 输出规范 (Output Specification)

输出是一个 **Content-Free (无内容)** 的设计指令集 (`brief.json`)。

### 核心变更 (Side-Car Architecture)
*   **Side-Car 模式**: Brief 不再包含任何正文内容 (`content_items`)。
*   **ID 映射**: 通过 `slide_id` (外键) 与 `content_draft.json` 严格对齐。
*   **纯设计指令**:
    - `project_name`: 项目名称。
    - `style_definition`: 视觉偏好（含具体的 HEX 色值偏好或抽象描述）。
    - `design_system_spec`: 详细设计规范。
    - `required_layouts`: 仅包含 `slide_id`, `layout_type`, `layout_intent`。

### 支持的布局
- `cover_branding` (品牌封面)
- `agenda_list` (议程列表)
- `grid_2_col` (两栏)
- `grid_3_col` (三栏)
- `grid_4_feature` (四特性网格)
- `chart_bar_comparison` (柱状对比图)
- `team_gallery` (团队展示)
- `timeline` (时间轴)
- `process_flow` (流程图)
- `quote_highlight` (金句高亮)

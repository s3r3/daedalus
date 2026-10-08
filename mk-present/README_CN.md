<p align="right">
  <a href="README.md">English</a> | <strong>中文</strong>
</p>

# MK Present

兼容 **Claude Code** · **Codex** · **Hermes Agent** · **OpenClaw**

> 完整的演示文稿工作流：规划故事线、生成精美的 HTML 幻灯片、导出为 PowerPoint。三个 AI Skill，一条无缝流水线。

> **Forked 自** [mk-present](https://github.com/textboy/mk-present) — 拆分为 3 个专业化 Skill，覆盖演示文稿的全生命周期。

---

## 它能做什么

MK Present 是一个 **3-Skill 流水线**，覆盖演示文稿全生命周期：

1. **📋 [present-workflow](present-workflow/README_CN.md)** — 规划故事线。明确需求、调研、大纲、审查。
2. **🎨 [present-html](present-html/README_CN.md)** — 生成精美的 HTML 演示。50+ 精选风格，支持架构图和流程图。
3. **📄 [present-ppt](present-ppt/README_CN.md)** — 将 HTML deck 转换为可编辑的 PowerPoint (.pptx)，保留原生形状和文字。

```
你："帮我做一个 AI agents 的 pitch deck，10 页左右，科技感强一点"

→ present-workflow 起草故事线，获得你的确认
→ present-html 用你选的风格生成漂亮的 HTML deck
→ present-ppt 导出为 PowerPoint 文件，直接可用
```

**输入：** 自然语言、Markdown 或参考截图
**输出：** HTML 演示文稿 (.html) + 可选 PowerPoint (.pptx)

---

## 仓库内的 3 个 Skill

本仓库包含三个相关的 Skill，分别处理演示文稿工作流的不同阶段：

| Skill | 目录 | Forked From | 用途 |
|-------|------|-------------|------|
| **[present-workflow](present-workflow/README_CN.md)** | `present-workflow/` | [ppt-agent-workflow-san/ppt-workflow](https://github.com/mucsbr/ppt-agent-workflow-san/tree/main/ppt-workflow) | 完成演示文稿的故事线 / 工作流 |
| **[present-html](present-html/README_CN.md)** | `present-html/` | [next-slide](https://github.com/codesstar/next-slide) | 生成 HTML 演示文稿，支持架构图 & 流程图 |
| **[present-ppt](present-ppt/README_CN.md)** | `present-ppt/` | [ppt-agent-workflow-san/html-slide-to-pptx](https://github.com/mucsbr/ppt-agent-workflow-san/tree/main/html-slide-to-pptx) | 将 HTML 转换为可编辑的 PowerPoint (.pptx) |

- **[present-workflow](present-workflow/README_CN.md)** — 作为第一阶段，准备演示文稿的故事线：明确需求、调研、大纲、规划、审查。
- **[present-html](present-html/README_CN.md)** — 从自然语言生成动画丰富的 HTML 演示文稿。50+ 精选风格，中英双语。还支持架构图和流程图生成（企业架构房、逻辑/系统/物理架构、流程图、API 时序图），支持 Drawio → PNG → 嵌入 HTML，或直接生成 HTML。
- **[present-ppt](present-ppt/README_CN.md)** — 将结构化的单页或小型 HTML 文件转换为可编辑的 PPTX 幻灯片，包含原生文本框、形状、标签、箭头和面板。预设驱动，非通用浏览器渲染器。

---

## 快速开始

```bash
# 1. 克隆仓库到任意位置
git clone https://github.com/textboy/mk-present

# 2. 安装全部 3 个 Skill
bash install.sh           # 自动检测所有可用平台
bash install.sh claude    # 或指定平台：claude / codex / hermes / openclaw
```

```markdown
# 3. 按顺序调用三个 Skill

# 第一步 — 规划故事线
/present-workflow, 帮我设计 10 页关于统一 API 平台的演示

# 第二步 — 生成 HTML 幻灯片（以上一步的输出作为输入）
/present-html, [上一步生成的演示内容]

# 第三步 — 导出为 PowerPoint
/present-ppt, 根据 present-html 的输出生成 api.pptx
```

### 多平台支持

| 平台 | 安装 |
|------|------|
| **Claude Code** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh claude` |
| **OpenAI Codex** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh codex` |
| **Hermes Agent** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh hermes` |
| **OpenClaw** | `git clone https://github.com/textboy/mk-present && cd mk-present && bash install.sh openclaw` |
| **任意 AI 工具** | 将各 Skill 的 `SKILL.md` 作为系统提示词 + 引用支持文件 |

> 或用 `bash install.sh` 一键安装 —— 自动检测三个平台并创建符号链接。

无运行时、无 API key、无厂商绑定。本质就是：Markdown 指令 + CSS/HTML 参考。

---

## 50+ 风格，7 大类

| 分类 | 数量 | 代表风格 | 适用场景 |
|------|------|---------|---------|
| **暗色** | 11 | Keynote Noir、Bold Signal、Neon Cyber、Terminal Green、Midnight Corporate、Cinema Scope、Dark Botanical、Starfield、Dark Premium、Dark Cinema、Futuristic Blue | 大会、发布会、技术分享 |
| **浅色** | 11 | Swiss Modern、Paper & Ink、Notebook Tabs、Pastel Geometry、Morning Brief、Campus White、Soft Landing、Watercolor Wash、Korean Soft、Claymorphism 3D、Wabi-Sabi Zen | 学术、商务、教学 |
| **编辑** | 4 | Editorial Serif、Fashion Editorial、Newsprint Broadsheet、Vintage Editorial | 杂志风、思想领导力 |
| **大胆** | 7 | Electric Studio、Creative Voltage、Split Pastel、Pop Art、Bold Typography、Neon Brutalism、Memphis Pop | 创业 pitch、创意提案 |
| **复古** | 5 | Grainy Retro、Art Deco Gatsby、Risograph Overprint、Vintage Poster、Retro Arcade | 怀旧、主题化 |
| **艺术** | 7 | Surrealism Gallery、Scrapbook Portfolio、Blue Collage、Pink Handwritten、Art Nouveau Botanical、Soft Dreamy、Terracotta Earth | 艺术、设计、作品集 |
| **文化** | 8 | Ink Wash、Wafu、Gradient Dreams、Blueprint、Bauhaus Primary、Swiss Grid、Aurora Mesh、Chinese Ink Wash | 文化活动、主题演讲 |

每个风格都是完整的设计系统：精挑的字体、色板、版式、专属动画、响应式断点。

**浏览全部场景/风格/图表**：<a href="present-html/gallery_cn.html" target="_blank" style="font-weight: bold; font-size: 18px;">浏览画廊</a>

### 画廊界面

![画廊界面](sample/gallery.png)

### 场景样例

| 场景 01 | 场景 02 |
|:------:|:------:|
| ![场景 01](sample/scenario01.png) | ![场景 02](sample/scenario02.png) |

### 风格样例

| 风格 01 | 风格 02 |
|:------:|:------:|
| ![风格 01](sample/style01.png) | ![风格 02](sample/style02.png) |

### 图表样例

| 图表 01 | 图表 02 |
|:------:|:------:|
| ![图表 01](sample/diagram01.png) | ![图表 02](sample/diagram02.png) |

---

## 工作原理

```
┌─────────────────────────────────────────────────────┐
│  1. 内容                                          │
│     大白话描述、贴 Markdown、                       │
│     或者丢参考截图                                  │
├─────────────────────────────────────────────────────┤
│  2. 选风格                                        │
│     看 50+ 风格 → 挑个调性 →                       │
│     看 3 个实时预览 → 选定                         │
│     （或者说"照这张截图来"）                        │
├─────────────────────────────────────────────────────┤
│  3. 生成                                          │
│     AI 出整份 deck：版式、动画、                    │
│     响应式 CSS、键盘导航                           │
├─────────────────────────────────────────────────────┤
│  4. 交付                                          │
│     浏览器打开。按 E 直接编辑文字。                 │
│     一行命令部署到 Vercel。                         │
└─────────────────────────────────────────────────────┘
```

---

## 特性

### present-workflow
- **分阶段工作流** — 需求 → 调研 → 大纲 → 策划稿 → 评审 → 定稿
- **金字塔原理** — 结论先行，自上而下，分组归类，逻辑递进
- **评审关卡** — 重要 deck 在提交完整草稿前暂停，获取反馈
- **资料驱动** — 接受 URL、报告、PDF、转录稿作为输入上下文

### present-html
- **50+ 精选风格** — 不是换个颜色那么简单，每个都是独立设计语言（带 Layout DNA）
- **中英文原生** — 中文 CJK 字体支持到位
- **5 种输入方式** — 从零开始 / Markdown / 增强已有 deck / 截图匹配 / 风格对比
- **响应式** — 手机到 4K 投影都适配
- **键盘导航** — 方向键、空格、Home/End
- **行内编辑** — 按 `E` 在浏览器里直接改文字
- **一键部署** — `npx vercel --prod` 直接拿到线上 URL
- **质量自检** — 生成后自动检查溢出、字体、信息密度
- **字号精确** — 每个风格的 `clamp()` 数值都从手工参考稿里抠出来
- **架构图 & 流程图生成** — 用自然语言描述即可生成：企业架构房、逻辑架构、系统架构、物理架构、逻辑流程图、流程图、API 时序图。支持 Drawio → PNG → 嵌入 HTML，或直接用 HTML（CSS 定位卡片 + SVG 连线）。

### present-ppt
- **HTML 转 PPTX** — 将任意 HTML 演示导出为 PowerPoint，转换为原生形状（文本框、矩形、圆角矩形、带样式的文字、边框、背景填充）
- **预设驱动** — 语义块映射，非通用浏览器渲染器
- **可编辑输出** — 文字在 PowerPoint 中保持可编辑，结构完整保留
- **QA 预检** — 内置间距、溢出、箭头方向检查

---

## 输入方式

| 方式 | 例子 |
|------|------|
| 自然语言 | "做一份 10 页的 AI agents pitch deck" |
| Markdown | 喂一个 `.md` 文件 —— 标题变 slide |
| 参考截图 | 发张图 —— AI 找最接近的风格 |
| 增强已有 | 指向一份现成 HTML deck —— AI 帮你改进 |

---

## 设计哲学

MK Present 是一个 **3-Skill 流水线**，每个阶段有其独特的原则：

### present-workflow
1. **约束工作流，而非实现方式** —— 告诉 agent 什么阶段该做什么，但将如何执行交给环境。
2. **分阶段优于一次性生成** —— 调研 → 大纲 → 策划 → 评审，避免代价高昂的方向偏差。
3. **重要 deck 设评审关卡** —— 对外、高层或高风险的演示在扩展前停下，获取用户反馈。

### present-html
1. **拒绝 AI 屎山** —— 每个风格都是手工调教的字体、间距、动效。AI 跟着精确规格走，不靠"感觉"
2. **Layout DNA** —— 每个风格都定义了结构模式：slide 机制、标题对齐、导航样式、背景处理、动画路数、组件结构
3. **字号精确** —— 每个元素都有精确的 `clamp()` 值，确保 AI 能复现字号、字重、行高、字距
4. **Viewport First** —— 每页正好 100vh。不滚动。内容超了？自动拆成多页

### present-ppt
1. **语义映射优于截图嵌入** —— 将 HTML 解析为小型中间模型，再重建为原生 PowerPoint 形状。
2. **可编辑性优先** —— 文字在 PowerPoint 中保持可编辑。保真度逐步迭代，不为像素完美牺牲可编辑性。

---

## 键盘快捷键

| 键 | 动作 |
|----|------|
| `←` `→` `↑` `↓` | 切换 slide |
| `空格` | 下一页 |
| `Home` / `End` | 首页 / 末页 |
| `E` | 切换编辑模式 |

---

## 自定义

每份演示用 CSS 自定义属性。在 `:root` 里覆盖：

```css
:root {
    --bg-primary: #0a0a0a;
    --accent: #ff6b35;
    --font-display: '你的字体', sans-serif;
}
```

---

## 文件结构

```
mk-present/
├── CLAUDE.md                    # 行为指南
├── LICENSE                      # MIT 许可
├── README.md                    # 本文档（英文）
├── README_CN.md                 # 本文档（中文）
│
├── present-workflow/            # 阶段一：故事线准备
│   ├── SKILL.md
│   ├── README.md / README_CN.md
│   └── references/
│       ├── agent-integration.md
│       ├── method.md
│       └── prompts.md
│
├── present-html/                # 阶段二：HTML 演示生成
│   ├── SKILL.md                 # AI 指令（大脑）
│   ├── STYLE_PRESETS.md         # 50+ 风格定义（带 Layout DNA）
│   ├── html-template.md         # HTML 架构参考
│   ├── animation-patterns.md    # 动画片段
│   ├── viewport-base.css        # 响应式 CSS 基础
│   ├── gallery.html             # 风格画廊（英文版）
│   ├── gallery_cn.html          # 风格画廊（中文版）
│   ├── SCENARIO_TEMPLATES.md    # 场景模板
│   ├── PROJECT_CONTEXT.md       # 项目上下文
│   ├── README.md / README_CN.md # 文档
│   ├── openclaw.plugin.json     # OpenClaw 插件清单
│   ├── install.sh               # 自动检测安装
│   ├── package.json             # 开发元数据
│   ├── vercel.json              # 部署配置
│   │
│   ├── styles/                  # 56 个参考演示（对应每个风格）
│   ├── scenarios/               # 114 个场景模板
│   │   └── images/              # 场景图片
│   ├── diagram/                 # 图表生成规格 & 示例
│   │   ├── *.md                 # 规格文档
│   │   └── samples/
│   │       ├── *.drawio.xml     # Drawio XML 示例图表
│   │       └── *.html           # HTML 示例图表
│   ├── scripts/
│   │   └── generate-drawio.py   # Drawio 图表 → PNG 生成
│   ├── spec/                    # 10 份规格文档
│   └── landing/                 # 产品落地页
│
├── present-ppt/                 # 阶段三：HTML → PPTX 转换
│   ├── SKILL.md
│   ├── README.md / README_CN.md
│   ├── package.json / package-lock.json
│   ├── references/
│   │   ├── presets.md
│   │   ├── preset-template.md
│   │   ├── preset-decision-rules.md
│   │   ├── setup.md
│   │   ├── usage-principles.md
│   │   ├── qa-heuristics.md
│   │   └── roadmap.md
│   └── scripts/
│       ├── html_to_pptx.js / html_to_pptx_v9.js
│       ├── layout_v9.js / layout_template.js / layout_utils.js
│       ├── ai_runtime_preset.js / data_strategy_deck_preset.js
│       ├── preset_template.js / preflight_qa.js / check_env.js
│       └── layout_ai_runtime.js
│
├── test/                        # 测试 & 示例输出
│
├── .claude/
│   └── settings.local.json
└── .loci/
    └── memory.md
```

---

## License

MIT. Copyright 2026 Callum.

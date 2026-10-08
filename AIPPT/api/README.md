# AI PPT Generator API

FastAPI 后端服务，为 WebUI 前端提供 PPT 生成、编辑和导出功能。

## 功能特性

- **文件上传**: 支持 `.md/.txt/.pdf/.docx/.pptx`，统一解析为 Markdown
- **PPT 生成**: 基于输入材料生成 PPT 幻灯片，支持流式返回进度
- **图生图编辑**: 对单页幻灯片进行修改
- **导出功能**: 支持导出为 PDF、栅格 PPTX 和生成式高保真可编辑 PPTX 格式
- **模型路由**: 支持 prompt/image/edit 三角色模型 profile

## API 端点

### 健康检查
```
GET /api/health
```

### 文件上传
```
POST /api/upload
Content-Type: multipart/form-data

参数:
- file: 文档文件 (.md/.txt/.pdf/.docx/.pptx)

响应:
{
  "success": true,
  "content": "文件内容",
  "filename": "文件名.md",
  "message": "文件上传成功"
}
```

### PPT 生成
```
POST /api/generate
Content-Type: application/json

请求体:
{
  "content": "Markdown 内容",
  "config": {
    "model_profiles": {
      "text_model": {
        "model": "DeepSeek-V4-Pro",
        "base_url": "https://api.example.com/v1",
        "api_key": "your-text-key"
      },
      "image_model": {
        "model": "gpt-image-2",
        "base_url": "https://api.example.com/v1",
        "api_key": "your-image-key"
      }
    },
    "page_count": 10,
    "quality": "1K",
    "aspect_ratio": "16:9"
  }
}

响应: Server-Sent Events (SSE) 流
- type: "progress" - 进度更新
- type: "slide" - 单页幻灯片生成完成
- type: "complete" - 全部完成
- type: "error" - 错误信息
```

### 图生图编辑
```
POST /api/edit
Content-Type: application/json

请求体:
{
  "image_base64": "base64编码的图片",
  "instruction": "修改指令",
  "config": {
    "model_profiles": {
      "text_model": {"model": "DeepSeek-V4-Pro", "base_url": "https://api.example.com/v1", "api_key": "key"},
      "image_model": {"model": "gpt-image-2", "base_url": "https://api.example.com/v1", "api_key": "key"},
      "edit_model": {"model": "gpt-image-2", "base_url": "https://api.example.com/v1", "api_key": "key"}
    },
    "quality": "1K",
    "aspect_ratio": "16:9"
  }
}

响应:
{
  "success": true,
  "image_base64": "base64编码的新图片",
  "message": "编辑成功"
}
```

### 导出
```
POST /api/export
Content-Type: application/json

请求体:
{
  "slides": [
    {"image_base64": "base64编码的图片"}
  ],
  "format": "pdf" | "pptx",
  "aspect_ratio": "16:9" | "4:3"
}

响应: 文件下载
```

#### 生成式高保真可编辑 PPTX

该模式与普通 `pptx` 分开：普通 `pptx` 仍是把每页图片作为整页背景放入 PowerPoint；`generative_editable_pptx` 会通过 OCR、图片清理、前景资产重建、原生形状拟合和验证流程重建可编辑元素。

```
POST /api/export
Content-Type: application/json

请求体:
{
  "format": "generative_editable_pptx",
  "aspect_ratio": "16:9",
  "slide_order": ["slide-1", "slide-2"],
  "editable_options": {
    "fallback_policy": "fail"
  },
  "slides": [
    {
      "slide_id": "slide-1",
      "image_base64": "base64编码的图片",
      "text_metadata": [
        {
          "text": "Quarterly Plan",
          "role": "title",
          "order": 1,
          "style_hint": {"font_size": 32, "bold": true}
        }
      ]
    }
  ]
}
```

`fallback_policy` 可选值：
- `fail`：默认。验证失败时返回错误，不返回低保真文件。
- `text_editable_background`：显式允许使用文本可编辑、背景清理后的 fallback。
- `raster_pptx`：显式允许降级到现有栅格 PPTX 导出。

成功响应仍是 `.pptx` 文件下载。若使用 fallback，响应 header 会包含：
- `X-Generative-Editable-Status`
- `X-Generative-Editable-Fallback-Policy`
- `X-Generative-Editable-Fallback-Used`

更多配置和限制见 `docs/generative-editable-pptx.md`。

## 启动服务器

### 方式 1: 使用启动脚本
```bash
./start-api.sh
```

### 方式 2: 直接使用 uvicorn
```bash
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000 --reload
```

## 访问 API 文档

启动服务器后，访问以下地址查看交互式 API 文档：

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## 依赖项

所有依赖已添加到项目根目录的 `requirements.txt` 文件中：

- fastapi>=0.104.0
- uvicorn>=0.24.0
- python-multipart>=0.0.6
- python-pptx>=0.6.21

## 项目结构

```
api/
├── __init__.py
├── main.py              # FastAPI 应用入口
├── models.py            # Pydantic 数据模型
├── routes/
│   ├── __init__.py
│   ├── upload.py        # 文件上传路由
│   ├── generate.py      # PPT 生成路由
│   ├── edit.py          # 图生图编辑路由
│   ├── models.py        # 模型 profile 路由
│   └── export.py        # 导出路由
└── README.md
```

## 与现有模块集成

API 服务器直接使用项目中现有的 Python 模块：

- `src.model_router.ModelRouter` - 三角色模型路由
- `src.image_result.ImageResultNormalizer` - URL/base64 图片结果规范化
- `src.document_parser.DocumentParser` - 文档解析
- `src.exporter.PDFExporter` - PDF 导出器
- `src.config` - 配置管理

## 开发说明

### CORS 配置

当前配置允许所有来源访问 API（`allow_origins=["*"]`）。在生产环境中，应该设置具体的前端域名。

### 静态文件服务

如果 `web/dist` 目录存在，API 服务器会自动提供前端静态文件服务。

### 错误处理

所有路由都包含适当的错误处理，返回结构化的错误响应。

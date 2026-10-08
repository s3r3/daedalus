import { Slide, ExportFormat, GenerationConfig, EditablePptxFallbackPolicy } from '../types'

/**
 * 导出请求配置
 */
export interface ExportRequestConfig {
  slides: Slide[]
  format: ExportFormat
  aspectRatio: GenerationConfig['aspectRatio']
  fallbackPolicy?: EditablePptxFallbackPolicy
}

/**
 * 导出进度回调
 */
export interface ExportCallbacks {
  onStart?: () => void
  onProgress?: (progress: number) => void
  onComplete?: (filename: string) => void
  onError?: (error: string) => void
}

type ExportRequestBody = {
  slides: Array<{
    image_base64: string
    slide_id?: string
    text_metadata?: Array<{
      text: string
      role: string
      order: number
      style_hint: Record<string, unknown>
    }>
  }>
  format: ExportFormat
  aspect_ratio: GenerationConfig['aspectRatio']
  slide_order?: string[]
  editable_options?: {
    fallback_policy: EditablePptxFallbackPolicy
  }
}

/**
 * 获取文件扩展名对应的 MIME 类型
 */
export function getExportMimeType(format: ExportFormat): string {
  switch (format) {
    case 'pdf':
      return 'application/pdf'
    case 'pptx':
    case 'generative_editable_pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 获取默认文件名
 */
export function getDefaultExportFilename(format: ExportFormat, now = new Date()): string {
  const timestamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  if (format === 'generative_editable_pptx') {
    return `presentation_${timestamp}.generative-editable.pptx`
  }
  return `presentation_${timestamp}.${format}`
}

export function buildExportRequestBody(config: ExportRequestConfig): ExportRequestBody {
  const { slides, format, aspectRatio, fallbackPolicy = 'fail' } = config
  const baseSlides = slides.map(slide => ({
    image_base64: slide.imageBase64 || extractBase64FromDataUrl(slide.imageUrl)
  }))

  if (format !== 'generative_editable_pptx') {
    return {
      slides: baseSlides,
      format,
      aspect_ratio: aspectRatio
    }
  }

  return {
    slides: slides.map(slide => ({
      image_base64: slide.imageBase64 || extractBase64FromDataUrl(slide.imageUrl),
      slide_id: slide.id,
      text_metadata: (slide.textMetadata || []).map(item => ({
        text: item.text,
        role: item.role,
        order: item.order,
        style_hint: item.style_hint || {}
      }))
    })),
    format,
    aspect_ratio: aspectRatio,
    slide_order: slides.map(slide => slide.id),
    editable_options: { fallback_policy: fallbackPolicy }
  }
}

/**
 * 导出演示文稿
 * 
 * @param config 导出配置
 * @param callbacks 回调函数
 * @returns Promise<void>
 */
export async function exportPresentation(
  config: ExportRequestConfig,
  callbacks?: ExportCallbacks
): Promise<void> {
  const { slides, format, aspectRatio, fallbackPolicy } = config

  // 验证输入
  if (!slides || slides.length === 0) {
    callbacks?.onError?.('没有可导出的幻灯片')
    throw new Error('没有可导出的幻灯片')
  }

  callbacks?.onStart?.()
  if (format !== 'generative_editable_pptx') {
    callbacks?.onProgress?.(10)
  }

  try {
    const requestBody = buildExportRequestBody({ slides, format, aspectRatio, fallbackPolicy })

    if (format !== 'generative_editable_pptx') {
      callbacks?.onProgress?.(30)
    }

    // 发起请求
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    })

    if (format !== 'generative_editable_pptx') {
      callbacks?.onProgress?.(70)
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: '导出失败' }))
      throw new Error(errorData.detail || `导出失败: ${response.status}`)
    }

    // 获取文件名
    const contentDisposition = response.headers.get('Content-Disposition')
    let filename = getDefaultExportFilename(format)
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename="?([^";\n]+)"?/)
      if (filenameMatch) {
        filename = filenameMatch[1]
      }
    }

    if (format !== 'generative_editable_pptx') {
      callbacks?.onProgress?.(90)
    }

    // 下载文件
    const blob = await response.blob()
    downloadBlob(blob, filename, getExportMimeType(format))

    if (format !== 'generative_editable_pptx') {
      callbacks?.onProgress?.(100)
    }
    callbacks?.onComplete?.(filename)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '导出失败'
    callbacks?.onError?.(errorMessage)
    throw error
  }
}

/**
 * 从 Data URL 中提取 Base64 数据
 */
function extractBase64FromDataUrl(dataUrl: string): string {
  if (!dataUrl) return ''
  
  // 如果已经是纯 base64，直接返回
  if (!dataUrl.startsWith('data:')) {
    return dataUrl
  }
  
  // 提取 base64 部分
  const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/)
  return base64Match ? base64Match[1] : dataUrl
}

/**
 * 下载 Blob 文件
 */
function downloadBlob(blob: Blob, filename: string, mimeType: string): void {
  // 创建 Blob URL
  const blobWithType = new Blob([blob], { type: mimeType })
  const url = URL.createObjectURL(blobWithType)

  // 创建下载链接
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'

  // 触发下载
  document.body.appendChild(link)
  link.click()

  // 清理
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * 验证幻灯片是否可以导出
 */
export function canExport(slides: Slide[]): boolean {
  return slides.length > 0 && slides.every(slide => 
    slide.imageUrl || slide.imageBase64
  )
}

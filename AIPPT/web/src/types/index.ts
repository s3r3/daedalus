/**
 * 幻灯片数据结构
 */
export type ProjectStatus =
  | 'draft'
  | 'planning'
  | 'prompts_ready'
  | 'generating'
  | 'generated'
  | 'editing'
  | 'error'

export interface SlideAssetRef {
  key: string
  mimeType: string
  byteLength: number
  sha256?: string
}

export interface Slide {
  id: string
  pageNumber: number
  imageUrl: string
  imageBase64?: string
  imageStorageKey?: string
  imageAsset?: SlideAssetRef
  textMetadata?: ExportTextMetadata[]
  prompt: string
  editHistory?: EditHistoryItem[]
  updatedAt?: number
}

export interface ExportTextMetadata {
  text: string
  role: string
  order: number
  style_hint?: Record<string, unknown>
}

export type EditablePptxFallbackPolicy = 'fail' | 'text_editable_background' | 'raster_pptx'

/**
 * 编辑历史记录项
 */
export interface EditHistoryItem {
  imageUrl: string
  imageBase64: string
  instruction: string
  timestamp: number
}

/**
 * 编辑会话状态
 */
export interface EditSession {
  slideId: string
  originalImage: string
  currentImage: string
  history: EditHistoryItem[]
  savedHistoryLength?: number
  userInput: string
}

/**
 * 图像模型 API 配置
 */
export interface ImageApiConfig {
  apiKey: string
  baseUrl: string
  model: string
}

/**
 * 文本模型 API 配置
 */
export interface TextApiConfig {
  apiKey: string
  baseUrl: string
  model: string
  format: 'gemini' | 'openai'
  thinking?: 'enabled' | 'disabled'
}

/**
 * 完整 API 配置（包含图像和文本模型）
 */
export interface FullApiConfig {
  image: ImageApiConfig
  text: TextApiConfig
  edit?: ImageApiConfig
  vlm?: ImageApiConfig
  ocr?: ImageApiConfig
}

/**
 * API 配置（向后兼容）
 * @deprecated 使用 FullApiConfig 代替
 */
export interface ApiConfig {
  apiKey: string
  baseUrl: string
}

/**
 * PPT 内容配置
 */
export interface PptContentConfig {
  language: string
  style: string
  targetAudience: string
}

/**
 * 生成配置
 */
export interface GenerationConfig {
  pageCount: number
  quality: '1K' | '2K' | '4K'
  aspectRatio: '16:9' | '4:3'
  // PPT 内容配置
  language?: string
  style?: string
  targetAudience?: string
  userRequirements?: string
}

export interface SlideOutline {
  page: number
  title: string
  narrative_goal: string
  key_points: string[]
  visual_direction: string
}

export interface DeckOutline {
  title: string
  user_requirements: string
  design_style: string
  audience: string
  slides: SlideOutline[]
}

export interface ConfirmedSlidePrompt {
  page: number
  title: string
  content_summary: string
  display_content?: string
  prompt: string
}

export interface WorkflowState {
  status:
    | 'idle'
    | 'outline_loading'
    | 'outline_ready'
    | 'prompts_loading'
    | 'prompts_ready'
    | 'error'
  outline: DeckOutline | null
  slidePrompts: ConfirmedSlidePrompt[]
  expandedOutlinePages: number[]
  expandedDesignPages: number[]
  error: string | null
}

export interface ProjectSummary {
  id: string
  title: string
  fileName: string
  slideCount: number
  status: ProjectStatus
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export interface ProjectRecord {
  version: 2
  id: string
  title: string
  fileName: string
  fileContent: string
  slides: Slide[]
  generationConfig: GenerationConfig
  workflow: WorkflowState
  status: ProjectStatus
  generationRunId: string | null
  lastCompletedSlides: Slide[]
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

/**
 * 应用全局状态
 */
export interface AppState {
  // 文件状态
  uploadedFile: File | null
  fileContent: string
  fileName: string

  // API 配置（完整版）
  fullApiConfig: FullApiConfig

  // API 配置（向后兼容）
  apiConfig: ApiConfig

  // 生成配置
  generationConfig: GenerationConfig

  // 生成状态
  slides: Slide[]
  isGenerating: boolean
  generationProgress: number
  generationError: string | null

  // 编辑状态
  editingSlide: EditSession | null
  selectedSlideId: string | null
}

/**
 * localStorage 持久化结构
 */
export interface PersistedState {
  version: number
  apiConfig: ApiConfig
  fullApiConfig?: FullApiConfig
  currentProject: {
    fileContent: string
    fileName: string
    slides: Slide[]
    generationConfig: GenerationConfig
  } | null
}

/**
 * 生成请求配置
 */
export interface GenerationRequestConfig {
  // 图像模型配置
  image_api_key: string
  image_base_url: string
  image_model: string
  // 文本模型配置
  text_api_key: string
  text_base_url: string
  text_model: string
  text_format: string
  text_thinking?: 'enabled' | 'disabled'
  model_profiles?: ModelProfilesRequestConfig
  // 生成参数
  page_count: number
  quality: string
  aspect_ratio: string
  // PPT 内容配置
  language?: string
  style?: string
  target_audience?: string
  user_requirements?: string
}

/**
 * 编辑请求配置
 */
export interface EditRequestConfig {
  api_key?: string
  base_url?: string
  model?: string
  model_profiles?: ModelProfilesRequestConfig
  quality: string
  aspect_ratio: string
}

export interface ModelProfileRequestConfig {
  id?: string
  label?: string
  model: string
  base_url: string
  api_key: string
  thinking?: 'enabled' | 'disabled'
}

export interface ModelProfilesRequestConfig {
  text_model: ModelProfileRequestConfig
  image_model: ModelProfileRequestConfig
  edit_model?: ModelProfileRequestConfig
  VLM?: ModelProfileRequestConfig
  ocr_model?: ModelProfileRequestConfig
}

export interface ModelProfilePublic {
  id: string
  label: string
  model: string
  base_url: string
  has_api_key: boolean
  thinking?: 'enabled' | 'disabled'
}

export interface ModelProfilesResponse {
  success: boolean
  profiles?: {
    text_model: ModelProfilePublic
    prompt_model?: ModelProfilePublic
    image_model: ModelProfilePublic
    edit_model: ModelProfilePublic
    VLM?: ModelProfilePublic
    ocr_model?: ModelProfilePublic
  }
  message?: string
}

/**
 * SSE 事件类型
 */
export type SSEEventType = 'progress' | 'slide' | 'complete' | 'error'

/**
 * SSE 事件数据
 */
export interface SSEEvent {
  type: SSEEventType
  data: unknown
}

/**
 * 导出格式
 */
export type ExportFormat = 'pdf' | 'pptx' | 'generative_editable_pptx'

import { createContext, useReducer, useCallback, ReactNode } from 'react'
import {
  Slide,
  EditSession,
  ApiConfig,
  GenerationConfig,
  FullApiConfig,
  ProjectStatus,
  WorkflowState
} from '../types'
import { loadApiConfig, loadFullApiConfig } from '../utils/apiConfig'
import { DEFAULT_GENERATION_CONFIG } from '../utils/generationConfig'

/**
 * 应用状态接口
 */
export interface AppState {
  // 文件状态
  uploadedFile: File | null
  fileContent: string
  fileName: string

  // 项目状态
  projectId: string | null
  status: ProjectStatus
  workflow: WorkflowState
  generationRunId: string | null

  // API 配置（完整版）
  fullApiConfig: FullApiConfig

  // API 配置（向后兼容）
  apiConfig: ApiConfig

  // 生成配置
  generationConfig: GenerationConfig

  // 生成状态
  slides: Slide[]
  lastCompletedSlides: Slide[]
  isGenerating: boolean
  generationProgress: {
    current: number
    total: number
    status: string
    message: string
  }
  generationError: string | null

  // 编辑状态
  editingSlide: EditSession | null
  selectedSlideId: string | null
}

function createEmptyWorkflowState(): WorkflowState {
  return {
    status: 'idle',
    outline: null,
    slidePrompts: [],
    expandedOutlinePages: [],
    expandedDesignPages: [],
    error: null
  }
}

function createEmptyGenerationProgress(): AppState['generationProgress'] {
  return {
    current: 0,
    total: 0,
    status: '',
    message: ''
  }
}

/**
 * 初始状态
 */
const initialState: AppState = {
  uploadedFile: null,
  fileContent: '',
  fileName: '',
  projectId: null,
  status: 'draft',
  workflow: createEmptyWorkflowState(),
  generationRunId: null,
  fullApiConfig: loadFullApiConfig(),
  apiConfig: loadApiConfig(),
  generationConfig: DEFAULT_GENERATION_CONFIG,
  slides: [],
  lastCompletedSlides: [],
  isGenerating: false,
  generationProgress: createEmptyGenerationProgress(),
  generationError: null,
  editingSlide: null,
  selectedSlideId: null
}

/**
 * 恢复状态的数据结构
 */
interface RestoreStatePayload {
  projectId: string
  fileContent: string
  fileName: string
  slides: Slide[]
  generationConfig: GenerationConfig
  workflow: WorkflowState
  status?: ProjectStatus
  lastCompletedSlides?: Slide[]
}

function sortSlides(slides: Slide[]): Slide[] {
  return [...slides].sort((a, b) => a.pageNumber - b.pageNumber)
}

function upsertSlide(slides: Slide[], nextSlide: Slide): Slide[] {
  const existingIndex = slides.findIndex(slide => slide.id === nextSlide.id)
  if (existingIndex >= 0) {
    const updated = [...slides]
    updated[existingIndex] = nextSlide
    return sortSlides(updated)
  }
  return sortSlides([...slides, nextSlide])
}

function dedupeSlides(slides: Slide[]): Slide[] {
  const byId = new Map<string, Slide>()
  for (const slide of slides) {
    byId.set(slide.id, slide)
  }
  return sortSlides(Array.from(byId.values()))
}

function slideAssetRefsEqual(first: Slide['imageAsset'], second: Slide['imageAsset']): boolean {
  if (first === second) {
    return true
  }

  if (!first || !second) {
    return !first && !second
  }

  return first.mimeType === second.mimeType &&
    first.byteLength === second.byteLength &&
    first.sha256 === second.sha256
}

function editHistoriesEqual(first: Slide['editHistory'], second: Slide['editHistory']): boolean {
  if (first === second) {
    return true
  }

  if (!first || !second || first.length !== second.length) {
    return !first && !second
  }

  return first.every((item, index) => {
    const other = second[index]
    return item.imageUrl === other.imageUrl &&
      item.imageBase64 === other.imageBase64 &&
      item.instruction === other.instruction &&
      item.timestamp === other.timestamp
  })
}

function matchesCompletedSlideSnapshot(currentSlide: Slide | undefined, completedSlide: Slide | undefined): boolean {
  if (!currentSlide || !completedSlide) {
    return false
  }

  return currentSlide.id === completedSlide.id &&
    currentSlide.pageNumber === completedSlide.pageNumber &&
    currentSlide.imageUrl === completedSlide.imageUrl &&
    currentSlide.imageBase64 === completedSlide.imageBase64 &&
    currentSlide.prompt === completedSlide.prompt &&
    currentSlide.updatedAt === completedSlide.updatedAt &&
    slideAssetRefsEqual(currentSlide.imageAsset, completedSlide.imageAsset) &&
    editHistoriesEqual(currentSlide.editHistory, completedSlide.editHistory)
}

function resetProjectRuntimeState(state: AppState): AppState {
  return {
    ...state,
    projectId: null,
    slides: [],
    lastCompletedSlides: [],
    isGenerating: false,
    generationProgress: createEmptyGenerationProgress(),
    generationError: null,
    editingSlide: null,
    selectedSlideId: null,
    workflow: createEmptyWorkflowState(),
    status: 'draft',
    generationRunId: null
  }
}

function statusFromWorkflow(currentStatus: ProjectStatus, workflow: WorkflowState): ProjectStatus {
  if (workflow.status === 'prompts_ready') {
    return 'prompts_ready'
  }

  if (workflow.status === 'error') {
    return 'error'
  }

  return currentStatus
}

function normalizeRestoredStatus(
  status: ProjectStatus | undefined,
  workflow: WorkflowState,
  slides: Slide[]
): ProjectStatus {
  const restoredStatus = status ?? (slides.length > 0 ? 'generated' : 'draft')

  if (restoredStatus !== 'generating') {
    return restoredStatus
  }

  if (slides.length > 0) {
    return 'generated'
  }

  return statusFromWorkflow('draft', workflow)
}

/**
 * Action 类型
 */
type AppAction =
  | { type: 'SET_FILE'; payload: { file: File; content: string; name: string } }
  | { type: 'SET_FILE_CONTENT'; payload: { content: string; name: string } }
  | { type: 'CLEAR_FILE' }
  | { type: 'SET_API_CONFIG'; payload: ApiConfig }
  | { type: 'SET_FULL_API_CONFIG'; payload: FullApiConfig }
  | { type: 'SET_GENERATION_CONFIG'; payload: GenerationConfig }
  | { type: 'START_GENERATION'; payload: { runId: string } }
  | { type: 'UPDATE_PROGRESS'; payload: { current: number; total: number; status: string; message: string } }
  | { type: 'ADD_SLIDE'; payload: Slide }
  | { type: 'UPDATE_SLIDE'; payload: { id: string; updates: Partial<Slide> } }
  | { type: 'SET_SLIDES'; payload: Slide[] }
  | { type: 'COMPLETE_GENERATION' }
  | { type: 'GENERATION_ERROR'; payload: string }
  | { type: 'CLEAR_GENERATION_ERROR' }
  | { type: 'SELECT_SLIDE'; payload: string | null }
  | { type: 'START_EDIT'; payload: EditSession }
  | { type: 'UPDATE_EDIT'; payload: Partial<EditSession> }
  | { type: 'END_EDIT' }
  | { type: 'RESET_STATE' }
  | { type: 'RESTORE_STATE'; payload: RestoreStatePayload }
  | { type: 'SET_WORKFLOW'; payload: WorkflowState }
  | { type: 'SET_PROJECT_ID'; payload: string | null }

/**
 * Reducer 函数
 */
function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_FILE':
      return resetProjectRuntimeState({
        ...state,
        uploadedFile: action.payload.file,
        fileContent: action.payload.content,
        fileName: action.payload.name
      })

    case 'SET_FILE_CONTENT':
      return resetProjectRuntimeState({
        ...state,
        uploadedFile: null,
        fileContent: action.payload.content,
        fileName: action.payload.name
      })

    case 'CLEAR_FILE':
      return resetProjectRuntimeState({
        ...state,
        uploadedFile: null,
        fileContent: '',
        fileName: ''
      })

    case 'SET_API_CONFIG':
      return {
        ...state,
        apiConfig: action.payload
      }

    case 'SET_FULL_API_CONFIG':
      return {
        ...state,
        fullApiConfig: action.payload,
        // 同步更新向后兼容的 apiConfig
        apiConfig: {
          apiKey: action.payload.image.apiKey,
          baseUrl: action.payload.image.baseUrl
        }
      }

    case 'SET_GENERATION_CONFIG':
      return {
        ...state,
        generationConfig: action.payload
      }

    case 'START_GENERATION':
      return {
        ...state,
        isGenerating: true,
        status: 'generating',
        generationRunId: action.payload.runId,
        generationProgress: {
          current: 0,
          total: 0,
          status: 'started',
          message: '开始生成 PPT'
        },
        generationError: null,
        slides: []
      }

    case 'UPDATE_PROGRESS':
      return {
        ...state,
        generationProgress: action.payload
      }

    case 'ADD_SLIDE': {
      return {
        ...state,
        slides: upsertSlide(state.slides, action.payload)
      }
    }

    case 'UPDATE_SLIDE': {
      const currentSlide = state.slides.find(slide => slide.id === action.payload.id)
      const completedSlide = state.lastCompletedSlides.find(slide => slide.id === action.payload.id)
      const updatedSlides = state.slides.map(slide =>
        slide.id === action.payload.id
          ? { ...slide, ...action.payload.updates }
          : slide
      )
      const hasEditableCompletedDeck = state.status === 'generated' || state.status === 'prompts_ready'
      const isFallbackOnlyCompletedSlide = !currentSlide && state.slides.length === 0
      const shouldUpdateCompletedSlides = Boolean(completedSlide) && (
        isFallbackOnlyCompletedSlide ||
        (
          !state.isGenerating &&
          Boolean(currentSlide) &&
          (hasEditableCompletedDeck || matchesCompletedSlideSnapshot(currentSlide, completedSlide))
        )
      )

      return {
        ...state,
        slides: updatedSlides,
        lastCompletedSlides: shouldUpdateCompletedSlides
          ? state.lastCompletedSlides.map(slide =>
            slide.id === action.payload.id
              ? { ...slide, ...action.payload.updates }
              : slide
          )
          : state.lastCompletedSlides
      }
    }

    case 'SET_SLIDES':
      return {
        ...state,
        slides: dedupeSlides(action.payload)
      }

    case 'COMPLETE_GENERATION':
      return {
        ...state,
        isGenerating: false,
        status: 'generated',
        generationRunId: null,
        lastCompletedSlides: state.slides,
        generationProgress: {
          ...state.generationProgress,
          status: 'completed',
          message: 'PPT 生成完成'
        }
      }

    case 'GENERATION_ERROR':
      return {
        ...state,
        isGenerating: false,
        status: 'error',
        generationRunId: null,
        generationError: action.payload
      }

    case 'CLEAR_GENERATION_ERROR':
      return {
        ...state,
        generationError: null
      }

    case 'SELECT_SLIDE':
      return {
        ...state,
        selectedSlideId: action.payload
      }

    case 'START_EDIT':
      return {
        ...state,
        editingSlide: action.payload
      }

    case 'UPDATE_EDIT':
      if (!state.editingSlide) return state
      return {
        ...state,
        editingSlide: {
          ...state.editingSlide,
          ...action.payload
        }
      }

    case 'END_EDIT':
      return {
        ...state,
        editingSlide: null
      }

    case 'RESET_STATE':
      return {
        ...initialState,
        workflow: createEmptyWorkflowState(),
        generationProgress: createEmptyGenerationProgress(),
        apiConfig: state.apiConfig, // 保留 API 配置
        fullApiConfig: state.fullApiConfig // 保留完整 API 配置
      }

    case 'RESTORE_STATE': {
      const slides = dedupeSlides(action.payload.slides)
      const lastCompletedSlides = dedupeSlides(action.payload.lastCompletedSlides ?? action.payload.slides)
      const status = normalizeRestoredStatus(action.payload.status, action.payload.workflow, slides)

      return {
        ...state,
        projectId: action.payload.projectId,
        uploadedFile: null,
        fileContent: action.payload.fileContent,
        fileName: action.payload.fileName,
        slides,
        lastCompletedSlides,
        generationConfig: action.payload.generationConfig,
        workflow: action.payload.workflow,
        status,
        generationRunId: null,
        isGenerating: false,
        generationError: null,
        editingSlide: null,
        selectedSlideId: null,
        generationProgress: {
          current: slides.length,
          total: slides.length,
          status: slides.length > 0 ? 'completed' : '',
          message: slides.length > 0 ? '已恢复之前的会话' : ''
        }
      }
    }

    case 'SET_WORKFLOW':
      return {
        ...state,
        workflow: action.payload,
        status: statusFromWorkflow(state.status, action.payload)
      }

    case 'SET_PROJECT_ID':
      return {
        ...state,
        projectId: action.payload
      }

    default:
      return state
  }
}

/**
 * Context 类型
 */
export interface AppStateContextType {
  state: AppState
  dispatch: React.Dispatch<AppAction>
  // 便捷方法
  setFile: (file: File, content: string, name: string) => void
  clearFile: () => void
  setApiConfig: (config: ApiConfig) => void
  setFullApiConfig: (config: FullApiConfig) => void
  setGenerationConfig: (config: GenerationConfig) => void
  startGeneration: (runId: string) => void
  updateProgress: (current: number, total: number, status: string, message: string) => void
  addSlide: (slide: Slide) => void
  updateSlide: (id: string, updates: Partial<Slide>) => void
  setSlides: (slides: Slide[]) => void
  completeGeneration: () => void
  setGenerationError: (error: string) => void
  clearGenerationError: () => void
  selectSlide: (id: string | null) => void
  startEdit: (session: EditSession) => void
  updateEdit: (updates: Partial<EditSession>) => void
  endEdit: () => void
  resetState: () => void
  restoreState: (data: RestoreStatePayload) => void
  setFileContent: (content: string, name: string) => void
  setWorkflow: (workflow: WorkflowState) => void
  setProjectId: (id: string | null) => void
}

/**
 * 创建 Context
 */
const AppStateContext = createContext<AppStateContextType | null>(null)

/**
 * Provider 组件
 */
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState)

  // 便捷方法
  const setFile = useCallback((file: File, content: string, name: string) => {
    dispatch({ type: 'SET_FILE', payload: { file, content, name } })
  }, [])

  const clearFile = useCallback(() => {
    dispatch({ type: 'CLEAR_FILE' })
  }, [])

  const setApiConfig = useCallback((config: ApiConfig) => {
    dispatch({ type: 'SET_API_CONFIG', payload: config })
  }, [])

  const setFullApiConfig = useCallback((config: FullApiConfig) => {
    dispatch({ type: 'SET_FULL_API_CONFIG', payload: config })
  }, [])

  const setGenerationConfig = useCallback((config: GenerationConfig) => {
    dispatch({ type: 'SET_GENERATION_CONFIG', payload: config })
  }, [])

  const startGeneration = useCallback((runId: string) => {
    dispatch({ type: 'START_GENERATION', payload: { runId } })
  }, [])

  const updateProgress = useCallback((current: number, total: number, status: string, message: string) => {
    dispatch({ type: 'UPDATE_PROGRESS', payload: { current, total, status, message } })
  }, [])

  const addSlide = useCallback((slide: Slide) => {
    dispatch({ type: 'ADD_SLIDE', payload: slide })
  }, [])

  const updateSlide = useCallback((id: string, updates: Partial<Slide>) => {
    dispatch({ type: 'UPDATE_SLIDE', payload: { id, updates } })
  }, [])

  const setSlides = useCallback((slides: Slide[]) => {
    dispatch({ type: 'SET_SLIDES', payload: slides })
  }, [])

  const completeGeneration = useCallback(() => {
    dispatch({ type: 'COMPLETE_GENERATION' })
  }, [])

  const setGenerationError = useCallback((error: string) => {
    dispatch({ type: 'GENERATION_ERROR', payload: error })
  }, [])

  const clearGenerationError = useCallback(() => {
    dispatch({ type: 'CLEAR_GENERATION_ERROR' })
  }, [])

  const selectSlide = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_SLIDE', payload: id })
  }, [])

  const startEdit = useCallback((session: EditSession) => {
    dispatch({ type: 'START_EDIT', payload: session })
  }, [])

  const updateEdit = useCallback((updates: Partial<EditSession>) => {
    dispatch({ type: 'UPDATE_EDIT', payload: updates })
  }, [])

  const endEdit = useCallback(() => {
    dispatch({ type: 'END_EDIT' })
  }, [])

  const resetState = useCallback(() => {
    dispatch({ type: 'RESET_STATE' })
  }, [])

  const restoreState = useCallback((data: RestoreStatePayload) => {
    dispatch({ type: 'RESTORE_STATE', payload: data })
  }, [])

  const setFileContent = useCallback((content: string, name: string) => {
    dispatch({ type: 'SET_FILE_CONTENT', payload: { content, name } })
  }, [])

  const setWorkflow = useCallback((workflow: WorkflowState) => {
    dispatch({ type: 'SET_WORKFLOW', payload: workflow })
  }, [])

  const setProjectId = useCallback((id: string | null) => {
    dispatch({ type: 'SET_PROJECT_ID', payload: id })
  }, [])

  const value: AppStateContextType = {
    state,
    dispatch,
    setFile,
    clearFile,
    setApiConfig,
    setFullApiConfig,
    setGenerationConfig,
    startGeneration,
    updateProgress,
    addSlide,
    updateSlide,
    setSlides,
    completeGeneration,
    setGenerationError,
    clearGenerationError,
    selectSlide,
    startEdit,
    updateEdit,
    endEdit,
    resetState,
    restoreState,
    setFileContent,
    setWorkflow,
    setProjectId
  }

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  )
}

export { AppStateContext }
// eslint-disable-next-line react-refresh/only-export-components -- Test-only reducer exports for AppState persistence coverage.
export { appReducer as appReducerForTests, initialState as initialAppStateForTests }
export type { AppAction }

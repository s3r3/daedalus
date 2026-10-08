import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DesignWorkflowPanel from '../DesignWorkflowPanel'
import { UiPreferencesProvider } from '../../contexts/UiPreferencesContext'
import { ConfirmedSlidePrompt, DeckOutline, FullApiConfig, GenerationConfig, WorkflowState } from '../../types'

const fullApiConfig: FullApiConfig = {
  image: { apiKey: '', baseUrl: '', model: 'gpt-image-2' },
  edit: { apiKey: '', baseUrl: '', model: 'gpt-image-2' },
  text: { apiKey: '', baseUrl: '', model: 'DeepSeek-V4-Pro', format: 'openai' }
}

const generationConfig: GenerationConfig = {
  pageCount: 2,
  quality: '1K',
  aspectRatio: '16:9',
  language: '中文',
  style: '现代简约商务风格',
  targetAudience: '研发团队',
  userRequirements: '强调风险控制'
}

const outline: DeckOutline = {
  title: 'L9 设计大纲',
  user_requirements: '已强调风险控制',
  design_style: '现代简约商务风格',
  audience: '研发团队',
  slides: [
    {
      page: 1,
      title: '封面',
      narrative_goal: '建立主题',
      key_points: ['L9', '实验'],
      visual_direction: '大标题和抽象架构图'
    },
    {
      page: 2,
      title: '总结',
      narrative_goal: '收束观点',
      key_points: ['结论', '风险'],
      visual_direction: '结论卡片'
    }
  ]
}

const prompts: ConfirmedSlidePrompt[] = [
  {
    page: 1,
    title: '封面',
    content_summary: '封面摘要',
    display_content: '封面展示标题、来源和一个抽象架构图。',
    prompt: '你生成的 PPT 其中一页的内容，要图文并茂。封面。'
  },
  {
    page: 2,
    title: '总结',
    content_summary: '总结摘要',
    display_content: '总结页展示两个关键结论和风险控制建议。',
    prompt: '你生成的 PPT 其中一页的内容，要图文并茂。总结。'
  }
]

function emptyWorkflow(): WorkflowState {
  return {
    status: 'idle',
    outline: null,
    slidePrompts: [],
    expandedOutlinePages: [],
    expandedDesignPages: [],
    error: null
  }
}

function isEmptyWorkflowState(workflow: WorkflowState): boolean {
  return workflow.status === 'idle' &&
    workflow.outline === null &&
    workflow.slidePrompts.length === 0 &&
    workflow.expandedOutlinePages.length === 0 &&
    workflow.expandedDesignPages.length === 0 &&
    workflow.error === null
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function renderPanel({
  initialWorkflow = emptyWorkflow(),
  confirmedPrompts = null,
  onWorkflowChange = vi.fn(),
  onPromptsReady = vi.fn(),
  onClearPrompts = vi.fn()
}: {
  initialWorkflow?: WorkflowState
  confirmedPrompts?: ConfirmedSlidePrompt[] | null
  onWorkflowChange?: ReturnType<typeof vi.fn>
  onPromptsReady?: ReturnType<typeof vi.fn>
  onClearPrompts?: ReturnType<typeof vi.fn>
} = {}) {
  function ControlledPanel() {
    const [workflow, setWorkflow] = useState(initialWorkflow)

    const handleWorkflowChange = (nextWorkflow: WorkflowState) => {
      onWorkflowChange(nextWorkflow)
      setWorkflow(nextWorkflow)
    }

    return (
      <UiPreferencesProvider>
        <DesignWorkflowPanel
          fileContent="# L9"
          fullApiConfig={fullApiConfig}
          generationConfig={generationConfig}
          workflow={workflow}
          confirmedPrompts={confirmedPrompts}
          onWorkflowChange={handleWorkflowChange}
          onPromptsReady={onPromptsReady}
          onClearPrompts={onClearPrompts}
        />
      </UiPreferencesProvider>
    )
  }

  const view = render(
    <ControlledPanel />
  )
  return { ...view, onWorkflowChange, onPromptsReady, onClearPrompts }
}

describe('DesignWorkflowPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders an editable non-technical outline and collapsible page designs before image generation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, outline })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, slide_prompts: prompts })
      })
    vi.stubGlobal('fetch', fetchMock)

    const { onPromptsReady } = renderPanel()

    fireEvent.click(screen.getByRole('button', { name: '生成设计大纲' }))

    const titleInput = await screen.findByLabelText('大纲标题')
    expect(titleInput).toHaveValue('L9 设计大纲')
    expect(screen.getByText('PPT 大纲')).toBeInTheDocument()
    expect(screen.queryByText('渲染后的设计大纲')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('设计大纲编辑器')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('第 1 页标题'), { target: { value: '封面：技术实验' } })
    fireEvent.click(screen.getByRole('button', { name: '展开第 1 页大纲' }))
    expect(screen.getByLabelText('第 1 页叙事目标')).toHaveValue('建立主题')
    expect(screen.getByLabelText('第 1 页关键要点')).toHaveValue('L9\n实验')
    fireEvent.change(screen.getByLabelText('第 1 页关键要点'), { target: { value: 'L9\n实验\n' } })
    expect(screen.getByLabelText('第 1 页关键要点')).toHaveValue('L9\n实验\n')

    fireEvent.click(screen.getByRole('button', { name: '确认大纲并生成逐页设计' }))

    await waitFor(() => {
      expect(onPromptsReady).toHaveBeenCalledWith(prompts)
    })
    expect(screen.getByText('逐页设计预览')).toBeInTheDocument()
    expect(screen.getByText('封面摘要')).toBeInTheDocument()
    expect(screen.queryByText('封面展示标题、来源和一个抽象架构图。')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开第 1 页设计' }))
    expect(screen.getByText('封面展示标题、来源和一个抽象架构图。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '收起第 1 页设计' }))
    expect(screen.queryByText('封面展示标题、来源和一个抽象架构图。')).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]?.body).toContain('封面：技术实验')
    const promptRequest = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
    expect(promptRequest.outline.slides[0].key_points).toEqual(['L9', '实验'])
  })

  it('renders restored workflow and invalidates prompts when the restored outline changes', () => {
    const restoredPrompt: ConfirmedSlidePrompt = {
      page: 1,
      title: 'Restored page',
      content_summary: 'Restored summary',
      display_content: 'Restored display',
      prompt: 'Restored prompt'
    }
    const restoredWorkflow: WorkflowState = {
      status: 'prompts_ready',
      outline: {
        title: 'Restored outline',
        user_requirements: 'Restored requirements',
        design_style: 'Restored style',
        audience: 'Restored audience',
        slides: [
          {
            page: 1,
            title: 'Restored page',
            narrative_goal: 'Restored goal',
            key_points: ['Restored point'],
            visual_direction: 'Restored visual direction'
          }
        ]
      },
      slidePrompts: [restoredPrompt],
      expandedOutlinePages: [],
      expandedDesignPages: [],
      error: null
    }
    const onWorkflowChange = vi.fn()
    const onClearPrompts = vi.fn()

    renderPanel({
      initialWorkflow: restoredWorkflow,
      confirmedPrompts: [restoredPrompt],
      onWorkflowChange,
      onClearPrompts
    })

    expect(screen.getByLabelText('大纲标题')).toHaveValue('Restored outline')
    expect(screen.getByLabelText('第 1 页标题')).toHaveValue('Restored page')
    expect(screen.getByText('逐页设计预览')).toBeInTheDocument()
    expect(screen.getByText('Restored summary')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '展开第 1 页设计' }))
    expect(screen.getByText('Restored display')).toBeInTheDocument()

    const workflowCallsBeforeEdit = onWorkflowChange.mock.calls.length
    const clearCallsBeforeEdit = onClearPrompts.mock.calls.length
    fireEvent.change(screen.getByLabelText('大纲标题'), { target: { value: 'Edited restored outline' } })

    expect(onWorkflowChange.mock.calls.length).toBeGreaterThan(workflowCallsBeforeEdit)
    expect(onClearPrompts.mock.calls.length).toBeGreaterThan(clearCallsBeforeEdit)
    const updatedWorkflow = onWorkflowChange.mock.calls.at(-1)?.[0] as WorkflowState
    expect(updatedWorkflow.status).toBe('outline_ready')
    expect(updatedWorkflow.outline?.title).toBe('Edited restored outline')
    expect(updatedWorkflow.slidePrompts).toEqual([])
    expect(updatedWorkflow.expandedDesignPages).toEqual([])
  })

  it('preserves restored workflow when the panel hydrates from an initially empty app shell', async () => {
    const restoredPrompt: ConfirmedSlidePrompt = {
      page: 1,
      title: 'Hydrated page',
      content_summary: 'Hydrated summary',
      display_content: 'Hydrated display',
      prompt: 'Hydrated prompt'
    }
    const restoredWorkflow: WorkflowState = {
      status: 'prompts_ready',
      outline: {
        title: 'Hydrated outline',
        user_requirements: 'Hydrated requirements',
        design_style: 'Hydrated style',
        audience: 'Hydrated audience',
        slides: [
          {
            page: 1,
            title: 'Hydrated page',
            narrative_goal: 'Hydrated goal',
            key_points: ['Hydrated point'],
            visual_direction: 'Hydrated visual direction'
          }
        ]
      },
      slidePrompts: [restoredPrompt],
      expandedOutlinePages: [],
      expandedDesignPages: [],
      error: null
    }
    const restoredGenerationConfig: GenerationConfig = {
      ...generationConfig,
      pageCount: 1
    }
    const onWorkflowChange = vi.fn()

    function HydratingPanel() {
      const [fileContent, setFileContent] = useState('')
      const [currentGenerationConfig, setCurrentGenerationConfig] = useState(generationConfig)
      const [workflow, setWorkflow] = useState(emptyWorkflow())
      const [confirmedPrompts, setConfirmedPrompts] = useState<ConfirmedSlidePrompt[] | null>(null)

      const handleWorkflowChange = (nextWorkflow: WorkflowState) => {
        onWorkflowChange(nextWorkflow)
        setWorkflow(nextWorkflow)
      }

      const restoreWorkflow = () => {
        setFileContent('# L9')
        setCurrentGenerationConfig(restoredGenerationConfig)
        setWorkflow(restoredWorkflow)
        setConfirmedPrompts([restoredPrompt])
      }

      return (
        <UiPreferencesProvider>
          <button type="button" onClick={restoreWorkflow}>restore</button>
          <DesignWorkflowPanel
            fileContent={fileContent}
            fullApiConfig={fullApiConfig}
            generationConfig={currentGenerationConfig}
            workflow={workflow}
            confirmedPrompts={confirmedPrompts}
            onWorkflowChange={handleWorkflowChange}
            onPromptsReady={setConfirmedPrompts}
            onClearPrompts={() => setConfirmedPrompts(null)}
          />
        </UiPreferencesProvider>
      )
    }

    render(<HydratingPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'restore' }))

    expect(await screen.findByLabelText('大纲标题')).toHaveValue('Hydrated outline')
    expect(screen.getByLabelText('第 1 页标题')).toHaveValue('Hydrated page')
    expect(screen.getByText('逐页设计预览')).toBeInTheDocument()
    expect(screen.getByText('Hydrated summary')).toBeInTheDocument()
    expect(onWorkflowChange.mock.calls.some(([nextWorkflow]) => isEmptyWorkflowState(nextWorkflow))).toBe(false)
  })

  it('ignores stale prompt responses after the outline changes while prompts are loading', async () => {
    const promptResponse = createDeferred<{ success: true; slide_prompts: ConfirmedSlidePrompt[] }>()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => promptResponse.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const onPromptsReady = vi.fn()

    renderPanel({
      initialWorkflow: {
        ...emptyWorkflow(),
        status: 'outline_ready',
        outline
      },
      onPromptsReady
    })

    fireEvent.click(screen.getByRole('button', { name: '确认大纲并生成逐页设计' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(screen.getByLabelText('大纲标题'), { target: { value: 'Edited while loading' } })
    promptResponse.resolve({ success: true, slide_prompts: prompts })

    await waitFor(() => {
      expect(screen.getByLabelText('大纲标题')).toHaveValue('Edited while loading')
    })
    expect(screen.queryByText('逐页设计预览')).not.toBeInTheDocument()
    expect(onPromptsReady).not.toHaveBeenCalled()
  })

  it('ignores stale outline regeneration after the visible outline changes while loading', async () => {
    const outlineResponse = createDeferred<{ success: true; outline: DeckOutline }>()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => outlineResponse.promise
    })
    vi.stubGlobal('fetch', fetchMock)

    renderPanel({
      initialWorkflow: {
        ...emptyWorkflow(),
        status: 'outline_ready',
        outline
      }
    })

    fireEvent.click(screen.getByRole('button', { name: '生成设计大纲' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    fireEvent.change(screen.getByLabelText('大纲标题'), { target: { value: 'Edited while outline loads' } })
    outlineResponse.resolve({
      success: true,
      outline: {
        ...outline,
        title: 'Stale regenerated outline'
      }
    })

    await waitFor(() => {
      expect(screen.getByLabelText('大纲标题')).toHaveValue('Edited while outline loads')
    })
    expect(screen.queryByDisplayValue('Stale regenerated outline')).not.toBeInTheDocument()
  })

  it('ignores outline responses that resolve after the panel unmounts', async () => {
    const outlineResponse = createDeferred<{ success: true; outline: DeckOutline }>()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => outlineResponse.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const onWorkflowChange = vi.fn()

    const { unmount } = renderPanel({ onWorkflowChange })

    fireEvent.click(screen.getByRole('button', { name: '生成设计大纲' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(onWorkflowChange).toHaveBeenCalledTimes(1)
    })
    expect(onWorkflowChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'outline_loading'
    }))

    unmount()
    await act(async () => {
      outlineResponse.resolve({
        success: true,
        outline: {
          ...outline,
          title: 'Unmounted stale outline'
        }
      })
      await outlineResponse.promise
      await Promise.resolve()
    })

    expect(onWorkflowChange).toHaveBeenCalledTimes(1)
    expect(onWorkflowChange).not.toHaveBeenCalledWith(expect.objectContaining({
      status: 'outline_ready',
      outline: expect.objectContaining({ title: 'Unmounted stale outline' })
    }))
  })

  it('ignores prompt responses that resolve after the panel unmounts', async () => {
    const promptResponse = createDeferred<{ success: true; slide_prompts: ConfirmedSlidePrompt[] }>()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => promptResponse.promise
    })
    vi.stubGlobal('fetch', fetchMock)
    const onWorkflowChange = vi.fn()
    const onPromptsReady = vi.fn()

    const { unmount } = renderPanel({
      initialWorkflow: {
        ...emptyWorkflow(),
        status: 'outline_ready',
        outline
      },
      onWorkflowChange,
      onPromptsReady
    })

    fireEvent.click(screen.getByRole('button', { name: '确认大纲并生成逐页设计' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(onWorkflowChange).toHaveBeenCalledTimes(1)
    })
    expect(onWorkflowChange).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'prompts_loading'
    }))

    unmount()
    await act(async () => {
      promptResponse.resolve({ success: true, slide_prompts: prompts })
      await promptResponse.promise
      await Promise.resolve()
    })

    expect(onWorkflowChange).toHaveBeenCalledTimes(1)
    expect(onWorkflowChange).not.toHaveBeenCalledWith(expect.objectContaining({
      status: 'prompts_ready'
    }))
    expect(onPromptsReady).not.toHaveBeenCalled()
  })

  it.each([
    ['quality', { quality: '2K' as const }],
    ['aspect ratio', { aspectRatio: '4:3' as const }]
  ])('resets workflow when %s changes', async (_label, nextConfig) => {
    const restoredPrompt: ConfirmedSlidePrompt = {
      page: 1,
      title: 'Config page',
      content_summary: 'Config summary',
      display_content: 'Config display',
      prompt: 'Config prompt'
    }
    const restoredWorkflow: WorkflowState = {
      status: 'prompts_ready',
      outline: {
        title: 'Config outline',
        user_requirements: 'Config requirements',
        design_style: 'Config style',
        audience: 'Config audience',
        slides: [
          {
            page: 1,
            title: 'Config page',
            narrative_goal: 'Config goal',
            key_points: ['Config point'],
            visual_direction: 'Config visual direction'
          }
        ]
      },
      slidePrompts: [restoredPrompt],
      expandedOutlinePages: [],
      expandedDesignPages: [],
      error: null
    }
    const onWorkflowChange = vi.fn()
    const onClearPrompts = vi.fn()

    function ConfigChangingPanel() {
      const [currentGenerationConfig, setCurrentGenerationConfig] = useState(generationConfig)
      const [workflow, setWorkflow] = useState(restoredWorkflow)

      const handleWorkflowChange = (nextWorkflow: WorkflowState) => {
        onWorkflowChange(nextWorkflow)
        setWorkflow(nextWorkflow)
      }

      return (
        <UiPreferencesProvider>
          <button
            type="button"
            onClick={() => setCurrentGenerationConfig({ ...generationConfig, ...nextConfig })}
          >
            change config
          </button>
          <DesignWorkflowPanel
            fileContent="# L9"
            fullApiConfig={fullApiConfig}
            generationConfig={currentGenerationConfig}
            workflow={workflow}
            confirmedPrompts={[restoredPrompt]}
            onWorkflowChange={handleWorkflowChange}
            onPromptsReady={vi.fn()}
            onClearPrompts={onClearPrompts}
          />
        </UiPreferencesProvider>
      )
    }

    render(<ConfigChangingPanel />)
    expect(screen.getByLabelText('大纲标题')).toHaveValue('Config outline')

    fireEvent.click(screen.getByRole('button', { name: 'change config' }))

    await waitFor(() => {
      expect(onWorkflowChange.mock.calls.some(([nextWorkflow]) => isEmptyWorkflowState(nextWorkflow))).toBe(true)
    })
    expect(onClearPrompts).toHaveBeenCalled()
  })
})

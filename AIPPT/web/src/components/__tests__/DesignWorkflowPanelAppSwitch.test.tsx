import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import type { DeckOutline, ProjectRecord, ProjectSummary, WorkflowState } from '../../types'

const mocks = vi.hoisted(() => {
  const firstSummary: ProjectSummary = {
    id: 'first-project',
    title: 'First Deck',
    fileName: 'first.md',
    slideCount: 0,
    status: 'prompts_ready',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1
  }
  const secondSummary: ProjectSummary = {
    id: 'second-project',
    title: 'Second Deck',
    fileName: 'second.md',
    slideCount: 0,
    status: 'prompts_ready',
    createdAt: 2,
    updatedAt: 2,
    lastOpenedAt: 2
  }

  const outlineFor = (title: string): DeckOutline => ({
    title,
    user_requirements: `${title} requirements`,
    design_style: `${title} style`,
    audience: `${title} audience`,
    slides: [{
      page: 1,
      title: `${title} page`,
      narrative_goal: `${title} goal`,
      key_points: [`${title} point`],
      visual_direction: `${title} visual`
    }]
  })
  const workflowFor = (title: string): WorkflowState => ({
    status: 'prompts_ready',
    outline: outlineFor(title),
    slidePrompts: [{
      page: 1,
      title: `${title} page`,
      content_summary: `${title} summary`,
      display_content: `${title} display`,
      prompt: `${title} prompt`
    }],
    expandedOutlinePages: [],
    expandedDesignPages: [],
    error: null
  })
  const projectFor = (id: string, title: string): ProjectRecord => ({
    version: 2,
    id,
    title,
    fileName: `${id}.md`,
    fileContent: `# ${title}`,
    slides: [],
    generationConfig: {
      pageCount: 1,
      quality: '1K',
      aspectRatio: '16:9'
    },
    workflow: workflowFor(`${title} outline`),
    status: 'prompts_ready',
    generationRunId: null,
    lastCompletedSlides: [],
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1
  })

  return {
    firstSummary,
    secondSummary,
    firstProject: projectFor('first-project', 'First'),
    secondProject: projectFor('second-project', 'Second'),
    openProject: vi.fn(),
    createProject: vi.fn(),
    renameProject: vi.fn(),
    duplicateProject: vi.fn(),
    deleteProject: vi.fn(),
    refreshProjects: vi.fn(),
    saveNow: vi.fn()
  }
})

vi.mock('../Layout', () => ({
  default: ({ leftPanel, centerPanel }: { leftPanel: React.ReactNode; centerPanel: React.ReactNode }) => (
    <div>
      <section>{leftPanel}</section>
      <section>{centerPanel}</section>
    </div>
  )
}))

vi.mock('../LeftPanel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('../CenterPanel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('../RightPanel', () => ({ default: () => null }))
vi.mock('../ApiConfigForm', () => ({ default: () => null }))
vi.mock('../GenerationConfigForm', () => ({ default: () => null }))
vi.mock('../GenerateButton', () => ({ default: () => null }))
vi.mock('../ProgressIndicator', () => ({ default: () => null }))
vi.mock('../ConfirmDialog', () => ({ default: () => null }))
vi.mock('../RestoreSessionDialog', () => ({ default: () => null }))

vi.mock('../../hooks/useEdit', () => ({
  useEdit: () => ({
    editSession: null,
    isEditing: false,
    beginEdit: vi.fn(),
    submitEdit: vi.fn(),
    revertToVersion: vi.fn(),
    confirmEdit: vi.fn(),
    cancelEdit: vi.fn()
  })
}))

vi.mock('../../hooks/useEditConflict', () => ({
  useEditConflict: () => ({
    showConfirmDialog: false,
    tryStartEdit: vi.fn(() => true),
    tryCancelEdit: vi.fn(() => true),
    confirmDiscard: vi.fn(),
    cancelDiscard: vi.fn()
  })
}))

vi.mock('../../hooks/useExport', () => ({
  useExport: () => ({
    state: { isExporting: false, progress: 0, error: null },
    startExport: vi.fn()
  })
}))

vi.mock('../../hooks/useStateRestore', () => ({
  useStateRestore: () => ({
    isRestoring: false,
    hasRestoredData: false,
    restoredProject: null,
    dismissRestore: vi.fn()
  })
}))

vi.mock('../../hooks/useGeneration', () => ({
  useGeneration: () => ({
    generate: vi.fn(),
    cancel: vi.fn(),
    isGenerating: false,
    progress: { current: 0, total: 0, status: '', message: '' },
    error: null,
    slides: []
  })
}))

vi.mock('../../hooks/useAutoSave', () => ({
  useAutoSave: () => ({
    isSaving: false,
    lastSaved: null,
    saveNow: mocks.saveNow
  })
}))

vi.mock('../../hooks/useProjectManager', () => ({
  useProjectManager: () => ({
    projects: [mocks.firstSummary, mocks.secondSummary],
    activeProjectId: null,
    isLoadingProjects: false,
    refreshProjects: mocks.refreshProjects,
    openProject: mocks.openProject,
    createProject: mocks.createProject,
    renameProject: mocks.renameProject,
    duplicateProject: mocks.duplicateProject,
    deleteProject: mocks.deleteProject
  })
}))

describe('DesignWorkflowPanel project switching from App', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('preserves the incoming restored workflow when switching between populated projects', async () => {
    mocks.saveNow.mockResolvedValue(undefined)
    mocks.openProject.mockImplementation(async (id: string) => (
      id === 'first-project' ? mocks.firstProject : mocks.secondProject
    ))

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /打开 First Deck/ }))
    expect(await screen.findByDisplayValue('First outline')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /打开 Second Deck/ }))
    expect(await screen.findByDisplayValue('Second outline')).toBeInTheDocument()

    await Promise.resolve()
    expect(screen.getByDisplayValue('Second outline')).toBeInTheDocument()
    expect(screen.getByText('Second outline summary')).toBeInTheDocument()
  })
})

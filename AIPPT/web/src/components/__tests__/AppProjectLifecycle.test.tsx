import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import type { EditSession, ProjectRecord, ProjectSummary, Slide } from '../../types'

interface AutoSaveCancellation {
  resume: () => void
}

const mocks = vi.hoisted(() => {
  const operations: string[] = []
  const slide: Slide = {
    id: 'current-slide',
    pageNumber: 1,
    imageUrl: 'data:image/png;base64,current',
    imageBase64: 'current',
    prompt: 'current prompt'
  }
  const projectSummary: ProjectSummary = {
    id: 'saved-project',
    title: 'Saved Deck',
    fileName: 'saved.md',
    slideCount: 3,
    status: 'generated',
    createdAt: 1712131200000,
    updatedAt: 1712131200000,
    lastOpenedAt: 1712131200000
  }
  const currentProjectSummary: ProjectSummary = {
    id: 'current-project',
    title: 'Current Deck',
    fileName: 'current.md',
    slideCount: 1,
    status: 'generated',
    createdAt: 1712131200000,
    updatedAt: 1712131200000,
    lastOpenedAt: 1712131200000
  }
  const projectRecord: ProjectRecord = {
    version: 2,
    id: 'saved-project',
    title: 'Saved Deck',
    fileName: 'saved.md',
    fileContent: '# Saved',
    slides: [],
    generationConfig: {
      pageCount: 3,
      quality: '1K',
      aspectRatio: '16:9'
    },
    workflow: {
      status: 'idle',
      outline: null,
      slidePrompts: [],
      expandedOutlinePages: [],
      expandedDesignPages: [],
      error: null
    },
    status: 'generated',
    generationRunId: null,
    lastCompletedSlides: [],
    createdAt: 1712131200000,
    updatedAt: 1712131200000,
    lastOpenedAt: 1712131200000
  }
  const duplicateProjectRecord: ProjectRecord = {
    ...projectRecord,
    id: 'duplicate-project',
    title: 'Current Deck copy',
    fileName: 'current-copy.md',
    fileContent: '# Duplicate',
    slides: [{
      ...slide,
      id: 'duplicate-slide',
      pageNumber: 1,
      prompt: 'duplicate prompt'
    }],
    lastCompletedSlides: [],
    createdAt: 1712131300000,
    updatedAt: 1712131300000,
    lastOpenedAt: 1712131300000
  }
  const resumeAutoSave = vi.fn(() => {
    operations.push('resume-autosave')
  })

  return {
    operations,
    generationSlides: [slide] as Slide[],
    generationIsGenerating: true,
    rightPanelSnapshots: [] as Array<{ slideIds: string[]; isLoading: boolean; hasEditHandler: boolean }>,
    exportSlideSnapshots: [] as string[][],
    exportHookError: null as string | null,
    uploadSettlements: [] as Array<{ status: 'resolved' } | { status: 'rejected'; message: string }>,
    latestUploadSettlement: null as Promise<void> | null,
    capturedAutoSaveParams: undefined as Record<string, unknown> | undefined,
    editSession: null as EditSession | null,
    pendingResumeAction: undefined as (() => void | Promise<void>) | undefined,
    selectedUploadFile: new File(['# Uploaded Deck'], 'uploaded.md', { type: 'text/markdown' }),
    workflowPanelMounts: 0,
    startExport: vi.fn(),
    clearExportError: vi.fn(),
    beginEdit: vi.fn(),
    submitEdit: vi.fn(),
    revertToVersion: vi.fn(),
    confirmEdit: vi.fn(),
    cancelEdit: vi.fn(),
    tryStartEdit: vi.fn((...args: unknown[]) => {
      void args
      return true
    }),
    tryCancelEdit: vi.fn((...args: unknown[]) => {
      void args
      return true
    }),
    confirmDiscard: vi.fn(),
    cancelDiscard: vi.fn(),
    uploadDocument: vi.fn(async (file: File) => {
      operations.push(`upload:${file.name}`)
      return { content: '# Uploaded Deck', filename: file.name }
    }),
    saveNow: vi.fn(async () => {
      operations.push('save')
    }),
    cancelGeneration: vi.fn(() => {
      operations.push('cancel')
    }),
    openProject: vi.fn(async () => {
      operations.push('open')
      return projectRecord
    }),
    createProject: vi.fn(async () => {
      operations.push('create')
      return { ...projectRecord, id: 'new-project', title: 'Untitled project', fileName: '', fileContent: '' }
    }),
    refreshProjects: vi.fn(),
    renameProject: vi.fn(),
    duplicateProject: vi.fn(async () => {
      operations.push('duplicate')
      return duplicateProjectRecord
    }),
    resumeAutoSave,
    cancelPendingAutoSave: vi.fn(async (): Promise<AutoSaveCancellation> => {
      operations.push('cancel-autosave')
      return { resume: resumeAutoSave }
    }),
    deleteProject: vi.fn(async () => {
      operations.push('delete')
    }),
    slide,
    projectRecord,
    projectSummary,
    currentProjectSummary
  }
})

vi.mock('../Layout', () => ({
  default: ({ leftPanel, centerPanel, rightPanel }: { leftPanel: React.ReactNode; centerPanel: React.ReactNode; rightPanel: React.ReactNode }) => (
    <div>
      <section>{leftPanel}</section>
      <section>{centerPanel}</section>
      <section>{rightPanel}</section>
    </div>
  )
}))

vi.mock('../LeftPanel', () => ({
  default: ({
    children,
    onFileSelect
  }: {
    children?: React.ReactNode
    onFileSelect: (file: File) => void | Promise<void>
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          const recordUploadSettlement = async () => {
            try {
              await onFileSelect(mocks.selectedUploadFile)
              mocks.uploadSettlements.push({ status: 'resolved' })
            } catch (error) {
              mocks.uploadSettlements.push({
                status: 'rejected',
                message: error instanceof Error ? error.message : String(error)
              })
            }
          }

          mocks.latestUploadSettlement = recordUploadSettlement()
          void mocks.latestUploadSettlement
        }}
      >
        Upload fixture
      </button>
      {children}
    </div>
  )
}))

vi.mock('../CenterPanel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('../RightPanel', () => ({
  default: ({
    slides,
    isLoading,
    onSlideEdit,
    onExport
  }: {
    slides: Slide[]
    isLoading?: boolean
    onSlideEdit?: (slideId: string) => void
    onExport?: (format: 'generative_editable_pptx') => void
  }) => {
    mocks.rightPanelSnapshots.push({
      slideIds: slides.map(slide => slide.id),
      isLoading: Boolean(isLoading),
      hasEditHandler: typeof onSlideEdit === 'function'
    })

    return (
      <div>
        <div data-testid="right-panel-slide-ids">{slides.map(slide => slide.id).join(',')}</div>
        {onExport && (
          <button type="button" onClick={() => onExport('generative_editable_pptx')}>
            Export generative editable
          </button>
        )}
      </div>
    )
  }
}))
vi.mock('../ApiConfigForm', () => ({ default: () => null }))
vi.mock('../GenerationConfigForm', () => ({ default: () => null }))
vi.mock('../DesignWorkflowPanel', async () => {
  const React = await vi.importActual('react') as typeof import('react')

  function MockDesignWorkflowPanel({ children, fileContent }: { children?: React.ReactNode; fileContent: string }) {
    const [localDraft, setLocalDraft] = React.useState('')

    React.useEffect(() => {
      mocks.workflowPanelMounts += 1
    }, [])

    React.useEffect(() => {
      if (fileContent) {
        mocks.operations.push(`file:${fileContent}`)
      }
    }, [fileContent])

    return (
      <div>
        <div data-testid="workflow-file-content">{fileContent}</div>
        <input
          aria-label="workflow local draft"
          value={localDraft}
          onChange={(event) => setLocalDraft(event.currentTarget.value)}
        />
        {children}
      </div>
    )
  }

  return {
    default: MockDesignWorkflowPanel
  }
})
vi.mock('../GenerateButton', () => ({ default: () => null }))
vi.mock('../ProgressIndicator', () => ({ default: () => null }))
vi.mock('../ConfirmDialog', () => ({
  default: ({
    isOpen,
    onConfirm
  }: {
    isOpen: boolean
    onConfirm: () => void
  }) => isOpen ? <button type="button" onClick={onConfirm}>Discard edit</button> : null
}))
vi.mock('../RestoreSessionDialog', () => ({ default: () => null }))

vi.mock('../../hooks/useEdit', () => ({
  useEdit: () => ({
    editSession: mocks.editSession,
    isEditing: false,
    beginEdit: mocks.beginEdit,
    submitEdit: mocks.submitEdit,
    revertToVersion: mocks.revertToVersion,
    confirmEdit: mocks.confirmEdit,
    cancelEdit: mocks.cancelEdit
  })
}))

vi.mock('../../hooks/useEditConflict', async () => {
  const React = await vi.importActual('react') as typeof import('react')

  return {
    useEditConflict: () => {
      const [showConfirmDialog, setShowConfirmDialog] = React.useState(false)

      return {
        showConfirmDialog,
        tryStartEdit: (...args: unknown[]) => {
          const canStart = mocks.tryStartEdit(args[0], args[1])
          if (!canStart) {
            setShowConfirmDialog(true)
          }
          return canStart
        },
        tryCancelEdit: (...args: unknown[]) => {
          const canCancel = mocks.tryCancelEdit(args[0], args[1])
          if (!canCancel) {
            setShowConfirmDialog(true)
          }
          return canCancel
        },
        confirmDiscard: () => {
          setShowConfirmDialog(false)
          return mocks.confirmDiscard()
        },
        cancelDiscard: () => {
          setShowConfirmDialog(false)
          mocks.cancelDiscard()
        }
      }
    }
  }
})

vi.mock('../../services/uploadService', () => ({
  uploadDocument: mocks.uploadDocument
}))

vi.mock('../../hooks/useExport', () => ({
  useExport: (slides: Slide[]) => {
    mocks.exportSlideSnapshots.push(slides.map(slide => slide.id))

    return {
      state: { isExporting: false, progress: 0, error: mocks.exportHookError, format: null },
      startExport: mocks.startExport,
      clearError: mocks.clearExportError
    }
  }
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
    cancel: mocks.cancelGeneration,
    isGenerating: mocks.generationIsGenerating,
    progress: { current: 1, total: 3, status: 'generating', message: 'Generating' },
    error: null,
    slides: mocks.generationSlides
  })
}))

vi.mock('../../hooks/useAutoSave', () => ({
  useAutoSave: (params: Record<string, unknown>) => {
    mocks.capturedAutoSaveParams = params
    return {
      isSaving: false,
      lastSaved: null,
      saveNow: mocks.saveNow,
      cancelPendingSaves: mocks.cancelPendingAutoSave
    }
  }
}))

vi.mock('../../hooks/useProjectManager', () => ({
  useProjectManager: () => ({
    projects: [mocks.currentProjectSummary, mocks.projectSummary],
    activeProjectId: 'current-project',
    isLoadingProjects: false,
    refreshProjects: mocks.refreshProjects,
    openProject: mocks.openProject,
    createProject: mocks.createProject,
    renameProject: mocks.renameProject,
    duplicateProject: mocks.duplicateProject,
    deleteProject: mocks.deleteProject
  })
}))

describe('App project lifecycle safeguards', () => {
  afterEach(() => {
    mocks.operations.length = 0
    mocks.generationSlides = [mocks.slide]
    mocks.generationIsGenerating = true
    mocks.rightPanelSnapshots.length = 0
    mocks.exportSlideSnapshots.length = 0
    mocks.exportHookError = null
    mocks.uploadSettlements.length = 0
    mocks.latestUploadSettlement = null
    mocks.capturedAutoSaveParams = undefined
    mocks.editSession = null
    mocks.pendingResumeAction = undefined
    mocks.workflowPanelMounts = 0
    mocks.projectRecord.fileName = 'saved.md'
    mocks.projectRecord.fileContent = '# Saved'
    mocks.projectRecord.slides = []
    mocks.projectRecord.lastCompletedSlides = []
    mocks.projectRecord.status = 'generated'
    mocks.confirmDiscard.mockReturnValue(undefined)
    mocks.uploadDocument.mockImplementation(async (file: File) => {
      mocks.operations.push(`upload:${file.name}`)
      return { content: '# Uploaded Deck', filename: file.name }
    })
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('flushes current autosave and cancels generation before opening another project', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))

    await waitFor(() => {
      expect(mocks.openProject).toHaveBeenCalledWith('saved-project')
    })
    expect(mocks.operations.indexOf('save')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('save')).toBeLessThan(mocks.operations.indexOf('open'))
    expect(mocks.operations.indexOf('cancel')).toBeLessThan(mocks.operations.indexOf('open'))
  })

  it('keeps the workflow panel mounted when autosave assigns a durable project id', async () => {
    render(<App />)

    fireEvent.change(screen.getByRole('textbox', { name: 'workflow local draft' }), {
      target: { value: 'keep this local draft' }
    })

    expect(mocks.workflowPanelMounts).toBe(1)
    expect(typeof mocks.capturedAutoSaveParams?.onProjectIdChange).toBe('function')

    await act(async () => {
      const onProjectIdChange = mocks.capturedAutoSaveParams?.onProjectIdChange as (projectId: string) => void
      onProjectIdChange('autosaved-project')
    })

    await waitFor(() => {
      expect(mocks.capturedAutoSaveParams?.projectId).toBe('autosaved-project')
    })
    expect(mocks.workflowPanelMounts).toBe(1)
    expect(screen.getByRole('textbox', { name: 'workflow local draft' })).toHaveValue('keep this local draft')
  })

  it('flushes current autosave and cancels generation before creating a new project', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalled()
    })
    expect(mocks.operations.indexOf('save')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('save')).toBeLessThan(mocks.operations.indexOf('create'))
    expect(mocks.operations.indexOf('cancel')).toBeLessThan(mocks.operations.indexOf('create'))
  })

  it('cancels generation without flushing autosave before deleting the current project', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '删除 Current Deck' }))

    await waitFor(() => {
      expect(mocks.deleteProject).toHaveBeenCalledWith('current-project')
    })
    expect(mocks.saveNow).not.toHaveBeenCalled()
    expect(mocks.operations.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('cancel')).toBeLessThan(mocks.operations.indexOf('delete'))
  })

  it('cancels pending autosaves before deleting the current project', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let resolveCancel: () => void = () => undefined
    const cancelSettled = new Promise<void>((resolve) => {
      resolveCancel = resolve
    })
    mocks.cancelPendingAutoSave.mockImplementationOnce(async () => {
      mocks.operations.push('cancel-autosave-start')
      await cancelSettled
      mocks.operations.push('cancel-autosave-done')
      return { resume: mocks.resumeAutoSave }
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '删除 Current Deck' }))

    await waitFor(() => {
      expect(mocks.cancelPendingAutoSave).toHaveBeenCalledTimes(1)
    })
    expect(mocks.deleteProject).not.toHaveBeenCalled()

    await act(async () => {
      resolveCancel()
      await cancelSettled
    })

    await waitFor(() => {
      expect(mocks.deleteProject).toHaveBeenCalledWith('current-project')
    })
    expect(mocks.operations.indexOf('cancel-autosave-done')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('cancel-autosave-done')).toBeLessThan(mocks.operations.indexOf('delete'))
    expect(mocks.resumeAutoSave).not.toHaveBeenCalled()
  })

  it('resumes autosave when deleting the current project fails after cancellation', async () => {
    const error = new Error('delete failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.deleteProject.mockImplementationOnce(async () => {
      mocks.operations.push('delete')
      throw error
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '删除 Current Deck' }))

    await waitFor(() => {
      expect(mocks.deleteProject).toHaveBeenCalledWith('current-project')
    })
    await waitFor(() => {
      expect(mocks.resumeAutoSave).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(mocks.saveNow).toHaveBeenCalledTimes(1)
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to delete project:', error)
    expect(mocks.operations.indexOf('delete')).toBeLessThan(mocks.operations.indexOf('resume-autosave'))
    expect(mocks.operations.indexOf('resume-autosave')).toBeLessThan(mocks.operations.indexOf('save'))
  })

  it('does not cancel current autosave when deleting a non-current project', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '删除 Saved Deck' }))

    await waitFor(() => {
      expect(mocks.deleteProject).toHaveBeenCalledWith('saved-project')
    })
    expect(mocks.cancelPendingAutoSave).not.toHaveBeenCalled()
  })

  it('flushes current autosave, cancels generation, and restores the duplicate project', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '复制 Current Deck' }))

    await waitFor(() => {
      expect(mocks.duplicateProject).toHaveBeenCalledWith('current-project')
    })
    expect(mocks.operations.indexOf('save')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('cancel')).toBeGreaterThanOrEqual(0)
    expect(mocks.operations.indexOf('save')).toBeLessThan(mocks.operations.indexOf('duplicate'))
    expect(mocks.operations.indexOf('cancel')).toBeLessThan(mocks.operations.indexOf('duplicate'))
    await waitFor(() => {
      expect(screen.getByTestId('workflow-file-content')).toHaveTextContent('# Duplicate')
    })
  })

  it('does not switch projects when the current autosave flush fails', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.saveNow.mockRejectedValueOnce(error)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Failed to save current project before switching:', error)
    })
    expect(mocks.openProject).not.toHaveBeenCalled()
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
  })

  it('warns when opening a saved project fails after the current project is saved', async () => {
    const error = new Error('open failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.openProject.mockImplementationOnce(async () => {
      mocks.operations.push('open')
      throw error
    })

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('项目操作失败，当前内容已保留。')
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to run project lifecycle action:', error)
    expect(mocks.operations).toEqual(['save', 'cancel', 'open'])
  })

  it('warns when creating a new project fails after the current project is saved', async () => {
    const error = new Error('create failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.createProject.mockImplementationOnce(async () => {
      mocks.operations.push('create')
      throw error
    })

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('项目操作失败，当前内容已保留。')
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to run project lifecycle action:', error)
    expect(mocks.operations).toEqual(['save', 'cancel', 'create'])
  })

  it('warns when duplicating a project fails after the current project is saved', async () => {
    const error = new Error('duplicate failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.duplicateProject.mockImplementationOnce(async () => {
      mocks.operations.push('duplicate')
      throw error
    })

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '复制 Current Deck' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('项目操作失败，当前内容已保留。')
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to run project lifecycle action:', error)
    expect(mocks.operations).toEqual(['save', 'cancel', 'duplicate'])
  })

  it('renders and exports the last completed deck while regeneration has no current slides yet', async () => {
    const previousSlide: Slide = {
      ...mocks.slide,
      id: 'previous-completed-slide',
      imageUrl: 'data:image/png;base64,previous',
      imageBase64: 'previous',
      prompt: 'previous prompt'
    }
    mocks.generationSlides = []
    mocks.projectRecord.fileContent = '# Regenerating'
    mocks.projectRecord.slides = []
    mocks.projectRecord.lastCompletedSlides = [previousSlide]
    mocks.projectRecord.status = 'generating'

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))

    await waitFor(() => {
      expect(screen.getByTestId('workflow-file-content')).toHaveTextContent('# Regenerating')
    })
    await waitFor(() => {
      expect(screen.getByTestId('right-panel-slide-ids')).toHaveTextContent('previous-completed-slide')
    })

    const latestRightPanel = mocks.rightPanelSnapshots[mocks.rightPanelSnapshots.length - 1]
    expect(latestRightPanel).toEqual({
      slideIds: ['previous-completed-slide'],
      isLoading: false,
      hasEditHandler: true
    })
    expect(mocks.exportSlideSnapshots).toContainEqual(['previous-completed-slide'])
  })

  it('keeps the current deck visible when generative editable export fails', async () => {
    mocks.startExport.mockRejectedValueOnce(new Error('preview validation failed'))

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('right-panel-slide-ids')).toHaveTextContent('current-slide')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Export generative editable' }))

    await waitFor(() => {
      expect(screen.getByText('preview validation failed')).toBeInTheDocument()
    })
    expect(screen.getByTestId('right-panel-slide-ids')).toHaveTextContent('current-slide')
  })

  it('can dismiss export errors reported by the export hook', async () => {
    mocks.exportHookError = 'provider timed out'

    render(<App />)

    expect(screen.getByText('provider timed out')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭导出错误' }))

    expect(mocks.clearExportError).toHaveBeenCalled()
  })

  it('blocks project open, new, and duplicate when edit discard confirmation is needed', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockReturnValue(false)

    render(<App />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))
      fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
      fireEvent.click(screen.getByRole('button', { name: '复制 Current Deck' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.tryCancelEdit).toHaveBeenCalledWith(
      mocks.editSession,
      expect.objectContaining({ type: 'callback', run: expect.any(Function) })
    )
    expect(mocks.openProject).not.toHaveBeenCalled()
    expect(mocks.createProject).not.toHaveBeenCalled()
    expect(mocks.duplicateProject).not.toHaveBeenCalled()
    expect(mocks.saveNow).not.toHaveBeenCalled()
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
    expect(mocks.cancelEdit).not.toHaveBeenCalled()
  })

  it('resumes a blocked project open after confirming edit discard', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementationOnce((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementationOnce(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))

    expect(mocks.openProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.openProject).toHaveBeenCalledWith('saved-project')
    })
    expect(mocks.cancelEdit).toHaveBeenCalledTimes(1)
    expect(mocks.operations).toContain('open')
  })

  it('warns when a resumed project open fails after edit discard confirmation', async () => {
    const error = new Error('open after discard failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementationOnce((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementationOnce(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )
    mocks.openProject.mockImplementationOnce(async () => {
      mocks.operations.push('open')
      throw error
    })

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('项目操作失败，当前内容已保留。')
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to run project lifecycle action:', error)
    expect(mocks.cancelEdit).toHaveBeenCalledTimes(1)
  })

  it('resumes a blocked new project action after confirming edit discard', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementationOnce((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementationOnce(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalled()
    })
    expect(mocks.cancelEdit).toHaveBeenCalledTimes(1)
    expect(mocks.operations).toContain('create')
  })

  it('resumes a blocked duplicate project action after confirming edit discard', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementationOnce((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementationOnce(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '复制 Current Deck' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.duplicateProject).toHaveBeenCalledWith('current-project')
    })
    expect(mocks.cancelEdit).toHaveBeenCalledTimes(1)
    expect(mocks.operations).toContain('duplicate')
  })

  it('resumes a blocked file upload with the original selected file after confirming edit discard', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementationOnce((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementationOnce(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.uploadSettlements).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.uploadDocument).toHaveBeenCalledWith(mocks.selectedUploadFile)
    })
    expect(mocks.cancelEdit).toHaveBeenCalledTimes(1)
    expect(mocks.operations).toContain('upload:uploaded.md')
    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({ status: 'resolved' })
    })
    expect(mocks.uploadSettlements).not.toContainEqual(expect.objectContaining({ status: 'rejected' }))
  })

  it('rejects a pending file upload when another project action replaces the discard callback', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementation((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementation(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.uploadSettlements).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))

    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({
        status: 'rejected',
        message: '已切换到其他项目操作，本次上传已取消。'
      })
    })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.createProject).toHaveBeenCalled()
    })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()
    expect(mocks.uploadSettlements).not.toContainEqual({ status: 'resolved' })
  })

  it('rejects a pending file upload when the resumed upload cannot save the current project', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.saveNow.mockRejectedValueOnce(error)
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementationOnce((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementationOnce(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.uploadSettlements).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({
        status: 'rejected',
        message: '文件已解析，但替换前无法保存当前项目。'
      })
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to save current project before switching:', error)
    expect(mocks.uploadDocument).toHaveBeenCalledWith(mocks.selectedUploadFile)
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
  })

  it('rejects the previous pending upload when a new upload is selected during edit confirmation', async () => {
    mocks.editSession = {
      slideId: 'current-slide',
      originalImage: 'current',
      currentImage: 'edited-current',
      history: [],
      savedHistoryLength: 0,
      userInput: ''
    }
    mocks.tryCancelEdit.mockImplementation((...args) => {
      const pendingAction = args[1]
      mocks.pendingResumeAction = (pendingAction as { run?: () => Promise<void> }).run
      return false
    })
    mocks.confirmDiscard.mockImplementation(() => mocks.pendingResumeAction
      ? { type: 'callback', run: mocks.pendingResumeAction }
      : undefined
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.uploadSettlements).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({
        status: 'rejected',
        message: '已选择新的上传文件，之前的上传已取消。'
      })
    })
    expect(mocks.uploadDocument).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))

    await waitFor(() => {
      expect(mocks.uploadDocument).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({ status: 'resolved' })
    })
  })

  it('uploads document content before saving, canceling generation, and replacing the current deck', async () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await waitFor(() => {
      expect(screen.getByTestId('workflow-file-content')).toHaveTextContent('# Uploaded Deck')
    })

    const uploadIndex = mocks.operations.indexOf('upload:uploaded.md')
    const saveIndex = mocks.operations.indexOf('save')
    const cancelIndex = mocks.operations.indexOf('cancel')
    const fileIndex = mocks.operations.indexOf('file:# Uploaded Deck')
    expect(uploadIndex).toBeGreaterThanOrEqual(0)
    expect(saveIndex).toBeGreaterThanOrEqual(0)
    expect(cancelIndex).toBeGreaterThanOrEqual(0)
    expect(fileIndex).toBeGreaterThanOrEqual(0)
    expect(uploadIndex).toBeLessThan(saveIndex)
    expect(saveIndex).toBeLessThan(cancelIndex)
    expect(cancelIndex).toBeLessThan(fileIndex)
  })

  it('does not replace the current deck or cancel generation when saving fails after upload parsing', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.saveNow.mockRejectedValueOnce(error)

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Failed to save current project before switching:', error)
    })
    expect(mocks.uploadDocument).toHaveBeenCalledWith(mocks.selectedUploadFile)
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
    expect(screen.getByTestId('workflow-file-content')).not.toHaveTextContent('# Uploaded Deck')
  })

  it('does not save, cancel generation, or replace the current deck when upload parsing fails', async () => {
    const error = new Error('upload failed')
    mocks.uploadDocument.mockImplementationOnce(async (file: File) => {
      mocks.operations.push(`upload:${file.name}`)
      throw error
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await waitFor(() => {
      expect(mocks.uploadDocument).toHaveBeenCalledWith(mocks.selectedUploadFile)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.saveNow).not.toHaveBeenCalled()
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
    expect(screen.getByTestId('workflow-file-content')).not.toHaveTextContent('# Uploaded Deck')
  })

  it('ignores new and duplicate lifecycle actions while a project open is in flight', async () => {
    let resolveOpen: (project: ProjectRecord) => void = () => undefined
    const openPromise = new Promise<ProjectRecord>((resolve) => {
      resolveOpen = resolve
    })
    mocks.openProject.mockImplementationOnce(async (...args: unknown[]) => {
      const id = args[0] as string
      mocks.operations.push(`open:${id}`)
      return openPromise
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))
    await waitFor(() => {
      expect(mocks.openProject).toHaveBeenCalledWith('saved-project')
    })

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    fireEvent.click(screen.getByRole('button', { name: '复制 Current Deck' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.createProject).not.toHaveBeenCalled()
    expect(mocks.duplicateProject).not.toHaveBeenCalled()

    await act(async () => {
      resolveOpen(mocks.projectRecord)
      await openPromise
    })
    await waitFor(() => {
      expect(screen.getByTestId('workflow-file-content')).toHaveTextContent('# Saved')
    })
  })

  it('ignores project deletes while a lifecycle transition is in flight', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let resolveOpen: (project: ProjectRecord) => void = () => undefined
    const openPromise = new Promise<ProjectRecord>((resolve) => {
      resolveOpen = resolve
    })
    mocks.openProject.mockImplementationOnce(async (...args: unknown[]) => {
      const id = args[0] as string
      mocks.operations.push(`open:${id}`)
      return openPromise
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))
    await waitFor(() => {
      expect(mocks.openProject).toHaveBeenCalledWith('saved-project')
    })

    fireEvent.click(screen.getByRole('button', { name: '删除 Saved Deck' }))
    await act(async () => {
      await Promise.resolve()
    })

    expect(mocks.deleteProject).not.toHaveBeenCalled()

    await act(async () => {
      resolveOpen(mocks.projectRecord)
      await openPromise
    })
  })

  it('rejects file uploads while a project lifecycle transition is in flight', async () => {
    let resolveOpen: (project: ProjectRecord) => void = () => undefined
    const openPromise = new Promise<ProjectRecord>((resolve) => {
      resolveOpen = resolve
    })
    mocks.openProject.mockImplementationOnce(async (...args: unknown[]) => {
      const id = args[0] as string
      mocks.operations.push(`open:${id}`)
      return openPromise
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))
    await waitFor(() => {
      expect(mocks.openProject).toHaveBeenCalledWith('saved-project')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))
    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({
        status: 'rejected',
        message: '请等待当前项目操作完成后再上传。'
      })
    })

    expect(mocks.uploadDocument).not.toHaveBeenCalled()

    await act(async () => {
      resolveOpen(mocks.projectRecord)
      await openPromise
    })
  })

  it('rejects file uploads when saving the current project fails after parsing', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.saveNow.mockRejectedValueOnce(error)

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: 'Upload fixture' }))

    await waitFor(() => {
      expect(mocks.uploadSettlements).toContainEqual({
        status: 'rejected',
        message: '文件已解析，但替换前无法保存当前项目。'
      })
    })
    expect(consoleError).toHaveBeenCalledWith('Failed to save current project before switching:', error)
    expect(mocks.uploadDocument).toHaveBeenCalledWith(mocks.selectedUploadFile)
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
    expect(screen.getByTestId('workflow-file-content')).not.toHaveTextContent('# Uploaded Deck')
  })

  it('warns when opening a saved project with missing image assets', async () => {
    const projectWithMissingAssets = {
      ...mocks.projectRecord,
      missingAssetKeys: ['saved-project:slides:missing-slide:current']
    } as ProjectRecord & { missingAssetKeys: string[] }
    mocks.openProject.mockResolvedValueOnce(projectWithMissingAssets)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /打开 Saved Deck/ }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        '有 1 张图片未能完整恢复。文本和大纲仍可恢复，也可以稍后重新生成图片。'
      )
    })
  })

  it('does not create a new project when the current autosave flush fails', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.saveNow.mockRejectedValueOnce(error)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith('Failed to save current project before switching:', error)
    })
    expect(mocks.createProject).not.toHaveBeenCalled()
    expect(mocks.cancelGeneration).not.toHaveBeenCalled()
  })

  it('deletes the current project even when an autosave flush would fail', async () => {
    const error = new Error('save failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.saveNow.mockRejectedValueOnce(error)

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '删除 Current Deck' }))

    await waitFor(() => {
      expect(mocks.deleteProject).toHaveBeenCalledWith('current-project')
    })
    expect(mocks.saveNow).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalledWith('Failed to save current project before switching:', error)
    expect(mocks.cancelGeneration).toHaveBeenCalled()
  })

  it('refreshes project summaries after autosave reports a durable save', () => {
    render(<App />)

    expect(typeof mocks.capturedAutoSaveParams?.onSaved).toBe('function')
    ;(mocks.capturedAutoSaveParams?.onSaved as (projectId: string) => void)('current-project')

    expect(mocks.refreshProjects).toHaveBeenCalled()
  })

  it('renames a project exactly once from the project library action', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Renamed Deck')

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '重命名 Saved Deck' }))

    await waitFor(() => {
      expect(mocks.renameProject).toHaveBeenCalledWith('saved-project', 'Renamed Deck')
    })
    expect(mocks.renameProject).toHaveBeenCalledTimes(1)
  })
})

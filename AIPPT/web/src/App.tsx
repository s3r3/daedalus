import { useCallback, useState, useEffect, useRef } from 'react'
import Layout from './components/Layout'
import LeftPanel from './components/LeftPanel'
import CenterPanel from './components/CenterPanel'
import RightPanel from './components/RightPanel'
import ApiConfigForm from './components/ApiConfigForm'
import GenerationConfigForm from './components/GenerationConfigForm'
import DesignWorkflowPanel from './components/DesignWorkflowPanel'
import GenerateButton from './components/GenerateButton'
import ProgressIndicator from './components/ProgressIndicator'
import ConfirmDialog from './components/ConfirmDialog'
import RestoreSessionDialog from './components/RestoreSessionDialog'
import ProjectLibrary from './components/ProjectLibrary'
import { AppStateProvider } from './contexts/AppStateContext'
import { useAppState } from './contexts/useAppState'
import { UiPreferencesProvider } from './contexts/UiPreferencesContext'
import { useUiPreferences } from './contexts/useUiPreferences'
import { useGeneration } from './hooks/useGeneration'
import { useEdit } from './hooks/useEdit'
import { useEditConflict } from './hooks/useEditConflict'
import { useExport } from './hooks/useExport'
import { useAutoSave } from './hooks/useAutoSave'
import { useStateRestore } from './hooks/useStateRestore'
import { useProjectManager, type OpenedProjectRecord } from './hooks/useProjectManager'
import { StorageService } from './services/storageService'
import { uploadDocument } from './services/uploadService'
import { saveFullApiConfig } from './utils/apiConfig'
import { ConfirmedSlidePrompt, GenerationConfig, ExportFormat, FullApiConfig, ProjectRecord, WorkflowState } from './types'

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

function isResetWorkflow(workflow: WorkflowState): boolean {
  return workflow.status === 'idle' &&
    workflow.outline === null &&
    workflow.slidePrompts.length === 0 &&
    workflow.expandedOutlinePages.length === 0 &&
    workflow.expandedDesignPages.length === 0 &&
    workflow.error === null
}

/**
 * 主应用内容组件
 * 使用 Context 中的状态
 */
function AppContent() {
  const { t } = useUiPreferences()
  const {
    state,
    setFile,
    setFullApiConfig,
    setGenerationConfig,
    setWorkflow,
    selectSlide,
    resetState,
    restoreState,
    setProjectId
  } = useAppState()
  
  const { generate, cancel: cancelGeneration, isGenerating, progress, error, slides } = useGeneration()
  const visibleSlides = slides.length > 0 ? slides : state.lastCompletedSlides
  const {
    editSession,
    isEditing,
    beginEdit,
    submitEdit,
    revertToVersion,
    confirmEdit,
    cancelEdit
  } = useEdit()
  const {
    showConfirmDialog,
    tryStartEdit,
    tryCancelEdit,
    confirmDiscard,
    cancelDiscard
  } = useEditConflict()
  const {
    state: exportState,
    startExport,
    clearError: clearExportError
  } = useExport(visibleSlides, state.generationConfig.aspectRatio)
  const [exportError, setExportError] = useState<string | null>(null)
  const {
    projects,
    activeProjectId,
    isLoadingProjects,
    refreshProjects,
    openProject,
    createProject,
    renameProject,
    duplicateProject,
    deleteProject
  } = useProjectManager()

  // 状态恢复
  const {
    isRestoring,
    hasRestoredData,
    restoredProject,
    dismissRestore
  } = useStateRestore()

  const [showRestoreDialog, setShowRestoreDialog] = useState(false)
  const [confirmedSlidePrompts, setConfirmedSlidePrompts] = useState<ConfirmedSlidePrompt[] | null>(null)
  const [projectWarning, setProjectWarning] = useState<string | null>(null)
  const projectLifecycleInFlightRef = useRef(false)
  const pendingUploadRejectRef = useRef<((error: Error) => void) | null>(null)

  // 检查是否有可恢复的数据
  useEffect(() => {
    if (!isRestoring && hasRestoredData && restoredProject) {
      setShowRestoreDialog(true)
    }
  }, [isRestoring, hasRestoredData, restoredProject])

  const handleProjectSaved = useCallback(() => {
    void Promise.resolve(refreshProjects()).catch((err) => {
      console.error('Failed to refresh project summaries after save:', err)
    })
  }, [refreshProjects])

  const currentProjectId = state.projectId || activeProjectId

  // 自动保存
  const { saveNow, cancelPendingSaves } = useAutoSave({
    projectId: state.projectId,
    fileContent: state.fileContent,
    fileName: state.fileName,
    slides: slides,
    lastCompletedSlides: state.lastCompletedSlides,
    generationConfig: state.generationConfig,
    workflow: state.workflow,
    status: state.status,
    generationRunId: state.generationRunId,
    onProjectIdChange: setProjectId,
    onSaved: handleProjectSaved,
    enabled: !isRestoring && !showRestoreDialog
  })

  // 处理恢复会话
  const handleRestoreSession = useCallback(() => {
    if (restoredProject) {
      restoreState({
        projectId: restoredProject.projectId,
        fileContent: restoredProject.fileContent,
        fileName: restoredProject.fileName,
        slides: restoredProject.slides,
        generationConfig: restoredProject.generationConfig,
        workflow: restoredProject.workflow,
        status: restoredProject.status,
        lastCompletedSlides: restoredProject.lastCompletedSlides
      })
      setConfirmedSlidePrompts(
        restoredProject.workflow.status === 'prompts_ready' && restoredProject.workflow.slidePrompts.length > 0
          ? restoredProject.workflow.slidePrompts
          : null
      )
    }
    setShowRestoreDialog(false)
    dismissRestore()
  }, [restoredProject, restoreState, dismissRestore])

  // 处理放弃恢复
  const handleDiscardRestore = useCallback(() => {
    StorageService.clearProject()
    setShowRestoreDialog(false)
    dismissRestore()
  }, [dismissRestore])

  const rejectPendingUpload = useCallback((message: string) => {
    const rejectPending = pendingUploadRejectRef.current
    pendingUploadRejectRef.current = null
    rejectPending?.(new Error(message))
    return Boolean(rejectPending)
  }, [])

  const restoreProjectRecord = useCallback((project: ProjectRecord | OpenedProjectRecord | null) => {
    if (!project) return
    const missingAssetKeys = (project as OpenedProjectRecord).missingAssetKeys ?? []

    restoreState({
      projectId: project.id,
      fileContent: project.fileContent,
      fileName: project.fileName,
      slides: project.slides,
      generationConfig: project.generationConfig,
      workflow: project.workflow,
      status: project.status,
      lastCompletedSlides: project.lastCompletedSlides
    })
    setConfirmedSlidePrompts(
      project.workflow.status === 'prompts_ready' && project.workflow.slidePrompts.length > 0
        ? project.workflow.slidePrompts
        : null
    )
    setProjectWarning(
      missingAssetKeys.length > 0
        ? t('restore.missingImages', { count: missingAssetKeys.length })
        : null
    )
  }, [restoreState, t])

  const hasCurrentProjectContent = useCallback(() => Boolean(
    state.fileContent ||
    slides.length > 0 ||
    state.lastCompletedSlides.length > 0 ||
    !isResetWorkflow(state.workflow)
  ), [slides.length, state.fileContent, state.lastCompletedSlides.length, state.workflow])

  const runProjectLifecycleChange = useCallback(async (action: () => Promise<void> | void) => {
    if (hasCurrentProjectContent()) {
      try {
        await saveNow()
      } catch (err) {
        console.error('Failed to save current project before switching:', err)
        return false
      }
    }

    cancelGeneration()
    try {
      await action()
    } catch (err) {
      console.error('Failed to run project lifecycle action:', err)
      return false
    }
    return true
  }, [cancelGeneration, hasCurrentProjectContent, saveNow])

  const runExclusiveProjectLifecycleChange = useCallback(async (action: () => Promise<boolean> | boolean) => {
    if (projectLifecycleInFlightRef.current) {
      return false
    }

    projectLifecycleInFlightRef.current = true
    try {
      return await action()
    } finally {
      projectLifecycleInFlightRef.current = false
    }
  }, [])

  const prepareProjectLifecycleChange = useCallback(async (action: () => Promise<void> | void) => {
    rejectPendingUpload(t('upload.lifecycleActionSuperseded'))

    if (projectLifecycleInFlightRef.current) {
      setProjectWarning(t('projects.lifecycleInFlight'))
      return false
    }

    const resumeAction = () => runExclusiveProjectLifecycleChange(() => runProjectLifecycleChange(action))
    const resumeActionWithWarning = async () => {
      const didRun = await resumeAction()
      if (!didRun) {
        setProjectWarning(t('projects.lifecycleActionFailed'))
      }
      return didRun
    }

    if (!tryCancelEdit(editSession, { type: 'callback', run: resumeActionWithWarning })) {
      return false
    }

    return resumeActionWithWarning()
  }, [editSession, rejectPendingUpload, runExclusiveProjectLifecycleChange, runProjectLifecycleChange, t, tryCancelEdit])

  const handleOpenProject = useCallback(async (id: string) => {
    await prepareProjectLifecycleChange(async () => {
      const project = await openProject(id)
      restoreProjectRecord(project)
    })
  }, [openProject, prepareProjectLifecycleChange, restoreProjectRecord])

  const handleCreateProject = useCallback(async () => {
    await prepareProjectLifecycleChange(async () => {
      const project = await createProject({
        generationConfig: state.generationConfig,
        workflow: createEmptyWorkflowState()
      })
      restoreProjectRecord(project)
    })
  }, [createProject, prepareProjectLifecycleChange, restoreProjectRecord, state.generationConfig])

  const handleRenameProject = useCallback(async (id: string, title: string) => {
    await renameProject(id, title)
  }, [renameProject])

  const handleDuplicateProject = useCallback(async (id: string) => {
    await prepareProjectLifecycleChange(async () => {
      const project = await duplicateProject(id)
      restoreProjectRecord(project)
    })
  }, [duplicateProject, prepareProjectLifecycleChange, restoreProjectRecord])

  const handleDeleteProject = useCallback(async (id: string) => {
    rejectPendingUpload(t('upload.lifecycleActionSuperseded'))

    const didRun = await runExclusiveProjectLifecycleChange(async () => {
      if (id !== currentProjectId) {
        try {
          await deleteProject(id)
        } catch (err) {
          setProjectWarning(t('projects.deleteFailed'))
          console.error('Failed to delete project:', err)
        }
        return true
      }

      const autoSaveCancellation = await cancelPendingSaves()
      cancelGeneration()

      try {
        await deleteProject(id)
      } catch (err) {
        autoSaveCancellation.resume()
        try {
          await saveNow()
        } catch (saveError) {
          console.error('Failed to save current project after delete failure:', saveError)
        }
        setProjectWarning(t('projects.deleteFailed'))
        console.error('Failed to delete project:', err)
        return false
      }

      resetState()
      setConfirmedSlidePrompts(null)
      setProjectWarning(null)
      return true
    })
    if (!didRun) {
      setProjectWarning(t('projects.lifecycleInFlight'))
    }
  }, [
    cancelGeneration,
    cancelPendingSaves,
    currentProjectId,
    deleteProject,
    rejectPendingUpload,
    resetState,
    runExclusiveProjectLifecycleChange,
    saveNow,
    t
  ])

  const runUploadLifecycleChange = useCallback(async (file: File) => {
    const uploadResult = await uploadDocument(file)
    return runProjectLifecycleChange(() => {
      setFile(file, uploadResult.content, uploadResult.filename || file.name)
      setConfirmedSlidePrompts(null)
    })
  }, [runProjectLifecycleChange, setFile])

  const executeFileUpload = useCallback(async (file: File) => {
    if (projectLifecycleInFlightRef.current) {
      throw new Error(t('upload.lifecycleInFlight'))
    }

    const didReplaceDeck = await runExclusiveProjectLifecycleChange(() => runUploadLifecycleChange(file))
    if (!didReplaceDeck) {
      throw new Error(t('upload.lifecycleSaveFailed'))
    }
  }, [runExclusiveProjectLifecycleChange, runUploadLifecycleChange, t])

  const handleFileSelect = useCallback((file: File): Promise<void> => {
    if (!editSession) {
      return executeFileUpload(file)
    }

    rejectPendingUpload(t('upload.lifecycleSuperseded'))

    let resolvePendingUpload: () => void = () => undefined
    let rejectPendingUploadPromise: (error: Error) => void = () => undefined
    const pendingUpload = new Promise<void>((resolve, reject) => {
      resolvePendingUpload = resolve
      rejectPendingUploadPromise = reject
    })

    const resumeAction = async () => {
      pendingUploadRejectRef.current = null
      try {
        await executeFileUpload(file)
        resolvePendingUpload()
      } catch (error) {
        rejectPendingUploadPromise(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    }

    if (!tryCancelEdit(editSession, { type: 'callback', run: resumeAction })) {
      pendingUploadRejectRef.current = rejectPendingUploadPromise
      return pendingUpload
    }

    pendingUploadRejectRef.current = null
    return executeFileUpload(file)
  }, [editSession, executeFileUpload, rejectPendingUpload, tryCancelEdit, t])

  const handleSlideSelect = useCallback((slideId: string) => {
    selectSlide(slideId)
  }, [selectSlide])

  const handleSlideEdit = useCallback((slideId: string) => {
    // 找到要编辑的幻灯片
    const slide = visibleSlides.find(s => s.id === slideId)
    if (!slide) return

    // 检查是否有未保存的编辑
    if (tryStartEdit(editSession, slide)) {
      // 可以直接开始编辑
      selectSlide(slideId)
      beginEdit(slide)
    }
    // 如果返回 false，会显示确认对话框，用户确认后再处理
  }, [selectSlide, visibleSlides, beginEdit, editSession, tryStartEdit])

  const handleApiConfigChange = useCallback((config: FullApiConfig) => {
    setFullApiConfig(config)
    // 同时保存到 localStorage
    saveFullApiConfig(config)
  }, [setFullApiConfig])

  const handleGenerationConfigChange = useCallback((config: GenerationConfig) => {
    setGenerationConfig(config)
  }, [setGenerationConfig])

  const handleGenerate = useCallback(() => {
    generate(confirmedSlidePrompts || undefined)
  }, [confirmedSlidePrompts, generate])

  const handlePromptsReady = useCallback((prompts: ConfirmedSlidePrompt[]) => {
    setConfirmedSlidePrompts(prompts)
  }, [])

  const handleClearPrompts = useCallback(() => {
    setConfirmedSlidePrompts(null)
  }, [])

  // 处理取消编辑（带冲突检测）
  const handleEditCancel = useCallback(() => {
    if (tryCancelEdit(editSession)) {
      // 可以直接取消
      cancelEdit()
    }
    // 如果返回 false，会显示确认对话框
  }, [editSession, tryCancelEdit, cancelEdit])

  // 用户确认放弃编辑
  const handleConfirmDiscard = useCallback(() => {
    const rejectPending = pendingUploadRejectRef.current
    const action = confirmDiscard()
    if (!action) {
      pendingUploadRejectRef.current = null
      rejectPending?.(new Error(t('upload.lifecycleDiscardCancelled')))
      return
    }

    if (action.type === 'switch' && action.targetSlide) {
      pendingUploadRejectRef.current = null
      rejectPending?.(new Error(t('upload.lifecycleDiscardCancelled')))
      // 切换到新的幻灯片编辑
      cancelEdit()
      selectSlide(action.targetSlide.id)
      beginEdit(action.targetSlide)
    } else if (action.type === 'cancel') {
      pendingUploadRejectRef.current = null
      rejectPending?.(new Error(t('upload.lifecycleDiscardCancelled')))
      // 取消当前编辑
      cancelEdit()
    } else if (action.type === 'callback' && typeof action.run === 'function') {
      cancelEdit()
      void Promise.resolve(action.run()).catch((err) => {
        console.error('Failed to resume action after discarding edit:', err)
      })
    } else {
      pendingUploadRejectRef.current = null
      rejectPending?.(new Error(t('upload.lifecycleDiscardCancelled')))
    }
  }, [confirmDiscard, cancelEdit, selectSlide, beginEdit, t])

  // 用户取消放弃编辑（继续编辑）
  const handleCancelDiscard = useCallback(() => {
    const rejectPending = pendingUploadRejectRef.current
    pendingUploadRejectRef.current = null
    cancelDiscard()
    rejectPending?.(new Error(t('upload.lifecycleDiscardCancelled')))
  }, [cancelDiscard, t])

  // 处理导出
  const handleExport = useCallback(async (format: ExportFormat) => {
    setExportError(null)
    try {
      await startExport(format)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : t('export.failed'))
    }
  }, [startExport, t])

  return (
    <>
    {/* 恢复会话对话框 */}
    <RestoreSessionDialog
      isOpen={showRestoreDialog}
      restoredProject={restoredProject}
      onRestore={handleRestoreSession}
      onDiscard={handleDiscardRestore}
    />

    <Layout
      leftPanel={
        <LeftPanel
          fileName={state.fileName || null}
          fileContent={state.fileContent}
          onFileSelect={handleFileSelect}
        >
          <ProjectLibrary
            projects={projects}
            activeProjectId={currentProjectId}
            isLoading={isLoadingProjects}
            onOpenProject={handleOpenProject}
            onNewProject={handleCreateProject}
            onRenameProject={handleRenameProject}
            onDuplicateProject={handleDuplicateProject}
            onDeleteProject={handleDeleteProject}
          />
        </LeftPanel>
      }
      centerPanel={
        <CenterPanel
          isEditMode={editSession !== null}
          editSession={editSession}
          isEditing={isEditing}
          onEditSubmit={submitEdit}
          onEditConfirm={confirmEdit}
          onEditCancel={handleEditCancel}
          onRevertToVersion={revertToVersion}
        >
          {/* API 配置表单 */}
          <ApiConfigForm
            initialConfig={state.fullApiConfig}
            onConfigChange={handleApiConfigChange}
          />

          {/* 生成配置表单 */}
          <GenerationConfigForm
            initialConfig={state.generationConfig}
            onConfigChange={handleGenerationConfigChange}
          />

          <DesignWorkflowPanel
            fileContent={state.fileContent}
            fullApiConfig={state.fullApiConfig}
            generationConfig={state.generationConfig}
            workflow={state.workflow}
            confirmedPrompts={confirmedSlidePrompts}
            onWorkflowChange={setWorkflow}
            onPromptsReady={handlePromptsReady}
            onClearPrompts={handleClearPrompts}
          >
            <GenerateButton
              fileContent={state.fileContent}
              apiConfig={state.fullApiConfig}
              generationConfig={state.generationConfig}
              isGenerating={isGenerating}
              onGenerate={handleGenerate}
              canGenerate={Boolean(confirmedSlidePrompts?.length) && !isGenerating}
              disabledReason={t('workflow.generateBlocked')}
              readyLabel={t('workflow.generateImages')}
            />

            {(isGenerating || progress.status === 'completed' || error) && (
              <div className="mt-4">
              <ProgressIndicator
                current={progress.current}
                total={progress.total}
                status={progress.status}
                message={progress.message}
                error={error}
              />
              </div>
            )}
          </DesignWorkflowPanel>
        </CenterPanel>
      }
      rightPanel={
        <RightPanel
          slides={visibleSlides}
          selectedSlideId={state.selectedSlideId}
          onSlideSelect={handleSlideSelect}
          onSlideEdit={visibleSlides.length > 0 ? handleSlideEdit : undefined}
          onExport={handleExport}
          isExporting={exportState.isExporting}
          exportProgress={exportState.progress}
          exportFormat={exportState.format}
          isLoading={isGenerating && slides.length === 0 && state.lastCompletedSlides.length === 0}
        />
      }
    />

    {/* 编辑冲突确认对话框 */}
    <ConfirmDialog
      isOpen={showConfirmDialog}
      title={t('edit.conflictTitle')}
      message={t('edit.conflictMessage')}
      confirmText={t('edit.discard')}
      cancelText={t('edit.continue')}
      confirmVariant="danger"
      onConfirm={handleConfirmDiscard}
      onCancel={handleCancelDiscard}
    />

    {/* 导出错误提示 */}
    {projectWarning && (
      <div
        role="alert"
        className="fixed bottom-4 right-4 z-50 max-w-md rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-800 shadow-lg"
      >
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.72-1.36 3.486 0l6.518 11.59c.75 1.334-.213 2.986-1.743 2.986H3.482c-1.53 0-2.493-1.652-1.743-2.986l6.518-11.59zM11 14a1 1 0 10-2 0 1 1 0 002 0zm-1-2a1 1 0 01-1-1V8a1 1 0 112 0v3a1 1 0 01-1 1z" clipRule="evenodd" />
          </svg>
          <span>{projectWarning}</span>
          <button
            type="button"
            onClick={() => setProjectWarning(null)}
            className="ml-2 text-amber-700 hover:text-amber-900"
            aria-label={t('image.close')}
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
    )}

    {(exportError || exportState.error) && (
      <div className="fixed bottom-4 right-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg shadow-lg z-50">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          <span>{exportError || exportState.error}</span>
          <button
            onClick={() => {
              setExportError(null)
              clearExportError()
            }}
            className="ml-2 text-red-500 hover:text-red-700"
            aria-label={t('export.dismissError')}
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      </div>
    )}
  </>
  )
}

/**
 * 主应用组件
 * 包装 Provider
 */
function App() {
  return (
    <UiPreferencesProvider>
      <AppStateProvider>
        <AppContent />
      </AppStateProvider>
    </UiPreferencesProvider>
  )
}

export default App

/**
 * useAutoSave Hook - 自动保存状态到 IndexedDB
 * 
 * Requirements: 10.1
 * 
 * 监听状态变化，使用防抖机制保存到 IndexedDB
 */

import { useEffect, useRef, useCallback } from 'react'
import { createProjectId, getProject, saveProjectRecord, setActiveProjectId } from '../services/projectStore'
import { Slide, GenerationConfig, ProjectRecord, ProjectStatus, WorkflowState } from '../types'

/**
 * 防抖延迟时间（毫秒）
 */
const DEBOUNCE_DELAY = 1000

/**
 * 自动保存 Hook 参数
 */
interface UseAutoSaveParams {
  projectId: string | null
  fileContent: string
  fileName: string
  slides: Slide[]
  lastCompletedSlides: Slide[]
  generationConfig: GenerationConfig
  workflow: WorkflowState
  status: ProjectStatus
  generationRunId: string | null
  onProjectIdChange?: (projectId: string) => void
  onSaved?: (projectId: string) => void
  enabled?: boolean
}

/**
 * 自动保存 Hook 返回值
 */
interface UseAutoSaveReturn {
  isSaving: boolean
  lastSaved: Date | null
  saveNow: () => Promise<void>
  cancelPendingSaves: () => Promise<AutoSaveCancellation>
}

type AutoSaveSnapshot = Required<UseAutoSaveParams> & {
  saveGeneration: number
}

interface AutoSaveCancellation {
  resume: () => void
}

function isResetWorkflow(workflow: WorkflowState): boolean {
  return workflow.status === 'idle' &&
    workflow.outline === null &&
    workflow.slidePrompts.length === 0 &&
    workflow.expandedOutlinePages.length === 0 &&
    workflow.expandedDesignPages.length === 0 &&
    workflow.error === null
}

function projectTitleFromFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '').trim()
  return baseName || 'Untitled project'
}

function hasPersistableContent(snapshot: AutoSaveSnapshot): boolean {
  return Boolean(
    snapshot.fileContent ||
    snapshot.slides.length > 0 ||
    snapshot.lastCompletedSlides.length > 0 ||
    !isResetWorkflow(snapshot.workflow)
  )
}

/**
 * 自动保存 Hook
 * 
 * 监听状态变化，使用防抖机制自动保存到 IndexedDB
 */
export function useAutoSave({
  projectId,
  fileContent,
  fileName,
  slides,
  lastCompletedSlides,
  generationConfig,
  workflow,
  status,
  generationRunId,
  onProjectIdChange,
  onSaved,
  enabled = true
}: UseAutoSaveParams): UseAutoSaveReturn {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isSavingRef = useRef(false)
  const lastSavedRef = useRef<Date | null>(null)
  const lifecycleFlushInFlightRef = useRef(false)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const lifecycleProjectIdRef = useRef<string | null>(projectId)
  const saveGenerationRef = useRef(0)
  const cancelledSaveGenerationsRef = useRef<Set<number>>(new Set())
  const backgroundSavesCancelledRef = useRef(false)

  if (projectId !== lifecycleProjectIdRef.current) {
    lifecycleProjectIdRef.current = projectId
    backgroundSavesCancelledRef.current = false
    saveGenerationRef.current += 1
  }

  const latestSnapshotRef = useRef<AutoSaveSnapshot>({
    projectId,
    fileContent,
    fileName,
    slides,
    lastCompletedSlides,
    generationConfig,
    workflow,
    status,
    generationRunId,
    onProjectIdChange: onProjectIdChange ?? (() => undefined),
    onSaved: onSaved ?? (() => undefined),
    enabled,
    saveGeneration: saveGenerationRef.current
  })

  latestSnapshotRef.current = {
    projectId,
    fileContent,
    fileName,
    slides,
    lastCompletedSlides,
    generationConfig,
    workflow,
    status,
    generationRunId,
    onProjectIdChange: onProjectIdChange ?? (() => undefined),
    onSaved: onSaved ?? (() => undefined),
    enabled,
    saveGeneration: saveGenerationRef.current
  }

  const clearPendingTimer = useCallback((): boolean => {
    if (!timeoutRef.current) {
      return false
    }

    clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    return true
  }, [])

  const isSnapshotCancelled = useCallback((snapshot: AutoSaveSnapshot): boolean => (
    cancelledSaveGenerationsRef.current.has(snapshot.saveGeneration) ||
    (
      backgroundSavesCancelledRef.current &&
      snapshot.saveGeneration === saveGenerationRef.current
    )
  ), [])

  const cancelPendingSaves = useCallback(async (): Promise<AutoSaveCancellation> => {
    const cancelledProjectId = latestSnapshotRef.current.projectId
    const shouldQuarantineNextGeneration = latestSnapshotRef.current.projectId !== null
    let hasResumed = false
    const resume = () => {
      if (hasResumed || latestSnapshotRef.current.projectId !== cancelledProjectId) {
        return
      }

      hasResumed = true
      backgroundSavesCancelledRef.current = false
      saveGenerationRef.current += 1
      latestSnapshotRef.current = {
        ...latestSnapshotRef.current,
        saveGeneration: saveGenerationRef.current
      }
    }

    clearPendingTimer()
    cancelledSaveGenerationsRef.current.add(saveGenerationRef.current)
    backgroundSavesCancelledRef.current = shouldQuarantineNextGeneration
    saveGenerationRef.current += 1
    if (shouldQuarantineNextGeneration) {
      cancelledSaveGenerationsRef.current.add(saveGenerationRef.current)
    }
    latestSnapshotRef.current = {
      ...latestSnapshotRef.current,
      saveGeneration: saveGenerationRef.current
    }
    await saveQueueRef.current.catch(() => undefined)
    return { resume }
  }, [clearPendingTimer])

  /**
   * 执行保存操作
   */
  const performSave = useCallback(async (snapshot = latestSnapshotRef.current) => {
    if (isSnapshotCancelled(snapshot)) {
      return
    }

    // 只有当有内容时才保存
    if (!hasPersistableContent(snapshot)) {
      return
    }

    isSavingRef.current = true

    try {
      const now = Date.now()
      const id = snapshot.projectId || createProjectId()
      const existingProject = snapshot.projectId ? await getProject(snapshot.projectId) : null
      if (isSnapshotCancelled(snapshot)) {
        return
      }

      const project: ProjectRecord = {
        version: 2,
        id,
        title: existingProject?.title || projectTitleFromFileName(snapshot.fileName),
        fileName: snapshot.fileName,
        fileContent: snapshot.fileContent,
        slides: snapshot.slides,
        generationConfig: snapshot.generationConfig,
        workflow: snapshot.workflow,
        status: snapshot.status,
        generationRunId: snapshot.generationRunId,
        lastCompletedSlides: snapshot.lastCompletedSlides,
        createdAt: existingProject?.createdAt || now,
        updatedAt: now,
        lastOpenedAt: now
      }

      if (isSnapshotCancelled(snapshot)) {
        return
      }
      const savedProject = await saveProjectRecord(project)
      if (isSnapshotCancelled(snapshot)) {
        return
      }
      await setActiveProjectId(savedProject.id)
      if (isSnapshotCancelled(snapshot)) {
        return
      }
      if (!snapshot.projectId) {
        snapshot.onProjectIdChange(savedProject.id)
      }
      snapshot.onSaved(savedProject.id)
      lastSavedRef.current = new Date()
    } finally {
      isSavingRef.current = false
    }
  }, [isSnapshotCancelled])

  const enqueueSave = useCallback((snapshot = latestSnapshotRef.current) => {
    const saveTask = saveQueueRef.current.then(() => performSave(snapshot))
    saveQueueRef.current = saveTask.catch(() => undefined)
    return saveTask
  }, [performSave])

  const saveBestEffort = useCallback(async (snapshot = latestSnapshotRef.current) => {
    try {
      await enqueueSave(snapshot)
    } catch (error) {
      console.error('Failed to save project:', error)
    }
  }, [enqueueSave])

  /**
   * 立即保存（跳过防抖）
   */
  const saveNow = useCallback(async () => {
    // 清除待执行的防抖保存
    clearPendingTimer()
    await enqueueSave(latestSnapshotRef.current)
  }, [clearPendingTimer, enqueueSave])

  /**
   * 防抖保存
   */
  const debouncedSave = useCallback(() => {
    // 清除之前的定时器
    clearPendingTimer()

    // 设置新的定时器
    timeoutRef.current = setTimeout(() => {
      const snapshot = latestSnapshotRef.current
      timeoutRef.current = null
      void saveBestEffort(snapshot)
    }, DEBOUNCE_DELAY)
  }, [clearPendingTimer, saveBestEffort])

  /**
   * 监听状态变化，触发防抖保存
   */
  useEffect(() => {
    if (!enabled) {
      clearPendingTimer()
      return
    }

    // 触发防抖保存
    debouncedSave()
  }, [
    clearPendingTimer,
    debouncedSave,
    enabled,
    fileContent,
    fileName,
    generationConfig,
    generationRunId,
    lastCompletedSlides,
    slides,
    status,
    workflow
  ])

  /**
   * 组件卸载时保存
   */
  useEffect(() => {
    return () => {
      // 组件卸载时，如果有待保存的内容，立即保存
      if (clearPendingTimer()) {
        void saveBestEffort(latestSnapshotRef.current)
      }
    }
  }, [clearPendingTimer, saveBestEffort])

  /**
   * 页面进入后台或被卸载时保存
   */
  useEffect(() => {
    const flushPendingSave = () => {
      const snapshot = latestSnapshotRef.current
      if (
        !snapshot.enabled ||
        !timeoutRef.current ||
        lifecycleFlushInFlightRef.current ||
        !hasPersistableContent(snapshot)
      ) {
        return
      }

      clearPendingTimer()
      lifecycleFlushInFlightRef.current = true
      void saveBestEffort(snapshot).finally(() => {
        lifecycleFlushInFlightRef.current = false
      })
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingSave()
      }
    }

    window.addEventListener('pagehide', flushPendingSave)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', flushPendingSave)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [clearPendingTimer, saveBestEffort])

  return {
    isSaving: isSavingRef.current,
    lastSaved: lastSavedRef.current,
    saveNow,
    cancelPendingSaves
  }
}

export default useAutoSave

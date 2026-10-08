/**
 * useStateRestore Hook - 应用启动时恢复状态
 * 
 * Requirements: 10.2
 * 
 * 从 localStorage 恢复之前的会话状态
 */

import { useEffect, useState, useCallback } from 'react'
import { StorageService } from '../services/storageService'
import { Slide, GenerationConfig, ProjectStatus, WorkflowState } from '../types'

/**
 * 恢复的项目数据
 */
export interface RestoredProject {
  projectId: string
  fileContent: string
  fileName: string
  slides: Slide[]
  generationConfig: GenerationConfig
  workflow: WorkflowState
  status: ProjectStatus
  lastCompletedSlides: Slide[]
  missingAssetKeys: string[]
}

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

/**
 * 状态恢复 Hook 返回值
 */
interface UseStateRestoreReturn {
  isRestoring: boolean
  hasRestoredData: boolean
  restoredProject: RestoredProject | null
  restoreProject: () => RestoredProject | null
  dismissRestore: () => void
}

/**
 * 状态恢复 Hook
 * 
 * 应用启动时检查 localStorage 并恢复之前的会话状态
 */
export function useStateRestore(): UseStateRestoreReturn {
  const [isRestoring, setIsRestoring] = useState(true)
  const [hasRestoredData, setHasRestoredData] = useState(false)
  const [restoredProject, setRestoredProject] = useState<RestoredProject | null>(null)

  /**
   * 检查并加载保存的状态
   */
  useEffect(() => {
    let cancelled = false
    const checkSavedState = async () => {
      setIsRestoring(true)
      
      try {
        const restore = await StorageService.loadActiveProjectForRestore()
        if (cancelled) return
        const project = restore?.project
        
        // 验证数据完整性
        if (project && (project.fileContent || project.slides.length > 0 || project.lastCompletedSlides.length > 0)) {
          setRestoredProject({
            projectId: project.id,
            fileContent: project.fileContent,
            fileName: project.fileName,
            slides: project.slides,
            generationConfig: project.generationConfig,
            workflow: project.workflow,
            status: project.status,
            lastCompletedSlides: project.lastCompletedSlides,
            missingAssetKeys: restore.missingAssetKeys
          })
          setHasRestoredData(true)
        }
      } catch (error) {
        console.error('Failed to restore state:', error)
      } finally {
        if (!cancelled) {
          setIsRestoring(false)
        }
      }
    }

    checkSavedState()

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 恢复项目数据
   */
  const restoreProject = useCallback((): RestoredProject | null => {
    if (!restoredProject) {
      return null
    }
    
    // 返回恢复的数据
    return restoredProject
  }, [restoredProject])

  /**
   * 放弃恢复（清除恢复数据但不清除 localStorage）
   */
  const dismissRestore = useCallback(() => {
    setRestoredProject(null)
    setHasRestoredData(false)
  }, [])

  return {
    isRestoring,
    hasRestoredData,
    restoredProject,
    restoreProject,
    dismissRestore
  }
}

/**
 * 检查是否有可恢复的数据（静态方法）
 */
export function checkHasRestoredData(): boolean {
  return StorageService.hasProject()
}

/**
 * 直接加载保存的项目（静态方法）
 */
export function loadSavedProject(): RestoredProject | null {
  const project = StorageService.loadProject()
  
  if (!project) {
    return null
  }

  return {
    projectId: '',
    fileContent: project.fileContent,
    fileName: project.fileName,
    slides: project.slides,
    generationConfig: project.generationConfig,
    workflow: emptyWorkflow(),
    status: project.slides.length > 0 ? 'generated' : 'draft',
    lastCompletedSlides: project.slides,
    missingAssetKeys: []
  }
}

export default useStateRestore

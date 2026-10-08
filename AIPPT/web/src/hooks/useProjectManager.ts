import { useCallback, useEffect, useState } from 'react'
import {
  createProjectId,
  deleteProject as deleteStoredProject,
  duplicateProject as duplicateStoredProject,
  getActiveProjectId,
  getProject,
  getProjectSummaries,
  hydrateProjectImages,
  renameProject as renameStoredProject,
  saveProjectRecord,
  setActiveProjectId,
  verifyProjectIntegrity
} from '../services/projectStore'
import type { GenerationConfig, ProjectRecord, ProjectSummary, WorkflowState } from '../types'

interface CreateProjectInput {
  title?: string
  fileName?: string
  fileContent?: string
  generationConfig: GenerationConfig
  workflow: WorkflowState
}

export type OpenedProjectRecord = ProjectRecord & {
  readonly missingAssetKeys?: string[]
}

interface DeleteProjectResult {
  deleted: true
}

function titleFromFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop()?.replace(/\.[^/.]+$/, '').trim()
  return baseName || 'Untitled project'
}

function attachMissingAssetKeys(project: ProjectRecord, missingAssetKeys: string[]): OpenedProjectRecord {
  Object.defineProperty(project, 'missingAssetKeys', {
    value: missingAssetKeys,
    enumerable: false,
    configurable: true
  })
  return project as OpenedProjectRecord
}

export function useProjectManager() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null)
  const [isLoadingProjects, setIsLoadingProjects] = useState(true)

  const refreshProjects = useCallback(async () => {
    setIsLoadingProjects(true)
    try {
      const [summaries, activeId] = await Promise.all([
        getProjectSummaries(),
        getActiveProjectId()
      ])
      setProjects(summaries)
      setActiveProjectIdState(activeId)
    } finally {
      setIsLoadingProjects(false)
    }
  }, [])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const openProject = useCallback(async (id: string): Promise<OpenedProjectRecord | null> => {
    const project = await getProject(id)
    if (!project) {
      await refreshProjects()
      return null
    }

    const integrity = await verifyProjectIntegrity(project)

    const openedProject: ProjectRecord = {
      ...project,
      lastOpenedAt: Date.now()
    }

    const savedProject = await saveProjectRecord(openedProject, { allowMissingAssets: true })
    await setActiveProjectId(id)
    await refreshProjects()
    return attachMissingAssetKeys(await hydrateProjectImages(savedProject), integrity.missingAssetKeys)
  }, [refreshProjects])

  const createProject = useCallback(async (input: CreateProjectInput): Promise<ProjectRecord> => {
    const now = Date.now()
    const fileName = input.fileName ?? ''
    const project: ProjectRecord = {
      version: 2,
      id: createProjectId(),
      title: input.title?.trim() || titleFromFileName(fileName),
      fileName,
      fileContent: input.fileContent ?? '',
      slides: [],
      generationConfig: input.generationConfig,
      workflow: input.workflow,
      status: 'draft',
      generationRunId: null,
      lastCompletedSlides: [],
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now
    }

    const savedProject = await saveProjectRecord(project)
    await setActiveProjectId(savedProject.id)
    await refreshProjects()
    return savedProject
  }, [refreshProjects])

  const renameProject = useCallback(async (id: string, title: string) => {
    await renameStoredProject(id, title)
    await refreshProjects()
  }, [refreshProjects])

  const duplicateProject = useCallback(async (id: string) => {
    const duplicatedProject = await duplicateStoredProject(id)
    await setActiveProjectId(duplicatedProject.id)
    const hydratedProject = await hydrateProjectImages(duplicatedProject)
    await refreshProjects()
    return hydratedProject
  }, [refreshProjects])

  const deleteProject = useCallback(async (id: string): Promise<DeleteProjectResult> => {
    await deleteStoredProject(id)
    try {
      await refreshProjects()
    } catch (error) {
      console.error('Failed to refresh project summaries after delete:', error)
    }
    return { deleted: true }
  }, [refreshProjects])

  return {
    projects,
    activeProjectId,
    isLoadingProjects,
    refreshProjects,
    openProject,
    createProject,
    renameProject,
    duplicateProject,
    deleteProject
  }
}

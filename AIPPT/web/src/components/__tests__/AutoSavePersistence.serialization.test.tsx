import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSave } from '../../hooks/useAutoSave'
import type { GenerationConfig, ProjectRecord, WorkflowState } from '../../types'

const mocks = vi.hoisted(() => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve
      reject = promiseReject
    })
    return { promise, resolve, reject }
  }

  return {
    ids: ['project-old', 'project-new'],
    saves: [] as Array<{
      project: ProjectRecord
      deferred: ReturnType<typeof createDeferred<ProjectRecord>>
    }>,
    createProjectId: vi.fn(() => 'project-id'),
    getProject: vi.fn(),
    saveProjectRecord: vi.fn(),
    setActiveProjectId: vi.fn()
  }
})

vi.mock('../../services/projectStore', () => ({
  createProjectId: mocks.createProjectId,
  getProject: mocks.getProject,
  saveProjectRecord: mocks.saveProjectRecord,
  setActiveProjectId: mocks.setActiveProjectId
}))

const generationConfig: GenerationConfig = {
  pageCount: 1,
  quality: '1K',
  aspectRatio: '16:9'
}

const workflow: WorkflowState = {
  status: 'idle',
  outline: null,
  slidePrompts: [],
  expandedOutlinePages: [],
  expandedDesignPages: [],
  error: null
}

describe('AutoSavePersistence save serialization', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.ids = ['project-old', 'project-new']
    mocks.saves = []
    mocks.createProjectId.mockImplementation(() => mocks.ids.shift() || 'project-extra')
    mocks.getProject.mockResolvedValue(null)
    mocks.saveProjectRecord.mockImplementation((project: ProjectRecord) => {
      const deferred = (() => {
        let resolve!: (value: ProjectRecord) => void
        let reject!: (error: unknown) => void
        const promise = new Promise<ProjectRecord>((promiseResolve, promiseReject) => {
          resolve = promiseResolve
          reject = promiseReject
        })
        return { promise, resolve, reject }
      })()
      mocks.saves.push({ project, deferred })
      return deferred.promise
    })
    mocks.setActiveProjectId.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('queues saveNow behind an in-flight debounced save so older snapshots cannot finish last', async () => {
    const onProjectIdChange = vi.fn()
    const onSaved = vi.fn()
    const { result, rerender, unmount } = renderHook(
      ({ fileContent }) => useAutoSave({
        projectId: null,
        fileContent,
        fileName: `${fileContent}.md`,
        slides: [],
        lastCompletedSlides: [],
        generationConfig,
        workflow,
        status: 'draft',
        generationRunId: null,
        onProjectIdChange,
        onSaved,
        enabled: true
      }),
      { initialProps: { fileContent: 'old' } }
    )

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    await Promise.resolve()
    expect(mocks.saveProjectRecord).toHaveBeenCalledTimes(1)

    rerender({ fileContent: 'new' })
    const saveNowPromise = result.current.saveNow()
    await Promise.resolve()

    expect(mocks.saveProjectRecord).toHaveBeenCalledTimes(1)

    await act(async () => {
      mocks.saves[0].deferred.resolve(mocks.saves[0].project)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.saveProjectRecord).toHaveBeenCalledTimes(2)
    expect(mocks.saves[1].project.fileContent).toBe('new')

    mocks.saves[1].deferred.resolve(mocks.saves[1].project)
    await saveNowPromise

    expect(mocks.setActiveProjectId).toHaveBeenNthCalledWith(1, 'project-old')
    expect(mocks.setActiveProjectId).toHaveBeenNthCalledWith(2, 'project-new')
    expect(onProjectIdChange).toHaveBeenNthCalledWith(1, 'project-old')
    expect(onProjectIdChange).toHaveBeenNthCalledWith(2, 'project-new')
    expect(onSaved).toHaveBeenNthCalledWith(1, 'project-old')
    expect(onSaved).toHaveBeenNthCalledWith(2, 'project-new')

    unmount()
  })
})

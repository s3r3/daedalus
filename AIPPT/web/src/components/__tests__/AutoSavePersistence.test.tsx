import { act, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAutoSave } from '../../hooks/useAutoSave'
import {
  deleteProject,
  getActiveProjectId,
  getProject,
  hydrateProjectImages,
  saveProjectRecord
} from '../../services/projectStore'
import {
  buildProjectRecord,
  buildSlide,
  EMPTY_WORKFLOW_STATE,
  listStoredAssets,
  resetProjectStoreForTests,
  TEST_GENERATION_CONFIG
} from '../../services/projectStore.test-utils'
import type { ProjectRecord, ProjectStatus, Slide, WorkflowState } from '../../types'

interface AutoSaveCancellation {
  resume: () => void
}

interface AutoSaveProbeProps {
  projectId: string | null
  fileContent?: string
  fileName?: string
  slides?: Slide[]
  lastCompletedSlides?: Slide[]
  status?: ProjectStatus
  workflow?: WorkflowState
  generationRunId?: string | null
  enabled?: boolean
  onProjectIdChange?: (projectId: string) => void
  onProjectSaved?: (projectId: string) => void
  onSaveReady?: (saveNow: () => Promise<void>) => void
  onCancelReady?: (cancelPendingSaves: () => Promise<AutoSaveCancellation>) => void
  onSaved?: () => void
  autoSaveNow?: boolean
}

function AutoSaveProbe({
  projectId,
  fileContent = '# Autosave',
  fileName = 'autosave.md',
  slides = [],
  lastCompletedSlides = [],
  status = 'draft',
  workflow = EMPTY_WORKFLOW_STATE,
  generationRunId = null,
  enabled = false,
  onProjectIdChange,
  onProjectSaved,
  onSaveReady,
  onCancelReady,
  onSaved,
  autoSaveNow = true
}: AutoSaveProbeProps) {
  const autoSave = useAutoSave({
    projectId,
    fileContent,
    fileName,
    slides,
    lastCompletedSlides,
    generationConfig: TEST_GENERATION_CONFIG,
    workflow,
    status,
    generationRunId,
    onProjectIdChange,
    onSaved: onProjectSaved,
    enabled
  })
  const { saveNow } = autoSave
  const cancelPendingSaves = (autoSave as { cancelPendingSaves?: () => Promise<AutoSaveCancellation> }).cancelPendingSaves

  useEffect(() => {
    onSaveReady?.(saveNow)
  }, [onSaveReady, saveNow])

  useEffect(() => {
    if (cancelPendingSaves) {
      onCancelReady?.(cancelPendingSaves)
    }
  }, [cancelPendingSaves, onCancelReady])

  useEffect(() => {
    if (!autoSaveNow) {
      return
    }

    void saveNow().then(onSaved)
  }, [autoSaveNow, onSaved, saveNow])

  return null
}

function throwOnProjectPut(message: string) {
  const originalPut = IDBObjectStore.prototype.put

  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    if (this.name === 'projects') {
      throw new Error(message)
    }

    return key === undefined
      ? originalPut.call(this, value)
      : originalPut.call(this, value, key)
  })
}

describe('AutoSave durable persistence', () => {
  let originalVisibilityState: DocumentVisibilityState

  beforeEach(async () => {
    originalVisibilityState = document.visibilityState
    await resetProjectStoreForTests()
  })

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: originalVisibilityState
    })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stores slide images in IndexedDB and hydrateProjectImages restores imageBase64', async () => {
    const imageBase64 = 'YXV0b3NhdmUtaW1hZ2U='
    const slide = buildSlide({
      id: 'slide-image',
      imageUrl: `data:image/png;base64,${imageBase64}`,
      imageBase64
    })
    const onSaved = vi.fn()

    render(
      <AutoSaveProbe
        projectId="autosave-images"
        slides={[slide]}
        lastCompletedSlides={[]}
        onSaved={onSaved}
      />
    )

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })

    const compactProject = await getProject('autosave-images')
    expect(compactProject?.slides[0].imageBase64).toBeUndefined()
    expect(compactProject?.slides[0]).toMatchObject({
      imageUrl: '',
      imageStorageKey: 'autosave-images:slides:slide-image:current'
    })
    expect(await listStoredAssets('autosave-images')).toHaveLength(1)

    const hydrated = await hydrateProjectImages(compactProject!)
    expect(hydrated.slides[0].imageBase64).toBe(imageBase64)
    expect(hydrated.slides[0].imageUrl).toBe(`data:image/png;base64,${imageBase64}`)
  })

  it('notifies after a durable save completes with the saved project id', async () => {
    const onProjectSaved = vi.fn()
    const onProjectIdChange = vi.fn()

    render(
      <AutoSaveProbe
        projectId={null}
        fileContent="# Saved callback"
        fileName="saved-callback.md"
        slides={[]}
        lastCompletedSlides={[]}
        onProjectIdChange={onProjectIdChange}
        onProjectSaved={onProjectSaved}
      />
    )

    await waitFor(() => {
      expect(onProjectSaved).toHaveBeenCalledTimes(1)
    })
    const savedProjectId = onProjectSaved.mock.calls[0][0]
    expect(onProjectIdChange).toHaveBeenCalledWith(savedProjectId)
    expect(await getProject(savedProjectId)).toMatchObject({
      id: savedProjectId,
      fileName: 'saved-callback.md',
      fileContent: '# Saved callback'
    })
  })

  it('preserves lastCompletedSlides while generating even when current slides are empty', async () => {
    const completedImage = 'Y29tcGxldGVkLWltYWdl'
    const completedSlide = buildSlide({
      id: 'completed-slide',
      imageUrl: `data:image/png;base64,${completedImage}`,
      imageBase64: completedImage
    })
    const onSaved = vi.fn()

    render(
      <AutoSaveProbe
        projectId="autosave-generating"
        slides={[]}
        lastCompletedSlides={[completedSlide]}
        status="generating"
        generationRunId="run-1"
        onSaved={onSaved}
      />
    )

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })

    const compactProject = await getProject('autosave-generating')
    expect(compactProject).toMatchObject({
      status: 'generating',
      generationRunId: 'run-1',
      slides: []
    })
    expect(compactProject?.lastCompletedSlides).toHaveLength(1)

    const hydrated = await hydrateProjectImages(compactProject!)
    expect(hydrated.lastCompletedSlides[0].imageBase64).toBe(completedImage)
  })

  it('preserves an existing project title and createdAt across autosaves', async () => {
    await saveProjectRecord(buildProjectRecord({
      id: 'existing-project',
      title: 'Existing title',
      createdAt: 123,
      updatedAt: 456,
      lastOpenedAt: 456,
      fileName: 'original.md',
      fileContent: '# Original'
    }))
    const onSaved = vi.fn()

    render(
      <AutoSaveProbe
        projectId="existing-project"
        fileName="renamed.md"
        fileContent="# Updated"
        slides={[]}
        lastCompletedSlides={[]}
        onSaved={onSaved}
      />
    )

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })

    const stored = await getProject('existing-project')
    expect(stored).toMatchObject({
      title: 'Existing title',
      createdAt: 123,
      fileName: 'renamed.md',
      fileContent: '# Updated'
    })
    expect(stored?.updatedAt).toBeGreaterThan(456)
  })

  it('flushes pagehide and hidden visibilitychange saves without waiting for debounce', async () => {
    const onProjectIdChange = vi.fn()

    const { unmount } = render(
      <AutoSaveProbe
        projectId={null}
        fileContent="# Lifecycle"
        fileName="lifecycle.md"
        slides={[]}
        lastCompletedSlides={[]}
        enabled
        autoSaveNow={false}
        onProjectIdChange={onProjectIdChange}
      />
    )

    window.dispatchEvent(new PageTransitionEvent('pagehide'))

    await waitFor(() => {
      expect(onProjectIdChange).toHaveBeenCalled()
    }, { timeout: 500 })
    const pagehideProjectId = onProjectIdChange.mock.calls[0][0]
    expect(await getProject(pagehideProjectId)).toMatchObject({
      fileName: 'lifecycle.md',
      fileContent: '# Lifecycle'
    })
    unmount()

    onProjectIdChange.mockClear()
    render(
      <AutoSaveProbe
        projectId={null}
        fileContent="# Hidden"
        fileName="hidden.md"
        slides={[]}
        lastCompletedSlides={[]}
        enabled
        autoSaveNow={false}
        onProjectIdChange={onProjectIdChange}
      />
    )

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => {
      expect(onProjectIdChange).toHaveBeenCalled()
    }, { timeout: 500 })
    const hiddenProjectId = onProjectIdChange.mock.calls[0][0]
    expect(await getProject(hiddenProjectId)).toMatchObject({
      fileName: 'hidden.md',
      fileContent: '# Hidden'
    })
  })

  it('does not immediately save the previous snapshot when autosave inputs change with a pending debounce', async () => {
    const { rerender } = render(
      <AutoSaveProbe
        projectId="debounced-project"
        fileContent="# First"
        fileName="first.md"
        slides={[]}
        lastCompletedSlides={[]}
        enabled
        autoSaveNow={false}
      />
    )

    rerender(
      <AutoSaveProbe
        projectId="debounced-project"
        fileContent="# Latest"
        fileName="latest.md"
        slides={[]}
        lastCompletedSlides={[]}
        enabled
        autoSaveNow={false}
      />
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await getProject('debounced-project')).toBeNull()

    await waitFor(async () => {
      expect(await getProject('debounced-project')).toMatchObject({
        fileContent: '# Latest',
        fileName: 'latest.md'
      })
    }, { timeout: 1500 })
  })

  it('coalesces repeated lifecycle flush events for a new pending project', async () => {
    const onProjectIdChange = vi.fn()

    render(
      <AutoSaveProbe
        projectId={null}
        fileContent="# Coalesce"
        fileName="coalesce.md"
        slides={[]}
        lastCompletedSlides={[]}
        enabled
        autoSaveNow={false}
        onProjectIdChange={onProjectIdChange}
      />
    )

    window.dispatchEvent(new PageTransitionEvent('pagehide'))
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden'
    })
    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => {
      expect(onProjectIdChange).toHaveBeenCalledTimes(1)
    }, { timeout: 500 })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(onProjectIdChange).toHaveBeenCalledTimes(1)
  })

  it('propagates explicit saveNow failures while background saves catch and log failures', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let saveNow: (() => Promise<void>) | undefined

    render(
      <AutoSaveProbe
        projectId="explicit-failure"
        fileContent="# Explicit"
        autoSaveNow={false}
        onSaveReady={(save) => {
          saveNow = save
        }}
      />
    )

    await waitFor(() => {
      expect(saveNow).toBeDefined()
    })
    const putSpy = throwOnProjectPut('project put failed')

    await expect(saveNow!()).rejects.toThrow('project put failed')

    putSpy.mockRestore()
    consoleError.mockClear()

    throwOnProjectPut('background put failed')
    render(
      <AutoSaveProbe
        projectId="background-failure"
        fileContent="# Background"
        enabled
        autoSaveNow={false}
      />
    )
    window.dispatchEvent(new PageTransitionEvent('pagehide'))

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to save project:',
        expect.objectContaining({ message: 'background put failed' })
      )
    })
  })

  it('sets the active project id after autosave', async () => {
    const onSaved = vi.fn()

    render(
      <AutoSaveProbe
        projectId="active-autosave"
        fileContent="# Active"
        onSaved={onSaved}
      />
    )

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })

    expect(await getActiveProjectId()).toBe('active-autosave')
  })

  it('cancels a pending debounced save while a normal explicit save remains usable', async () => {
    vi.useFakeTimers()
    let cancelPendingSaves: (() => Promise<AutoSaveCancellation>) | undefined

    const cancelledView = render(
      <AutoSaveProbe
        projectId="debounced-cancelled"
        fileContent="# Deleted"
        enabled={false}
        autoSaveNow={false}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })
    if (!cancelPendingSaves) {
      cancelledView.unmount()
      vi.useRealTimers()
    }
    expect(cancelPendingSaves).toBeDefined()

    cancelledView.rerender(
      <AutoSaveProbe
        projectId="debounced-cancelled"
        fileContent="# Deleted"
        enabled
        autoSaveNow={false}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )
    await cancelPendingSaves!()

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    vi.useRealTimers()
    expect(await getProject('debounced-cancelled')).toBeNull()

    let saveNow: (() => Promise<void>) | undefined
    render(
      <AutoSaveProbe
        projectId="normal-explicit-save"
        fileContent="# Normal"
        autoSaveNow={false}
        onSaveReady={(save) => {
          saveNow = save
        }}
      />
    )

    await waitFor(() => {
      expect(saveNow).toBeDefined()
    })
    await saveNow!()

    expect(await getProject('normal-explicit-save')).toMatchObject({
      fileContent: '# Normal'
    })
  })

  it('allows future debounced saves after cancellation while already reset without a project id', async () => {
    let cancelPendingSaves: (() => Promise<AutoSaveCancellation>) | undefined
    const onProjectIdChange = vi.fn()
    const onProjectSaved = vi.fn()

    const { rerender } = render(
      <AutoSaveProbe
        projectId={null}
        fileContent=""
        enabled={false}
        autoSaveNow={false}
        onProjectIdChange={onProjectIdChange}
        onProjectSaved={onProjectSaved}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(cancelPendingSaves).toBeDefined()

    await cancelPendingSaves!()

    rerender(
      <AutoSaveProbe
        projectId={null}
        fileContent="# Reused"
        fileName="reused.md"
        enabled
        autoSaveNow={false}
        onProjectIdChange={onProjectIdChange}
        onProjectSaved={onProjectSaved}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await waitFor(() => {
      expect(onProjectSaved).toHaveBeenCalledTimes(1)
    }, { timeout: 2000 })
    const savedProjectId = onProjectSaved.mock.calls[0][0]
    expect(onProjectIdChange).toHaveBeenCalledWith(savedProjectId)
    expect(await getProject(savedProjectId)).toMatchObject({
      fileContent: '# Reused',
      fileName: 'reused.md'
    })
  })

  it('ignores a queued pagehide background snapshot after cancellation', async () => {
    let cancelPendingSaves: (() => Promise<AutoSaveCancellation>) | undefined

    const cancelledView = render(
      <AutoSaveProbe
        projectId="queued-cancelled"
        fileContent="# Queued"
        enabled={false}
        autoSaveNow={false}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })
    if (!cancelPendingSaves) {
      cancelledView.unmount()
    }
    expect(cancelPendingSaves).toBeDefined()

    cancelledView.rerender(
      <AutoSaveProbe
        projectId="queued-cancelled"
        fileContent="# Queued"
        enabled
        autoSaveNow={false}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )
    window.dispatchEvent(new PageTransitionEvent('pagehide'))
    await cancelPendingSaves!()

    await act(async () => {
      await Promise.resolve()
    })

    expect(await getProject('queued-cancelled')).toBeNull()
  })

  it('ignores an already-started background save after cancellation', async () => {
    const projectId = 'inflight-cancelled'
    const existingProject = buildProjectRecord({
      id: projectId,
      fileName: 'inflight.md',
      fileContent: '# Before delete'
    })
    await saveProjectRecord(existingProject)

    let cancelPendingSaves: (() => Promise<AutoSaveCancellation>) | undefined
    const onProjectSaved = vi.fn()
    let releaseProjectRead: (() => void) | undefined
    const projectReadStarted = new Promise<void>((resolve) => {
      const originalGet = IDBObjectStore.prototype.get
      let delayedProjectRead = false

      vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange
      ) {
        if (delayedProjectRead || this.name !== 'projects' || query !== projectId) {
          return originalGet.call(this, query)
        }
        delayedProjectRead = true

        const request = {
          result: existingProject,
          error: null,
          onsuccess: null,
          onerror: null
        } as IDBRequest<ProjectRecord | undefined>

        releaseProjectRead = () => {
          request.onsuccess?.(new Event('success'))
        }
        resolve()
        return request
      })
    })

    const { rerender } = render(
      <AutoSaveProbe
        projectId={projectId}
        fileContent="# After delete"
        enabled={false}
        autoSaveNow={false}
        onProjectSaved={onProjectSaved}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(cancelPendingSaves).toBeDefined()

    rerender(
      <AutoSaveProbe
        projectId={projectId}
        fileContent="# After delete"
        enabled
        autoSaveNow={false}
        onProjectSaved={onProjectSaved}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )
    window.dispatchEvent(new PageTransitionEvent('pagehide'))

    await projectReadStarted
    const cancellation = cancelPendingSaves!()
    releaseProjectRead!()
    await cancellation
    await deleteProject(projectId)

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(await getProject(projectId)).toBeNull()
    expect(onProjectSaved).not.toHaveBeenCalled()
    expect(await getActiveProjectId()).not.toBe(projectId)
  })

  it('resumes future saves for the same loaded project after cancellation is rolled back', async () => {
    const projectId = 'delete-rollback-resumed'
    await saveProjectRecord(buildProjectRecord({
      id: projectId,
      fileName: 'rollback.md',
      fileContent: '# Before failed delete'
    }))

    let cancelPendingSaves: (() => Promise<AutoSaveCancellation>) | undefined
    const onProjectSaved = vi.fn()
    const { rerender } = render(
      <AutoSaveProbe
        projectId={projectId}
        fileContent="# Before failed delete"
        enabled={false}
        autoSaveNow={false}
        onProjectSaved={onProjectSaved}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(cancelPendingSaves).toBeDefined()

    const cancellation = await cancelPendingSaves!()
    expect(cancellation).toEqual({ resume: expect.any(Function) })
    cancellation.resume()

    rerender(
      <AutoSaveProbe
        projectId={projectId}
        fileContent="# After failed delete"
        enabled
        autoSaveNow={false}
        onProjectSaved={onProjectSaved}
        onCancelReady={(cancel) => {
          cancelPendingSaves = cancel
        }}
      />
    )

    await waitFor(() => {
      expect(onProjectSaved).toHaveBeenCalledWith(projectId)
    }, { timeout: 2000 })
    expect(await getProject(projectId)).toMatchObject({
      fileContent: '# After failed delete'
    })
  })
})

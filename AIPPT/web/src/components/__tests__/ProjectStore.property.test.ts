import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import * as fc from 'fast-check'
import 'fake-indexeddb/auto'
import type { ProjectRecord, ProjectStatus, ProjectSummary, Slide } from '../../types'
import {
  clearActiveProjectId,
  deleteProject,
  duplicateProject,
  getActiveProjectId,
  getProject,
  getProjectSummaries,
  hydrateProjectImages,
  renameProject,
  saveProjectRecord,
  setActiveProjectId,
  verifyProjectIntegrity
} from '../../services/projectStore'
import {
  buildProjectRecord,
  buildSlide,
  deleteStoredAsset,
  listStoredAssets,
  readStoredAsset,
  readStoredProject,
  resetProjectStoreForTests
} from '../../services/projectStore.test-utils'
import { useProjectManager } from '../../hooks/useProjectManager'

const CURRENT_IMAGE = 'Y3VycmVudA=='
const COMPLETED_IMAGE = 'Y29tcGxldGVk'
const SECOND_IMAGE = 'c2Vjb25k'
const OTHER_IMAGE = 'b3RoZXI='

const currentAssetKey = (projectId: string, slideId: string) => `${projectId}:slides:${slideId}:current`
const completedAssetKey = (projectId: string, slideId: string) =>
  `${projectId}:lastCompletedSlides:${slideId}:current`
const editHistoryAssetKey = (projectId: string, bucket: 'slides' | 'lastCompletedSlides', slideId: string) =>
  `${projectId}:${bucket}:${slideId}:editHistory:0:1234`

function imageSlide(overrides: Partial<Slide> = {}): Slide {
  return buildSlide({
    id: 'slide-1',
    pageNumber: 1,
    imageUrl: `data:image/png;base64,${CURRENT_IMAGE}`,
    imageBase64: CURRENT_IMAGE,
    prompt: 'Generate a cover page',
    ...overrides
  })
}

describe('IndexedDB project store', () => {
  beforeEach(async () => {
    await resetProjectStoreForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves and restores a project with slide images after a browser-like reload', async () => {
    const project = buildProjectRecord({
      id: 'project-images',
      title: 'Image deck',
      slides: [
        imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE, imageUrl: `data:image/png;base64,${CURRENT_IMAGE}` }),
        imageSlide({
          id: 'slide-2',
          pageNumber: 2,
          imageBase64: undefined,
          imageUrl: `data:image/jpeg;base64,${SECOND_IMAGE}`
        })
      ],
      lastCompletedSlides: [
        imageSlide({
          id: 'slide-1',
          imageBase64: COMPLETED_IMAGE,
          imageUrl: `data:image/png;base64,${COMPLETED_IMAGE}`
        })
      ]
    })

    const saved = await saveProjectRecord(project)
    const compact = await getProject('project-images')

    expect(localStorage.length).toBe(0)
    expect(saved).toEqual(compact)
    expect(compact?.slides[0]).toMatchObject({
      imageUrl: '',
      imageStorageKey: currentAssetKey('project-images', 'slide-1'),
      imageAsset: {
        key: currentAssetKey('project-images', 'slide-1'),
        mimeType: 'image/png',
        byteLength: 7
      }
    })
    expect(compact?.slides[0].imageBase64).toBeUndefined()
    expect(compact?.slides[1]).toMatchObject({
      imageUrl: '',
      imageStorageKey: currentAssetKey('project-images', 'slide-2'),
      imageAsset: {
        key: currentAssetKey('project-images', 'slide-2'),
        mimeType: 'image/jpeg',
        byteLength: 6
      }
    })
    expect(compact?.lastCompletedSlides[0]).toMatchObject({
      imageUrl: '',
      imageStorageKey: completedAssetKey('project-images', 'slide-1')
    })

    expect(await readStoredAsset(currentAssetKey('project-images', 'slide-1'))).toMatchObject({
      key: currentAssetKey('project-images', 'slide-1'),
      projectId: 'project-images',
      bucket: 'slides',
      slideId: 'slide-1',
      mimeType: 'image/png',
      imageBase64: CURRENT_IMAGE
    })

    const reloadedCompact = await readStoredProject('project-images')
    expect(reloadedCompact?.slides[0].imageBase64).toBeUndefined()
    expect(reloadedCompact?.slides[0].imageUrl).toBe('')

    const hydrated = await hydrateProjectImages(reloadedCompact as ProjectRecord)
    expect(hydrated.slides[0].imageBase64).toBe(CURRENT_IMAGE)
    expect(hydrated.slides[0].imageUrl).toBe(`data:image/png;base64,${CURRENT_IMAGE}`)
    expect(hydrated.slides[1].imageBase64).toBe(SECOND_IMAGE)
    expect(hydrated.slides[1].imageUrl).toBe(`data:image/jpeg;base64,${SECOND_IMAGE}`)
    expect(hydrated.lastCompletedSlides[0].imageBase64).toBe(COMPLETED_IMAGE)
    expect(hydrated.lastCompletedSlides[0].imageUrl).toBe(`data:image/png;base64,${COMPLETED_IMAGE}`)
  })

  it('keeps multiple projects and opens the requested active project', async () => {
    await saveProjectRecord(buildProjectRecord({
      id: 'older-project',
      title: 'Older',
      lastOpenedAt: 10,
      slides: [imageSlide({ id: 'older-slide', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: []
    }))
    await saveProjectRecord(buildProjectRecord({
      id: 'newer-project',
      title: 'Newer',
      lastOpenedAt: 30,
      slides: [imageSlide({ id: 'newer-slide', imageBase64: SECOND_IMAGE })],
      lastCompletedSlides: []
    }))

    await setActiveProjectId('older-project')

    const activeId = await getActiveProjectId()
    const activeProject = activeId ? await getProject(activeId) : null
    const summaries = await getProjectSummaries()

    expect(activeId).toBe('older-project')
    expect(activeProject?.title).toBe('Older')
    expect(summaries.map((summary: ProjectSummary) => summary.id)).toEqual(['newer-project', 'older-project'])
    expect(summaries[0]).toMatchObject({
      id: 'newer-project',
      title: 'Newer',
      slideCount: 1,
      lastOpenedAt: 30
    })
  })

  it('renames, duplicates, and deletes projects without affecting other projects', async () => {
    await saveProjectRecord(buildProjectRecord({
      id: 'source-project',
      title: 'Source',
      slides: [imageSlide({ id: 'source-slide', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: []
    }))
    await saveProjectRecord(buildProjectRecord({
      id: 'other-project',
      title: 'Other',
      slides: [imageSlide({ id: 'other-slide', imageBase64: OTHER_IMAGE })],
      lastCompletedSlides: []
    }))

    const renamed = await renameProject('source-project', 'Renamed source')
    const duplicate = await duplicateProject('source-project')
    const hydratedDuplicate = await hydrateProjectImages(duplicate)

    expect(renamed.title).toBe('Renamed source')
    expect((await getProject('source-project'))?.title).toBe('Renamed source')
    expect(duplicate.id).not.toBe('source-project')
    expect(duplicate.title).toBe('Renamed source copy')
    expect(duplicate.slides[0].imageStorageKey).toBe(currentAssetKey(duplicate.id, 'source-slide'))
    expect(hydratedDuplicate.slides[0].imageBase64).toBe(CURRENT_IMAGE)

    await setActiveProjectId('source-project')
    await deleteProject('source-project')

    expect(await getProject('source-project')).toBeNull()
    expect(await getActiveProjectId()).toBeNull()
    expect(await listStoredAssets('source-project')).toEqual([])
    expect((await getProject('other-project'))?.title).toBe('Other')
    expect(await getProject(duplicate.id)).not.toBeNull()
  })

  it('marks a duplicated project as active through the project manager', async () => {
    await saveProjectRecord(buildProjectRecord({
      id: 'manager-source',
      title: 'Manager source',
      slides: [imageSlide({ id: 'manager-slide', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: []
    }))
    await setActiveProjectId('manager-source')

    const { result } = renderHook(() => useProjectManager())
    await waitFor(() => {
      expect(result.current.isLoadingProjects).toBe(false)
    })

    let duplicateId = ''
    await act(async () => {
      const duplicate = await result.current.duplicateProject('manager-source')
      duplicateId = duplicate.id
    })

    expect(duplicateId).toBeTruthy()
    expect(duplicateId).not.toBe('manager-source')
    expect(await getActiveProjectId()).toBe(duplicateId)
    await waitFor(() => {
      expect(result.current.activeProjectId).toBe(duplicateId)
    })
  })

  it('opens a compact project without rewriting existing slide asset records', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)

    await saveProjectRecord(buildProjectRecord({
      id: 'manager-open-compact',
      title: 'Compact deck',
      slides: [imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: [imageSlide({ id: 'slide-1', imageBase64: COMPLETED_IMAGE })]
    }))
    const assetsBeforeOpen = await listStoredAssets('manager-open-compact')

    nowSpy.mockReturnValue(2000)

    const { result } = renderHook(() => useProjectManager())
    await waitFor(() => {
      expect(result.current.isLoadingProjects).toBe(false)
    })

    let openedProject!: ProjectRecord
    await act(async () => {
      const opened = await result.current.openProject('manager-open-compact')
      expect(opened).not.toBeNull()
      openedProject = opened as ProjectRecord
    })

    const assetsAfterOpen = await listStoredAssets('manager-open-compact')
    expect(assetsAfterOpen).toEqual(assetsBeforeOpen)
    expect(await getActiveProjectId()).toBe('manager-open-compact')
    expect((await getProject('manager-open-compact'))?.lastOpenedAt).toBe(2000)
    expect(openedProject.slides[0].imageBase64).toBe(CURRENT_IMAGE)
    expect(openedProject.lastCompletedSlides[0].imageBase64).toBe(COMPLETED_IMAGE)
  })

  it('does not rewrite hydrated slide assets on a full save when images are unchanged', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const historyImage = 'aHlkcmF0ZWQtaGlzdG9yeQ=='

    const saved = await saveProjectRecord(buildProjectRecord({
      id: 'hydrated-resave',
      slides: [
        imageSlide({
          id: 'slide-1',
          imageBase64: CURRENT_IMAGE,
          editHistory: [{
            imageUrl: `data:image/webp;base64,${historyImage}`,
            imageBase64: historyImage,
            instruction: 'make it quieter',
            timestamp: 1234
          }]
        })
      ],
      lastCompletedSlides: []
    }))
    const assetsBeforeHydratedSave = await listStoredAssets('hydrated-resave')

    const hydrated = await hydrateProjectImages(saved)
    expect(hydrated.slides[0].imageBase64).toBe(CURRENT_IMAGE)
    expect(hydrated.slides[0].editHistory?.[0].imageBase64).toBe(historyImage)

    nowSpy.mockReturnValue(2000)
    await saveProjectRecord({
      ...hydrated,
      title: 'Hydrated resave'
    })

    expect(await listStoredAssets('hydrated-resave')).toEqual(assetsBeforeHydratedSave)
  })

  it('opens a project with missing asset references by omitting unavailable images', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)

    await saveProjectRecord(buildProjectRecord({
      id: 'manager-open-missing-assets',
      title: 'Partial deck',
      slides: [
        imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE }),
        imageSlide({ id: 'slide-2', pageNumber: 2, imageBase64: SECOND_IMAGE })
      ],
      lastCompletedSlides: []
    }))
    await deleteStoredAsset(currentAssetKey('manager-open-missing-assets', 'slide-2'))

    nowSpy.mockReturnValue(2000)

    const { result } = renderHook(() => useProjectManager())
    await waitFor(() => {
      expect(result.current.isLoadingProjects).toBe(false)
    })

    let openedProject!: ProjectRecord
    await act(async () => {
      const opened = await result.current.openProject('manager-open-missing-assets')
      expect(opened).not.toBeNull()
      openedProject = opened as ProjectRecord
    })

    expect((openedProject as ProjectRecord & { missingAssetKeys?: string[] }).missingAssetKeys).toEqual([
      currentAssetKey('manager-open-missing-assets', 'slide-2')
    ])
    expect(await getActiveProjectId()).toBe('manager-open-missing-assets')
    expect((await getProject('manager-open-missing-assets'))?.lastOpenedAt).toBe(2000)
    expect(openedProject.slides[0].imageBase64).toBe(CURRENT_IMAGE)
    expect(openedProject.slides[1].imageBase64).toBeUndefined()
    expect(openedProject.slides[1].imageUrl).toBe('')
  })

  it('does not treat a post-delete project list refresh failure as a storage delete failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await saveProjectRecord(buildProjectRecord({
      id: 'delete-refresh-failure',
      title: 'Delete refresh failure'
    }))
    await setActiveProjectId('delete-refresh-failure')

    const { result } = renderHook(() => useProjectManager())
    await waitFor(() => {
      expect(result.current.isLoadingProjects).toBe(false)
    })

    const originalGetAll = IDBObjectStore.prototype.getAll
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (
      this: IDBObjectStore,
      query?: IDBValidKey | IDBKeyRange | null,
      count?: number
    ) {
      if (this.name === 'projects') {
        throw new Error('refresh failed after delete')
      }

      return count === undefined
        ? originalGetAll.call(this, query)
        : originalGetAll.call(this, query, count)
    })

    await expect(result.current.deleteProject('delete-refresh-failure')).resolves.toEqual({ deleted: true })
    expect(await getProject('delete-refresh-failure')).toBeNull()
    expect(await getActiveProjectId()).toBeNull()
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to refresh project summaries after delete:',
      expect.objectContaining({ message: 'refresh failed after delete' })
    )
  })

  it('strips missing slide and history asset references during partial recovery so later normal saves succeed', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000)
    const historyImage = 'cGFydGlhbC1oaXN0b3J5'

    await saveProjectRecord(buildProjectRecord({
      id: 'partial-recovery-sanitize',
      title: 'Partial sanitize deck',
      slides: [
        imageSlide({
          id: 'kept-slide',
          imageBase64: CURRENT_IMAGE,
          editHistory: [{
            imageUrl: `data:image/webp;base64,${historyImage}`,
            imageBase64: historyImage,
            instruction: 'remove stale history if asset disappears',
            timestamp: 1234
          }]
        }),
        imageSlide({ id: 'missing-slide', pageNumber: 2, imageBase64: SECOND_IMAGE })
      ],
      lastCompletedSlides: [
        imageSlide({ id: 'completed-missing', imageBase64: COMPLETED_IMAGE })
      ]
    }))
    await deleteStoredAsset(currentAssetKey('partial-recovery-sanitize', 'missing-slide'))
    await deleteStoredAsset(completedAssetKey('partial-recovery-sanitize', 'completed-missing'))
    await deleteStoredAsset(editHistoryAssetKey('partial-recovery-sanitize', 'slides', 'kept-slide'))

    nowSpy.mockReturnValue(2000)

    const { result } = renderHook(() => useProjectManager())
    await waitFor(() => {
      expect(result.current.isLoadingProjects).toBe(false)
    })

    let openedProject!: ProjectRecord
    await act(async () => {
      const opened = await result.current.openProject('partial-recovery-sanitize')
      expect(opened).not.toBeNull()
      openedProject = opened as ProjectRecord
    })

    const savedAfterNormalSave = await saveProjectRecord(openedProject)
    const persistedAfterNormalSave = await readStoredProject('partial-recovery-sanitize')

    expect(savedAfterNormalSave.slides[0]).toMatchObject({
      imageStorageKey: currentAssetKey('partial-recovery-sanitize', 'kept-slide'),
      imageAsset: {
        key: currentAssetKey('partial-recovery-sanitize', 'kept-slide')
      }
    })
    expect(savedAfterNormalSave.slides[0].editHistory?.[0]).toEqual({
      imageUrl: '',
      imageBase64: '',
      instruction: 'remove stale history if asset disappears',
      timestamp: 1234
    })
    expect(savedAfterNormalSave.slides[1].imageStorageKey).toBeUndefined()
    expect(savedAfterNormalSave.slides[1].imageAsset).toBeUndefined()
    expect(savedAfterNormalSave.lastCompletedSlides[0].imageStorageKey).toBeUndefined()
    expect(savedAfterNormalSave.lastCompletedSlides[0].imageAsset).toBeUndefined()
    expect(persistedAfterNormalSave).toEqual(savedAfterNormalSave)
  })

  it('prunes stale unreferenced project assets on save without deleting other projects assets', async () => {
    const historyImage = 'c3RhbGUtaGlzdG9yeQ=='

    await saveProjectRecord(buildProjectRecord({
      id: 'prune-source',
      slides: [
        imageSlide({
          id: 'keep-slide',
          imageBase64: CURRENT_IMAGE,
          editHistory: [{
            imageUrl: `data:image/webp;base64,${historyImage}`,
            imageBase64: historyImage,
            instruction: 'keep this history initially',
            timestamp: 1234
          }]
        }),
        imageSlide({ id: 'remove-slide', pageNumber: 2, imageBase64: SECOND_IMAGE })
      ],
      lastCompletedSlides: [
        imageSlide({ id: 'completed-slide', imageBase64: COMPLETED_IMAGE })
      ]
    }))
    await saveProjectRecord(buildProjectRecord({
      id: 'prune-other',
      slides: [imageSlide({ id: 'other-slide', imageBase64: OTHER_IMAGE })],
      lastCompletedSlides: []
    }))

    const compactProject = await getProject('prune-source')
    await saveProjectRecord({
      ...(compactProject as ProjectRecord),
      slides: [{
        ...(compactProject as ProjectRecord).slides[0],
        editHistory: []
      }],
      lastCompletedSlides: []
    })

    expect((await listStoredAssets('prune-source')).map(asset => asset.key).sort()).toEqual([
      currentAssetKey('prune-source', 'keep-slide')
    ])
    expect((await listStoredAssets('prune-other')).map(asset => asset.key)).toEqual([
      currentAssetKey('prune-other', 'other-slide')
    ])
  })

  it('requests existing compact asset references as one IndexedDB batch while resaving', async () => {
    await saveProjectRecord(buildProjectRecord({
      id: 'batch-asset-refs',
      title: 'Batch deck',
      slides: [imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: [imageSlide({ id: 'slide-1', imageBase64: COMPLETED_IMAGE })]
    }))
    const compactProject = await getProject('batch-asset-refs')
    const originalGet = IDBObjectStore.prototype.get
    let assetGetCalls = 0
    const getCallsBeforeEachSuccess: number[] = []
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      key: IDBValidKey | IDBKeyRange
    ) {
      const request = originalGet.call(this, key)

      if (this.name === 'assets') {
        assetGetCalls += 1
        request.addEventListener('success', () => {
          getCallsBeforeEachSuccess.push(assetGetCalls)
        }, { once: true })
      }

      return request
    })

    await saveProjectRecord({
      ...(compactProject as ProjectRecord),
      title: 'Resaved compact deck'
    })
    getSpy.mockRestore()

    expect(assetGetCalls).toBeGreaterThanOrEqual(2)
    expect(getCallsBeforeEachSuccess[0]).toBe(assetGetCalls)
  })

  it('hydrates all slide and edit-history assets using a single readonly transaction', async () => {
    const historyImage = 'YmF0Y2gtaGlzdG9yeQ=='
    const saved = await saveProjectRecord(buildProjectRecord({
      id: 'batch-hydrate-assets',
      title: 'Batch hydrate deck',
      slides: [
        imageSlide({
          id: 'slide-1',
          imageBase64: CURRENT_IMAGE,
          editHistory: [{
            imageUrl: `data:image/webp;base64,${historyImage}`,
            imageBase64: historyImage,
            instruction: 'make this calmer',
            timestamp: 1234
          }]
        }),
        imageSlide({ id: 'slide-2', pageNumber: 2, imageBase64: SECOND_IMAGE })
      ],
      lastCompletedSlides: [
        imageSlide({ id: 'completed-slide', imageBase64: COMPLETED_IMAGE })
      ]
    }))
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    transactionSpy.mockClear()

    await hydrateProjectImages(saved)

    const readonlyAssetTransactions = transactionSpy.mock.calls.filter(([storeNames, mode]) => (
      storeNames === 'assets' && mode === 'readonly'
    ))
    expect(readonlyAssetTransactions).toHaveLength(1)
  })

  it('checks project image integrity using a single readonly asset transaction', async () => {
    const saved = await saveProjectRecord(buildProjectRecord({
      id: 'batch-integrity-assets',
      title: 'Batch integrity deck',
      slides: [
        imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE }),
        imageSlide({ id: 'slide-2', pageNumber: 2, imageBase64: SECOND_IMAGE })
      ],
      lastCompletedSlides: [
        imageSlide({ id: 'completed-slide', imageBase64: COMPLETED_IMAGE })
      ]
    }))
    const transactionSpy = vi.spyOn(IDBDatabase.prototype, 'transaction')
    transactionSpy.mockClear()

    await verifyProjectIntegrity(saved)

    const readonlyAssetTransactions = transactionSpy.mock.calls.filter(([storeNames, mode]) => (
      storeNames === 'assets' && mode === 'readonly'
    ))
    expect(readonlyAssetTransactions).toHaveLength(1)
  })

  it('reports missing image assets instead of silently claiming full recovery', async () => {
    const project = buildProjectRecord({
      id: 'missing-assets',
      slides: [
        imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE }),
        imageSlide({ id: 'slide-2', pageNumber: 2, imageBase64: SECOND_IMAGE })
      ],
      lastCompletedSlides: [
        imageSlide({ id: 'slide-1', imageBase64: COMPLETED_IMAGE }),
        imageSlide({ id: 'slide-2', pageNumber: 2, imageBase64: OTHER_IMAGE })
      ]
    })
    const saved = await saveProjectRecord(project)

    await deleteStoredAsset(currentAssetKey('missing-assets', 'slide-2'))
    await deleteStoredAsset(completedAssetKey('missing-assets', 'slide-1'))

    const integrity = await verifyProjectIntegrity({
      ...saved,
      lastCompletedSlides: [
        ...saved.lastCompletedSlides,
        {
          ...saved.lastCompletedSlides[0],
          imageStorageKey: completedAssetKey('missing-assets', 'slide-1')
        }
      ]
    })
    const hydrated = await hydrateProjectImages(saved)

    expect(integrity).toEqual({
      ok: false,
      missingAssetKeys: [
        currentAssetKey('missing-assets', 'slide-2'),
        completedAssetKey('missing-assets', 'slide-1')
      ]
    })
    expect(hydrated.slides[0].imageBase64).toBe(CURRENT_IMAGE)
    expect(hydrated.slides[1].imageBase64).toBeUndefined()
    expect(hydrated.lastCompletedSlides[0].imageBase64).toBeUndefined()
  })

  it('does not save a compact slide reference when asset saving or opening fails', async () => {
    const project = buildProjectRecord({
      id: 'failed-save',
      slides: [imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: []
    })
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
      const request = { error: new Error('open failed') } as IDBOpenDBRequest
      queueMicrotask(() => {
        request.onerror?.call(request, new Event('error'))
      })
      return request
    })

    await expect(saveProjectRecord(project)).rejects.toThrow('open failed')
    openSpy.mockRestore()

    expect(await getProject('failed-save')).toBeNull()
    expect(await readStoredAsset(currentAssetKey('failed-save', 'slide-1'))).toBeNull()
  })

  it('rejects normal saves that reference missing compact assets', async () => {
    const project = buildProjectRecord({
      id: 'strict-missing-reference',
      slides: [{
        id: 'slide-1',
        pageNumber: 1,
        imageUrl: '',
        imageStorageKey: 'missing:asset',
        prompt: 'Missing compact image'
      }],
      lastCompletedSlides: []
    })

    await expect(saveProjectRecord(project)).rejects.toThrow('Missing image asset: missing:asset')
    expect(await getProject('strict-missing-reference')).toBeNull()
  })

  it('rolls back slide assets when the project record write fails', async () => {
    const project = buildProjectRecord({
      id: 'transaction-failure',
      slides: [imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: []
    })
    const originalPut = IDBObjectStore.prototype.put
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey
    ) {
      if (this.name === 'projects') {
        throw new Error('project put failed')
      }

      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key)
    })

    await expect(saveProjectRecord(project)).rejects.toThrow('project put failed')
    putSpy.mockRestore()

    expect(await readStoredProject('transaction-failure')).toBeNull()
    expect(await readStoredAsset(currentAssetKey('transaction-failure', 'slide-1'))).toBeNull()
  })

  it('stores edit-history images as assets and hydrates them back onto the slide history', async () => {
    const historyImage = 'aGlzdG9yeQ=='
    const project = buildProjectRecord({
      id: 'history-assets',
      slides: [
        imageSlide({
          id: 'slide-1',
          imageBase64: CURRENT_IMAGE,
          editHistory: [{
            imageUrl: `data:image/webp;base64,${historyImage}`,
            imageBase64: historyImage,
            instruction: 'make it brighter',
            timestamp: 1234
          }]
        })
      ],
      lastCompletedSlides: []
    })

    const saved = await saveProjectRecord(project)
    const stored = await readStoredProject('history-assets')
    const historyKey = editHistoryAssetKey('history-assets', 'slides', 'slide-1')

    expect(stored?.slides[0].editHistory?.[0]).toEqual({
      imageUrl: `asset:${historyKey}`,
      imageBase64: '',
      instruction: 'make it brighter',
      timestamp: 1234
    })
    expect(JSON.stringify(stored)).not.toContain(historyImage)
    expect(JSON.stringify(stored)).not.toContain(`data:image/webp;base64,${historyImage}`)
    expect(await readStoredAsset(historyKey)).toMatchObject({
      key: historyKey,
      projectId: 'history-assets',
      bucket: 'slides',
      slideId: 'slide-1',
      mimeType: 'image/webp',
      imageBase64: historyImage
    })

    const hydrated = await hydrateProjectImages(saved)
    expect(hydrated.slides[0].editHistory?.[0]).toEqual({
      imageUrl: `data:image/webp;base64,${historyImage}`,
      imageBase64: historyImage,
      instruction: 'make it brighter',
      timestamp: 1234
    })
  })

  it('hydrates larger image assets with chunked base64 conversion', async () => {
    const largeImage = btoa('x'.repeat(130_000))
    const project = buildProjectRecord({
      id: 'large-image',
      slides: [imageSlide({ id: 'large-slide', imageBase64: largeImage })],
      lastCompletedSlides: []
    })

    const saved = await saveProjectRecord(project)
    const hydrated = await hydrateProjectImages(saved)

    expect(hydrated.slides[0].imageBase64).toBe(largeImage)
    expect(hydrated.slides[0].imageUrl).toBe(`data:image/png;base64,${largeImage}`)
  })

  it('persists arbitrary small project metadata without mutating source fields', async () => {
    const statusArbitrary = fc.constantFrom<ProjectStatus>(
      'draft',
      'planning',
      'prompts_ready',
      'generating',
      'generated',
      'editing',
      'error'
    )
    const projectMetadataArbitrary = fc.record({
      id: fc.uuid(),
      title: fc.string({ maxLength: 80 }),
      fileName: fc.string({ maxLength: 80 }),
      fileContent: fc.string({ maxLength: 200 }),
      status: statusArbitrary,
      generationRunId: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
      createdAt: fc.nat({ max: 2_000_000 }),
      updatedAt: fc.nat({ max: 2_000_000 }),
      lastOpenedAt: fc.nat({ max: 2_000_000 })
    })

    await fc.assert(
      fc.asyncProperty(projectMetadataArbitrary, async (metadata) => {
        await resetProjectStoreForTests()
        const project: ProjectRecord = {
          ...buildProjectRecord({
            slides: [
              buildSlide({
                id: 'metadata-slide',
                imageUrl: '',
                imageBase64: undefined,
                prompt: 'Metadata-only slide'
              })
            ],
            lastCompletedSlides: []
          }),
          ...metadata,
          slides: [
            buildSlide({
              id: 'metadata-slide',
              imageUrl: '',
              imageBase64: undefined,
              prompt: 'Metadata-only slide'
            })
          ],
          lastCompletedSlides: []
        }
        const sourceSnapshot = structuredClone(project)

        const saved = await saveProjectRecord(project)
        const loaded = await getProject(project.id)

        expect(project).toEqual(sourceSnapshot)
        expect(saved).toEqual(loaded)
        expect(loaded).toMatchObject({
          id: metadata.id,
          title: metadata.title,
          fileName: metadata.fileName,
          fileContent: metadata.fileContent,
          status: metadata.status,
          generationRunId: metadata.generationRunId,
          createdAt: metadata.createdAt,
          updatedAt: metadata.updatedAt,
          lastOpenedAt: metadata.lastOpenedAt
        })
      }),
      { numRuns: 30 }
    )
  })

  it('clears the active project id without deleting saved projects', async () => {
    const project = await saveProjectRecord(buildProjectRecord({
      id: 'active-project',
      slides: [imageSlide({ id: 'slide-1', imageBase64: CURRENT_IMAGE })],
      lastCompletedSlides: []
    }))

    await setActiveProjectId(project.id)
    await clearActiveProjectId()

    expect(await getActiveProjectId()).toBeNull()
    expect(await getProject(project.id)).toEqual(project)
  })

  it('keeps current and last-completed images with the same slide id in distinct assets', async () => {
    const project = buildProjectRecord({
      id: 'bucketed-assets',
      slides: [
        imageSlide({
          id: 'shared-slide',
          imageBase64: CURRENT_IMAGE,
          imageUrl: `data:image/png;base64,${CURRENT_IMAGE}`
        })
      ],
      lastCompletedSlides: [
        imageSlide({
          id: 'shared-slide',
          imageBase64: COMPLETED_IMAGE,
          imageUrl: `data:image/png;base64,${COMPLETED_IMAGE}`
        })
      ]
    })

    const saved = await saveProjectRecord(project)
    const currentKey = currentAssetKey('bucketed-assets', 'shared-slide')
    const completedKey = completedAssetKey('bucketed-assets', 'shared-slide')

    expect(saved.slides[0].imageStorageKey).toBe(currentKey)
    expect(saved.lastCompletedSlides[0].imageStorageKey).toBe(completedKey)
    expect(await readStoredAsset(currentKey)).toMatchObject({ imageBase64: CURRENT_IMAGE })
    expect(await readStoredAsset(completedKey)).toMatchObject({ imageBase64: COMPLETED_IMAGE })

    const hydrated = await hydrateProjectImages(saved)
    expect(hydrated.slides[0].imageBase64).toBe(CURRENT_IMAGE)
    expect(hydrated.lastCompletedSlides[0].imageBase64).toBe(COMPLETED_IMAGE)
    expect(hydrated.slides[0].imageUrl).toBe(`data:image/png;base64,${CURRENT_IMAGE}`)
    expect(hydrated.lastCompletedSlides[0].imageUrl).toBe(`data:image/png;base64,${COMPLETED_IMAGE}`)
  })
})

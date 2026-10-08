import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fc from 'fast-check'
import 'fake-indexeddb/auto'
import { render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { useAutoSave } from '../../hooks/useAutoSave'
import {
  StorageService,
  PersistedState,
  saveState,
  loadState,
  saveProject,
  loadProject,
  loadProjectWithImages,
  saveApiConfig,
  loadApiConfig,
  clearProject,
  clearAll,
  hasProject,
  hasSlides
} from '../../services/storageService'
import { Slide, ApiConfig, GenerationConfig, ProjectStatus, WorkflowState } from '../../types'
import {
  getActiveProjectId,
  getProject,
  saveProjectRecord,
  setActiveProjectId
} from '../../services/projectStore'
import {
  deleteStoredAsset,
  buildDeckOutline,
  buildProjectRecord,
  buildSlide,
  buildSlidePrompt,
  TEST_GENERATION_CONFIG,
  resetProjectStoreForTests
} from '../../services/projectStore.test-utils'
import { RestoredProject, loadSavedProject, useStateRestore } from '../../hooks/useStateRestore'

const LEGACY_STATE_KEY = 'aippt_persisted_state'
const LEGACY_IMAGE_DB_NAME = 'aippt_slide_images'

function RestoreProbe({ onRestore }: { onRestore: (project: RestoredProject) => void }) {
  const { restoredProject } = useStateRestore()

  useEffect(() => {
    if (restoredProject) {
      onRestore(restoredProject)
    }
  }, [onRestore, restoredProject])

  return null
}

function AutoSaveWorkflowProbe({
  workflow,
  status,
  onSaved
}: {
  workflow: WorkflowState
  status: ProjectStatus
  onSaved: () => void
}) {
  const { saveNow } = useAutoSave({
    projectId: null,
    fileContent: '# Workflow',
    fileName: 'workflow.md',
    slides: [],
    lastCompletedSlides: [],
    generationConfig: TEST_GENERATION_CONFIG,
    workflow,
    status,
    generationRunId: null,
    onProjectIdChange: vi.fn(),
    enabled: false
  })

  useEffect(() => {
    void Promise.resolve(saveNow()).then(onSaved)
  }, [onSaved, saveNow])

  return null
}

async function deleteIndexedDbForTests(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return
  }

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error(`Failed to delete ${name}`))
    request.onblocked = () => reject(new Error(`Blocked while deleting ${name}`))
  })
}

/**
 * Feature: webui-frontend, Property 7: State Persistence Round-Trip
 * Validates: Requirements 10.1, 10.2
 * 
 * Property-based test to verify that application state is correctly
 * persisted to and restored from localStorage.
 * 
 * For any application state (slides, configuration), saving to local storage
 * and then restoring should produce an equivalent state.
 */
describe('State Persistence Property Tests', () => {
  // Clear localStorage and project databases before each test
  beforeEach(async () => {
    await resetProjectStoreForTests()
    await deleteIndexedDbForTests(LEGACY_IMAGE_DB_NAME)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Arbitrary for generating valid Slide objects
   */
  const slideArbitrary = fc.record({
    id: fc.uuid(),
    pageNumber: fc.integer({ min: 1, max: 100 }),
    imageUrl: fc.webUrl(),
    imageBase64: fc.option(fc.base64String({ minLength: 10, maxLength: 100 }), { nil: undefined }),
    prompt: fc.string({ minLength: 0, maxLength: 500 })
  })

  /**
   * Arbitrary for generating valid ApiConfig objects
   */
  const apiConfigArbitrary: fc.Arbitrary<ApiConfig> = fc.record({
    apiKey: fc.string({ minLength: 0, maxLength: 100 }),
    baseUrl: fc.oneof(fc.webUrl(), fc.constant(''))
  })

  /**
   * Arbitrary for generating valid GenerationConfig objects
   */
  const generationConfigArbitrary: fc.Arbitrary<GenerationConfig> = fc.record({
    pageCount: fc.integer({ min: 1, max: 20 }),
    quality: fc.constantFrom('1K', '2K', '4K') as fc.Arbitrary<'1K' | '2K' | '4K'>,
    aspectRatio: fc.constantFrom('16:9', '4:3') as fc.Arbitrary<'16:9' | '4:3'>
  })

  /**
   * Arbitrary for generating valid PersistedState objects
   */
  const persistedStateArbitrary: fc.Arbitrary<PersistedState> = fc.record({
    version: fc.constant(1),
    apiConfig: apiConfigArbitrary,
    currentProject: fc.option(
      fc.record({
        fileContent: fc.string({ minLength: 0, maxLength: 1000 }),
        fileName: fc.string({ minLength: 0, maxLength: 100 }),
        slides: fc.array(slideArbitrary, { minLength: 0, maxLength: 10 }),
        generationConfig: generationConfigArbitrary
      }),
      { nil: null }
    )
  })

  /**
   * Property 7: State Persistence Round-Trip
   * For any valid persisted state, saving and loading should return equivalent state
   */
  it('should persist and restore complete state correctly (round-trip)', () => {
    fc.assert(
      fc.property(
        persistedStateArbitrary,
        (state: PersistedState) => {
          // Save the state
          const saveSuccess = saveState(state)
          expect(saveSuccess).toBe(true)
          
          // Load the state
          const loaded = loadState()
          
          // Property: Loaded state should equal saved state
          expect(loaded).not.toBeNull()
          expect(loaded!.version).toBe(state.version)
          expect(loaded!.apiConfig).toEqual(state.apiConfig)
          
          if (state.currentProject === null) {
            expect(loaded!.currentProject).toBeNull()
          } else {
            expect(loaded!.currentProject).not.toBeNull()
            expect(loaded!.currentProject!.fileContent).toBe(state.currentProject.fileContent)
            expect(loaded!.currentProject!.fileName).toBe(state.currentProject.fileName)
            expect(loaded!.currentProject!.slides).toEqual(state.currentProject.slides)
            expect(loaded!.currentProject!.generationConfig).toEqual(state.currentProject.generationConfig)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * Property 7: State Persistence Round-Trip
   * For any valid project data, saving and loading should return equivalent data
   */
  it('should persist and restore project data correctly (round-trip)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1000 }),
        fc.string({ minLength: 0, maxLength: 100 }),
        fc.array(slideArbitrary, { minLength: 0, maxLength: 10 }),
        generationConfigArbitrary,
        (fileContent, fileName, slides, generationConfig) => {
          // Save the project
          const saveSuccess = saveProject(fileContent, fileName, slides, generationConfig)
          expect(saveSuccess).toBe(true)
          
          // Load the project
          const loaded = loadProject()
          
          // Property: Loaded project should equal saved project
          expect(loaded).not.toBeNull()
          expect(loaded!.fileContent).toBe(fileContent)
          expect(loaded!.fileName).toBe(fileName)
          expect(loaded!.slides).toEqual(slides)
          expect(loaded!.generationConfig).toEqual(generationConfig)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * Property 7: State Persistence Round-Trip
   * For any valid API config, saving and loading should return equivalent config
   */
  it('should persist and restore API config correctly (round-trip)', () => {
    fc.assert(
      fc.property(
        apiConfigArbitrary,
        (config: ApiConfig) => {
          // Save the config
          const saveSuccess = saveApiConfig(config)
          expect(saveSuccess).toBe(true)
          
          // Load the config
          const loaded = loadApiConfig()
          
          // Property: Loaded config should equal saved config
          expect(loaded.apiKey).toBe(config.apiKey)
          expect(loaded.baseUrl).toBe(config.baseUrl)
        }
      ),
      { numRuns: 100 }
    )
  })

  /**
   * Property: Clearing project should preserve API config
   */
  it('should preserve API config when clearing project', () => {
    fc.assert(
      fc.property(
        apiConfigArbitrary,
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(slideArbitrary, { minLength: 1, maxLength: 5 }),
        generationConfigArbitrary,
        (apiConfig, fileContent, fileName, slides, generationConfig) => {
          // Save API config and project
          saveApiConfig(apiConfig)
          saveProject(fileContent, fileName, slides, generationConfig)
          
          // Clear project
          const clearSuccess = clearProject()
          expect(clearSuccess).toBe(true)
          
          // API config should be preserved
          const loadedApiConfig = loadApiConfig()
          expect(loadedApiConfig.apiKey).toBe(apiConfig.apiKey)
          expect(loadedApiConfig.baseUrl).toBe(apiConfig.baseUrl)
          
          // Project should be cleared
          const loadedProject = loadProject()
          expect(loadedProject).toBeNull()
        }
      ),
      { numRuns: 50 }
    )
  })

  /**
   * Property: hasProject should correctly detect saved projects
   */
  it('should correctly detect presence of saved project', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(slideArbitrary, { minLength: 0, maxLength: 5 }),
        generationConfigArbitrary,
        (fileContent, fileName, slides, generationConfig) => {
          // Initially no project
          expect(hasProject()).toBe(false)
          
          // Save project
          saveProject(fileContent, fileName, slides, generationConfig)
          
          // Now has project
          expect(hasProject()).toBe(true)
          
          // Clear project
          clearProject()
          
          // No project again
          expect(hasProject()).toBe(false)
        }
      ),
      { numRuns: 50 }
    )
  })

  /**
   * Property: hasSlides should correctly detect saved slides
   */
  it('should correctly detect presence of saved slides', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        generationConfigArbitrary,
        (fileContent, fileName, generationConfig) => {
          // Save project with no slides
          saveProject(fileContent, fileName, [], generationConfig)
          expect(hasSlides()).toBe(false)
          
          // Save project with slides
          const slide: Slide = {
            id: 'test-id',
            pageNumber: 1,
            imageUrl: 'https://example.com/image.png',
            prompt: 'test prompt'
          }
          saveProject(fileContent, fileName, [slide], generationConfig)
          expect(hasSlides()).toBe(true)
        }
      ),
      { numRuns: 50 }
    )
  })

  it('should restore slide images from IndexedDB when image payload exceeds storage quota', async () => {
    const originalSetItem = Storage.prototype.setItem
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      })
      .mockImplementation(function (this: Storage, key: string, value: string) {
        return originalSetItem.call(this, key, value)
      })

    const slide: Slide = {
      id: 'slide-1',
      pageNumber: 1,
      imageUrl: 'data:image/png;base64,' + 'a'.repeat(1000),
      imageBase64: 'a'.repeat(1000),
      prompt: 'prompt'
    }

    const generationConfig: GenerationConfig = {
      pageCount: 1,
      quality: '1K',
      aspectRatio: '16:9'
    }

    expect(saveProject('content', 'demo.md', [slide], generationConfig)).toBe(true)

    const loaded = loadProject()
    expect(loaded?.slides).toHaveLength(1)
    expect(loaded?.slides[0].imageStorageKey).toBe('demo.md:slide-1')
    expect(loaded?.slides[0].imageUrl).toBe('')
    expect(loaded?.slides[0].imageBase64).toBeUndefined()

    const restored = await loadProjectWithImages()
    expect(restored?.slides[0].imageUrl).toBe(slide.imageUrl)
    expect(restored?.slides[0].imageBase64).toBe(slide.imageBase64)
    expect(setItemSpy).toHaveBeenCalledTimes(2)
  })

  it('autosaves confirmed workflow into the durable restore path', async () => {
    const workflow: WorkflowState = {
      status: 'prompts_ready',
      outline: buildDeckOutline({
        title: 'Autosaved workflow outline'
      }),
      slidePrompts: [
        buildSlidePrompt({
          title: 'Autosaved workflow page',
          content_summary: 'Autosaved workflow summary',
          display_content: 'Autosaved workflow display',
          prompt: 'Autosaved workflow prompt'
        })
      ],
      expandedOutlinePages: [1],
      expandedDesignPages: [1],
      error: null
    }
    const onSaved = vi.fn()

    render(
      <AutoSaveWorkflowProbe
        workflow={workflow}
        status="prompts_ready"
        onSaved={onSaved}
      />
    )

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
    })

    const activeProjectId = await getActiveProjectId()
    expect(activeProjectId).toBeTruthy()
    const restored = await StorageService.loadActiveProjectWithMigration()
    expect(restored?.fileName).toBe('workflow.md')
    expect(restored?.workflow).toEqual(workflow)
    expect(restored?.status).toBe('prompts_ready')
  })

  it('migrates legacy currentProject into the durable active project store', async () => {
    const imageBase64 = 'bWlncmF0ZWQtaW1hZ2U='
    const slide: Slide = {
      id: 'legacy-slide-1',
      pageNumber: 1,
      imageUrl: `data:image/png;base64,${imageBase64}`,
      imageBase64,
      prompt: 'Legacy prompt'
    }
    const generationConfig: GenerationConfig = {
      pageCount: 1,
      quality: '2K',
      aspectRatio: '4:3',
      language: 'English',
      style: 'Editorial',
      targetAudience: 'Operators',
      userRequirements: 'Preserve this'
    }

    const legacyApiConfig: ApiConfig = {
      apiKey: 'legacy-key',
      baseUrl: 'https://api.example.test'
    }

    saveState({
      version: 1,
      apiConfig: legacyApiConfig,
      currentProject: {
        fileContent: '# Legacy Deck',
        fileName: 'legacy-deck.md',
        slides: [slide],
        generationConfig
      }
    })

    const migrated = await StorageService.loadActiveProjectWithMigration()
    const activeId = await getActiveProjectId()
    const compactStored = activeId ? await getProject(activeId) : null

    expect(migrated).not.toBeNull()
    expect(migrated?.version).toBe(2)
    expect(migrated?.id).toBe(activeId)
    expect(migrated?.title).toBe('legacy-deck')
    expect(migrated?.fileName).toBe('legacy-deck.md')
    expect(migrated?.fileContent).toBe('# Legacy Deck')
    expect(migrated?.generationConfig).toEqual(generationConfig)
    expect(migrated?.slides).toHaveLength(1)
    expect(migrated?.slides[0]).toMatchObject(slide)
    expect(migrated?.lastCompletedSlides).toHaveLength(1)
    expect(migrated?.lastCompletedSlides[0]).toMatchObject(slide)
    expect(migrated?.workflow).toEqual({
      status: 'idle',
      outline: null,
      slidePrompts: [],
      expandedOutlinePages: [],
      expandedDesignPages: [],
      error: null
    })
    expect(migrated?.status).toBe('generated')
    expect(migrated?.generationRunId).toBeNull()
    expect(compactStored).not.toBeNull()
    expect(compactStored?.id).toBe(migrated?.id)
    expect(compactStored?.slides[0].imageBase64).toBeUndefined()
    expect(localStorage.getItem(LEGACY_STATE_KEY)).toBeNull()
    expect(loadApiConfig()).toEqual(legacyApiConfig)
  })

  it('returns an existing active durable project without clearing unrelated legacy state', async () => {
    const activeProject = await saveProjectRecord(buildProjectRecord({
      id: 'durable-active',
      title: 'Durable Active',
      fileName: 'durable.md',
      fileContent: '# Durable',
      slides: [{
        id: 'durable-slide-1',
        pageNumber: 1,
        imageUrl: 'data:image/png;base64,ZHVyYWJsZQ==',
        imageBase64: 'ZHVyYWJsZQ==',
        prompt: 'Durable prompt'
      }],
      lastCompletedSlides: []
    }))
    await setActiveProjectId(activeProject.id)

    saveState({
      version: 1,
      apiConfig: {
        apiKey: 'legacy-key',
        baseUrl: ''
      },
      currentProject: {
        fileContent: '# Unrelated Legacy',
        fileName: 'legacy.md',
        slides: [],
        generationConfig: {
          pageCount: 1,
          quality: '1K',
          aspectRatio: '16:9'
        }
      }
    })
    const legacyState = localStorage.getItem(LEGACY_STATE_KEY)

    const restored = await StorageService.loadActiveProjectWithMigration()

    expect(restored?.id).toBe('durable-active')
    expect(restored?.fileName).toBe('durable.md')
    expect(restored?.slides[0].imageBase64).toBe('ZHVyYWJsZQ==')
    expect(restored?.slides[0].imageUrl).toBe('data:image/png;base64,ZHVyYWJsZQ==')
    expect(localStorage.getItem(LEGACY_STATE_KEY)).toBe(legacyState)
  })

  it('clears the active durable project so it is not restored again', async () => {
    const activeProject = await saveProjectRecord(buildProjectRecord({
      id: 'durable-to-clear',
      title: 'Durable To Clear',
      fileName: 'durable-to-clear.md',
      fileContent: '# Durable To Clear'
    }))
    await setActiveProjectId(activeProject.id)

    expect(clearProject()).toBe(true)

    expect(await getActiveProjectId()).toBeNull()
    expect(await StorageService.loadActiveProjectWithMigration()).toBeNull()
  })

  it('maps durable project status and completed slide snapshot into restored project state', async () => {
    const currentSlide = buildSlide({
      id: 'current-slide',
      pageNumber: 1,
      prompt: 'Current in-progress slide'
    })
    const completedSlide = buildSlide({
      id: 'completed-slide',
      pageNumber: 1,
      prompt: 'Last completed slide'
    })
    const activeProject = await saveProjectRecord(buildProjectRecord({
      id: 'durable-distinct-snapshot',
      status: 'error',
      slides: [currentSlide],
      lastCompletedSlides: [completedSlide]
    }))
    await setActiveProjectId(activeProject.id)
    const onRestore = vi.fn()

    render(<RestoreProbe onRestore={onRestore} />)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalled()
    })

    const restored = onRestore.mock.calls.at(-1)?.[0] as RestoredProject
    expect(restored.status).toBe('error')
    expect(restored.slides.map((slide) => slide.id)).toEqual(['current-slide'])
    expect(restored.lastCompletedSlides.map((slide) => slide.id)).toEqual(['completed-slide'])
  })

  it('reports missing durable image asset refs while restoring sanitized active project slides', async () => {
    const activeProject = await saveProjectRecord(buildProjectRecord({
      id: 'durable-missing-image',
      slides: [buildSlide({
        id: 'missing-image-slide',
        imageUrl: 'data:image/png;base64,bWlzc2luZw==',
        imageBase64: 'bWlzc2luZw=='
      })],
      lastCompletedSlides: [buildSlide({
        id: 'missing-completed-slide',
        imageUrl: 'data:image/png;base64,bWlzc2luZy1jb21wbGV0ZWQ=',
        imageBase64: 'bWlzc2luZy1jb21wbGV0ZWQ='
      })],
    }))
    const missingSlideKey = activeProject.slides[0].imageStorageKey || activeProject.slides[0].imageAsset?.key
    const missingCompletedKey =
      activeProject.lastCompletedSlides[0].imageStorageKey ||
      activeProject.lastCompletedSlides[0].imageAsset?.key
    expect(missingSlideKey).toBeTruthy()
    expect(missingCompletedKey).toBeTruthy()
    await deleteStoredAsset(missingSlideKey as string)
    await deleteStoredAsset(missingCompletedKey as string)
    await setActiveProjectId(activeProject.id)
    const onRestore = vi.fn()

    render(<RestoreProbe onRestore={onRestore} />)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalled()
    })

    const restored = onRestore.mock.calls.at(-1)?.[0] as RestoredProject & { missingAssetKeys?: string[] }
    expect(restored.missingAssetKeys).toEqual([missingSlideKey, missingCompletedKey])
    expect(restored.slides[0]).toMatchObject({
      id: 'missing-image-slide',
      imageUrl: ''
    })
    expect(restored.slides[0].imageStorageKey).toBeUndefined()
    expect(restored.slides[0].imageAsset).toBeUndefined()
    expect(restored.lastCompletedSlides[0]).toMatchObject({
      id: 'missing-completed-slide',
      imageUrl: ''
    })
    expect(restored.lastCompletedSlides[0].imageStorageKey).toBeUndefined()
    expect(restored.lastCompletedSlides[0].imageAsset).toBeUndefined()
  })

  it('returns an empty missing asset list from the legacy saved project helper', () => {
    saveProject('# Legacy', 'legacy.md', [], TEST_GENERATION_CONFIG)

    const restored = loadSavedProject() as (RestoredProject & { missingAssetKeys?: string[] }) | null

    expect(restored?.missingAssetKeys).toEqual([])
  })

  it('restores legacy compact slides with missing old image refs stripped', async () => {
    const missingLegacyKey = 'legacy-missing.md:legacy-missing-slide'
    const slide: Slide = {
      id: 'legacy-missing-slide',
      pageNumber: 1,
      imageUrl: '',
      imageStorageKey: missingLegacyKey,
      prompt: 'Legacy prompt with a missing image'
    }
    saveState({
      version: 1,
      apiConfig: {
        apiKey: 'legacy-key',
        baseUrl: ''
      },
      currentProject: {
        fileContent: '# Legacy Missing Image',
        fileName: 'legacy-missing.md',
        slides: [slide],
        generationConfig: TEST_GENERATION_CONFIG
      }
    })
    const onRestore = vi.fn()

    render(<RestoreProbe onRestore={onRestore} />)

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalled()
    })

    const restored = onRestore.mock.calls.at(-1)?.[0] as RestoredProject
    expect(restored.fileContent).toBe('# Legacy Missing Image')
    expect(restored.slides[0]).toMatchObject({
      id: 'legacy-missing-slide',
      pageNumber: 1,
      imageUrl: '',
      prompt: 'Legacy prompt with a missing image'
    })
    expect(restored.slides[0].imageStorageKey).toBeUndefined()
    expect(restored.slides[0].imageAsset).toBeUndefined()
    expect(restored.missingAssetKeys).toEqual([missingLegacyKey])
  })

  it('migrates legacy fallback images from the old slide image database', async () => {
    const originalSetItem = Storage.prototype.setItem
    vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementationOnce(() => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      })
      .mockImplementation(function (this: Storage, key: string, value: string) {
        return originalSetItem.call(this, key, value)
      })

    const imageBase64 = 'ZmFsbGJhY2staW1hZ2U='
    const slide: Slide = {
      id: 'fallback-slide-1',
      pageNumber: 1,
      imageUrl: `data:image/png;base64,${imageBase64}`,
      imageBase64,
      prompt: 'Fallback prompt'
    }
    const generationConfig: GenerationConfig = {
      pageCount: 1,
      quality: '1K',
      aspectRatio: '16:9'
    }

    expect(saveProject('# Fallback', 'fallback.md', [slide], generationConfig)).toBe(true)
    expect(loadProject()?.slides[0]).toMatchObject({
      imageUrl: '',
      imageStorageKey: 'fallback.md:fallback-slide-1'
    })

    const migrated = await StorageService.loadActiveProjectWithMigration()
    const activeId = await getActiveProjectId()
    const compactStored = activeId ? await getProject(activeId) : null

    expect(migrated).not.toBeNull()
    expect(migrated?.id).toBe(activeId)
    expect(migrated?.fileName).toBe('fallback.md')
    expect(migrated?.fileContent).toBe('# Fallback')
    expect(migrated?.generationConfig).toEqual(generationConfig)
    expect(migrated?.slides[0]).toMatchObject({
      id: 'fallback-slide-1',
      imageBase64,
      imageUrl: `data:image/png;base64,${imageBase64}`
    })
    expect(migrated?.lastCompletedSlides[0]).toMatchObject({
      id: 'fallback-slide-1',
      imageBase64,
      imageUrl: `data:image/png;base64,${imageBase64}`
    })
    expect(compactStored?.slides[0].imageBase64).toBeUndefined()
    expect(localStorage.getItem(LEGACY_STATE_KEY)).toBeNull()
  })

  /**
   * Property: clearAll should remove all data
   */
  it('should clear all data when clearAll is called', () => {
    fc.assert(
      fc.property(
        apiConfigArbitrary,
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.array(slideArbitrary, { minLength: 1, maxLength: 5 }),
        generationConfigArbitrary,
        (apiConfig, fileContent, fileName, slides, generationConfig) => {
          // Save data
          saveApiConfig(apiConfig)
          saveProject(fileContent, fileName, slides, generationConfig)
          
          // Clear all
          const clearSuccess = clearAll()
          expect(clearSuccess).toBe(true)
          
          // All data should be cleared
          const loadedState = loadState()
          expect(loadedState).toBeNull()
          
          // API config should return defaults
          const loadedApiConfig = loadApiConfig()
          expect(loadedApiConfig.apiKey).toBe('')
          expect(loadedApiConfig.baseUrl).toBe('')
        }
      ),
      { numRuns: 50 }
    )
  })

  /**
   * Property: Multiple saves should only keep the latest state
   */
  it('should keep only the latest saved state', () => {
    fc.assert(
      fc.property(
        fc.tuple(persistedStateArbitrary, persistedStateArbitrary),
        ([state1, state2]) => {
          // Save first state
          saveState(state1)
          
          // Save second state
          saveState(state2)
          
          // Load should return second state
          const loaded = loadState()
          
          expect(loaded).not.toBeNull()
          expect(loaded!.apiConfig).toEqual(state2.apiConfig)
          
          if (state2.currentProject === null) {
            expect(loaded!.currentProject).toBeNull()
          } else {
            expect(loaded!.currentProject).toEqual(state2.currentProject)
          }
        }
      ),
      { numRuns: 50 }
    )
  })

  /**
   * Property: Empty localStorage should return null state
   */
  it('should return null when localStorage is empty', () => {
    localStorage.clear()
    const loaded = loadState()
    expect(loaded).toBeNull()
  })

  /**
   * Property: Empty localStorage should return default API config
   */
  it('should return default API config when localStorage is empty', () => {
    localStorage.clear()
    const loaded = loadApiConfig()
    expect(loaded.apiKey).toBe('')
    expect(loaded.baseUrl).toBe('')
  })

  /**
   * Property: Storage info should be available
   */
  it('should provide storage info', () => {
    fc.assert(
      fc.property(
        persistedStateArbitrary,
        (state) => {
          saveState(state)
          
          const info = StorageService.getStorageInfo()
          expect(info.available).toBe(true)
          expect(info.used).toBeGreaterThan(0)
        }
      ),
      { numRuns: 20 }
    )
  })
})

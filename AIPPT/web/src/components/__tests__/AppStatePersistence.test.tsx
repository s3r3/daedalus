import { describe, expect, it } from 'vitest'
import {
  AppState,
  appReducerForTests,
  initialAppStateForTests
} from '../../contexts/AppStateContext'
import { Slide, WorkflowState } from '../../types'
import {
  buildDeckOutline,
  buildSlide,
  buildSlidePrompt,
  EMPTY_WORKFLOW_STATE,
  TEST_GENERATION_CONFIG
} from '../../services/projectStore.test-utils'

function cloneWorkflow(workflow: WorkflowState): WorkflowState {
  return {
    ...workflow,
    outline: workflow.outline ? { ...workflow.outline, slides: workflow.outline.slides.map(slide => ({ ...slide })) } : null,
    slidePrompts: workflow.slidePrompts.map(prompt => ({ ...prompt })),
    expandedOutlinePages: [...workflow.expandedOutlinePages],
    expandedDesignPages: [...workflow.expandedDesignPages]
  }
}

function slide(overrides: Partial<Slide> = {}): Slide {
  return buildSlide(overrides)
}

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    ...cloneWorkflow(EMPTY_WORKFLOW_STATE),
    ...overrides
  }
}

function staleState(overrides: Partial<AppState> = {}): AppState {
  const existingSlide = slide({ id: 'slide-old', pageNumber: 1 })
  return {
    ...initialAppStateForTests,
    projectId: 'project-old',
    fileContent: '# old',
    fileName: 'old.md',
    slides: [existingSlide],
    lastCompletedSlides: [existingSlide],
    selectedSlideId: existingSlide.id,
    editingSlide: {
      slideId: existingSlide.id,
      originalImage: existingSlide.imageUrl,
      currentImage: existingSlide.imageUrl,
      history: [],
      userInput: 'make it brighter'
    },
    workflow: workflow({
      status: 'prompts_ready',
      outline: buildDeckOutline(),
      slidePrompts: [buildSlidePrompt()]
    }),
    status: 'prompts_ready',
    generationRunId: 'run-old',
    ...overrides
  }
}

describe('AppState persistence reducer behavior', () => {
  it('clears stale slides and workflow when file content changes to a different file', () => {
    const result = appReducerForTests(
      staleState(),
      { type: 'SET_FILE_CONTENT', payload: { content: '# new', name: 'new.md' } }
    )

    expect(result.uploadedFile).toBeNull()
    expect(result.fileContent).toBe('# new')
    expect(result.fileName).toBe('new.md')
    expect(result.projectId).toBeNull()
    expect(result.slides).toEqual([])
    expect(result.lastCompletedSlides).toEqual([])
    expect(result.selectedSlideId).toBeNull()
    expect(result.editingSlide).toBeNull()
    expect(result.workflow).toEqual(EMPTY_WORKFLOW_STATE)
    expect(result.status).toBe('draft')
    expect(result.generationRunId).toBeNull()
  })

  it('clears stale slides and workflow when a different file object is selected', () => {
    const file = new File(['# new'], 'new.md', { type: 'text/markdown' })

    const result = appReducerForTests(
      staleState(),
      { type: 'SET_FILE', payload: { file, content: '# new', name: 'new.md' } }
    )

    expect(result.uploadedFile).toBe(file)
    expect(result.fileContent).toBe('# new')
    expect(result.fileName).toBe('new.md')
    expect(result.projectId).toBeNull()
    expect(result.slides).toEqual([])
    expect(result.lastCompletedSlides).toEqual([])
    expect(result.selectedSlideId).toBeNull()
    expect(result.editingSlide).toBeNull()
    expect(result.workflow).toEqual(EMPTY_WORKFLOW_STATE)
    expect(result.status).toBe('draft')
    expect(result.generationRunId).toBeNull()
  })

  it('keeps completed slides but clears current slides when generation starts', () => {
    const completedSlides = [slide({ id: 'slide-completed', pageNumber: 1 })]
    const currentSlides = [slide({ id: 'slide-current', pageNumber: 2 })]

    const result = appReducerForTests(
      staleState({
        slides: currentSlides,
        lastCompletedSlides: completedSlides,
        status: 'generated'
      }),
      { type: 'START_GENERATION', payload: { runId: 'run-1' } }
    )

    expect(result.isGenerating).toBe(true)
    expect(result.status).toBe('generating')
    expect(result.generationRunId).toBe('run-1')
    expect(result.lastCompletedSlides).toEqual(completedSlides)
    expect(result.slides).toEqual([])
  })

  it('snapshots generated slides when generation completes', () => {
    const generatedSlides = [
      slide({ id: 'slide-1', pageNumber: 1 }),
      slide({ id: 'slide-2', pageNumber: 2 })
    ]

    const result = appReducerForTests(
      staleState({
        slides: generatedSlides,
        lastCompletedSlides: [],
        status: 'generating',
        generationRunId: 'run-1',
        isGenerating: true
      }),
      { type: 'COMPLETE_GENERATION' }
    )

    expect(result.isGenerating).toBe(false)
    expect(result.status).toBe('generated')
    expect(result.generationRunId).toBeNull()
    expect(result.lastCompletedSlides).toEqual(generatedSlides)
  })

  it('does not sync in-progress slide updates into the previous completed deck', () => {
    const previousCompletedSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'completed',
      imageUrl: 'data:image/png;base64,completed'
    })
    const partialGeneratingSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'partial',
      imageUrl: 'data:image/png;base64,partial'
    })

    const result = appReducerForTests(
      staleState({
        slides: [partialGeneratingSlide],
        lastCompletedSlides: [previousCompletedSlide],
        status: 'generating',
        isGenerating: true
      }),
      {
        type: 'UPDATE_SLIDE',
        payload: {
          id: 'slide-1',
          updates: {
            imageBase64: 'partial-edited',
            imageUrl: 'data:image/png;base64,partial-edited'
          }
        }
      }
    )

    expect(result.slides[0]).toMatchObject({
      imageBase64: 'partial-edited',
      imageUrl: 'data:image/png;base64,partial-edited'
    })
    expect(result.lastCompletedSlides).toEqual([previousCompletedSlide])
  })

  it('does not sync error-state partial regeneration edits into the previous completed deck', () => {
    const completedHistory = [{
      imageBase64: 'completed-history',
      imageUrl: 'data:image/png;base64,completed-history',
      instruction: 'Sharpen the original completed slide',
      timestamp: 1712131200000
    }]
    const previousCompletedSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'completed-original',
      imageUrl: 'data:image/png;base64,completed-original',
      editHistory: completedHistory
    })
    const previousCompletedDeck = [previousCompletedSlide]
    const partialRegenerationSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'partial-regeneration',
      imageUrl: 'data:image/png;base64,partial-regeneration'
    })
    const partialEditHistory = [{
      imageBase64: 'partial-edited-history',
      imageUrl: 'data:image/png;base64,partial-edited-history',
      instruction: 'Edit the failed partial slide',
      timestamp: 1712131300000
    }]

    const generating = appReducerForTests(
      staleState({
        slides: previousCompletedDeck,
        lastCompletedSlides: previousCompletedDeck,
        status: 'generated',
        isGenerating: false
      }),
      { type: 'START_GENERATION', payload: { runId: 'run-2' } }
    )
    const withPartialSlide = appReducerForTests(
      generating,
      { type: 'ADD_SLIDE', payload: partialRegenerationSlide }
    )
    const errored = appReducerForTests(
      withPartialSlide,
      { type: 'GENERATION_ERROR', payload: 'regeneration failed' }
    )
    const edited = appReducerForTests(
      errored,
      {
        type: 'UPDATE_SLIDE',
        payload: {
          id: 'slide-1',
          updates: {
            imageBase64: 'partial-edited',
            imageUrl: 'data:image/png;base64,partial-edited',
            editHistory: partialEditHistory
          }
        }
      }
    )

    expect(errored.status).toBe('error')
    expect(errored.isGenerating).toBe(false)
    expect(errored.slides).toEqual([partialRegenerationSlide])
    expect(edited.slides[0]).toMatchObject({
      imageBase64: 'partial-edited',
      imageUrl: 'data:image/png;base64,partial-edited',
      editHistory: partialEditHistory
    })
    expect(edited.lastCompletedSlides).toEqual(previousCompletedDeck)
  })

  it('keeps edited completed slide as fallback after workflow returns to prompts_ready', () => {
    const completedSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'original',
      imageUrl: 'data:image/png;base64,original'
    })
    const editedHistory = [{
      imageBase64: 'edited-history',
      imageUrl: 'data:image/png;base64,edited-history',
      instruction: 'Make the chart clearer',
      timestamp: 1712131200000
    }]

    const completed = appReducerForTests(
      staleState({
        slides: [completedSlide],
        lastCompletedSlides: [],
        status: 'generating',
        generationRunId: 'run-1',
        isGenerating: true
      }),
      { type: 'COMPLETE_GENERATION' }
    )
    const promptsReady = appReducerForTests(
      completed,
      {
        type: 'SET_WORKFLOW',
        payload: workflow({
          status: 'prompts_ready',
          outline: buildDeckOutline(),
          slidePrompts: [buildSlidePrompt()]
        })
      }
    )
    const edited = appReducerForTests(
      promptsReady,
      {
        type: 'UPDATE_SLIDE',
        payload: {
          id: 'slide-1',
          updates: {
            imageBase64: 'edited',
            imageUrl: 'data:image/png;base64,edited',
            editHistory: editedHistory
          }
        }
      }
    )
    const generatingAgain = appReducerForTests(
      edited,
      { type: 'START_GENERATION', payload: { runId: 'run-2' } }
    )

    expect(promptsReady.status).toBe('prompts_ready')
    expect(generatingAgain.slides).toEqual([])
    expect(generatingAgain.lastCompletedSlides[0]).toMatchObject({
      id: 'slide-1',
      imageBase64: 'edited',
      imageUrl: 'data:image/png;base64,edited',
      editHistory: editedHistory
    })
  })

  it('keeps edited completed slide as fallback after workflow errors', () => {
    const completedSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'original',
      imageUrl: 'data:image/png;base64,original'
    })
    const editedHistory = [{
      imageBase64: 'edited-history',
      imageUrl: 'data:image/png;base64,edited-history',
      instruction: 'Make the workflow-error deck clearer',
      timestamp: 1712131200000
    }]
    const completedDeck = [completedSlide]
    const workflowError = appReducerForTests(
      staleState({
        slides: completedDeck,
        lastCompletedSlides: completedDeck,
        status: 'generated',
        isGenerating: false
      }),
      {
        type: 'SET_WORKFLOW',
        payload: workflow({
          status: 'error',
          outline: buildDeckOutline(),
          slidePrompts: [buildSlidePrompt()],
          error: 'outline generation failed'
        })
      }
    )
    const edited = appReducerForTests(
      workflowError,
      {
        type: 'UPDATE_SLIDE',
        payload: {
          id: 'slide-1',
          updates: {
            imageBase64: 'edited',
            imageUrl: 'data:image/png;base64,edited',
            editHistory: editedHistory
          }
        }
      }
    )
    const generatingAgain = appReducerForTests(
      edited,
      { type: 'START_GENERATION', payload: { runId: 'run-2' } }
    )

    expect(workflowError.status).toBe('error')
    expect(generatingAgain.slides).toEqual([])
    expect(generatingAgain.lastCompletedSlides[0]).toMatchObject({
      id: 'slide-1',
      imageBase64: 'edited',
      imageUrl: 'data:image/png;base64,edited',
      editHistory: editedHistory
    })
  })

  it('keeps restored completed slide edits as fallback when image bucket keys differ after workflow errors', () => {
    const initialHistory = [{
      imageBase64: 'history-original',
      imageUrl: 'data:image/png;base64,history-original',
      instruction: 'Tighten the opening slide',
      timestamp: 1712131100000
    }]
    const sharedAssetMetadata = {
      mimeType: 'image/png',
      byteLength: 1024,
      sha256: 'same-image-sha256'
    }
    const currentSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'same-completed-image',
      imageUrl: 'data:image/png;base64,same-completed-image',
      imageStorageKey: 'project-1:slides:slide-1:image',
      imageAsset: {
        key: 'project-1:slides:slide-1:image',
        ...sharedAssetMetadata
      },
      prompt: 'Generate a cover page',
      editHistory: initialHistory,
      updatedAt: 1712131200000
    })
    const completedSlide = slide({
      id: 'slide-1',
      pageNumber: 1,
      imageBase64: 'same-completed-image',
      imageUrl: 'data:image/png;base64,same-completed-image',
      imageStorageKey: 'project-1:lastCompletedSlides:slide-1:image',
      imageAsset: {
        key: 'project-1:lastCompletedSlides:slide-1:image',
        ...sharedAssetMetadata
      },
      prompt: 'Generate a cover page',
      editHistory: initialHistory,
      updatedAt: 1712131200000
    })
    const editedHistory = [{
      imageBase64: 'edited-history',
      imageUrl: 'data:image/png;base64,edited-history',
      instruction: 'Make the restored workflow-error deck clearer',
      timestamp: 1712131300000
    }]
    const workflowError = appReducerForTests(
      staleState({
        slides: [currentSlide],
        lastCompletedSlides: [completedSlide],
        status: 'generated',
        isGenerating: false
      }),
      {
        type: 'SET_WORKFLOW',
        payload: workflow({
          status: 'error',
          outline: buildDeckOutline(),
          slidePrompts: [buildSlidePrompt()],
          error: 'workflow failed after restore'
        })
      }
    )
    const edited = appReducerForTests(
      workflowError,
      {
        type: 'UPDATE_SLIDE',
        payload: {
          id: 'slide-1',
          updates: {
            imageBase64: 'edited',
            imageUrl: 'data:image/png;base64,edited',
            editHistory: editedHistory
          }
        }
      }
    )
    const generatingAgain = appReducerForTests(
      edited,
      { type: 'START_GENERATION', payload: { runId: 'run-2' } }
    )

    expect(workflowError.status).toBe('error')
    expect(generatingAgain.slides).toEqual([])
    expect(generatingAgain.lastCompletedSlides[0]).toMatchObject({
      id: 'slide-1',
      imageBase64: 'edited',
      imageUrl: 'data:image/png;base64,edited',
      editHistory: editedHistory
    })
  })

  it('restores project-aware state with sorted unique slides and completed-slide fallback', () => {
    const duplicateFirst = slide({ id: 'slide-a', pageNumber: 3, prompt: 'older' })
    const duplicateLast = slide({ id: 'slide-a', pageNumber: 1, prompt: 'newer' })
    const middle = slide({ id: 'slide-b', pageNumber: 2 })
    const restoredWorkflow = workflow({
      status: 'prompts_ready',
      outline: buildDeckOutline(),
      slidePrompts: [buildSlidePrompt()]
    })

    const result = appReducerForTests(
      initialAppStateForTests,
      {
        type: 'RESTORE_STATE',
        payload: {
          projectId: 'project-1',
          fileContent: '# restored',
          fileName: 'restored.md',
          slides: [duplicateFirst, middle, duplicateLast],
          generationConfig: TEST_GENERATION_CONFIG,
          workflow: restoredWorkflow,
          status: 'prompts_ready'
        }
      }
    )

    expect(result.projectId).toBe('project-1')
    expect(result.fileContent).toBe('# restored')
    expect(result.fileName).toBe('restored.md')
    expect(result.workflow).toEqual(restoredWorkflow)
    expect(result.status).toBe('prompts_ready')
    expect(result.slides).toEqual([duplicateLast, middle])
    expect(result.lastCompletedSlides).toEqual([duplicateLast, middle])
    expect(result.generationRunId).toBeNull()
    expect(result.generationProgress).toMatchObject({
      current: 2,
      total: 2,
      status: 'completed'
    })
  })

  it('restores distinct current slides and last completed slide snapshot', () => {
    const currentSlides = [
      slide({ id: 'current-slide', pageNumber: 1, prompt: 'Current in-progress slide' })
    ]
    const completedSlides = [
      slide({ id: 'completed-slide', pageNumber: 1, prompt: 'Last completed slide' })
    ]

    const result = appReducerForTests(
      initialAppStateForTests,
      {
        type: 'RESTORE_STATE',
        payload: {
          projectId: 'project-distinct',
          fileContent: '# restored',
          fileName: 'restored.md',
          slides: currentSlides,
          generationConfig: TEST_GENERATION_CONFIG,
          workflow: workflow(),
          status: 'error',
          lastCompletedSlides: completedSlides
        }
      }
    )

    expect(result.status).toBe('error')
    expect(result.slides).toEqual(currentSlides)
    expect(result.lastCompletedSlides).toEqual(completedSlides)
  })

  it('normalizes transient generating status when restoring a persisted project', () => {
    const generatedSlides = [
      slide({ id: 'generated-slide', pageNumber: 1, prompt: 'Generated slide' })
    ]
    const restoredWorkflow = workflow({
      status: 'prompts_ready',
      outline: buildDeckOutline(),
      slidePrompts: [buildSlidePrompt()]
    })

    const result = appReducerForTests(
      staleState({
        isGenerating: true,
        generationRunId: 'stale-run',
        generationProgress: {
          current: 0,
          total: 1,
          status: 'generating',
          message: 'stale generation'
        }
      }),
      {
        type: 'RESTORE_STATE',
        payload: {
          projectId: 'project-generating',
          fileContent: '# restored',
          fileName: 'restored.md',
          slides: generatedSlides,
          generationConfig: TEST_GENERATION_CONFIG,
          workflow: restoredWorkflow,
          status: 'generating',
          lastCompletedSlides: generatedSlides
        }
      }
    )

    expect(result.status).toBe('generated')
    expect(result.isGenerating).toBe(false)
    expect(result.generationRunId).toBeNull()
    expect(result.generationProgress).toMatchObject({
      current: 1,
      total: 1,
      status: 'completed'
    })
  })

  it('clears project state on reset while preserving API configs', () => {
    const state = staleState({
      apiConfig: { apiKey: 'image-key', baseUrl: 'https://image.example.test' },
      fullApiConfig: {
        image: {
          apiKey: 'image-key',
          baseUrl: 'https://image.example.test',
          model: 'image-model'
        },
        text: {
          apiKey: 'text-key',
          baseUrl: 'https://text.example.test',
          model: 'text-model',
          format: 'openai'
        }
      }
    })

    const result = appReducerForTests(state, { type: 'RESET_STATE' })

    expect(result.apiConfig).toEqual(state.apiConfig)
    expect(result.fullApiConfig).toEqual(state.fullApiConfig)
    expect(result.projectId).toBeNull()
    expect(result.slides).toEqual([])
    expect(result.workflow).toEqual(EMPTY_WORKFLOW_STATE)
    expect(result.generationRunId).toBeNull()
    expect(result.lastCompletedSlides).toEqual([])
  })
})

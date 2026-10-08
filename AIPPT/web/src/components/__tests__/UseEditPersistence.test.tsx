import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppStateProvider } from '../../contexts/AppStateContext'
import { useAppState } from '../../contexts/useAppState'
import { useEdit } from '../../hooks/useEdit'
import { useEditConflict } from '../../hooks/useEditConflict'
import { EditHistoryItem, EditSession, Slide } from '../../types'

const editImageMock = vi.hoisted(() => vi.fn())

vi.mock('../../services/editService', () => ({
  editImage: editImageMock
}))

function useEditHarness() {
  const app = useAppState()
  const edit = useEdit()
  const conflict = useEditConflict()

  return { app, edit, conflict }
}

const persistedHistoryA: EditHistoryItem = {
  imageUrl: 'data:image/png;base64,cGVyc2lzdGVkLWltYWdlLWE=',
  imageBase64: 'cGVyc2lzdGVkLWltYWdlLWE=',
  instruction: 'make the title brighter',
  timestamp: 1700000000000
}

const persistedHistoryB: EditHistoryItem = {
  imageUrl: 'data:image/png;base64,cGVyc2lzdGVkLWltYWdlLWI=',
  imageBase64: 'cGVyc2lzdGVkLWltYWdlLWI=',
  instruction: 'make the chart clearer',
  timestamp: 1700000001000
}

const persistedHistory: EditHistoryItem[] = [persistedHistoryA]
const twoItemPersistedHistory: EditHistoryItem[] = [persistedHistoryA, persistedHistoryB]

function buildSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: 'slide-1',
    pageNumber: 1,
    imageUrl: 'data:image/png;base64,Y3VycmVudC1pbWFnZQ==',
    imageBase64: 'Y3VycmVudC1pbWFnZQ==',
    prompt: 'Intro slide',
    ...overrides
  }
}

describe('useEdit persisted edit history', () => {
  afterEach(() => {
    editImageMock.mockReset()
  })

  it('initializes a new edit session from the slide edit history', () => {
    const slide = buildSlide({ editHistory: persistedHistory })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(slide)
    })

    expect(result.current.edit.editSession?.history).toEqual(persistedHistory)
  })

  it('confirms the edited image with persisted and session history without duplicating the persisted prefix', () => {
    const sessionHistoryItem: EditHistoryItem = {
      imageUrl: 'data:image/png;base64,Y3VycmVudC1pbWFnZQ==',
      imageBase64: 'Y3VycmVudC1pbWFnZQ==',
      instruction: 'add presenter notes visual',
      timestamp: 1700000001000
    }
    const slide = buildSlide({ editHistory: persistedHistory })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.app.addSlide(slide)
      result.current.edit.beginEdit(slide)
    })

    act(() => {
      result.current.app.updateEdit({
        currentImage: 'ZWRpdGVkLWltYWdl',
        history: [...persistedHistory, sessionHistoryItem]
      })
    })

    act(() => {
      result.current.edit.confirmEdit()
    })

    const updatedSlide = result.current.app.state.slides.find(item => item.id === slide.id)
    expect(updatedSlide?.imageBase64).toBe('ZWRpdGVkLWltYWdl')
    expect(updatedSlide?.imageUrl).toBe('data:image/png;base64,ZWRpdGVkLWltYWdl')
    expect(updatedSlide?.editHistory).toEqual([...persistedHistory, sessionHistoryItem])
    expect(updatedSlide?.editHistory).toHaveLength(2)
    expect(result.current.app.state.selectedSlideId).toBe(slide.id)
    expect(result.current.edit.editSession).toBeNull()
  })

  it('keeps last completed slide in sync after confirming an edit', () => {
    const editHistoryItem: EditHistoryItem = {
      imageUrl: 'data:image/png;base64,b3JpZ2luYWw=',
      imageBase64: 'b3JpZ2luYWw=',
      instruction: 'make the closing chart clearer',
      timestamp: 1700000003000
    }
    const slide = buildSlide({
      imageBase64: 'b3JpZ2luYWw=',
      imageUrl: 'data:image/png;base64,b3JpZ2luYWw='
    })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.app.addSlide(slide)
      result.current.app.completeGeneration()
      result.current.edit.beginEdit(slide)
    })

    act(() => {
      result.current.app.updateEdit({
        currentImage: 'ZWRpdGVk',
        history: [editHistoryItem]
      })
    })

    act(() => {
      result.current.edit.confirmEdit()
    })

    const updatedSlide = result.current.app.state.slides.find(item => item.id === slide.id)
    expect(updatedSlide?.imageBase64).toBe('ZWRpdGVk')
    expect(updatedSlide?.editHistory).toEqual([editHistoryItem])

    act(() => {
      result.current.app.startGeneration('run-1')
    })

    expect(result.current.app.state.slides).toEqual([])
    expect(result.current.app.state.lastCompletedSlides[0]).toMatchObject({
      id: slide.id,
      imageBase64: 'ZWRpdGVk',
      imageUrl: 'data:image/png;base64,ZWRpdGVk',
      editHistory: [editHistoryItem]
    })
    expect(result.current.app.state.lastCompletedSlides[0]?.imageBase64).not.toBe('b3JpZ2luYWw=')
  })

  it('confirms edits to a fallback last completed slide when current slides are empty', () => {
    const editHistoryItem: EditHistoryItem = {
      imageUrl: 'data:image/png;base64,b3JpZ2luYWw=',
      imageBase64: 'b3JpZ2luYWw=',
      instruction: 'make the fallback chart clearer',
      timestamp: 1700000004000
    }
    const slide = buildSlide({
      imageBase64: 'b3JpZ2luYWw=',
      imageUrl: 'data:image/png;base64,b3JpZ2luYWw='
    })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.app.addSlide(slide)
      result.current.app.completeGeneration()
      result.current.app.startGeneration('run-1')
      result.current.edit.beginEdit(slide)
    })

    act(() => {
      result.current.app.updateEdit({
        currentImage: 'ZmFsbGJhY2stZWRpdGVk',
        history: [editHistoryItem]
      })
    })

    act(() => {
      result.current.edit.confirmEdit()
    })

    expect(result.current.app.state.slides).toEqual([])
    expect(result.current.app.state.lastCompletedSlides[0]).toMatchObject({
      id: slide.id,
      imageBase64: 'ZmFsbGJhY2stZWRpdGVk',
      imageUrl: 'data:image/png;base64,ZmFsbGJhY2stZWRpdGVk',
      editHistory: [editHistoryItem]
    })
    expect(result.current.app.state.selectedSlideId).toBe(slide.id)
    expect(result.current.edit.editSession).toBeNull()
    expect(result.current.edit.editError).toBeNull()
  })

  it('persists truncated history after reverting to a persisted version', () => {
    const slide = buildSlide({ editHistory: twoItemPersistedHistory })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.app.addSlide(slide)
      result.current.edit.beginEdit(slide)
    })

    act(() => {
      result.current.edit.revertToVersion(persistedHistoryB)
    })

    act(() => {
      result.current.edit.confirmEdit()
    })

    const updatedSlide = result.current.app.state.slides.find(item => item.id === slide.id)
    expect(updatedSlide?.imageBase64).toBe(persistedHistoryB.imageBase64)
    expect(updatedSlide?.editHistory).toEqual([persistedHistoryA])
  })

  it('clears persisted history after reverting to the first persisted version', () => {
    const slide = buildSlide({ editHistory: twoItemPersistedHistory })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.app.addSlide(slide)
      result.current.edit.beginEdit(slide)
    })

    act(() => {
      result.current.edit.revertToVersion(persistedHistoryA)
    })

    act(() => {
      result.current.edit.confirmEdit()
    })

    const updatedSlide = result.current.app.state.slides.find(item => item.id === slide.id)
    expect(updatedSlide?.imageBase64).toBe(persistedHistoryA.imageBase64)
    expect(updatedSlide?.editHistory).toEqual([])
  })

  it('keeps the edit session open with an error when confirming a missing slide', () => {
    const slide = buildSlide({ editHistory: persistedHistory })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(slide)
    })

    act(() => {
      result.current.edit.confirmEdit()
    })

    expect(result.current.edit.editSession?.slideId).toBe(slide.id)
    expect(result.current.edit.editError).toBe('无法确认编辑：幻灯片不存在')
    expect(result.current.app.state.selectedSlideId).toBeNull()
  })

  it('does not treat seeded persisted history as unsaved edit changes', () => {
    const slide = buildSlide({ editHistory: persistedHistory })
    const sessionHistoryItem: EditHistoryItem = {
      imageUrl: 'data:image/png;base64,Y3VycmVudC1pbWFnZQ==',
      imageBase64: 'Y3VycmVudC1pbWFnZQ==',
      instruction: 'add presenter notes visual',
      timestamp: 1700000002000
    }
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(slide)
    })

    expect(result.current.conflict.hasUnsavedEdits(result.current.edit.editSession)).toBe(false)

    act(() => {
      result.current.app.updateEdit({
        currentImage: 'ZWRpdGVkLWltYWdl',
        history: [...persistedHistory, sessionHistoryItem]
      })
    })

    expect(result.current.conflict.hasUnsavedEdits(result.current.edit.editSession)).toBe(true)
  })

  it('stores callback cancel actions for discard confirmation and clears them afterward', () => {
    const run = vi.fn()
    const callbackAction = { type: 'callback' as const, run }
    const dirtyEditSession: EditSession = {
      slideId: 'slide-1',
      originalImage: 'original-image',
      currentImage: 'edited-image',
      history: [],
      userInput: ''
    }
    const { result } = renderHook(() => useEditConflict())

    let canCancel = true
    act(() => {
      canCancel = result.current.tryCancelEdit(dirtyEditSession, callbackAction)
    })

    expect(canCancel).toBe(false)
    expect(result.current.showConfirmDialog).toBe(true)
    expect(result.current.pendingAction).toBe(callbackAction)

    let confirmedAction: ReturnType<typeof result.current.confirmDiscard> | undefined
    act(() => {
      confirmedAction = result.current.confirmDiscard()
    })

    expect(confirmedAction).toBe(callbackAction)
    expect(result.current.showConfirmDialog).toBe(false)
    expect(result.current.pendingAction).toBeNull()

    act(() => {
      result.current.tryCancelEdit(dirtyEditSession, callbackAction)
    })
    expect(result.current.showConfirmDialog).toBe(true)
    expect(result.current.pendingAction).toBe(callbackAction)

    act(() => {
      result.current.cancelDiscard()
    })

    expect(result.current.showConfirmDialog).toBe(false)
    expect(result.current.pendingAction).toBeNull()
  })

  it('ignores stale submitEdit responses after the edit session changes', async () => {
    let resolveEdit: ((value: { success: boolean; image_base64: string }) => void) | undefined
    const editPromise = new Promise<{ success: boolean; image_base64: string }>((resolve) => {
      resolveEdit = resolve
    })
    editImageMock.mockReturnValueOnce(editPromise)

    const firstSlide = buildSlide({
      id: 'slide-a',
      imageBase64: 'c2xpZGUtYQ==',
      imageUrl: 'data:image/png;base64,c2xpZGUtYQ=='
    })
    const secondSlide = buildSlide({
      id: 'slide-b',
      imageBase64: 'c2xpZGUtYg==',
      imageUrl: 'data:image/png;base64,c2xpZGUtYg=='
    })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.app.addSlide(firstSlide)
      result.current.app.addSlide(secondSlide)
      result.current.edit.beginEdit(firstSlide)
    })

    let submitPromise: Promise<void> | undefined
    act(() => {
      submitPromise = result.current.edit.submitEdit('make slide A blue')
    })

    act(() => {
      result.current.edit.cancelEdit()
      result.current.edit.beginEdit(secondSlide)
    })

    await act(async () => {
      resolveEdit?.({ success: true, image_base64: 'c3RhbGUtcmVzcG9uc2U=' })
      await submitPromise
    })

    expect(result.current.edit.editSession?.slideId).toBe(secondSlide.id)
    expect(result.current.edit.editSession?.currentImage).toBe('c2xpZGUtYg==')
    expect(result.current.edit.editSession?.history).toEqual([])
    expect(result.current.edit.editError).toBeNull()
  })

  it('keeps editing busy until the newest overlapping submit finishes', async () => {
    let resolveFirst: ((value: { success: boolean; image_base64: string }) => void) | undefined
    let resolveSecond: ((value: { success: boolean; image_base64: string }) => void) | undefined
    const firstEditPromise = new Promise<{ success: boolean; image_base64: string }>((resolve) => {
      resolveFirst = resolve
    })
    const secondEditPromise = new Promise<{ success: boolean; image_base64: string }>((resolve) => {
      resolveSecond = resolve
    })
    editImageMock
      .mockReturnValueOnce(firstEditPromise)
      .mockReturnValueOnce(secondEditPromise)

    const firstSlide = buildSlide({
      id: 'slide-a',
      imageBase64: 'c2xpZGUtYQ==',
      imageUrl: 'data:image/png;base64,c2xpZGUtYQ=='
    })
    const secondSlide = buildSlide({
      id: 'slide-b',
      imageBase64: 'c2xpZGUtYg==',
      imageUrl: 'data:image/png;base64,c2xpZGUtYg=='
    })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(firstSlide)
    })

    let firstSubmitPromise: Promise<void> | undefined
    act(() => {
      firstSubmitPromise = result.current.edit.submitEdit('make slide A blue')
    })
    expect(result.current.edit.isEditing).toBe(true)

    act(() => {
      result.current.edit.cancelEdit()
      result.current.edit.beginEdit(secondSlide)
    })

    let secondSubmitPromise: Promise<void> | undefined
    act(() => {
      secondSubmitPromise = result.current.edit.submitEdit('make slide B green')
    })

    await act(async () => {
      resolveFirst?.({ success: true, image_base64: 'c3RhbGUtcmVzcG9uc2U=' })
      await firstSubmitPromise
    })

    expect(result.current.edit.editSession?.slideId).toBe(secondSlide.id)
    expect(result.current.edit.isEditing).toBe(true)

    await act(async () => {
      resolveSecond?.({ success: true, image_base64: 'bmV3ZXN0LXJlc3BvbnNl' })
      await secondSubmitPromise
    })

    expect(result.current.edit.isEditing).toBe(false)
    expect(result.current.edit.editSession?.currentImage).toBe('bmV3ZXN0LXJlc3BvbnNl')
  })

  it('keeps the newest same-session submit result when responses resolve out of order', async () => {
    let resolveFirst: ((value: { success: boolean; image_base64: string }) => void) | undefined
    let resolveSecond: ((value: { success: boolean; image_base64: string }) => void) | undefined
    const firstEditPromise = new Promise<{ success: boolean; image_base64: string }>((resolve) => {
      resolveFirst = resolve
    })
    const secondEditPromise = new Promise<{ success: boolean; image_base64: string }>((resolve) => {
      resolveSecond = resolve
    })
    editImageMock
      .mockReturnValueOnce(firstEditPromise)
      .mockReturnValueOnce(secondEditPromise)

    const slide = buildSlide({
      id: 'slide-a',
      imageBase64: 'c2xpZGUtYQ==',
      imageUrl: 'data:image/png;base64,c2xpZGUtYQ=='
    })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(slide)
    })

    let firstSubmitPromise: Promise<void> | undefined
    act(() => {
      firstSubmitPromise = result.current.edit.submitEdit('older request')
    })

    let secondSubmitPromise: Promise<void> | undefined
    act(() => {
      secondSubmitPromise = result.current.edit.submitEdit('newer request')
    })

    await act(async () => {
      resolveSecond?.({ success: true, image_base64: 'bmV3ZXItcmVzcG9uc2U=' })
      await secondSubmitPromise
    })

    expect(result.current.edit.editSession?.currentImage).toBe('bmV3ZXItcmVzcG9uc2U=')

    await act(async () => {
      resolveFirst?.({ success: true, image_base64: 'b2xkZXItcmVzcG9uc2U=' })
      await firstSubmitPromise
    })

    expect(result.current.edit.editSession?.currentImage).toBe('bmV3ZXItcmVzcG9uc2U=')
    expect(result.current.edit.editSession?.history).toHaveLength(1)
    expect(result.current.edit.editSession?.history[0]?.instruction).toBe('newer request')
  })

  it('ignores an in-flight submit response after reverting the same edit session', async () => {
    let resolveEdit: ((value: { success: boolean; image_base64: string }) => void) | undefined
    const editPromise = new Promise<{ success: boolean; image_base64: string }>((resolve) => {
      resolveEdit = resolve
    })
    editImageMock.mockReturnValueOnce(editPromise)

    const slide = buildSlide({
      editHistory: twoItemPersistedHistory,
      imageBase64: persistedHistoryB.imageBase64,
      imageUrl: persistedHistoryB.imageUrl
    })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(slide)
    })

    let submitPromise: Promise<void> | undefined
    act(() => {
      submitPromise = result.current.edit.submitEdit('make this stale')
    })

    act(() => {
      result.current.edit.revertToVersion(persistedHistoryA)
    })

    await act(async () => {
      resolveEdit?.({ success: true, image_base64: 'c3RhbGUtcmV2ZXJ0LW92ZXJ3cml0ZQ==' })
      await submitPromise
    })

    expect(result.current.edit.editSession?.currentImage).toBe(persistedHistoryA.imageBase64)
    expect(result.current.edit.editSession?.history).toEqual([])
  })

  it('clones slide edit history when starting an edit session', () => {
    const slide = buildSlide({ editHistory: [{ ...persistedHistoryA }] })
    const { result } = renderHook(() => useEditHarness(), { wrapper: AppStateProvider })

    act(() => {
      result.current.edit.beginEdit(slide)
    })

    slide.editHistory?.push(persistedHistoryB)
    if (slide.editHistory?.[0]) {
      slide.editHistory[0].instruction = 'mutated outside session'
    }

    expect(result.current.edit.editSession?.history).toEqual([persistedHistoryA])
  })
})

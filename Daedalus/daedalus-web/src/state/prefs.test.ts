import { beforeEach, describe, expect, test } from 'vitest'
import {
  CHAT_HEIGHT,
  CHAT_HEIGHT_KEY,
  COLUMN_WIDTHS_KEY,
  COMPOSER_PREFS_KEY,
  composerPrefsOf,
  loadChatHeight,
  loadColumnWidths,
  loadComposerPrefs,
  saveChatHeight,
  saveColumnWidths,
  saveComposerPrefs,
} from './prefs'
import { useDaedalusStore } from './taskStore'

beforeEach(() => {
  localStorage.clear()
  useDaedalusStore.getState().reset()
})

describe('composer prefs (browser persistence for run defaults)', () => {
  test('a saved set of defaults loads back intact', () => {
    saveComposerPrefs({
      mode: 'plan',
      autoApprove: true,
      thinking: false,
      providerId: 'nine-router',
      model: 'kr/auto',
      maxIterations: 9,
      modelPool: 'alpha, beta',
      modelStrategy: 'round-robin',
    })
    expect(loadComposerPrefs()).toEqual({
      mode: 'plan',
      autoApprove: true,
      thinking: false,
      providerId: 'nine-router',
      model: 'kr/auto',
      maxIterations: 9,
      modelPool: 'alpha, beta',
      modelStrategy: 'round-robin',
    })
  })

  test('unknown modes, strategies, and non-numeric iterations are dropped, not trusted', () => {
    localStorage.setItem(
      COMPOSER_PREFS_KEY,
      JSON.stringify({ mode: 'bogus', modelStrategy: 'random', maxIterations: 'many', thinking: false }),
    )
    expect(loadComposerPrefs()).toEqual({ thinking: false })
  })

  test('corrupt storage degrades to no prefs', () => {
    localStorage.setItem(COMPOSER_PREFS_KEY, '{not json')
    expect(loadComposerPrefs()).toEqual({})
  })

  test('composerPrefsOf keeps only the persistable defaults', () => {
    const composer = {
      goal: 'a draft that must not persist',
      mode: 'auto' as const,
      providerId: '',
      model: '',
      modelPool: '',
      modelStrategy: 'failover' as const,
      autoApprove: false,
      thinking: true,
      maxIterations: 25,
      attachments: [],
      submitting: false,
      error: null,
    }
    expect(composerPrefsOf(composer)).toEqual({
      mode: 'auto',
      autoApprove: false,
      thinking: true,
      providerId: '',
      model: '',
      maxIterations: 25,
      modelPool: '',
      modelStrategy: 'failover',
    })
  })

  test('changing a composer default persists it through the store', () => {
    useDaedalusStore.getState().setComposer({ maxIterations: 42, modelPool: 'a-model, b-model', modelStrategy: 'round-robin' })
    const prefs = loadComposerPrefs()
    expect(prefs.maxIterations).toBe(42)
    expect(prefs.modelPool).toBe('a-model, b-model')
    expect(prefs.modelStrategy).toBe('round-robin')
  })
})

describe('panel layout prefs (chat height + column widths)', () => {
  test('chat height defaults, round-trips, and clamps to its sane range', () => {
    expect(loadChatHeight()).toBe(CHAT_HEIGHT.default)
    saveChatHeight(480)
    expect(loadChatHeight()).toBe(480)
    saveChatHeight(10_000)
    expect(loadChatHeight()).toBe(CHAT_HEIGHT.max)
    saveChatHeight(10)
    expect(loadChatHeight()).toBe(CHAT_HEIGHT.min)
    localStorage.setItem(CHAT_HEIGHT_KEY, 'not-a-number')
    expect(loadChatHeight()).toBe(CHAT_HEIGHT.default)
  })

  test('column widths default, round-trip, clamp, and survive corrupt storage', () => {
    expect(loadColumnWidths()).toEqual({ left: 320, right: 360 })
    saveColumnWidths({ left: 400, right: 500 })
    expect(loadColumnWidths()).toEqual({ left: 400, right: 500 })
    saveColumnWidths({ left: 50, right: 5_000 })
    expect(loadColumnWidths()).toEqual({ left: 240, right: 560 })
    localStorage.setItem(COLUMN_WIDTHS_KEY, '{broken')
    expect(loadColumnWidths()).toEqual({ left: 320, right: 360 })
  })
})

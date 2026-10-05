import { beforeEach, describe, expect, test } from 'vitest'
import { COMPOSER_PREFS_KEY, composerPrefsOf, loadComposerPrefs, saveComposerPrefs } from './prefs'
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

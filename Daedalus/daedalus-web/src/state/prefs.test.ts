import { beforeEach, describe, expect, test } from 'vitest'
import {
  CHAT_HEIGHT,
  CHAT_HEIGHT_KEY,
  COLUMN_WIDTHS_KEY,
  COMPOSER_PREFS_KEY,
  composerPrefsOf,
  domainFromPathname,
  loadChatHeight,
  pathForDomain,
  loadColumnWidths,
  loadComposerPrefs,
  saveChatHeight,
  saveColumnWidths,
  saveComposerPrefs,
  TERMINAL_HEIGHT,
  TERMINAL_HEIGHT_KEY,
  loadTerminalHeight,
  saveTerminalHeight,
  WORKSPACE_PANEL_HEIGHT,
  WORKSPACE_PANEL_HEIGHT_KEY,
  loadWorkspacePanelHeight,
  saveWorkspacePanelHeight,
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
      providerId: 'nine-router',
      model: 'kr/auto',
      tokenBudget: 50000,
      taskModel: 'nine-router::kr/auto',
      toolRules: { allow: ['read_file'], ask: ['run_command'], deny: [] },
    })
    expect(loadComposerPrefs()).toEqual({
      mode: 'plan',
      autoApprove: true,
      providerId: 'nine-router',
      model: 'kr/auto',
      tokenBudget: 50000,
      taskModel: 'nine-router::kr/auto',
      toolRules: { allow: ['read_file'], ask: ['run_command'], deny: [] },
    })
  })

  test('unknown modes and non-positive token budgets are dropped, not trusted', () => {
    localStorage.setItem(
      COMPOSER_PREFS_KEY,
      JSON.stringify({ mode: 'bogus', tokenBudget: -5, taskModel: '  ', toolRules: { allow: 'nope' } }),
    )
    expect(loadComposerPrefs()).toEqual({})
  })

  test('old 3-layer-moved keys are tolerated: thinking/pool/strategy simply disappear', () => {
    localStorage.setItem(
      COMPOSER_PREFS_KEY,
      JSON.stringify({
        mode: 'auto',
        thinking: false,
        maxIterations: 9,
        modelPool: 'alpha, beta',
        modelStrategy: 'round-robin',
        providerId: 'nine-router',
      }),
    )
    // No storage-key bump needed: unknown keys are ignored gracefully, so
    // a stored 'round-robin' disappears with the pool and valid keys survive.
    expect(loadComposerPrefs()).toEqual({ mode: 'auto', providerId: 'nine-router' })
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
      autoApprove: false,
      tokenBudget: 12000,
      taskModel: 'nine-router::kr/auto',
      toolRules: { allow: [] as string[], ask: [] as string[], deny: ['delete_file'] },
      attachments: [],
      submitting: false,
      error: null,
    }
    expect(composerPrefsOf(composer)).toEqual({
      mode: 'auto',
      autoApprove: false,
      providerId: '',
      model: '',
      tokenBudget: 12000,
      taskModel: 'nine-router::kr/auto',
      toolRules: { allow: [], ask: [], deny: ['delete_file'] },
    })
  })

  test('composerPrefsOf omits empty per-task values', () => {
    const composer = {
      goal: '',
      mode: 'auto' as const,
      providerId: '',
      model: '',
      autoApprove: false,
      tokenBudget: undefined,
      taskModel: '',
      toolRules: { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
      attachments: [],
      submitting: false,
      error: null,
    }
    expect(composerPrefsOf(composer)).toEqual({ mode: 'auto', autoApprove: false, providerId: '', model: '' })
  })

  test('changing a composer default persists it through the store', () => {
    useDaedalusStore.getState().setComposer({ tokenBudget: 42000, taskModel: 'nine-router::kr/auto', toolRules: { allow: ['read_file'], ask: [], deny: [] } })
    const prefs = loadComposerPrefs()
    expect(prefs.tokenBudget).toBe(42000)
    expect(prefs.taskModel).toBe('nine-router::kr/auto')
    expect(prefs.toolRules).toEqual({ allow: ['read_file'], ask: [], deny: [] })
  })
})

describe('domain from route (the pathname names the domain)', () => {
  test("'/slide' and everything under it resolve to the slide domain", () => {
    expect(domainFromPathname('/slide')).toBe('slide')
    expect(domainFromPathname('/slide/xyz')).toBe('slide')
  })

  test("the root and any other path resolve to the coding domain", () => {
    expect(domainFromPathname('/')).toBe('coding')
    expect(domainFromPathname('/foo')).toBe('coding')
  })

  test('pathForDomain is the inverse mapping used by the switcher', () => {
    expect(pathForDomain('slide')).toBe('/slide')
    expect(pathForDomain('coding')).toBe('/')
    expect(domainFromPathname(pathForDomain('slide'))).toBe('slide')
    expect(domainFromPathname(pathForDomain('coding'))).toBe('coding')
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

  test('workspace panel height: unset by default, round-trips, clamps, clears on 0', () => {
    expect(loadWorkspacePanelHeight()).toBe(0)
    saveWorkspacePanelHeight(330)
    expect(loadWorkspacePanelHeight()).toBe(330)
    expect(localStorage.getItem(WORKSPACE_PANEL_HEIGHT_KEY)).toBe('330')
    saveWorkspacePanelHeight(10_000)
    expect(loadWorkspacePanelHeight()).toBe(WORKSPACE_PANEL_HEIGHT.max)
    saveWorkspacePanelHeight(10)
    expect(loadWorkspacePanelHeight()).toBe(WORKSPACE_PANEL_HEIGHT.min)
    saveWorkspacePanelHeight(0)
    expect(loadWorkspacePanelHeight()).toBe(0)
    expect(localStorage.getItem(WORKSPACE_PANEL_HEIGHT_KEY)).toBeNull()
    localStorage.setItem(WORKSPACE_PANEL_HEIGHT_KEY, 'not-a-number')
    expect(loadWorkspacePanelHeight()).toBe(0)
  })

  test('terminal height defaults, round-trips, and clamps to its sane range', () => {
    expect(loadTerminalHeight()).toBe(TERMINAL_HEIGHT.default)
    saveTerminalHeight(300)
    expect(loadTerminalHeight()).toBe(300)
    expect(localStorage.getItem(TERMINAL_HEIGHT_KEY)).toBe('300')
    saveTerminalHeight(10_000)
    expect(loadTerminalHeight()).toBe(TERMINAL_HEIGHT.max)
    saveTerminalHeight(10)
    expect(loadTerminalHeight()).toBe(TERMINAL_HEIGHT.min)
    localStorage.setItem(TERMINAL_HEIGHT_KEY, 'not-a-number')
    expect(loadTerminalHeight()).toBe(TERMINAL_HEIGHT.default)
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

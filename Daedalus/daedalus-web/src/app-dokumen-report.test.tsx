import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { App } from './App'
import { useDaedalusStore } from './state/taskStore'

// Duplicate-panel guard (Farid's report): Dokumen has its own Panel
// Laporan, so the generic coding FinalReportView must NOT also render
// underneath it in the dokumen domain (it sat there empty: "No report
// yet"). Other domains keep the generic final report panel.

vi.mock('./api/useEventStream', () => ({ useEventStream: () => undefined }))

vi.mock('./components/editor/monaco-editor', () => ({
  MonacoEditor: () => <div data-testid="monaco-stub" />,
}))

vi.mock('./api/client', () => ({
  api: {
    settings: async () => ({
      session: { mode: 'auto', autoApprove: true, thinking: true, workspaceRoot: '/workspace' },
      providers: [],
    }),
    providers: async () => ({ providers: [], presets: [] }),
    models: async () => ({ models: [] }),
    roots: async () => ({ roots: [{ path: '/workspace', name: 'workspace' }], cwd: '/workspace' }),
    tree: async () => ({ path: '.', name: '.', isDirectory: true, children: [{ path: 'README.md', name: 'README.md', isDirectory: false }] }),
    list: async () => ({ items: [] }),
    pins: async () => ({ pins: [] }),
    extensionsStatus: async () => ({
      root: '/workspace',
      mcp: [],
      skills: [],
      lsp: [],
      problems: [],
    }),
    listConversations: async () => ({ conversations: [] }),
    getConversation: async () => ({ conversation: null }),
    listTasks: async () => ({ tasks: [] }),
    task: async () => ({ events: [], report: null, running: false }),
    terminals: async () => ({ terminals: [] }),
    files: async () => ({}),
    taskEvents: async () => ({}),
    taskAttachments: async () => ({ attachments: [] }),
    updateSession: async () => ({ session: { mode: 'auto', autoApprove: true, thinking: true, workspaceRoot: '/workspace' } }),
    dokumenDocument: async () => ({ root: '/workspace', document: null }),
    dokumenBlocks: async () => ({ source: null, blocks: [] }),
    dokumenSources: async () => ({ root: '/workspace', document: null }),
    dokumenSchema: async () => ({ root: '/workspace', document: null }),
    dokumenRelease: async () => ({ root: '/workspace', released: false }),
    dokumenField: async () => ({ root: '/workspace', document: null, record: null }),
    dokumenOutline: async () => ({ root: '/workspace', document: null }),
    dokumenSection: async () => ({ root: '/workspace', document: null }),
    dokumenExportData: async () => ({ root: '/workspace', exported: 0, held: 0 }),
    dokumenExportDocument: async () => ({ root: '/workspace', exported: 0, held: 0 }),
    dokumenStyleInspect: async () => ({ root: '/workspace', state: null, ops: [] }),
    dokumenReset: async () => ({ root: '/workspace', archived: null }),
  },
}))

describe('app shell report panels per domain', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.pushState(null, '', '/')
    useDaedalusStore.getState().reset()
  })

  afterEach(() => {
    cleanup()
    window.history.pushState(null, '', '/')
  })

  test('dokumen domain: Panel Laporan renders, the generic final report does not', () => {
    window.history.pushState(null, '', '/dokumen')
    useDaedalusStore.getState().reset()
    expect(useDaedalusStore.getState().domain).toBe('dokumen')

    render(<App />)
    expect(screen.getByTestId('dokumen-report-panel')).toBeTruthy()
    expect(screen.queryByTestId('final-report-panel')).toBeNull()
    expect(screen.queryByText('No report yet')).toBeNull()
  })

  test('coding domain: the generic final report panel renders as before', () => {
    window.history.pushState(null, '', '/')
    useDaedalusStore.getState().reset()
    expect(useDaedalusStore.getState().domain).toBe('coding')

    render(<App />)
    expect(screen.getByTestId('final-report-panel')).toBeTruthy()
    expect(screen.queryByTestId('dokumen-report-panel')).toBeNull()
  })
})

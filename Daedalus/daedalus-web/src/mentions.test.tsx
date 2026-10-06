import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useDaedalusStore } from './state/taskStore'
import { Composer } from './components/composer/composer'
import { api } from './api/client'

const FILES = [
  { path: 'daedalus-web', type: 'dir' as const },
  { path: 'daedalus-web/src', type: 'dir' as const },
  { path: 'daedalus-web/src/index.ts', type: 'file' as const },
  { path: 'src/index.ts', type: 'file' as const },
  { path: 'src/util.ts', type: 'file' as const },
  { path: 'README.md', type: 'file' as const },
]

vi.mock('./api/client', () => ({
  api: {
    cancelTask: vi.fn(async () => ({ cancelled: true, task_id: 'task-1' })),
    createTask: vi.fn(async () => ({ id: 'task-new' })),
    setMode: vi.fn(async () => ({ session: {} })),
    setAutoApprove: vi.fn(async () => ({ session: {} })),
    updateSession: vi.fn(async () => ({ session: {} })),
    models: vi.fn(async () => ({ models: [] })),
    providers: vi.fn(async () => ({ providers: [], presets: [] })),
    settings: vi.fn(async () => ({ session: {}, settings: {} })),
    extensionsStatus: vi.fn(async () => ({ root: '', mcp: [], skills: [], agents: [], lsp: [], problems: [] })),
    testProvider: vi.fn(async () => ({ message: 'ok' })),
    upload: vi.fn(async () => ({ files: [], attachments: [], destination: '' })),
    list: vi.fn(async () => ({ items: [] })),
    files: vi.fn(async () => ({ root: '/ws', files: FILES, truncated: false })),
    review: vi.fn(async () => ({ raw: '' })),
    updateSettings: vi.fn(async () => ({ session: {} })),
  },
}))

beforeEach(() => {
  localStorage.clear()
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/ws' })
  vi.mocked(api.createTask).mockClear()
  vi.mocked(api.files).mockClear()
})

afterEach(() => {
  cleanup()
})

function goal(): string {
  return useDaedalusStore.getState().composer.goal
}

async function renderComposer() {
  render(<Composer />)
  const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
  await waitFor(() => expect(vi.mocked(api.files)).toHaveBeenCalledWith('/ws'))
  return input
}

describe('Composer @-mentions', () => {
  test('typing @ opens the file menu and filters by substring', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: 'edit @dae' } })
    await waitFor(() => expect(screen.queryByTestId('mention-palette')).toBeTruthy())
    const items = screen.getAllByTestId('mention-suggestion')
    expect(items.map((item) => item.getAttribute('data-path'))).toEqual(['daedalus-web', 'daedalus-web/src', 'daedalus-web/src/index.ts'])
    expect(items[0]?.getAttribute('data-type')).toBe('dir')
  })

  test('arrow keys navigate and Enter inserts @path with the caret after it', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: 'edit @src' } })
    await waitFor(() => expect(screen.queryByTestId('mention-palette')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const items = screen.getAllByTestId('mention-suggestion')
    expect(items[1]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(goal()).toBe('edit @daedalus-web/src/index.ts ')
    expect(input.selectionStart).toBe('edit @daedalus-web/src/index.ts '.length)
    expect(screen.queryByTestId('mention-palette')).toBeNull()
  })

  test('mouse click inserts the mention', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '@RE' } })
    await waitFor(() => expect(screen.queryByTestId('mention-palette')).toBeTruthy())
    fireEvent.click(screen.getByTestId('mention-suggestion'))
    expect(goal()).toBe('@README.md ')
  })

  test('Escape closes the menu without touching the goal; Enter then sends the goal verbatim', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: 'edit @src' } })
    await waitFor(() => expect(screen.queryByTestId('mention-palette')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('mention-palette')).toBeNull()
    expect(goal()).toBe('edit @src')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(vi.mocked(api.createTask)).toHaveBeenCalled())
    expect(vi.mocked(api.createTask).mock.calls[0]?.[0].goal).toBe('edit @src')
  })
})

describe('Composer Enter to send', () => {
  test('Enter submits like the run button; Shift+Enter only adds a line', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: 'fix the bug' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(vi.mocked(api.createTask)).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(vi.mocked(api.createTask)).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.createTask).mock.calls[0]?.[0]).toMatchObject({ goal: 'fix the bug' })
  })

  test('an open slash palette takes precedence over Enter-to-send and @ completion', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/he' } })
    expect(screen.queryByTestId('slash-palette')).toBeTruthy()
    expect(screen.queryByTestId('mention-palette')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(goal()).toBe('/help ')
    expect(vi.mocked(api.createTask)).not.toHaveBeenCalled()
  })
})

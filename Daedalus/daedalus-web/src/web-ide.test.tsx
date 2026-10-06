import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { EditorPane } from './components/editor/editor-pane'
import { ExtensionsPanel } from './components/settings/extensions-panel'
import { FilesChangedPanel } from './components/report/report-panels'
import { useDaedalusStore } from './state/taskStore'

const saveFile = vi.fn()
const file = vi.fn()
const extensionsStatus = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    saveFile: (...args: unknown[]) => saveFile(...args),
    file: (...args: unknown[]) => file(...args),
    extensionsStatus: (...args: unknown[]) => extensionsStatus(...args),
  },
}))

vi.mock('./components/editor/monaco-editor', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="mock-monaco" aria-label="mock monaco" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}))

beforeEach(() => {
  saveFile.mockReset()
  saveFile.mockResolvedValue({ path: 'src/main.ts', absolute: '/workspace/src/main.ts', root: '/workspace' })
  file.mockReset()
  file.mockResolvedValue({ path: 'src/main.ts', content: 'changed on disk\n', size: 16 })
  extensionsStatus.mockReset()
  extensionsStatus.mockResolvedValue({
    root: '/workspace',
    mcp: [{ name: 'demo', connected: true, toolCount: 3 }],
    skills: [
      { name: 'greeter', description: 'Greets users warmly', origin: 'workspace' },
      { name: 'oracle', description: 'From the Claude skills dir', origin: 'claude' },
    ],
    lsp: [{ name: 'fake-lsp', extensions: ['.ts'], configured: true }],
    problems: [],
  })
  useDaedalusStore.getState().reset()
})

afterEach(() => cleanup())

describe('Web IDE editing', () => {
  test('edit → dirty → Save calls PUT API → clean, and Ctrl+S also saves', async () => {
    const onSaved = vi.fn()
    render(<EditorPane path="src/main.ts" content={'export const a = 1\n'} loading={false} error={null} size={18} root="/workspace" onSaved={onSaved} />)
    const editor = await screen.findByTestId('mock-monaco')
    fireEvent.change(editor, { target: { value: 'export const a = 2\n' } })
    expect(screen.getByTestId('editor-dirty')).toBeTruthy()

    await userEvent.click(screen.getByTestId('editor-save'))
    expect(saveFile).toHaveBeenCalledWith('/workspace', 'src/main.ts', 'export const a = 2\n')
    expect(await screen.findByText('saved')).toBeTruthy()
    expect(onSaved).toHaveBeenCalledWith('src/main.ts', 'export const a = 2\n')

    fireEvent.change(editor, { target: { value: 'export const a = 3\n' } })
    expect(screen.getByTestId('editor-dirty')).toBeTruthy()
    fireEvent.keyDown(screen.getByTestId('editor-pane'), { key: 's', ctrlKey: true })
    expect(saveFile).toHaveBeenCalledWith('/workspace', 'src/main.ts', 'export const a = 3\n')
    expect(await screen.findByText('saved')).toBeTruthy()
  })

  test('a failed save keeps the draft dirty and shows the error', async () => {
    saveFile.mockRejectedValue(new Error('disk full'))
    render(<EditorPane path="src/main.ts" content={'export const a = 1\n'} loading={false} error={null} size={18} root="/workspace" />)
    const editor = await screen.findByTestId('mock-monaco')
    fireEvent.change(editor, { target: { value: 'export const a = 2\n' } })
    await userEvent.click(screen.getByTestId('editor-save'))
    expect((await screen.findByRole('alert')).textContent).toContain('disk full')
    expect(screen.getByTestId('editor-dirty')).toBeTruthy()
    expect((editor as HTMLTextAreaElement).value).toBe('export const a = 2\n')
  })

  test('a disk change while dirty is announced without overwriting the draft', async () => {
    const view = render(<EditorPane path="src/main.ts" content={'export const a = 1\n'} loading={false} error={null} size={18} root="/workspace" />)
    const editor = await screen.findByTestId('mock-monaco')
    fireEvent.change(editor, { target: { value: 'my unsaved edit\n' } })
    view.rerender(<EditorPane path="src/main.ts" content={'agent rewrote this\n'} loading={false} error={null} size={19} root="/workspace" />)
    expect(await screen.findByTestId('editor-disk-changed')).toBeTruthy()
    expect((screen.getByTestId('mock-monaco') as HTMLTextAreaElement).value).toBe('my unsaved edit\n')
  })

  test('clicking a Files Changed entry opens that file in the editor state', async () => {
    const event = {
      seq: 1,
      task_id: 'task-1',
      ts: new Date().toISOString(),
      type: 'FILE_CHANGED',
      payload: { path: 'src/main.ts', operation: 'modified', added: 2, removed: 1 },
    } as Event
    useDaedalusStore.setState({ taskId: 'task-1', events: [event], workspace: { root: '/workspace', path: '', content: '', loading: false, error: null, size: 0 } })
    render(<FilesChangedPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'open changed file src/main.ts' }))
    expect(file).toHaveBeenCalledWith('/workspace', 'src/main.ts')
    expect(useDaedalusStore.getState().openFilePath).toBe('src/main.ts')
    expect(useDaedalusStore.getState().workspace.content).toBe('changed on disk\n')
  })
})

describe('ExtensionsPanel', () => {
  test('renders MCP, Skills, and LSP status for the shared workspace', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    render(<ExtensionsPanel />)
    expect(await screen.findByTestId('extension-mcp-entry')).toBeTruthy()
    expect(screen.getByTestId('extensions-panel').textContent).toContain('demo')
    expect(screen.getByTestId('extensions-panel').textContent).toContain('3 tools')
    expect(screen.getByTestId('extensions-panel').textContent).toContain('greeter')
    expect(screen.getByTestId('extensions-panel').textContent).toContain('(workspace)')
    expect(screen.getByTestId('extensions-panel').textContent).toContain('oracle')
    expect(screen.getByTestId('extensions-panel').textContent).toContain('(global · claude)')
    expect(screen.getByTestId('extensions-panel').textContent).toContain('fake-lsp')
    expect(extensionsStatus).toHaveBeenCalledWith('/workspace')
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalPane } from './components/terminal/terminal-pane'
import { useDaedalusStore } from './state/taskStore'
import { api } from './api/client'
import type { TerminalSession } from './api/types'

vi.mock('./api/client', () => ({
  api: {
    terminals: vi.fn(),
    createTerminal: vi.fn(),
    terminalInput: vi.fn(async () => ({ terminal: undefined })),
    terminalSignal: vi.fn(async () => ({ terminal: undefined })),
    deleteTerminal: vi.fn(async () => ({ killed: true, terminal: undefined })),
  },
}))

const agentSession: TerminalSession = {
  id: 'agent-1',
  kind: 'agent',
  title: 'agent',
  cwd: '/ws',
  status: 'running',
  exitCode: null,
  pid: null,
  createdAt: '2026-10-06T00:00:00.000Z',
}

const userSession: TerminalSession = {
  id: 'user-1',
  kind: 'user',
  title: 'shell 1',
  cwd: '/ws',
  status: 'running',
  exitCode: null,
  pid: 4242,
  createdAt: '2026-10-06T00:01:00.000Z',
}

function seed(sessions: TerminalSession[]): void {
  useDaedalusStore.getState().setWorkspace({ root: '/ws' })
  vi.mocked(api.terminals).mockResolvedValue({ terminals: sessions, root: '/ws' })
}

beforeEach(() => {
  localStorage.clear()
  useDaedalusStore.getState().reset()
  vi.clearAllMocks()
  vi.mocked(api.terminalInput).mockResolvedValue({ terminal: userSession })
  vi.mocked(api.terminalSignal).mockResolvedValue({ terminal: userSession })
  vi.mocked(api.deleteTerminal).mockResolvedValue({ killed: true, terminal: { ...userSession, status: 'exited' } })
})

afterEach(() => {
  cleanup()
})

async function renderPane(): Promise<void> {
  render(<TerminalPane />)
  await waitFor(() => expect(screen.getAllByTestId('terminal-tab').length).toBeGreaterThan(0))
}

const tabs = (): HTMLElement[] => screen.getAllByTestId('terminal-tab')
const tabByKind = (kind: string): HTMLElement => tabs().find((tab) => tab.dataset.kind === kind)!

describe('TerminalPane tabs', () => {
  test('tabs render from the session list; the agent tab is read-only', async () => {
    seed([agentSession, userSession])
    await renderPane()

    expect(tabs().map((tab) => tab.dataset.kind)).toEqual(['agent', 'user'])
    expect(tabByKind('agent').textContent).toContain('agent')
    // The agent tab is the default and has no input line.
    expect(tabByKind('agent').getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('terminal-input')).toBeNull()

    fireEvent.click(tabByKind('agent'))
    expect(screen.queryByTestId('terminal-input')).toBeNull()
  })

  test('Enter on the user tab posts the line; buffered output renders', async () => {
    seed([agentSession, userSession])
    await renderPane()

    fireEvent.click(tabByKind('user'))
    const input = screen.getByTestId('terminal-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'npm run dev' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(vi.mocked(api.terminalInput)).toHaveBeenCalledWith('user-1', 'npm run dev\n'))
    expect(input.value).toBe('')

    useDaedalusStore.getState().applyTerminalMessage({ kind: 'terminal_output', session_id: 'user-1', data: 'ready on :5173\n' })
    await waitFor(() => expect(screen.getByTestId('terminal-user-output').textContent).toContain('ready on :5173'))
  })

  test('arrow keys walk this session’s input history', async () => {
    seed([agentSession, userSession])
    await renderPane()

    fireEvent.click(tabByKind('user'))
    const input = screen.getByTestId('terminal-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'echo one' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'echo two' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('echo two')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input.value).toBe('echo one')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.value).toBe('echo two')
  })

  test('the + button creates a user session and activates it', async () => {
    seed([agentSession])
    const created: TerminalSession = { ...userSession, id: 'user-9', title: 'shell 1' }
    vi.mocked(api.createTerminal).mockResolvedValue({ terminal: created })
    await renderPane()

    fireEvent.click(screen.getByTestId('terminal-new'))
    await waitFor(() => expect(vi.mocked(api.createTerminal)).toHaveBeenCalledWith({ root: '/ws' }))
    await waitFor(() => expect(tabByKind('user').getAttribute('aria-selected')).toBe('true'))
  })

  test('closing a user tab calls DELETE and removes the tab', async () => {
    seed([agentSession, userSession])
    await renderPane()

    fireEvent.click(screen.getByTestId('terminal-close'))
    await waitFor(() => expect(vi.mocked(api.deleteTerminal)).toHaveBeenCalledWith('user-1'))
    await waitFor(() => expect(tabs()).toHaveLength(1))
    expect(tabs()[0]?.dataset.kind).toBe('agent')
  })

  test('an exited user session shows its exit code and a restart affordance', async () => {
    const exited: TerminalSession = { ...userSession, status: 'exited', exitCode: 3 }
    seed([agentSession, exited])
    const fresh: TerminalSession = { ...userSession, id: 'user-2', title: 'shell 2' }
    vi.mocked(api.createTerminal).mockResolvedValue({ terminal: fresh })
    await renderPane()

    expect(tabByKind('user').textContent).toContain('exit 3')
    fireEvent.click(tabByKind('user'))
    expect(screen.getByTestId('terminal-exited').textContent).toContain('exited with code 3')
    expect(screen.queryByTestId('terminal-input')).toBeNull()

    fireEvent.click(screen.getByTestId('terminal-restart'))
    await waitFor(() => expect(vi.mocked(api.deleteTerminal)).toHaveBeenCalledWith('user-1'))
    await waitFor(() => expect(vi.mocked(api.createTerminal)).toHaveBeenCalledWith({ root: '/ws' }))
  })
})

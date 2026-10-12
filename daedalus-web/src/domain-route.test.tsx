import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useDaedalusStore } from './state/taskStore'
import { DomainSwitch } from './components/layout/domain-switch'
import { TopBar } from './components/layout/top-bar'
import { Composer } from './components/composer/composer'

const listTasks = vi.fn()
const createTask = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    listTasks: (...args: unknown[]) => listTasks(...args),
    task: vi.fn(async () => ({ events: [], report: null, running: false })),
    taskAttachments: vi.fn(async () => ({ attachments: [] })),
    getConversation: vi.fn(async () => ({ conversation: null })),
    cancelTask: vi.fn(async () => ({ cancelled: true, cancel_requested: true, task_id: 'task-1' })),
    createTask: (...args: unknown[]) => createTask(...args),
    setMode: vi.fn(async () => ({ session: {} })),
    setAutoApprove: vi.fn(async () => ({ session: {} })),
    updateSession: vi.fn(async () => ({ session: {} })),
    models: vi.fn(async () => ({ models: [] })),
    providers: vi.fn(async () => ({ providers: [], presets: [] })),
    settings: vi.fn(async () => ({ session: {}, settings: {} })),
    extensionsStatus: vi.fn(async () => ({ root: '', mcp: [], skills: [], agents: [], lsp: [], problems: [] })),
    testProvider: vi.fn(async () => ({ message: 'ok' })),
    upload: vi.fn(async () => ({ files: [], attachments: [], destination: '' })),
    files: vi.fn(async () => ({ files: [] })),
    list: vi.fn(async () => ({ items: [] })),
    review: vi.fn(async () => ({ raw: '' })),
    updateSettings: vi.fn(async () => ({ session: {} })),
  },
}))

beforeEach(() => {
  localStorage.clear()
  window.history.pushState(null, '', '/')
  useDaedalusStore.getState().reset()
  listTasks.mockReset()
  listTasks.mockResolvedValue({ tasks: [] })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-new' })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('domain from route', () => {
  test('the store seeds its domain from the route — the pathname wins over localStorage', () => {
    localStorage.setItem('daedalus.web.domain.v1', 'coding')
    window.history.pushState(null, '', '/slide')
    useDaedalusStore.getState().reset()
    expect(useDaedalusStore.getState().domain).toBe('slide')
  })

  test('DomainSwitch click sets the store domain AND pushes the matching URL', () => {
    render(<DomainSwitch />)
    fireEvent.click(screen.getByTestId('domain-slide'))
    expect(useDaedalusStore.getState().domain).toBe('slide')
    expect(window.location.pathname).toBe('/slide')

    fireEvent.click(screen.getByTestId('domain-coding'))
    expect(useDaedalusStore.getState().domain).toBe('coding')
    expect(window.location.pathname).toBe('/')
  })
})

describe('Composer placeholder follows the domain', () => {
  test('slide domain shows the deck placeholder', () => {
    useDaedalusStore.setState({ domain: 'slide' })
    render(<Composer />)
    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe('Describe the deck to build… type /help for slash commands')
  })

  test('coding domain keeps the original placeholder', () => {
    useDaedalusStore.setState({ domain: 'coding' })
    render(<Composer />)
    expect(screen.getByTestId('composer-input').getAttribute('placeholder')).toBe(
      'Describe the coding task… type @ to reference a file or folder, /help for slash commands',
    )
  })
})

describe('Composer submit carries the store domain to the server', () => {
  test('slide domain: api.createTask is called with domain slide', async () => {
    useDaedalusStore.setState({ domain: 'slide' })
    render(<Composer />)
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: 'buatkan deck tentang bahaya AI untuk anak' } })
    fireEvent.click(screen.getByTestId('composer-submit'))
    await waitFor(() => expect(createTask).toHaveBeenCalled())
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ domain: 'slide' }))
  })

  test('coding domain: api.createTask is called with domain coding', async () => {
    useDaedalusStore.setState({ domain: 'coding' })
    render(<Composer />)
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: 'tulis fungsi halo dunia' } })
    fireEvent.click(screen.getByTestId('composer-submit'))
    await waitFor(() => expect(createTask).toHaveBeenCalled())
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ domain: 'coding' }))
  })
})

describe('TopBar task history dropdown (portaled out of the header)', () => {
  const seededTasks = [
    { id: 'task-aaaa-1111', status: 'done', goal: 'build the vite scaffold', event_count: 3, running: false },
    { id: 'task-bbbb-2222', status: 'failed', goal: 'fix the laravel migration', event_count: 7, running: false },
  ]

  test('the panel renders into document.body (not the header), items close it, Escape closes it', async () => {
    listTasks.mockResolvedValue({ tasks: seededTasks })
    const rendered = render(<TopBar />)

    fireEvent.click(await screen.findByTestId('topbar-history-button'))
    const panel = await screen.findByTestId('task-history')

    // Portal: the panel hangs off document.body, outside the header tree
    // and outside the render container — that is what lifts it above the
    // composer's stacking context.
    expect(document.body.contains(panel)).toBe(true)
    expect(panel.closest('header')).toBeNull()
    expect(rendered.container.contains(panel)).toBe(false)

    // Items stay fully clickable; choosing one closes the panel.
    const rows = screen.getAllByTestId('history-task')
    expect(rows).toHaveLength(2)
    fireEvent.click(rows[0]!)
    expect(screen.queryByTestId('task-history')).toBeNull()

    // Reopen and close with Escape dispatched at the document.
    fireEvent.click(screen.getByTestId('topbar-history-button'))
    expect(await screen.findByTestId('task-history')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('task-history')).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { ChatPanel } from './components/agent/chat-panel'
import { api } from './api/client'
import { CHAT_HEIGHT_KEY, loadChatHeight } from './state/prefs'

vi.mock('./api/client', () => ({
  api: {
    cancelTask: vi.fn(async () => ({ cancelled: true, cancel_requested: true, task_id: 'task-1' })),
  },
}))

// The chat panel is a pure view over the recorded event log, so — like the
// other panel suites — it is driven through seeded events, not a socket.
let seq = 0

function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

function seed(events: Event[], taskId: string | null = 'task-1'): void {
  useDaedalusStore.setState({ taskId, events })
}

/** Vitest ships these; @testing-library/jest-dom is not a dependency here. */
function textOf(node: Element | null): string {
  return node?.textContent ?? ''
}

const started = () =>
  ev('TASK_STARTED', {
    spec: { id: 'task-1', goal: 'add a health endpoint', repo_path: '/workspace', constraints: [], done_criteria: [] },
  })

beforeEach(() => {
  seq = 0
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('ChatPanel', () => {
  test('empty state invites running a task when nothing is selected', () => {
    seed([], null)
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-panel')).toBeTruthy()
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('Run a task to see the conversation here.')
  })

  test('empty state also shows for a selected task without events', () => {
    seed([], 'task-1')
    render(<ChatPanel />)
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('No conversation yet')
  })

  test("renders the user's prompt as a 'you' entry", () => {
    seed([started()])
    render(<ChatPanel />)
    const entries = screen.getAllByTestId('chat-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.getAttribute('data-role')).toBe('user')
    expect(textOf(entries[0] ?? null)).toContain('add a health endpoint')
  })

  test('renders provider thoughts distinctly and hides them when thinking is off', () => {
    seed([started(), ev('THOUGHT', { text: 'inspect the repository first', source: 'provider_reasoning' })])
    useDaedalusStore.getState().setComposer({ thinking: true })
    render(<ChatPanel />)
    const thought = screen.getAllByTestId('chat-entry').find((entry) => entry.getAttribute('data-role') === 'thought')
    expect(thought).toBeTruthy()
    expect(textOf(thought ?? null)).toContain('inspect the repository first')

    cleanup()
    seed([started(), ev('THOUGHT', { text: 'inspect the repository first', source: 'provider_reasoning' })])
    useDaedalusStore.getState().setComposer({ thinking: false })
    render(<ChatPanel />)
    expect(screen.getAllByTestId('chat-entry').some((entry) => entry.getAttribute('data-role') === 'thought')).toBe(false)
  })

  test("renders the assistant's reply text", () => {
    seed([started(), ev('MODEL_REQUEST_FINISHED', { message: { content: 'Done — the endpoint is in place.' } })])
    render(<ChatPanel />)
    const reply = screen.getAllByTestId('chat-entry').find((entry) => entry.getAttribute('data-role') === 'assistant')
    expect(reply).toBeTruthy()
    expect(textOf(reply ?? null)).toContain('Done — the endpoint is in place.')
  })

  test('pairs a tool call with its recorded result and output', () => {
    const call = { id: 'call-1', task_id: 'task-1', tool: 'read_file', args: { path: 'README.md' } }
    seed([
      started(),
      ev('TOOL_CALL_STARTED', { call }),
      ev('TOOL_CALL_FINISHED', { call, result: { call_id: 'call-1', status: 'ok', output: '# Daedalus readme', truncated: false, meta: {} } }),
    ])
    render(<ChatPanel />)
    const tool = screen.getAllByTestId('chat-entry').find((entry) => entry.getAttribute('data-role') === 'tool')
    expect(tool?.getAttribute('data-tool')).toBe('read_file')
    expect(textOf(tool ?? null)).toContain('ok')
    expect(textOf(tool ?? null)).toContain('# Daedalus readme')
    expect(textOf(tool ?? null)).toContain('README.md')
  })

  test('an unfinished tool call shows as running while the task runs', () => {
    const call = { id: 'call-1', task_id: 'task-1', tool: 'write_file', args: { path: 'src/health.ts' } }
    seed([started(), ev('TOOL_CALL_STARTED', { call })])
    render(<ChatPanel />)
    const tool = screen.getAllByTestId('chat-entry').find((entry) => entry.getAttribute('data-role') === 'tool')
    expect(textOf(tool ?? null)).toContain('awaiting result…')
    expect(screen.getByTestId('chat-working')).toBeTruthy()
    expect(textOf(screen.getByTestId('chat-status'))).toContain('running')
  })

  test('shows the pending-approval state and clears it once decided', () => {
    const key = { taskId: 'task-1', tool: 'write_file', action: 'create', path: 'src/health.ts' }
    seed([started(), ev('APPROVAL_REQUESTED', { key, policy: 'ask' })])
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-approval-pending')).toBeTruthy()
    expect(textOf(screen.getByTestId('chat-approval-pending'))).toContain('write_file')
    expect(textOf(screen.getByTestId('chat-status'))).toContain('awaiting-approval')
    const approval = screen.getAllByTestId('chat-entry').find((entry) => entry.getAttribute('data-role') === 'approval')
    expect(textOf(approval ?? null)).toContain('approval requested')

    cleanup()
    seed([started(), ev('APPROVAL_REQUESTED', { key, policy: 'ask' }), ev('APPROVAL_DECIDED', { key, decision: 'grant' })])
    render(<ChatPanel />)
    expect(screen.queryByTestId('chat-approval-pending')).toBeNull()
    const entries = screen.getAllByTestId('chat-entry')
    expect(textOf(entries.at(-1) ?? null)).toContain('approval grant')
  })

  test('renders completion and failure status lines', () => {
    seed([started(), ev('TASK_COMPLETED', { outcome: 'success', reason: 'all checks passed' })])
    render(<ChatPanel />)
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('task success')
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('all checks passed')
    expect(textOf(screen.getByTestId('chat-status'))).toContain('done')

    cleanup()
    seed([started(), ev('MODEL_REQUEST_FAILED', { error: 'provider unreachable' })])
    render(<ChatPanel />)
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('model request failed')
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('provider unreachable')
  })

  test('keeps conversation order across a full exchange', () => {
    const call = { id: 'call-1', task_id: 'task-1', tool: 'list_dir', args: { path: '.' } }
    seed([
      started(),
      ev('THOUGHT', { text: 'look around first', source: 'provider_reasoning' }),
      ev('TOOL_CALL_STARTED', { call }),
      ev('TOOL_CALL_FINISHED', { call, result: { call_id: 'call-1', status: 'ok', output: 'src/', truncated: false, meta: {} } }),
      ev('MODEL_REQUEST_FINISHED', { message: { content: 'Here is what I found.' } }),
      ev('TASK_COMPLETED', { outcome: 'success', reason: 'done' }),
    ])
    render(<ChatPanel />)
    const roles = screen.getAllByTestId('chat-entry').map((entry) => entry.getAttribute('data-role'))
    expect(roles).toEqual(['user', 'thought', 'tool', 'assistant', 'status'])
  })
})

describe('ChatPanel stop + resize', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api.cancelTask).mockClear()
  })

  test('shows a prominent Stop while running and calls the cancel API', async () => {
    seed([started()])
    render(<ChatPanel />)
    const stop = screen.getByTestId('chat-stop')
    fireEvent.click(stop)
    await waitFor(() => expect(vi.mocked(api.cancelTask)).toHaveBeenCalledWith('task-1'))
  })

  test('hides Stop when idle and reports a stopped task as stopped, not failed', () => {
    seed([started(), ev('TASK_COMPLETED', { outcome: 'failed', reason: 'aborted' })])
    render(<ChatPanel />)
    expect(screen.queryByTestId('chat-stop')).toBeNull()
    expect(textOf(screen.getByTestId('chat-status'))).toContain('stopped')
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('task stopped')
  })

  test('resize handle changes the height by keyboard and persists it', () => {
    seed([started()])
    render(<ChatPanel />)
    const scroll = screen.getByTestId('chat-scroll')
    const before = Number((scroll.getAttribute('style') ?? '').match(/height:\s*(\d+)px/)?.[1] ?? '0')
    expect(before).toBe(loadChatHeight())

    const handle = screen.getByTestId('chat-resize-handle')
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    const after = Number((scroll.getAttribute('style') ?? '').match(/height:\s*(\d+)px/)?.[1] ?? '0')
    expect(after).toBe(before + 16)
    expect(localStorage.getItem(CHAT_HEIGHT_KEY)).toBe(String(after))
    expect(handle.getAttribute('aria-valuenow')).toBe(String(after))
  })

  test('a persisted height is restored on the next mount', () => {
    localStorage.setItem(CHAT_HEIGHT_KEY, '512')
    seed([started()])
    render(<ChatPanel />)
    expect(screen.getByTestId('chat-scroll').getAttribute('style')).toContain('height: 512px')
  })

  test('offers jump-to-latest when the reader scrolls up during a run', () => {
    seed([started()])
    render(<ChatPanel />)
    const scroll = screen.getByTestId('chat-scroll')
    Object.defineProperty(scroll, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(scroll, 'clientHeight', { value: 320, configurable: true })
    scroll.scrollTop = 0
    fireEvent.scroll(scroll)
    const jump = screen.getByTestId('chat-jump-latest')
    fireEvent.click(jump)
    expect(scroll.scrollTop).toBe(1000)
    expect(screen.queryByTestId('chat-jump-latest')).toBeNull()
  })
})

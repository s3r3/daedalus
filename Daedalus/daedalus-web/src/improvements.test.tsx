import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { activity, latestContextPercent } from './state/selectors'
import { useDaedalusStore } from './state/taskStore'
import { TopBar } from './components/layout/top-bar'

const listTasks = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    approve: vi.fn(),
    createTask: vi.fn(),
    listTasks: (...args: unknown[]) => listTasks(...args),
    task: vi.fn(async () => ({ events: [], report: null, running: false })),
    extensionsStatus: vi.fn(async () => ({ mcp: [], lsp: [], skills: [] })),
    updateSession: vi.fn(async () => ({})),
  },
}))

let seq = 0
function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

describe('selectors: loop warnings and context meter', () => {
  test('LOOP_WARNING becomes a recovery activity entry', () => {
    const entries = activity([
      ev('LOOP_WARNING', { tool: 'read_file', repeats: 3, suppressed: false }),
      ev('LOOP_WARNING', { tool: 'read_file', repeats: 4, suppressed: true }),
    ])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'recovery', status: 'warning', title: 'loop warning' })
    expect(entries[0]?.detail).toContain('read_file repeated 3×')
    expect(entries[1]?.title).toContain('repeat suppressed')
  })

  test('MODEL_REQUEST_STARTED detail carries the ctx reading when present', () => {
    const withMeter = activity([ev('MODEL_REQUEST_STARTED', { provider: 'fake', messages: 4, context_percent: 64 })])
    expect(withMeter[0]?.detail).toBe('fake · 4 messages · ctx 64%')
    const without = activity([ev('MODEL_REQUEST_STARTED', { provider: 'fake', messages: 2 })])
    expect(without[0]?.detail).toBe('fake · 2 messages')
  })

  test('latestContextPercent reads the newest meter value', () => {
    expect(latestContextPercent([])).toBeUndefined()
    expect(latestContextPercent([ev('TASK_STARTED', { spec: {} })])).toBeUndefined()
    const events = [
      ev('MODEL_REQUEST_STARTED', { provider: 'fake', messages: 2, context_percent: 12 }),
      ev('MODEL_REQUEST_FINISHED', { message: { content: '' }, context_percent: 30 }),
      ev('TOOL_CALL_STARTED', { call: { tool: 'read_file' } }),
    ]
    expect(latestContextPercent(events)).toBe(30)
  })
})

describe('TopBar additions', () => {
  test('the task picker prefers the helper title and the ctx chip shows usage', async () => {
    listTasks.mockResolvedValue({
      tasks: [{ id: 'task-abcdef-1234', status: 'done', goal: 'fix the login crash on startup please', title: 'Fix Login Crash' }],
    })
    useDaedalusStore.setState({
      taskId: 'task-abcdef-1234',
      events: [
        ev('MODEL_REQUEST_STARTED', { provider: 'fake', messages: 4, context_estimate_tokens: 640, context_limit_tokens: 1000, context_percent: 64 }, 'task-abcdef-1234'),
      ],
    })
    render(<TopBar />)

    const picker = await screen.findByLabelText('select task')
    expect(picker.textContent).toContain('Fix Login Crash')
    expect(picker.textContent).not.toContain('fix the login crash')

    const chip = screen.getByTestId('topbar-context-meter')
    expect(chip.textContent).toContain('ctx 64%')
  })

  test('no ctx chip renders when no event carries a meter reading', () => {
    listTasks.mockResolvedValue({ tasks: [] })
    useDaedalusStore.setState({ taskId: 'task-1', events: [ev('TASK_STARTED', { spec: { goal: 'x' } })] })
    render(<TopBar />)
    expect(screen.queryByTestId('topbar-context-meter')).toBeNull()
  })
})

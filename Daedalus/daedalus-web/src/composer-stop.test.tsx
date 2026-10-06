import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { Composer } from './components/composer/composer'
import { api } from './api/client'

vi.mock('./api/client', () => ({
  api: {
    cancelTask: vi.fn(async () => ({ cancelled: true, cancel_requested: true, task_id: 'task-1' })),
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
    review: vi.fn(async () => ({ raw: '' })),
    updateSettings: vi.fn(async () => ({ session: {} })),
  },
}))

let seq = 0
function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

beforeEach(() => {
  seq = 0
  localStorage.clear()
  useDaedalusStore.getState().reset()
  vi.mocked(api.cancelTask).mockClear()
})

afterEach(() => {
  cleanup()
})

describe('Composer stop morph', () => {
  test('Run morphs into Stop while the selected task runs; Stop calls the cancel API', async () => {
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [ev('TASK_STARTED', { spec: { id: 'task-1', goal: 'do the thing', repo_path: '/workspace', constraints: [], done_criteria: [] } })],
    })
    render(<Composer />)
    expect(screen.queryByTestId('composer-submit')).toBeNull()
    fireEvent.click(screen.getByTestId('composer-stop'))
    await waitFor(() => expect(vi.mocked(api.cancelTask)).toHaveBeenCalledWith('task-1'))
  })

  test('Run is back once the task has finished', () => {
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [
        ev('TASK_STARTED', { spec: { id: 'task-1', goal: 'do the thing', repo_path: '/workspace', constraints: [], done_criteria: [] } }),
        ev('TASK_COMPLETED', { outcome: 'success', reason: 'done' }),
      ],
    })
    render(<Composer />)
    expect(screen.queryByTestId('composer-stop')).toBeNull()
    expect(screen.getByTestId('composer-submit')).toBeTruthy()
  })
})

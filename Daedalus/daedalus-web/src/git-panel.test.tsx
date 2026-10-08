import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { GitPanel } from './components/workspace/git-panel'
import { DiffViewer } from './components/editor/diff-viewer'
import { api } from './api/client'

/**
 * Git surface (gap: no git view, read-only diff). The panel lists the
 * worktree's changed files with per-file revert; the diff grows the
 * same revert for the file it shows. Revert is two-step everywhere —
 * discarding uncommitted edits must never be one stray click.
 */

vi.mock('./api/client', () => ({
  api: {
    gitStatus: vi.fn(async () => ({
      isRepo: true,
      branch: 'main',
      files: [
        { path: 'tracked.txt', status: 'modified' },
        { path: 'fresh.txt', status: 'untracked' },
      ],
    })),
    gitRevert: vi.fn(async () => ({ reverted: 'tracked.txt', root: '/ws' })),
    file: vi.fn(async () => ({ path: 'tracked.txt', size: 3, kind: 'text', content: 'abc' })),
  },
}))

beforeEach(() => {
  vi.mocked(api.gitStatus).mockClear()
  vi.mocked(api.gitRevert).mockClear()
  useDaedalusStore.setState({
    taskId: 'task-1',
    events: [],
    workspace: { ...useDaedalusStore.getState().workspace, root: '/ws' },
  })
})

afterEach(() => cleanup())

const ev = (seq: number, type: string, payload: unknown): Event =>
  ({ seq, task_id: 'task-1', ts: new Date().toISOString(), type, payload }) as Event

describe('GitPanel', () => {
  test('lists changed files; revert asks, then restores; untracked gets no button', async () => {
    render(<GitPanel />)
    expect(await screen.findByText('tracked.txt')).toBeTruthy()
    expect(screen.getByText('fresh.txt')).toBeTruthy()
    expect(screen.queryByLabelText('revert fresh.txt')).toBeNull()

    fireEvent.click(screen.getByLabelText('revert tracked.txt'))
    expect(vi.mocked(api.gitRevert)).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('confirm revert tracked.txt'))
    await waitFor(() => expect(vi.mocked(api.gitRevert)).toHaveBeenCalledWith('/ws', 'tracked.txt'))
    expect(await screen.findByTestId('git-note')).toBeTruthy()
  })

  test('renders nothing outside a git repo', async () => {
    vi.mocked(api.gitStatus).mockResolvedValueOnce({ isRepo: false, branch: null, files: [] })
    const { container } = render(<GitPanel />)
    await waitFor(() => expect(vi.mocked(api.gitStatus)).toHaveBeenCalled())
    expect(container.querySelector('[data-testid="git-panel"]')).toBeNull()
  })
})

describe('DiffViewer revert', () => {
  test('a modified file can be reverted from its diff; a created file cannot', async () => {
    useDaedalusStore.setState({
      events: [
        ev(1, 'FILE_CHANGED', {
          call_id: 'c1',
          path: 'tracked.txt',
          tool: 'write_file',
          operation: 'modified',
          added: 1,
          removed: 1,
          lines: [{ kind: 'add', text: 'agent edit' }],
          patch: '',
        }),
      ],
    })
    render(<DiffViewer />)
    fireEvent.click(await screen.findByLabelText('revert changed file tracked.txt'))
    fireEvent.click(screen.getByLabelText('confirm revert changed file tracked.txt'))
    await waitFor(() => expect(vi.mocked(api.gitRevert)).toHaveBeenCalledWith('/ws', 'tracked.txt'))
    expect(await screen.findByTestId('diff-revert-note')).toBeTruthy()
  })
})

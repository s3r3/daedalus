import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { DiffViewer } from './components/editor/diff-viewer'
import { api } from './api/client'

/**
 * Changes surface (merged DiffViewer + GitPanel): the task's live diffs
 * carry the branch badge and per-file git status badges, and worktree
 * files the task never recorded still get open + revert — revert stays
 * two-step everywhere, untracked files get no revert button, and the
 * git parts stay hidden outside a repo.
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
    checkpoints: vi.fn(async () => ({
      checkpoints: [
        { path: 'src/index.ts', created: false },
        { path: 'new-file.txt', created: true },
      ],
      count: 2,
    })),
    restoreTask: vi.fn(async () => ({ restored: ['src/index.ts'], deleted: ['new-file.txt'] })),
  },
}))

beforeEach(() => {
  vi.mocked(api.gitStatus).mockClear()
  vi.mocked(api.gitRevert).mockClear()
  vi.mocked(api.checkpoints).mockClear()
  vi.mocked(api.restoreTask).mockClear()
  useDaedalusStore.setState({
    taskId: 'task-1',
    domain: 'coding',
    events: [],
    workspace: { ...useDaedalusStore.getState().workspace, root: '/ws' },
  })
})

afterEach(() => cleanup())

const ev = (seq: number, type: string, payload: unknown): Event =>
  ({ seq, task_id: 'task-1', ts: new Date().toISOString(), type, payload }) as Event

describe('Changes surface', () => {
  test('shows the branch badge and git status badges for worktree files', async () => {
    render(<DiffViewer />)
    expect(await screen.findByTestId('changes-panel')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(await screen.findByText('tracked.txt')).toBeTruthy()
    expect(screen.getByText('fresh.txt')).toBeTruthy()
    const rows = screen.getAllByTestId('git-file')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('data-status')).toBe('modified')
  })

  test('revert asks first, then restores; untracked gets no revert button', async () => {
    render(<DiffViewer />)
    expect(await screen.findByText('tracked.txt')).toBeTruthy()
    expect(screen.queryByLabelText('revert fresh.txt')).toBeNull()

    fireEvent.click(screen.getByLabelText('revert tracked.txt'))
    expect(vi.mocked(api.gitRevert)).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('confirm revert tracked.txt'))
    await waitFor(() => expect(vi.mocked(api.gitRevert)).toHaveBeenCalledWith('/ws', 'tracked.txt'))
    expect(await screen.findByTestId('diff-revert-note')).toBeTruthy()
  })

  test('git parts stay hidden outside a repo; the diff list keeps its own empty state', async () => {
    vi.mocked(api.gitStatus).mockResolvedValueOnce({ isRepo: false, branch: null, files: [] })
    vi.mocked(api.checkpoints).mockResolvedValueOnce({ checkpoints: [], count: 0 })
    render(<DiffViewer />)
    await waitFor(() => expect(vi.mocked(api.gitStatus)).toHaveBeenCalled())
    expect(screen.queryByText('main')).toBeNull()
    expect(screen.queryByTestId('git-file')).toBeNull()
    // …but the task diff surface itself still renders its empty state.
    expect(screen.getByText('No file changes yet')).toBeTruthy()
  })

  test('a task-recorded diff keeps its badge, diff body, and revert', async () => {
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
    const file = await screen.findByTestId('diff-file')
    expect(file.textContent).toContain('tracked.txt')
    expect(file.textContent).toContain('modified')
    expect(screen.getByTestId('diff-body')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('revert changed file tracked.txt'))
    fireEvent.click(screen.getByLabelText('confirm revert changed file tracked.txt'))
    await waitFor(() => expect(vi.mocked(api.gitRevert)).toHaveBeenCalledWith('/ws', 'tracked.txt'))
    expect(await screen.findByTestId('diff-revert-note')).toBeTruthy()
  })

  test('a created file cannot be reverted from its diff', async () => {
    useDaedalusStore.setState({
      events: [
        ev(1, 'FILE_CHANGED', {
          call_id: 'c1',
          path: 'new.txt',
          tool: 'write_file',
          operation: 'created',
          added: 1,
          removed: 0,
          lines: [{ kind: 'add', text: 'brand new' }],
          patch: '',
        }),
      ],
    })
    render(<DiffViewer />)
    expect(await screen.findByTestId('diff-file')).toBeTruthy()
    expect(screen.queryByLabelText('revert changed file new.txt')).toBeNull()
  })
})

describe('Changes surface in the Slide domain', () => {
  test('hides the branch badge, git status badges, the git-only section, and all revert buttons — task diffs and checkpoints stay', async () => {
    useDaedalusStore.setState({
      domain: 'slide',
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
    expect(await screen.findByTestId('changes-panel')).toBeTruthy()
    // Task diffs stay: the file chip and diff body render.
    const file = await screen.findByTestId('diff-file')
    expect(file.textContent).toContain('tracked.txt')
    expect(screen.getByTestId('diff-body')).toBeTruthy()
    // The git parts are gone: no branch badge, no per-file status badges,
    // no git-only section, no revert buttons anywhere.
    await waitFor(() => expect(vi.mocked(api.gitStatus)).toHaveBeenCalled())
    expect(screen.queryByText('main')).toBeNull()
    expect(file.textContent).not.toContain('modified')
    expect(screen.queryByTestId('changes-git-only')).toBeNull()
    expect(screen.queryByLabelText(/revert/i)).toBeNull()
    // Checkpoints/restore survive the scoping.
    expect(await screen.findByTestId('changes-checkpoints')).toBeTruthy()
  })

  test('the empty state shows when only git-only files exist in slide', async () => {
    useDaedalusStore.setState({ domain: 'slide', events: [] })
    vi.mocked(api.checkpoints).mockResolvedValueOnce({ checkpoints: [], count: 0 })
    render(<DiffViewer />)
    await waitFor(() => expect(vi.mocked(api.gitStatus)).toHaveBeenCalled())
    expect(screen.queryByTestId('changes-git-only')).toBeNull()
    expect(screen.getByText('No file changes yet')).toBeTruthy()
  })
})

describe('Changes checkpoints', () => {
  test('lists backed-up files; restore asks first, then rewinds and bumps the revision', async () => {
    const revision = useDaedalusStore.getState().workspaceRevision
    render(<DiffViewer />)
    expect(await screen.findByTestId('changes-checkpoints')).toBeTruthy()
    expect(screen.getAllByTestId('checkpoint-file')).toHaveLength(2)

    fireEvent.click(screen.getByLabelText('restore task checkpoints'))
    expect(vi.mocked(api.restoreTask)).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('confirm restore task checkpoints'))
    await waitFor(() => expect(vi.mocked(api.restoreTask)).toHaveBeenCalledWith('task-1', '/ws'))
    expect(await screen.findByTestId('changes-restore-note')).toBeTruthy()
    expect(useDaedalusStore.getState().workspaceRevision).toBeGreaterThan(revision)
  })

  test('the section stays hidden when the task recorded no checkpoints', async () => {
    vi.mocked(api.checkpoints).mockResolvedValueOnce({ checkpoints: [], count: 0 })
    render(<DiffViewer />)
    await waitFor(() => expect(vi.mocked(api.checkpoints)).toHaveBeenCalled())
    expect(screen.queryByTestId('changes-checkpoints')).toBeNull()
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { PlanChipsBar } from './components/agent/plan-chips-bar'
import { loadDismissedPlans, saveDismissedPlans } from './state/prefs'

// Persistent plan chips above the composer: the server lists plans from
// .daedalus/plans (GET /workspace/plans); the bar shows one chip per plan,
// a single active chip gates Execute, and dismissal is a remembered view
// choice (files on disk are never deleted). The api module is mocked per
// the plan-interactive.test.tsx style.
const plansApi = vi.fn()
const createTask = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    plans: (...args: unknown[]) => plansApi(...args),
    createTask: (...args: unknown[]) => createTask(...args),
  },
}))

let seq = 0

function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

function started(): Event {
  return ev('TASK_STARTED', {
    spec: { id: 'task-1', goal: 'buat website sekolah', repo_path: '/workspace', constraints: [], done_criteria: [] },
  })
}

function planEvents(): Event[] {
  seq = 0
  return [
    started(),
    ev('PLAN_CREATED', {
      plan: { steps: [{ id: '1', text: 'Write plan' }] },
      mode: 'plan',
      documents: ['.daedalus/plans/website-sekolah/plan.md'],
    }),
    ev('TASK_COMPLETED', { outcome: 'success', report: { success: true } }),
  ]
}

function twoPlans() {
  return [
    {
      slug: 'website-sekolah',
      title: 'Rencana Website Sekolah',
      documents: ['.daedalus/plans/website-sekolah/plan.md', '.daedalus/plans/website-sekolah/PRD.md'],
      updatedAt: '2026-10-07T00:00:00.000Z',
    },
    {
      slug: 'blog-pribadi',
      title: 'Blog Pribadi',
      documents: ['.daedalus/plans/blog-pribadi/plan.md'],
      updatedAt: '2026-10-06T00:00:00.000Z',
    },
  ]
}

function seed(events: Event[] = []): void {
  useDaedalusStore.setState({ taskId: null, events, workspace: { root: '/workspace' } as never })
}

beforeEach(() => {
  saveDismissedPlans('/workspace', [])
  plansApi.mockReset()
  plansApi.mockResolvedValue({ root: '/workspace', plans: twoPlans() })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-exec', goal: 'Execute the approved plan', repo_path: '/workspace', created_at: new Date().toISOString() })
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
  saveDismissedPlans('/workspace', [])
})

describe('PlanChipsBar', () => {
  test('renders nothing when the workspace has no plans yet', async () => {
    plansApi.mockResolvedValue({ root: '/workspace', plans: [] })
    seed()
    render(<PlanChipsBar />)
    await waitFor(() => expect(plansApi).toHaveBeenCalledWith('/workspace'))
    expect(screen.queryByTestId('plan-chips-bar')).toBeNull()
    expect(screen.queryByTestId('plan-chip')).toBeNull()
  })

  test('renders one chip per plan, with the plan title', async () => {
    seed()
    render(<PlanChipsBar />)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(2))
    const chips = screen.getAllByTestId('plan-chip')
    expect(chips[0]?.dataset.slug).toBe('website-sekolah')
    expect(chips[0]?.textContent).toBe('Rencana Website Sekolah')
    expect(chips[1]?.dataset.slug).toBe('blog-pribadi')
  })

  test('clicking toggles the active plan; only one plan is active at a time', async () => {
    seed()
    render(<PlanChipsBar />)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(2))
    const [sekolah, blog] = screen.getAllByTestId('plan-chip') as [HTMLElement, HTMLElement]

    await userEvent.click(sekolah)
    expect(sekolah.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('plan-chip-execute').textContent).toContain('Execute plan')

    await userEvent.click(blog)
    expect(blog.getAttribute('aria-pressed')).toBe('true')
    expect(sekolah.getAttribute('aria-pressed')).toBe('false')

    await userEvent.click(blog)
    expect(blog.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('plan-chip-execute')).toBeNull()
  })

  test('the trash icon dismisses a chip and the dismissal persists across a remount', async () => {
    seed()
    render(<PlanChipsBar />)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(2))
    const dismiss = screen.getAllByTestId('plan-chip-dismiss')[0]!
    await userEvent.click(dismiss)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(1))
    expect(screen.getByTestId('plan-chip').dataset.slug).toBe('blog-pribadi')
    expect(loadDismissedPlans('/workspace')).toEqual(['website-sekolah'])

    // The file stays on disk — only the view is remembered — so remounting
    // (a reload, in effect) keeps the chip gone rather than resurrecting it.
    cleanup()
    render(<PlanChipsBar />)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(1))
    expect(screen.getByTestId('plan-chip').dataset.slug).toBe('blog-pribadi')
  })

  test('Execute on the active chip creates the follow-up Auto task with plan_task_id, like Approve & Execute', async () => {
    seed(planEvents())
    useDaedalusStore.setState({ taskId: 'task-1' })
    render(<PlanChipsBar />)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(2))
    await userEvent.click(screen.getAllByTestId('plan-chip')[0]!)
    await userEvent.click(screen.getByTestId('plan-chip-execute'))
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const input = createTask.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.plan_task_id).toBe('task-1')
    expect(input.mode).toBe('auto')
    expect(input.repo_path).toBe('/workspace')
    expect(input.goal).toBe('Execute the approved plan in .daedalus/plans/website-sekolah/plan.md')
    expect(useDaedalusStore.getState().taskId).toBe('task-exec')
    expect(useDaedalusStore.getState().composer.mode).toBe('auto')
  })

  test('Execute on a plan from an earlier session launches from its document path alone', async () => {
    seed()
    render(<PlanChipsBar />)
    await waitFor(() => expect(screen.getAllByTestId('plan-chip')).toHaveLength(2))
    await userEvent.click(screen.getAllByTestId('plan-chip')[1]!)
    await userEvent.click(screen.getByTestId('plan-chip-execute'))
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const input = createTask.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.goal).toBe('Execute the approved plan in .daedalus/plans/blog-pribadi/plan.md')
    expect(input.mode).toBe('auto')
    expect('plan_task_id' in input).toBe(false)
  })
})

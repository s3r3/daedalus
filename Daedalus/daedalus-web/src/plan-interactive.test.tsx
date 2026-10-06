import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { QuestionCard } from './components/approval/question-card'
import { ExecutePlanBar } from './components/agent/execute-plan-bar'
import { ChatPanel } from './components/agent/chat-panel'
import { pendingQuestions, planDocuments } from './state/selectors'

// Interactive Plan mode: the question card and Approve & Execute bar are
// functions of the event log, same as every other panel — seed events,
// render, assert. The api module is mocked per the panels.test.tsx style.
const answerQuestion = vi.fn()
const createTask = vi.fn()
const cancelTask = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    answerQuestion: (...args: unknown[]) => answerQuestion(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    cancelTask: (...args: unknown[]) => cancelTask(...args),
  },
}))

let seq = 0

function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

function questionInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    taskId: 'task-1',
    question: 'Website ini mau dipakai untuk apa?',
    options: [
      { label: 'Website e-commerce', description: 'Jual produk online' },
      { label: 'Website e-learning' },
    ],
    allowFreeText: true,
    mode: 'plan',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function started(): Event {
  return ev('TASK_STARTED', {
    spec: { id: 'task-1', goal: 'buat website sekolah', repo_path: '/workspace', constraints: [], done_criteria: [] },
  })
}

function questionEvents(overrides: Record<string, unknown> = {}): Event[] {
  seq = 0
  return [started(), ev('QUESTION_REQUESTED', { question: questionInfo(overrides) })]
}

function seed(events: Event[]): void {
  useDaedalusStore.setState({ taskId: 'task-1', events, workspace: { root: '/workspace' } as never })
}

beforeEach(() => {
  seq = 0
  answerQuestion.mockReset()
  answerQuestion.mockResolvedValue({ success: true, question_id: 'q-1' })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-exec', goal: 'Execute the approved plan', repo_path: '/workspace', created_at: new Date().toISOString() })
  cancelTask.mockReset()
  cancelTask.mockResolvedValue({ cancelled: true })
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('QuestionCard', () => {
  test('renders the question, its options with descriptions, and the free-text affordance last', () => {
    seed(questionEvents())
    render(<QuestionCard />)
    expect(screen.getByTestId('question-text').textContent).toContain('Website ini mau dipakai untuk apa?')
    expect(screen.getByTestId('question-option-0').textContent).toContain('Website e-commerce')
    expect(screen.getByTestId('question-option-0').textContent).toContain('Jual produk online')
    expect(screen.getByTestId('question-option-1').textContent).toContain('Website e-learning')
    expect(screen.getByTestId('question-free-toggle').textContent).toContain('Type your own')
  })

  test('clicking an option answers it through the api', async () => {
    seed(questionEvents())
    render(<QuestionCard />)
    await userEvent.click(screen.getByTestId('question-option-1'))
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith('task-1', 'q-1', 'Website e-learning'))
  })

  test('number keys answer options directly', async () => {
    seed(questionEvents())
    render(<QuestionCard />)
    fireEvent.keyDown(screen.getByTestId('question-card'), { key: '1' })
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith('task-1', 'q-1', 'Website e-commerce'))
  })

  test('free text is sent verbatim', async () => {
    seed(questionEvents())
    render(<QuestionCard />)
    await userEvent.click(screen.getByTestId('question-free-toggle'))
    await userEvent.type(screen.getByTestId('question-free-input'), 'Portfolio pribadi')
    await userEvent.click(screen.getByTestId('question-free-submit'))
    await waitFor(() => expect(answerQuestion).toHaveBeenCalledWith('task-1', 'q-1', 'Portfolio pribadi'))
  })

  test('allow_free_text=false hides the free-text affordance and says so', () => {
    seed(questionEvents({ allowFreeText: false }))
    render(<QuestionCard />)
    expect(screen.queryByTestId('question-free-toggle')).toBeNull()
    expect(screen.getByTestId('question-card').textContent).toContain('free-text answers are off')
  })

  test('once answered, the card is gone', () => {
    const events = [
      ...questionEvents(),
      ev('QUESTION_ANSWERED', { question_id: 'q-1', question: 'Website ini mau dipakai untuk apa?', outcome: 'answered', answer: 'Website e-learning', option_index: 1 }),
    ]
    seed(events)
    render(<QuestionCard />)
    expect(screen.queryByTestId('question-card')).toBeNull()
  })
})

describe('plan question selectors', () => {
  test('pendingQuestions pairs requests with their answers', () => {
    const events = [
      ...questionEvents(),
      ev('QUESTION_REQUESTED', { question: questionInfo({ id: 'q-2', question: 'Stack apa?' }) }),
      ev('QUESTION_ANSWERED', { question_id: 'q-1', question: 'Website ini mau dipakai untuk apa?', outcome: 'answered', answer: 'Website e-learning' }),
    ]
    const pending = pendingQuestions(events)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.question.id).toBe('q-2')
  })

  test('planDocuments reads the closing PLAN_CREATED documents', () => {
    const events = [
      started(),
      ev('PLAN_CREATED', { plan: { steps: [] } }),
      ev('PLAN_CREATED', { plan: { steps: [] }, mode: 'plan', documents: ['.daedalus/plans/website-sekolah/plan.md', '.daedalus/plans/website-sekolah/PRD.md'] }),
    ]
    expect(planDocuments(events)).toEqual(['.daedalus/plans/website-sekolah/plan.md', '.daedalus/plans/website-sekolah/PRD.md'])
    expect(planDocuments([started()])).toEqual([])
  })
})

describe('ChatPanel question transcript', () => {
  test('shows the asked question and the answered receipt', () => {
    const events = [
      ...questionEvents(),
      ev('QUESTION_ANSWERED', { question_id: 'q-1', question: 'Website ini mau dipakai untuk apa?', outcome: 'answered', answer: 'Website e-learning', option_index: 1 }),
    ]
    seed(events)
    render(<ChatPanel />)
    const text = document.body.textContent ?? ''
    expect(text).toContain('the agent asked — Website ini mau dipakai untuk apa?')
    expect(text).toContain('you answered — Website e-learning')
    // The pending card is not shown any more.
    expect(screen.queryByTestId('question-card')).toBeNull()
  })

  test('a timed-out question reads as "proceed with assumptions", not an error', () => {
    const events = [
      ...questionEvents(),
      ev('QUESTION_ANSWERED', { question_id: 'q-1', question: 'Website ini mau dipakai untuk apa?', outcome: 'timeout', timed_out: true }),
    ]
    seed(events)
    render(<ChatPanel />)
    expect(document.body.textContent ?? '').toContain('no answer — the agent continues with stated assumptions')
  })
})

describe('ExecutePlanBar', () => {
  function finishedPlanEvents(): Event[] {
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

  test('renders for a finished plan task with documents', () => {
    seed(finishedPlanEvents())
    render(<ExecutePlanBar />)
    expect(screen.getByTestId('execute-plan-bar').textContent).toContain('.daedalus/plans/website-sekolah/plan.md')
    expect(screen.getByTestId('execute-plan-auto')).toBeTruthy()
    expect(screen.getByTestId('execute-plan-orchestrator')).toBeTruthy()
  })

  test('stays hidden while the task is still running', () => {
    const events = finishedPlanEvents().slice(0, 2)
    seed(events)
    render(<ExecutePlanBar />)
    expect(screen.queryByTestId('execute-plan-bar')).toBeNull()
  })

  test('stays hidden when the finished task wrote no plan documents', () => {
    seq = 0
    seed([started(), ev('PLAN_CREATED', { plan: { steps: [] }, mode: 'plan' }), ev('TASK_COMPLETED', { outcome: 'success', report: { success: true } })])
    render(<ExecutePlanBar />)
    expect(screen.queryByTestId('execute-plan-bar')).toBeNull()
  })

  test('Execute with Auto creates the follow-up task carrying plan_task_id and switches the composer', async () => {
    seed(finishedPlanEvents())
    render(<ExecutePlanBar />)
    await userEvent.click(screen.getByTestId('execute-plan-auto'))
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const input = createTask.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.plan_task_id).toBe('task-1')
    expect(input.mode).toBe('auto')
    expect(String(input.goal)).toContain('.daedalus/plans/website-sekolah/plan.md')
    const state = useDaedalusStore.getState()
    expect(state.taskId).toBe('task-exec')
    expect(state.composer.mode).toBe('auto')
  })

  test('Execute with Orchestrator creates the follow-up in orchestrator mode', async () => {
    seed(finishedPlanEvents())
    render(<ExecutePlanBar />)
    await userEvent.click(screen.getByTestId('execute-plan-orchestrator'))
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    const input = createTask.mock.calls[0]?.[0] as Record<string, unknown>
    expect(input.plan_task_id).toBe('task-1')
    expect(input.mode).toBe('orchestrator')
    expect(useDaedalusStore.getState().composer.mode).toBe('orchestrator')
  })
})

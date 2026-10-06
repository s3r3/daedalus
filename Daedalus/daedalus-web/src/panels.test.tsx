import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { Composer } from './components/composer/composer'
import { ApprovalCard } from './components/approval/approval-card'
import { PlanPanel } from './components/agent/plan-panel'
import { ActivityTimeline } from './components/agent/activity-timeline'
import { ValidationPanel } from './components/validation/validation-panel'
import { ErrorPanel, RecoveryPanel } from './components/recovery/recovery-panel'
import { TopBar } from './components/layout/top-bar'
import { FilesChangedPanel, FinalReportView, ValidationSummary } from './components/report/report-panels'

// Every panel reads its facts from the event log, so the whole suite drives
// components through seeded events rather than through the socket.
const approve = vi.fn()
const decideApproval = vi.fn()
const createTask = vi.fn()
const listTasks = vi.fn()
const task = vi.fn()
const extensionsStatus = vi.fn()
const updateSession = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    approve: (...args: unknown[]) => approve(...args),
    decideApproval: (...args: unknown[]) => decideApproval(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    listTasks: (...args: unknown[]) => listTasks(...args),
    task: (...args: unknown[]) => task(...args),
    extensionsStatus: (...args: unknown[]) => extensionsStatus(...args),
    updateSession: (...args: unknown[]) => updateSession(...args),
  },
}))

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

beforeEach(() => {
  seq = 0
  approve.mockReset()
  approve.mockResolvedValue({ success: true, decision: 'grant', remember: false })
  decideApproval.mockReset()
  decideApproval.mockResolvedValue({ success: true, decision: 'grant', approval_id: 'approval-1' })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-new', goal: 'do the thing' })
  listTasks.mockReset()
  listTasks.mockResolvedValue({ tasks: [] })
  task.mockReset()
  task.mockResolvedValue({ events: [], report: null, running: false })
  extensionsStatus.mockReset()
  extensionsStatus.mockResolvedValue({
    root: '/workspace',
    mcp: [{ name: 'demo', connected: true, toolCount: 3 }],
    skills: [
      { name: 'greeter', description: 'Greets users warmly', origin: 'workspace' },
      { name: 'oracle', description: 'Answers from the Claude dir', origin: 'claude' },
    ],
    lsp: [{ name: 'fake-lsp', extensions: ['.ts'], configured: true }],
    problems: [],
  })
  updateSession.mockReset()
  updateSession.mockImplementation(async (input: Record<string, unknown>) => ({
    session: { mode: 'auto', autoApprove: false, thinking: true, workspaceRoot: '/workspace', ...input },
  }))
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('Composer', () => {
  test('an empty goal shows the required-field alert', async () => {
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(textOf(screen.getByRole('alert'))).toContain('a task description is required')
    expect(createTask).not.toHaveBeenCalled()
  })

  test('a populated goal creates a task with the composer options', async () => {
    useDaedalusStore.getState().setComposer({ goal: 'add a health endpoint', autoApprove: true, maxIterations: 7 })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(createTask).toHaveBeenCalledWith({
      goal: 'add a health endpoint',
      repo_path: '',
      auto_approve: true,
      max_iterations: 7,
      mode: 'auto',
      thinking: true,
      provider_id: undefined,
      model: undefined,
      attachments: [],
    })
  })

  test('a failed create surfaces the error instead of the task', async () => {
    createTask.mockRejectedValue(new Error('workspace not found'))
    useDaedalusStore.getState().setComposer({ goal: 'anything' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(textOf(await screen.findByRole('alert'))).toContain('workspace not found')
  })

  test('/mcp, /skills, and /lsp print real extension status from the gateway', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    useDaedalusStore.getState().setComposer({ goal: '/mcp' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(extensionsStatus).toHaveBeenCalledWith('/workspace')
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('demo: connected · 3 tools')

    cleanup()
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    useDaedalusStore.getState().setComposer({ goal: '/skills' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('greeter — Greets users warmly')

    cleanup()
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    useDaedalusStore.getState().setComposer({ goal: '/lsp' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('fake-lsp: configured · .ts')
  })

  test('Enter sends the task while Shift+Enter stays a newline', async () => {
    useDaedalusStore.getState().setComposer({ goal: 'add a health endpoint' })
    render(<Composer />)
    await userEvent.type(screen.getByTestId('composer-input'), '{Enter}')
    expect(createTask).toHaveBeenCalled()

    cleanup()
    createTask.mockClear()
    useDaedalusStore.getState().setComposer({ goal: 'line one' })
    render(<Composer />)
    await userEvent.type(screen.getByTestId('composer-input'), '{Shift>}{Enter}{/Shift}')
    expect(createTask).not.toHaveBeenCalled()
  })

  test('text submitted while an approval is pending declines it with that note instead of starting a task', async () => {
    seed([
      ev('APPROVAL_REQUESTED', {
        key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
        policy: 'ask',
        approval: {
          id: 'approval-9',
          key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
          policy: 'ask',
          tool: 'run_command',
          preview: { kind: 'command', command: 'rm -rf build' },
          requestedBy: { taskId: 'task-1' },
          createdAt: new Date().toISOString(),
        },
      }),
    ])
    useDaedalusStore.getState().setComposer({ goal: 'dont run that, clean the cache instead' })
    render(<Composer />)
    // While approval is pending the Run button is a Stop button; the text is
    // submitted with Enter, which is exactly the path a user takes.
    await userEvent.type(screen.getByTestId('composer-input'), '{Enter}')
    expect(decideApproval).toHaveBeenCalledWith('task-1', 'approval-9', 'decline', { note: 'dont run that, clean the cache instead' })
    expect(createTask).not.toHaveBeenCalled()
  })

  test('the model combobox filters by typing and Enter selects the match', async () => {
    useDaedalusStore.getState().setModels([
      { providerId: 'kr', model: 'claude-sonnet', supportsVision: true },
      { providerId: 'gemini', model: 'gemini-flash', supportsVision: false },
      { providerId: 'kr', model: 'gpt-5', supportsVision: false },
    ])
    render(<Composer />)
    await userEvent.click(screen.getByTestId('model-picker-button'))
    expect(screen.getAllByTestId('model-option').map((option) => option.getAttribute('data-value'))).toEqual([
      '',
      'gemini/gemini-flash',
      'kr/claude-sonnet',
      'kr/gpt-5',
    ])
    await userEvent.type(screen.getByTestId('model-picker-filter'), 'sonnet')
    expect(screen.getAllByTestId('model-option').map((option) => option.getAttribute('data-value'))).toEqual(['', 'kr/claude-sonnet'])
    await userEvent.type(screen.getByTestId('model-picker-filter'), '{Enter}')
    expect(useDaedalusStore.getState().composer).toMatchObject({ providerId: 'kr', model: 'claude-sonnet' })
  })

  test('picking the default entry clears provider and model', async () => {
    useDaedalusStore.getState().setModels([{ providerId: 'kr', model: 'claude-sonnet', supportsVision: true }])
    useDaedalusStore.getState().setComposer({ providerId: 'kr', model: 'claude-sonnet' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('model-picker-button'))
    await userEvent.click(screen.getAllByTestId('model-option')[0] as HTMLElement)
    expect(useDaedalusStore.getState().composer.providerId).toBe('')
    expect(useDaedalusStore.getState().composer.model).toBe('')
  })

  test('hundreds of models render capped with a keep-typing hint', async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({ providerId: 'r', model: `m-${index}`, supportsVision: false }))
    useDaedalusStore.getState().setModels(many)
    render(<Composer />)
    await userEvent.click(screen.getByTestId('model-picker-button'))
    expect(screen.getAllByTestId('model-option').length).toBe(101)
    expect(textOf(screen.getByTestId('model-picker-more'))).toContain('+150 more')
  })

  test('a follow-up after a plan carries plan_task_id so the steps execute in context', async () => {
    seed([
      ev('TASK_STARTED', { spec: { goal: 'rencanakan landing page' } }),
      ev('PLAN_CREATED', {
        plan: { steps: [{ intent: 'buat folder ayid', status: 'pending' }, { intent: 'tulis index.html', status: 'pending' }] },
        mode: 'plan',
      }),
    ])
    useDaedalusStore.getState().setComposer({ goal: 'jalankan rencananya', mode: 'auto' })
    render(<Composer />)
    await userEvent.type(screen.getByTestId('composer-input'), '{Enter}')
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ goal: 'jalankan rencananya', plan_task_id: 'task-1' }))
  })

  test('thinking toggle persists through the session and /settings thinking works', async () => {
    render(<Composer />)
    await userEvent.click(screen.getByTestId('thinking-toggle'))
    expect(updateSession).toHaveBeenCalledWith({ thinking: false })
    expect(useDaedalusStore.getState().composer.thinking).toBe(false)
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('Thinking off')

    cleanup()
    useDaedalusStore.getState().setComposer({ goal: '/settings thinking on' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(updateSession).toHaveBeenCalledWith({ thinking: true })
    expect(useDaedalusStore.getState().composer.thinking).toBe(true)
  })
})

describe('ApprovalCard', () => {
  const approvalEvent = () =>
    ev('APPROVAL_REQUESTED', {
      key: { taskId: 'task-1', tool: 'write_file', action: 'create', path: 'src/health.ts' },
      policy: 'ask',
    })

  test('renders nothing until an approval is actually pending', () => {
    seed([ev('TASK_STARTED', { spec: { goal: 'x' } })])
    const { container } = render(<ApprovalCard />)
    expect(container.innerHTML).toBe('')
  })

  test('renders tool, action, and path from the request', () => {
    seed([approvalEvent()])
    render(<ApprovalCard />)
    const card = screen.getByTestId('approval-card')
    expect(textOf(card)).toContain('write_file')
    expect(textOf(card)).toContain('src/health.ts')
  })

  test('allow grants without remember', async () => {
    seed([approvalEvent()])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-allow'))
    expect(approve).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'write_file' }), 'grant', false)
  })

  test('deny rejects the request', async () => {
    seed([approvalEvent()])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-deny'))
    await userEvent.click(screen.getByTestId('approval-decline-confirm'))
    expect(approve).toHaveBeenCalledWith('task-1', expect.objectContaining({ tool: 'write_file' }), 'deny', false)
  })

  test('a remembered decision carries the exact pattern label the card showed', async () => {
    seed([
      ev('APPROVAL_REQUESTED', {
        key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
        policy: 'ask',
        approval: {
          id: 'approval-cmd',
          key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
          policy: 'ask',
          tool: 'run_command',
          preview: { kind: 'command', command: 'npm test' },
          rememberPattern: { kind: 'command-prefix', tool: 'run_command', token: 'npm', label: 'run_command starting with "npm"' },
          mode: 'manual',
          requestedBy: { taskId: 'task-1' },
          createdAt: new Date().toISOString(),
        },
      }),
    ])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-remember'))
    expect(decideApproval).toHaveBeenCalledWith('task-1', 'approval-cmd', 'allow_remember', {})
  })

  test('a decided approval unblocks the card', () => {
    const key = { taskId: 'task-1', tool: 'write_file', action: 'create', path: 'src/health.ts' }
    seed([ev('APPROVAL_REQUESTED', { key, policy: 'ask' }), ev('APPROVAL_DECIDED', { key, decision: 'grant' })])
    const { container } = render(<ApprovalCard />)
    expect(container.innerHTML).toBe('')
  })

  test('an expired request is reported rather than silently dropped', async () => {
    approve.mockResolvedValue({ success: false, reason: 'expired' })
    seed([approvalEvent()])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-allow'))
    expect(textOf(await screen.findByText(/expired/i))).not.toBe('')
  })

  const commandApproval = () =>
    ev('APPROVAL_REQUESTED', {
      key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
      policy: 'ask',
      approval: {
        id: 'approval-cmd',
        key: { taskId: 'task-1', tool: 'run_command', action: 'execute' },
        policy: 'ask',
        tool: 'run_command',
        preview: { kind: 'command', command: 'npm test -- --watchPathIgnorePatterns=very/long/path/that/must/not/be/cut' },
        rememberPattern: { kind: 'command-prefix', tool: 'run_command', token: 'npm', label: 'run_command starting with "npm"' },
        mode: 'manual',
        requestedBy: { taskId: 'task-1' },
        createdAt: new Date().toISOString(),
      },
    })

  test('the command preview is verbatim and the remember label shows the exact pattern', () => {
    seed([commandApproval()])
    render(<ApprovalCard />)
    expect(textOf(screen.getByTestId('approval-preview'))).toContain('$ npm test -- --watchPathIgnorePatterns=very/long/path/that/must/not/be/cut')
    expect(textOf(screen.getByTestId('approval-remember'))).toContain('run_command starting with "npm"')
    expect(textOf(screen.getByTestId('approval-card'))).toContain('manual mode')
  })

  test('allow once decides by approval id', async () => {
    seed([commandApproval()])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-allow'))
    expect(decideApproval).toHaveBeenCalledWith('task-1', 'approval-cmd', 'allow', {})
  })

  test('Enter on the card allows, Escape opens the decline note', async () => {
    seed([commandApproval()])
    render(<ApprovalCard />)
    await userEvent.type(screen.getByTestId('approval-card'), '{Escape}')
    expect(screen.getByTestId('approval-note')).toBeTruthy()
    cleanup()
    seed([commandApproval()])
    render(<ApprovalCard />)
    await userEvent.type(screen.getByTestId('approval-card'), '{Enter}')
    expect(decideApproval).toHaveBeenCalledWith('task-1', 'approval-cmd', 'allow', {})
  })

  test('edit & allow runs the edited command, not the original', async () => {
    seed([commandApproval()])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-edit'))
    const input = screen.getByTestId('approval-edit-input') as HTMLInputElement
    expect(input.value).toContain('npm test')
    await userEvent.clear(input)
    await userEvent.type(input, 'npm run lint')
    await userEvent.click(screen.getByTestId('approval-edit-confirm'))
    expect(decideApproval).toHaveBeenCalledWith('task-1', 'approval-cmd', 'allow', { editedArgs: { command: 'npm', args: ['run', 'lint'] } })
  })

  test('decline delivers the typed note to the agent', async () => {
    seed([commandApproval()])
    render(<ApprovalCard />)
    await userEvent.click(screen.getByTestId('approval-deny'))
    await userEvent.type(screen.getByTestId('approval-note'), 'use the server package only')
    await userEvent.click(screen.getByTestId('approval-decline-confirm'))
    expect(decideApproval).toHaveBeenCalledWith('task-1', 'approval-cmd', 'decline', { note: 'use the server package only' })
  })

  test('a child task request names the child and its parent', () => {
    seed([
      ev('APPROVAL_REQUESTED', {
        key: { taskId: 'child-9', tool: 'write_file', action: 'create', path: 'src/kid.ts' },
        policy: 'ask',
        approval: {
          id: 'approval-kid',
          key: { taskId: 'child-9', tool: 'write_file', action: 'create', path: 'src/kid.ts' },
          policy: 'ask',
          tool: 'write_file',
          preview: { kind: 'write', path: 'src/kid.ts', content: 'export const kid = true\n' },
          requestedBy: { taskId: 'child-9', parentTaskId: 'task-1' },
          createdAt: new Date().toISOString(),
        },
      }),
    ])
    render(<ApprovalCard />)
    expect(textOf(screen.getByTestId('approval-requester'))).toContain('requested by child task child-9 (child of task-1)')
    expect(textOf(screen.getByTestId('approval-preview'))).toContain('export const kid = true')
  })

  test('queued requests show a count badge', () => {
    seed([commandApproval(), commandApproval()])
    render(<ApprovalCard />)
    expect(textOf(screen.getByTestId('approval-card'))).toContain('+1 queued')
  })
})

describe('PlanPanel', () => {
  test('empty state before the plan arrives', () => {
    seed([ev('TASK_STARTED', { spec: { goal: 'x' } })])
    render(<PlanPanel />)
    expect(textOf(screen.getByTestId('plan-panel'))).toContain('No plan yet')
  })

  test('renders each step intent with its live status', () => {
    seed([
      ev('PLAN_CREATED', {
        plan: {
          id: 'p1',
          task_id: 'task-1',
          version: 1,
          status: 'active',
          steps: [
            { id: 's1', intent: 'inspect the repository', status: 'done', evidence: ['read README'] },
            { id: 's2', intent: 'write the endpoint', status: 'active', evidence: [] },
            { id: 's3', intent: 'add a test', status: 'pending', evidence: [] },
          ],
        },
      }),
    ])
    render(<PlanPanel />)
    const steps = screen.getAllByTestId('plan-step')
    expect(steps).toHaveLength(3)
    expect(steps[0]?.getAttribute('data-status')).toBe('done')
    expect(steps[1]?.getAttribute('data-status')).toBe('active')
    expect(textOf(screen.getByTestId('plan-panel'))).toContain('read README')
  })

  test('the active step is surfaced as the current step', () => {
    seed([
      ev('PLAN_CREATED', {
        plan: {
          id: 'p1',
          task_id: 'task-1',
          version: 1,
          status: 'active',
          steps: [{ id: 's2', intent: 'write the endpoint', status: 'active', evidence: [] }],
        },
      }),
    ])
    render(<PlanPanel />)
    expect(textOf(screen.getByTestId('current-step'))).toContain('write the endpoint')
  })
})

describe('ActivityTimeline', () => {
  test('empty log renders without crashing', () => {
    seed([])
    render(<ActivityTimeline />)
    expect(screen.getByTestId('activity-panel')).toBeTruthy()
  })

  test('pairs a tool call with its result', () => {
    const call = { id: 'call-1', task_id: 'task-1', tool: 'read_file', args: { path: 'README.md' } }
    seed([
      ev('TOOL_CALL_STARTED', { call }),
      ev('TOOL_CALL_FINISHED', { call, result: { call_id: 'call-1', status: 'ok', output: 'hello there', truncated: false, meta: {} } }),
    ])
    render(<ActivityTimeline />)
    const panel = screen.getByTestId('activity-panel')
    expect(textOf(panel)).toContain('read_file')
    expect(textOf(panel)).toContain('hello there')
    expect(screen.getAllByTestId('tool-call')).toHaveLength(1)
  })

  test('THOUGHT events render distinctly when thinking is on and are filtered when off', () => {
    seed([ev('THOUGHT', { text: 'inspect the workspace first', source: 'provider_reasoning' })])
    useDaedalusStore.getState().setComposer({ thinking: true })
    render(<ActivityTimeline />)
    expect(textOf(screen.getByTestId('activity-panel'))).toContain('thinking')
    expect(textOf(screen.getByTestId('activity-panel'))).toContain('inspect the workspace first')

    cleanup()
    seed([ev('THOUGHT', { text: 'inspect the workspace first', source: 'provider_reasoning' })])
    useDaedalusStore.getState().setComposer({ thinking: false })
    render(<ActivityTimeline />)
    expect(textOf(screen.getByTestId('activity-panel'))).not.toContain('inspect the workspace first')
  })
})

describe('ValidationPanel', () => {
  const checks = [
    { name: 'build', cmd: 'npm run build', status: 'pass', exit_code: 0, summary: 'ok', diagnostics: [] },
    {
      name: 'test',
      cmd: 'npm test',
      status: 'fail',
      exit_code: 1,
      summary: '2 failing',
      diagnostics: [{ file: 'src/health.test.ts', line: 42, message: 'expected 200 to equal 404' }],
    },
  ]

  test('empty state before any check runs', () => {
    seed([ev('TASK_STARTED', { spec: { goal: 'x' } })])
    render(<ValidationPanel />)
    expect(textOf(screen.getByTestId('validation-panel'))).toContain('No validation run yet')
  })

  test('running state while checks are in flight', () => {
    seed([ev('VALIDATION_STARTED', {})])
    render(<ValidationPanel />)
    expect(screen.getByTestId('validation-running')).toBeTruthy()
  })

  test('a pass verdict shows every check and its exit code', () => {
    seed([ev('VALIDATION_STARTED', {}), ev('VALIDATION_PASSED', { result: { checks: [checks[0]] } })])
    render(<ValidationPanel />)
    expect(textOf(screen.getByTestId('validation-verdict'))).toContain('passed')
    expect(screen.getAllByTestId('validation-check')).toHaveLength(1)
    expect(textOf(screen.getByTestId('validation-panel'))).toContain('exit 0')
  })

  test('a failure renders the verdict plus file:line diagnostics', () => {
    seed([ev('VALIDATION_STARTED', {}), ev('VALIDATION_FAILED', { result: { checks } })])
    render(<ValidationPanel />)
    expect(textOf(screen.getByTestId('validation-verdict'))).toContain('failed')
    const diagnostic = screen.getByTestId('diagnostic')
    expect(textOf(diagnostic)).toContain('src/health.test.ts:42')
    expect(textOf(diagnostic)).toContain('expected 200 to equal 404')
  })
})

describe('RecoveryPanel', () => {
  test('empty state when nothing failed', () => {
    seed([ev('TASK_STARTED', { spec: { goal: 'x' } })])
    render(<RecoveryPanel />)
    expect(textOf(screen.getByTestId('recovery-panel'))).toContain('No recovery needed')
  })

  test('counts retries and replans and names the strategy', () => {
    seed([
      ev('RECOVERY_STARTED', { reason: 'test failed', strategy: 'retry', attempt: 1 }),
      ev('RECOVERY_STARTED', { reason: 'test failed again', strategy: 'fix', attempt: 2 }),
      ev('REPLAN_CREATED', { reason: 'approach was wrong' }),
    ])
    render(<RecoveryPanel />)
    expect(textOf(screen.getByTestId('recovery-count'))).toContain('2 retries')
    expect(textOf(screen.getByTestId('recovery-count'))).toContain('1 replans')
    expect(screen.getByTestId('replan-indicator')).toBeTruthy()
    expect(textOf(screen.getAllByTestId('recovery-attempt')[1])).toContain('fix')
  })
})

describe('ErrorPanel', () => {
  test('empty state with no errors', () => {
    seed([ev('TASK_STARTED', { spec: { goal: 'x' } })])
    render(<ErrorPanel />)
    expect(textOf(screen.getByTestId('error-panel'))).toContain('No errors recorded')
  })

  test('classifies a model failure and expands its context on demand', async () => {
    seed([ev('MODEL_REQUEST_FAILED', { error: 'rate limited' })])
    render(<ErrorPanel />)
    const entry = screen.getByTestId('error-entry')
    expect(entry.getAttribute('data-error-type')).toBe('model')
    expect(textOf(entry)).toContain('rate limited')
    await userEvent.click(screen.getByLabelText(/toggle details for error/i))
    expect(textOf(screen.getByTestId('error-entry'))).toContain('seq 1')
  })

  test('a non-success completion is surfaced as a task error', () => {
    seed([ev('TASK_COMPLETED', { outcome: 'failed', reason: 'max iterations reached' })])
    render(<ErrorPanel />)
    const entry = screen.getByTestId('error-entry')
    expect(entry.getAttribute('data-error-type')).toBe('task')
    expect(textOf(entry)).toContain('max iterations reached')
  })
})

describe('TopBar', () => {
  test('the thinking toggle updates the shared session', async () => {
    useDaedalusStore.getState().setComposer({ thinking: true })
    render(<TopBar />)
    await userEvent.click(screen.getByTestId('topbar-thinking-toggle'))
    expect(updateSession).toHaveBeenCalledWith({ thinking: false })
    expect(useDaedalusStore.getState().composer.thinking).toBe(false)
  })

  test('the theme toggle carries an accessible label and flips the theme', async () => {
    useDaedalusStore.setState({ theme: 'daedalus-dark' })
    render(<TopBar />)
    const toggle = screen.getByLabelText(/switch to light theme/i)
    await userEvent.click(toggle)
    expect(useDaedalusStore.getState().theme).toBe('daedalus-light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('daedalus-light')
  })
})

describe('report panels', () => {
  test('files changed renders an empty state', () => {
    seed([])
    render(<FilesChangedPanel />)
    expect(textOf(screen.getByTestId('files-changed-panel'))).toContain('files changed')
  })

  test('files changed lists each path from FILE_CHANGED', () => {
    seed([
      ev('FILE_CHANGED', { path: 'src/health.ts', operation: 'create', patch: '+export const ok = true', added: 1, removed: 0 }),
      ev('FILE_CHANGED', { path: 'src/health.test.ts', operation: 'create', patch: '+test', added: 1, removed: 0 }),
    ])
    render(<FilesChangedPanel />)
    const panel = screen.getByTestId('files-changed-panel')
    expect(textOf(panel)).toContain('src/health.ts')
    expect(textOf(panel)).toContain('src/health.test.ts')
  })

  test('validation summary is empty before checks run', () => {
    seed([])
    render(<ValidationSummary />)
    expect(screen.getByTestId('validation-summary-panel')).toBeTruthy()
  })

  test('validation summary reflects a real verdict', () => {
    seed([
      ev('VALIDATION_PASSED', {
        result: { checks: [{ name: 'build', cmd: 'npm run build', status: 'pass', exit_code: 0, summary: '', diagnostics: [] }] },
      }),
    ])
    render(<ValidationSummary />)
    expect(textOf(screen.getByTestId('validation-summary-panel'))).toContain('build')
  })

  test('the final report shows outcome and metrics', () => {
    render(
      <FinalReportView
        report={{
          task_id: 'task-1',
          outcome: 'success',
          diff: '+ok',
          evidence: ['build: pass (npm run build)'],
          metrics: {
            turns: 3,
            tool_calls: 5,
            events: 12,
            commands: 2,
            files_changed: 1,
            recoveries: 0,
            replans: 0,
            approvals: 1,
            checks_passed: 1,
            checks_failed: 0,
          },
        }}
      />,
    )
    expect(textOf(screen.getByTestId('final-report-panel'))).toContain('success')
    expect(textOf(screen.getByTestId('report-metrics'))).toContain('tool calls')
  })

  test('the final report shows an empty state until there is a report', () => {
    render(<FinalReportView report={null} />)
    const panel = screen.getByTestId('final-report-panel')
    expect(textOf(panel)).toContain('No report yet')
    expect(screen.queryByTestId('report-metrics')).toBeNull()
  })
})
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useDaedalusStore } from './state/taskStore'
import { Composer } from './components/composer/composer'
import { ExtensionsPanel } from './components/settings/extensions-panel'

const extensionsStatus = vi.fn()
const review = vi.fn()
const createTask = vi.fn()
const updateSession = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    extensionsStatus: (...args: unknown[]) => extensionsStatus(...args),
    review: (...args: unknown[]) => review(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    listTasks: async () => ({ tasks: [] }),
    task: async () => ({ events: [], report: null, running: false }),
    approve: async () => ({ success: true, decision: 'grant', remember: false }),
    updateSession: (...args: unknown[]) => updateSession(...args),
  },
}))

function textOf(node: Element | null): string {
  return node?.textContent ?? ''
}

const STATUS = {
  root: '/workspace',
  mcp: [],
  skills: [],
  lsp: [],
  problems: [],
  agents: [
    { name: 'only-reader', description: 'Read-only child', mode: 'ask', model: 'm-1', tools: ['read_file', 'grep'], path: '/workspace/.daedalus/agents/only-reader.md' },
  ],
}

beforeEach(() => {
  extensionsStatus.mockReset()
  extensionsStatus.mockResolvedValue(STATUS)
  review.mockReset()
  review.mockResolvedValue({
    findings: [{ severity: 'high', file: 'src/pay.ts', line: 42, message: 'amount is not validated' }],
    raw: '- **[high] src/pay.ts:42** — amount is not validated',
    source: 'unstaged',
    truncated: false,
  })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-new', goal: 'do the thing' })
  updateSession.mockReset()
  updateSession.mockImplementation(async (input: Record<string, unknown>) => ({
    session: { mode: 'auto', autoApprove: false, thinking: true, workspaceRoot: '/workspace', ...input },
  }))
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('ExtensionsPanel subagents', () => {
  test('renders defined subagents with mode, model, and tools', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    render(<ExtensionsPanel />)
    const section = await screen.findByTestId('extensions-agents')
    expect(textOf(section)).toContain('Subagents')
    const entry = await screen.findByTestId('extension-agent-entry')
    expect(textOf(entry)).toContain('only-reader')
    expect(textOf(entry)).toContain('ask')
    expect(textOf(entry)).toContain('m-1')
    expect(textOf(entry)).toContain('read_file, grep')
    expect(textOf(entry)).toContain('Read-only child')
  })

  test('shows the none-defined state when no agents exist', async () => {
    extensionsStatus.mockResolvedValue({ ...STATUS, agents: [] })
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    render(<ExtensionsPanel />)
    const section = await screen.findByTestId('extensions-agents')
    expect(textOf(section)).toContain('none defined (.daedalus/agents)')
  })
})

describe('Composer /agents and /review', () => {
  test('/agents lists the workspace subagents from the gateway', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    useDaedalusStore.getState().setComposer({ goal: '/agents' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(extensionsStatus).toHaveBeenCalledWith('/workspace')
    const output = textOf(await screen.findByTestId('slash-output'))
    expect(output).toContain('only-reader — Read-only child')
    expect(output).toContain('tools: read_file, grep')
  })

  test('/agents explains how to define one when none exist', async () => {
    extensionsStatus.mockResolvedValue({ ...STATUS, agents: [] })
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    useDaedalusStore.getState().setComposer({ goal: '/agents' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('No subagents defined under /workspace/.daedalus/agents')
  })

  test('/review calls the review endpoint for the workspace and prints findings', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    useDaedalusStore.getState().setComposer({ goal: '/review' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ root: '/workspace' }))
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('**[high] src/pay.ts:42**')
  })
})

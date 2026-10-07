import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { Composer } from './components/composer/composer'
import { ExtensionsPanel } from './components/settings/extensions-panel'
import { ChatPanel } from './components/agent/chat-panel'

const extensionsStatus = vi.fn()
const toggleSkill = vi.fn()
const createTask = vi.fn()
const createConversation = vi.fn()
const getConversation = vi.fn()
const files = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    extensionsStatus: (...args: unknown[]) => extensionsStatus(...args),
    toggleSkill: (...args: unknown[]) => toggleSkill(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    createConversation: (...args: unknown[]) => createConversation(...args),
    getConversation: (...args: unknown[]) => getConversation(...args),
    files: (...args: unknown[]) => files(...args),
    cancelTask: vi.fn(async () => ({ cancelled: true })),
    setMode: vi.fn(async () => ({ session: { mode: 'auto' } })),
    setAutoApprove: vi.fn(async () => ({ session: {} })),
    updateSession: vi.fn(async () => ({ session: {} })),
    models: vi.fn(async () => ({ models: [] })),
    providers: vi.fn(async () => ({ providers: [], presets: [] })),
    decideApproval: vi.fn(async () => ({ success: true })),
  },
}))

function textOf(node: Element | null): string {
  return node?.textContent ?? ''
}

const greeterStatus = {
  root: '/workspace',
  mcp: [],
  skills: [
    { name: 'greeter', description: 'Greets users warmly', origin: 'workspace', disabled: false },
    { name: 'oracle', description: 'Answers from the Claude dir', origin: 'claude', disabled: false },
    { name: 'oracle-clone', description: 'Shadowed copy', origin: 'codex', disabled: false, shadowedBy: 'claude' },
    { name: 'muted', description: 'Turned off', origin: 'global', disabled: true },
  ],
  agents: [],
  lsp: [],
  problems: [],
}

let seq = 0
function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

beforeEach(() => {
  seq = 0
  extensionsStatus.mockReset()
  extensionsStatus.mockResolvedValue(greeterStatus)
  toggleSkill.mockReset()
  toggleSkill.mockResolvedValue({ root: '/workspace', name: 'greeter', disabled: true, disabledSkills: ['greeter'] })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-new', goal: 'do the thing', repo_path: '/workspace' })
  createConversation.mockReset()
  createConversation.mockResolvedValue({ conversation: { id: 'conv-1', root: '/workspace', turns: [] } })
  getConversation.mockReset()
  getConversation.mockResolvedValue({ conversation: { id: 'conv-1', root: '/workspace', turns: [] } })
  files.mockReset()
  files.mockResolvedValue({ files: [] })
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
})

afterEach(() => {
  cleanup()
})

describe('ExtensionsPanel skills inventory', () => {
  test('renders origin groups with badges, shadowed-by marks, and per-skill toggles wired to the API', async () => {
    render(<ExtensionsPanel />)
    const groups = await screen.findAllByTestId('extension-skill-group')
    expect(groups.map((group) => group.getAttribute('data-origin'))).toEqual(['workspace', 'global', 'claude', 'codex'])

    const entries = screen.getAllByTestId('extension-skill-entry')
    const greeter = entries.find((entry) => textOf(entry).includes('greeter'))!
    expect(textOf(greeter)).toContain('(workspace)')
    expect(textOf(greeter)).toContain('Greets users warmly')

    const clone = entries.find((entry) => textOf(entry).includes('oracle-clone'))!
    expect(textOf(screen.getByTestId('extension-skill-shadowed'))).toContain('shadowed by global · claude')
    expect(textOf(clone)).toContain('shadowed by')

    const muted = entries.find((entry) => textOf(entry).includes('muted'))!
    expect(textOf(muted)).toContain('disabled for this workspace')

    const toggle = entries
      .flatMap((entry) => [...entry.querySelectorAll('[data-testid="extension-skill-toggle"]')])
      .find((button) => button.getAttribute('data-skill') === 'greeter')!
    await userEvent.click(toggle)
    expect(toggleSkill).toHaveBeenCalledWith({ root: '/workspace', name: 'greeter', disabled: true })
  })

  test('shows the honest overflow note when enabled winners exceed the prompt index cap', async () => {
    const many = Array.from({ length: 43 }, (_, i) => ({
      name: `bulk-${i}`,
      description: `bulk skill ${i}`,
      origin: 'workspace',
      disabled: i >= 41, // 41 enabled: one over the cap
    }))
    extensionsStatus.mockResolvedValue({ ...greeterStatus, skills: many })
    render(<ExtensionsPanel />)
    const note = await screen.findByTestId('extension-skills-overflow')
    expect(textOf(note)).toContain('1 more skill not shown to the model')
    expect(textOf(note)).toContain('caps at 40')
  })
})

describe('Composer palette state machine', () => {
  async function renderComposer() {
    render(<Composer />)
    return screen.getByTestId('composer-input')
  }

  test('Escape closes the slash palette without clearing the draft', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/he' } })
    expect(screen.queryByTestId('slash-palette')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('slash-palette')).toBeNull()
    expect(useDaedalusStore.getState().composer.goal).toBe('/he')
  })

  test('clicking outside the composer closes the slash palette', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/he' } })
    expect(screen.queryByTestId('slash-palette')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByTestId('slash-palette')).toBeNull())
    expect(useDaedalusStore.getState().composer.goal).toBe('/he')
  })

  test('executing a slash command closes the palette and its output can be dismissed', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skills' } })
    await userEvent.click(screen.getByTestId('composer-submit'))
    await waitFor(() => expect(screen.queryByTestId('slash-output')).toBeTruthy())
    expect(textOf(screen.getByTestId('slash-output'))).toContain('greeter — Greets users warmly')
    expect(useDaedalusStore.getState().composer.goal).toBe('')
    // The close affordance dismisses the (bounded, scrollable) output block.
    await userEvent.click(screen.getByTestId('slash-output-close'))
    expect(screen.queryByTestId('slash-output')).toBeNull()
  })

  test('Escape in a plain draft dismisses slash output (the stuck skills dump)', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skills' } })
    await userEvent.click(screen.getByTestId('composer-submit'))
    await waitFor(() => expect(screen.queryByTestId('slash-output')).toBeTruthy())
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByTestId('slash-output')).toBeNull()
  })

  test('/skill <name> <task> submits with the forced-load marker and the stripped goal', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skill greeter greet the new user' } })
    await waitFor(() => expect(extensionsStatus).toHaveBeenCalled())
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ goal: 'greet the new user', skills: ['greeter'] })
  })

  test('picking a skill from the palette inserts the invocation prefix', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skill gr' } })
    const suggestion = await screen.findByTestId('skill-suggestion')
    expect(suggestion.getAttribute('data-skill')).toBe('greeter')
    await userEvent.click(suggestion)
    expect(useDaedalusStore.getState().composer.goal).toBe('/skill greeter ')
  })

  test('an unknown invoked skill warns visibly and never submits', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skill ghost do something' } })
    await waitFor(() => expect(extensionsStatus).toHaveBeenCalled())
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeTruthy())
    expect(textOf(screen.getByRole('alert'))).toContain('Unknown skill "ghost"')
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('Unknown skill "ghost"')
    expect(createTask).not.toHaveBeenCalled()
  })

  test('a disabled invoked skill warns visibly and never submits', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skill muted do something' } })
    await waitFor(() => expect(extensionsStatus).toHaveBeenCalled())
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeTruthy())
    expect(textOf(screen.getByRole('alert'))).toContain('disabled for this workspace')
    expect(createTask).not.toHaveBeenCalled()
  })

  test('/skill <name> alone stages an invoked-skill chip the next submit carries', async () => {
    const input = await renderComposer()
    fireEvent.change(input, { target: { value: '/skill greeter' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    const chip = await screen.findByTestId('invoked-skill-chip')
    expect(chip.getAttribute('data-skill')).toBe('greeter')
    fireEvent.change(input, { target: { value: 'greet everyone' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({ goal: 'greet everyone', skills: ['greeter'] })
  })
})

describe('ChatPanel skill activation chip', () => {
  test('renders for a read_skill activation with origin and a disable action wired to the API', async () => {
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [
        ev('TASK_STARTED', { spec: { id: 'task-1', goal: 'greet', repo_path: '/workspace', constraints: [], done_criteria: [] } }),
        ev('SKILL_LOADED', { name: 'deploy', origin: 'claude', via: 'agent' }),
      ],
    })
    render(<ChatPanel />)
    const chip = await screen.findByTestId('chat-skill-chip')
    expect(chip.getAttribute('data-skill')).toBe('deploy')
    expect(chip.getAttribute('data-origin')).toBe('claude')
    expect(textOf(chip)).toContain('global · claude')
    expect(textOf(chip)).toContain('loaded by agent')

    await userEvent.click(screen.getByTestId('chat-skill-chip-disable'))
    expect(toggleSkill).toHaveBeenCalledWith({ root: '/workspace', name: 'deploy', disabled: true })
    await waitFor(() => expect(textOf(screen.getByTestId('chat-skill-chip-state'))).toContain('disabled for this workspace'))
  })

  test('a user-invoked activation reads "invoked by you"', async () => {
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [
        ev('TASK_STARTED', { spec: { id: 'task-1', goal: 'greet', repo_path: '/workspace', constraints: [], done_criteria: [] } }),
        ev('SKILL_LOADED', { name: 'greeter', origin: 'workspace', via: 'user' }),
      ],
    })
    render(<ChatPanel />)
    const chip = await screen.findByTestId('chat-skill-chip')
    expect(textOf(chip)).toContain('invoked by you')
  })
})

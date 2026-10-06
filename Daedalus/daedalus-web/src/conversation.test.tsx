import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import type { Conversation } from './api/types'
import { Composer } from './components/composer/composer'
import { ChatPanel } from './components/agent/chat-panel'
import { loadActiveConversationId, saveActiveConversationId } from './state/prefs'

// Chat conversations (Farid's main complaint): one continuing session, not
// one task per prompt. The suite fakes the gateway's conversation endpoints
// and drives submits through the real composer + chat panel.

const createConversation = vi.fn()
const getConversation = vi.fn()
const listConversations = vi.fn()
const createTask = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    createConversation: (...args: unknown[]) => createConversation(...args),
    getConversation: (...args: unknown[]) => getConversation(...args),
    listConversations: (...args: unknown[]) => listConversations(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    cancelTask: vi.fn(async () => ({ cancelled: true, task_id: 'task-1' })),
    files: vi.fn(async (root: string) => ({ root, files: [], truncated: false })),
    updateSession: vi.fn(async () => ({
      session: { mode: 'auto', autoApprove: false, thinking: true, workspaceRoot: '/workspace' },
    })),
    setMode: vi.fn(async () => ({
      session: { mode: 'auto', autoApprove: false, thinking: true, workspaceRoot: '/workspace' },
    })),
    setAutoApprove: vi.fn(async () => ({
      session: { mode: 'auto', autoApprove: true, thinking: true, workspaceRoot: '/workspace' },
    })),
    decideApproval: vi.fn(async () => ({ success: true, decision: 'decline', approval_id: 'a-1' })),
    models: vi.fn(async () => ({ models: [], session: {}, count: 0 })),
    providers: vi.fn(async () => ({ providers: [], presets: [] })),
  },
}))

let seq = 0

function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

function textOf(node: Element | null): string {
  return node?.textContent ?? ''
}

/** Fake on-the-wire conversation, mutated by the mocks like the server would. */
let serverConversation: Conversation

beforeEach(() => {
  seq = 0
  localStorage.clear()
  serverConversation = { id: 'conv-1', root: '/workspace', created_at: new Date().toISOString(), turns: [] }
  createConversation.mockReset()
  let convSeq = 0
  createConversation.mockImplementation(async () => {
    convSeq += 1
    serverConversation = { id: `conv-${convSeq}`, root: '/workspace', created_at: new Date().toISOString(), turns: [] }
    return { conversation: serverConversation }
  })
  getConversation.mockReset()
  getConversation.mockImplementation(async () => ({ conversation: serverConversation }))
  listConversations.mockReset()
  listConversations.mockResolvedValue({ conversations: [], count: 0, root: '/workspace' })
  createTask.mockReset()
  let taskSeq = 0
  createTask.mockImplementation(async (input: { goal: string; conversation_id?: string; mode?: string }) => {
    taskSeq += 1
    const id = `task-${taskSeq}`
    // Like the real gateway: creating the task records its user turn.
    if (input.conversation_id && input.conversation_id === serverConversation.id) {
      serverConversation = {
        ...serverConversation,
        turns: [
          ...serverConversation.turns,
          { role: 'user', text: input.goal, task_id: id, mode: input.mode, ts: new Date().toISOString() },
        ],
      }
    }
    return { id, goal: input.goal, repo_path: '/workspace', created_at: new Date().toISOString() }
  })
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
})

afterEach(() => {
  cleanup()
})

async function submitGoal(goal: string): Promise<void> {
  useDaedalusStore.getState().setComposer({ goal })
  await userEvent.type(screen.getByTestId('composer-input'), '{Enter}')
}

describe('chat conversations (web)', () => {
  test('two submits stay in ONE conversation: the panel shows both turns and the reply summary', async () => {
    render(
      <>
        <Composer />
        <ChatPanel />
      </>,
    )

    await submitGoal('buat landing page ayid')
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: expect.any(String) }))
    const conversationId = (createTask.mock.calls[0]?.[0] as { conversation_id: string }).conversation_id
    expect(conversationId).toBeTruthy()
    // The prompt is on screen immediately (optimistic turn; no events yet).
    await waitFor(() => expect(textOf(screen.getByTestId('chat-entries'))).toContain('buat landing page ayid'))

    // The task finishes; the server recorded the assistant summary turn.
    serverConversation = {
      id: conversationId,
      root: '/workspace',
      created_at: new Date().toISOString(),
      turns: [
        { role: 'user', text: 'buat landing page ayid', task_id: 'task-1', mode: 'auto', ts: new Date().toISOString() },
        {
          role: 'assistant',
          text: 'Selesai. (buat landing page ayid)\ncreated ayid/index.html (+40/-0)',
          task_id: 'task-1',
          mode: 'auto',
          ts: new Date().toISOString(),
        },
      ],
    }
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [
        ev('TASK_STARTED', { spec: { goal: 'buat landing page ayid', repo_path: '/workspace', constraints: [], done_criteria: [] } }),
        ev('TASK_COMPLETED', { outcome: 'success', reason: 'completed', state: { status: 'done' } }),
      ],
    })
    await waitFor(() => expect(textOf(screen.getByTestId('chat-panel'))).toContain('task success'))

    // Follow-up in the same session — Farid's "dmn plan nya?" moment.
    await submitGoal('dmn plan nya?')
    expect(createTask).toHaveBeenCalledTimes(2)
    expect(createTask.mock.calls[1]?.[0]).toMatchObject({ conversation_id: conversationId })

    // Whole session visible in order: prompt → summary → follow-up prompt.
    const panel = textOf(screen.getByTestId('chat-entries'))
    const first = panel.indexOf('buat landing page ayid')
    const summary = panel.indexOf('Selesai.')
    const followUp = panel.indexOf('dmn plan nya?')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(summary).toBeGreaterThan(first)
    expect(followUp).toBeGreaterThan(summary)
    const userEntries = screen.getAllByTestId('chat-entry').filter((entry) => entry.getAttribute('data-role') === 'user')
    expect(userEntries).toHaveLength(2)
  })

  test('New chat starts a fresh conversation and clears the panel', async () => {
    useDaedalusStore.getState().setConversation({
      id: 'conv-old',
      root: '/workspace',
      created_at: new Date().toISOString(),
      turns: [{ role: 'user', text: 'percakapan lama', task_id: 'task-9', ts: new Date().toISOString() }],
    })
    useDaedalusStore.setState({ taskId: 'task-9' })
    createConversation.mockResolvedValue({
      conversation: { id: 'conv-fresh', root: '/workspace', created_at: new Date().toISOString(), turns: [] },
    })
    render(<ChatPanel />)
    expect(textOf(screen.getByTestId('chat-entries'))).toContain('percakapan lama')

    await userEvent.click(screen.getByTestId('new-chat'))
    await waitFor(() => expect(useDaedalusStore.getState().conversation?.id).toBe('conv-fresh'))
    expect(useDaedalusStore.getState().taskId).toBeNull()
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('No conversation yet')
    expect(loadActiveConversationId('/workspace')).toBe('conv-fresh')
  })

  test('a restored conversation renders its turns without any task selected', () => {
    // What App's restore effect leaves in the store after a reload.
    useDaedalusStore.getState().setConversation({
      id: 'conv-restored',
      root: '/workspace',
      created_at: new Date().toISOString(),
      turns: [
        { role: 'user', text: 'halo, kemarin kita bahas apa?', task_id: 'task-1', ts: new Date().toISOString() },
        { role: 'assistant', text: 'Kemarin kita buat landing page ayid.', task_id: 'task-1', ts: new Date().toISOString() },
      ],
    })
    render(<ChatPanel />)
    const panel = textOf(screen.getByTestId('chat-entries'))
    expect(panel).toContain('halo, kemarin kita bahas apa?')
    expect(panel).toContain('Kemarin kita buat landing page ayid.')
    expect(panel.indexOf('halo, kemarin kita bahas apa?')).toBeLessThan(panel.indexOf('Kemarin kita buat landing page ayid.'))
  })

  test('the active-conversation pointer round-trips per workspace root', () => {
    saveActiveConversationId('/workspace', 'conv-9')
    expect(loadActiveConversationId('/workspace')).toBe('conv-9')
    expect(loadActiveConversationId('/other')).toBeNull()
    saveActiveConversationId('/workspace', null)
    expect(loadActiveConversationId('/workspace')).toBeNull()
  })

  test('the model dropdown opens DOWNWARD (top-full), never upward', async () => {
    useDaedalusStore.getState().setModels([
      { providerId: 'kr', model: 'claude-sonnet', supportsVision: true },
      { providerId: 'gemini', model: 'gemini-flash', supportsVision: false },
    ])
    render(<Composer />)
    await userEvent.click(screen.getByTestId('model-picker-button'))
    const list = screen.getByTestId('model-picker-list')
    expect(list.className).toContain('top-full')
    expect(list.className).toContain('mt-1')
    expect(list.className).not.toContain('bottom-full')
  })
})

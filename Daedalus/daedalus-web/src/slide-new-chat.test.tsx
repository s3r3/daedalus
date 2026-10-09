import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeckSpec } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import { ChatPanel } from './components/agent/chat-panel'
import { SlideStage } from './components/slides/slide-stage'
import { DeckOutlinePanel } from './components/slides/deck-outline'

// Slide new chat (Farid: "pas tekan new chat ke reset semua"): in the
// Slide domain the new-chat button also resets the deck workspace — the
// server archives the current deck aside first, and only then does the
// fresh conversation start. Coding's new chat stays conversation-only.

const createConversation = vi.fn()
const getConversation = vi.fn()
const listConversations = vi.fn()
const fileMock = vi.fn()
const deckResetMock = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    createConversation: (...args: unknown[]) => createConversation(...args),
    getConversation: (...args: unknown[]) => getConversation(...args),
    listConversations: (...args: unknown[]) => listConversations(...args),
    file: (...args: unknown[]) => fileMock(...args),
    deckReset: (...args: unknown[]) => deckResetMock(...args),
    deckGenerate: vi.fn(async () => ({ root: '/workspace', outcome: 'success', summary: 'ok', exported: null })),
    deckExport: vi.fn(async () => ({ root: '/workspace', path: 'deck/deck.pptx', bytes: 1, slides: 1 })),
    deckAssetUrl: (root: string, name: string) => `/slides/deck/asset?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`,
    pptTemplates: vi.fn(async () => ({ root: '/workspace', templates: [] })),
    pptTemplateAssetUrl: (root: string, id: string, file: string) => `/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`,
  },
}))

const fixtureDeck: DeckSpec = {
  version: 1,
  id: 'deck-lama',
  title: 'Hai',
  theme: {},
  slides: [
    { id: 's1', layout: 'title', content: { title: 'Judul Lama', subtitle: 'Kemarin' } },
    { id: 's2', layout: 'bullets', content: { title: 'Isi Lama', points: ['satu'] } },
  ],
}

/** Call order across the gateway: the reset must precede the new conversation. */
let calls: string[] = []
/** Once the (fake) server archives the deck, deck/deck.json stops reading. */
let deckArchived = false

function textOf(node: Element | null): string {
  return node?.textContent ?? ''
}

beforeEach(() => {
  localStorage.clear()
  calls = []
  deckArchived = false
  createConversation.mockReset()
  createConversation.mockImplementation(async () => {
    calls.push('conversation')
    return { conversation: { id: 'conv-fresh', root: '/workspace', created_at: new Date().toISOString(), turns: [] } }
  })
  getConversation.mockReset()
  getConversation.mockResolvedValue({ conversation: { id: 'conv-old', root: '/workspace', created_at: new Date().toISOString(), turns: [] } })
  listConversations.mockReset()
  listConversations.mockResolvedValue({ conversations: [], count: 0, root: '/workspace' })
  fileMock.mockReset()
  fileMock.mockImplementation(async (_root: string, path: string) => {
    if (deckArchived) throw new Error('404 file not found')
    const content = JSON.stringify(fixtureDeck)
    return { path, content, size: content.length }
  })
  deckResetMock.mockReset()
  deckResetMock.mockImplementation(async () => {
    calls.push('reset')
    deckArchived = true
    return { root: '/workspace', archived: '.daedalus/deck-archive/2026-10-09T02-00-00-000Z', staged_abandoned: false }
  })
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
  useDaedalusStore.getState().setConversation({
    id: 'conv-old',
    root: '/workspace',
    created_at: new Date().toISOString(),
    turns: [{ role: 'user', text: 'buatkan slide tentang anatomi', task_id: 'task-9', ts: new Date().toISOString() }],
  })
  useDaedalusStore.setState({ taskId: 'task-9' })
})

afterEach(() => {
  cleanup()
})

describe('new chat in the Slide domain resets everything', () => {
  test('archives the deck first, then starts fresh: stage and outline go empty', async () => {
    useDaedalusStore.getState().setDomain('slide')
    render(
      <>
        <ChatPanel />
        <SlideStage />
        <DeckOutlinePanel />
      </>,
    )
    await screen.findByTestId('slide-thumb-0')
    expect(screen.getByTestId('deck-outline-item-1')).toBeTruthy()
    expect(textOf(screen.getByTestId('chat-entries'))).toContain('buatkan slide tentang anatomi')

    await userEvent.click(screen.getByTestId('new-chat'))

    // Reset hit the server before the new conversation was created.
    expect(calls).toEqual(['reset', 'conversation'])
    expect(deckResetMock).toHaveBeenCalledWith('/workspace')
    await waitFor(() => expect(useDaedalusStore.getState().conversation?.id).toBe('conv-fresh'))
    // Stage and outline repaint from the empty state; panel is clean.
    await screen.findByTestId('slide-empty')
    await waitFor(() => expect(screen.queryByTestId('deck-outline-item-0')).toBeNull())
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('No conversation yet')
  })

  test('a refused reset surfaces the error and nothing pretends to reset', async () => {
    useDaedalusStore.getState().setDomain('slide')
    deckResetMock.mockReset()
    deckResetMock.mockRejectedValue(new Error('Tugas slide sedang berjalan di workspace ini'))
    render(
      <>
        <ChatPanel />
        <SlideStage />
      </>,
    )
    await screen.findByTestId('slide-thumb-0')

    await userEvent.click(screen.getByTestId('new-chat'))

    await waitFor(() => expect(useDaedalusStore.getState().composer.error).toContain('belum bisa direset'))
    expect(useDaedalusStore.getState().composer.error).toContain('Tugas slide sedang berjalan')
    // No new conversation, the old session and deck stay exactly as they were.
    expect(createConversation).not.toHaveBeenCalled()
    expect(useDaedalusStore.getState().conversation?.id).toBe('conv-old')
    expect(screen.getByTestId('slide-thumb-0')).toBeTruthy()
    expect(screen.queryByTestId('slide-empty')).toBeNull()
  })

  test('Coding new chat never touches the deck reset', async () => {
    useDaedalusStore.getState().setDomain('coding')
    render(<ChatPanel />)
    expect(textOf(screen.getByTestId('chat-entries'))).toContain('buatkan slide tentang anatomi')

    await userEvent.click(screen.getByTestId('new-chat'))

    await waitFor(() => expect(useDaedalusStore.getState().conversation?.id).toBe('conv-fresh'))
    expect(deckResetMock).not.toHaveBeenCalled()
    expect(calls).toEqual(['conversation'])
    expect(textOf(screen.getByTestId('chat-panel'))).toContain('No conversation yet')
  })
})

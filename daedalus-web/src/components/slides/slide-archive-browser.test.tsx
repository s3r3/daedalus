import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useDaedalusStore } from '../../state/taskStore'
import { SlideWorkspacePanel } from './slide-workspace'

const listMock = vi.fn()
const deckArchivesMock = vi.fn()
const deckArchiveRestoreMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    list: (...args: unknown[]) => listMock(...args),
    deckArchives: (...args: unknown[]) => deckArchivesMock(...args),
    deckArchiveRestore: (...args: unknown[]) => deckArchiveRestoreMock(...args),
  },
}))

const archivedAt = '2026-10-10T01-00-00-000Z'

beforeEach(() => {
  localStorage.clear()
  listMock.mockReset()
  listMock.mockImplementation(async (_root: string, path = '.') => {
    if (path === 'deck') {
      return {
        path,
        items: [{ name: 'deck.json', path: 'deck/deck.json', isDirectory: false, size: 1024 }],
      }
    }
    return {
      path,
      items: [{ name: 'deck', path: 'deck', isDirectory: true }],
    }
  })
  deckArchivesMock.mockReset()
  deckArchivesMock.mockResolvedValue({
    root: '/ws',
    archives: [{ name: archivedAt, title: 'Deck Lama', slides: 4, archivedAt: '2026-10-10T01:00:00.000Z' }],
  })
  deckArchiveRestoreMock.mockReset()
  deckArchiveRestoreMock.mockResolvedValue({
    root: '/ws',
    deck: { version: 1, id: 'deck-lama', title: 'Deck Lama', theme: {}, slides: [{ id: 's1', layout: 'title', content: { title: 'A' } }] },
  })
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/ws' })
})

afterEach(() => cleanup())

describe('SlideArchiveBrowser', () => {
  test('opens from the workspace header, lists archives, and restores ask-first', async () => {
    const user = userEvent.setup()
    render(<SlideWorkspacePanel />)

    await user.click(await screen.findByTestId('slide-archive-open'))
    expect(await screen.findByTestId('slide-archive-dialog')).toBeTruthy()
    expect(deckArchivesMock).toHaveBeenCalledWith('/ws')

    const entry = await screen.findByTestId(`slide-archive-${archivedAt}`)
    expect(entry.textContent).toContain('Deck Lama')
    expect(entry.textContent).toContain('4 slide')

    // Ask-first: the first click arms the confirm, the second restores.
    await user.click(screen.getByTestId(`slide-archive-restore-${archivedAt}`))
    expect(deckArchiveRestoreMock).not.toHaveBeenCalled()
    await user.click(screen.getByTestId(`slide-archive-restore-confirm-${archivedAt}`))
    expect(deckArchiveRestoreMock).toHaveBeenCalledWith('/ws', archivedAt)
    expect(await screen.findByTestId('slide-archive-note')).toBeTruthy()
  })

  test('a restore error surfaces honestly in the dialog', async () => {
    const user = userEvent.setup()
    deckArchiveRestoreMock.mockRejectedValue(new Error('500 Internal Server Error'))
    render(<SlideWorkspacePanel />)

    await user.click(await screen.findByTestId('slide-archive-open'))
    await screen.findByTestId('slide-archive-dialog')
    await user.click(await screen.findByTestId(`slide-archive-restore-${archivedAt}`))
    await user.click(await screen.findByTestId(`slide-archive-restore-confirm-${archivedAt}`))

    const note = await screen.findByTestId('slide-archive-note')
    expect(note.textContent).toContain('500')
  })

  test('an empty archive shows the honest empty state', async () => {
    const user = userEvent.setup()
    deckArchivesMock.mockResolvedValue({ root: '/ws', archives: [] })
    render(<SlideWorkspacePanel />)

    await user.click(await screen.findByTestId('slide-archive-open'))
    await screen.findByTestId('slide-archive-dialog')
    expect(screen.getByText(/Belum ada arsip/)).toBeTruthy()
  })
})

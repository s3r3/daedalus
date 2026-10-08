import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeckSpec } from '@daedalus/core'
import { useDaedalusStore } from '../../state/taskStore'
import { DOMAIN_PREFS_KEY, loadDomain } from '../../state/prefs'
import { DomainSwitch } from '../layout/domain-switch'
import { SlideRenderer } from './slide-renderer'
import { SlideStage } from './slide-stage'
import { DeckOutlinePanel } from './deck-outline'

const fileMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    file: (...args: unknown[]) => fileMock(...args),
  },
}))

const fixtureDeck: DeckSpec = {
  version: 1,
  id: 'deck-uji',
  title: 'Deck Uji',
  theme: {},
  slides: [
    { id: 's1', layout: 'title', content: { title: 'Judul Besar', subtitle: 'Subjudul pendamping' } },
    {
      id: 's2',
      layout: 'diagram-flow',
      content: {
        title: 'Alur Kerja',
        steps: [
          { title: 'Mulai', desc: 'Siapkan bahan' },
          { title: 'Proses', desc: 'Kerjakan inti' },
          { title: 'Selesai', desc: 'Kirim hasil' },
        ],
      },
    },
    {
      id: 's3',
      layout: 'chart-bar',
      content: {
        title: 'Hasil Kuartal',
        unit: ' jt',
        data: [
          { label: 'Jan', value: 10 },
          { label: 'Feb', value: 25 },
          { label: 'Mar', value: 18 },
        ],
      },
    },
  ],
}

function deckFile(deck: DeckSpec = fixtureDeck): { path: string; content: string; size: number } {
  const content = JSON.stringify(deck)
  return { path: 'deck/deck.json', content, size: content.length }
}

beforeEach(() => {
  localStorage.clear()
  fileMock.mockReset()
  fileMock.mockResolvedValue(deckFile())
  useDaedalusStore.getState().reset()
})

afterEach(() => {
  cleanup()
})

describe('SlideRenderer', () => {
  test('title slide renders its title and subtitle', () => {
    render(<SlideRenderer slide={fixtureDeck.slides[0]} theme={fixtureDeck.theme} />)
    expect(screen.getByText('Judul Besar')).toBeTruthy()
    expect(screen.getByText('Subjudul pendamping')).toBeTruthy()
    expect(screen.getByTestId('slide-renderer').getAttribute('data-layout')).toBe('title')
  })

  test('diagram-flow renders every step title and description', () => {
    render(<SlideRenderer slide={fixtureDeck.slides[1]} theme={fixtureDeck.theme} />)
    expect(screen.getByText('Alur Kerja')).toBeTruthy()
    expect(screen.getByText(/Mulai/)).toBeTruthy()
    expect(screen.getByText(/Proses/)).toBeTruthy()
    expect(screen.getByText(/Selesai/)).toBeTruthy()
    expect(screen.getByText('Kerjakan inti')).toBeTruthy()
  })

  test('chart-bar renders data labels and values', () => {
    render(<SlideRenderer slide={fixtureDeck.slides[2]} theme={fixtureDeck.theme} />)
    expect(screen.getByText('Hasil Kuartal')).toBeTruthy()
    expect(screen.getByText('Jan')).toBeTruthy()
    expect(screen.getByText('Feb')).toBeTruthy()
    expect(screen.getByText('Mar')).toBeTruthy()
    expect(screen.getByText(/25/)).toBeTruthy()
  })
})

describe('DomainSwitch', () => {
  test('clicking Slide flips the store domain and persists the pref', async () => {
    render(<DomainSwitch />)
    expect(screen.getByTestId('domain-switch')).toBeTruthy()
    expect(screen.getByTestId('domain-coding').getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(screen.getByTestId('domain-slide'))
    expect(useDaedalusStore.getState().domain).toBe('slide')
    expect(localStorage.getItem(DOMAIN_PREFS_KEY)).toBe('slide')
    expect(loadDomain()).toBe('slide')
    expect(screen.getByTestId('domain-slide').getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(screen.getByTestId('domain-coding'))
    expect(useDaedalusStore.getState().domain).toBe('coding')
    expect(localStorage.getItem(DOMAIN_PREFS_KEY)).toBe('coding')
  })
})

describe('DeckOutlinePanel', () => {
  test('lists one numbered item per slide with registry layout labels', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<DeckOutlinePanel />)

    const first = await screen.findByTestId('deck-outline-item-0')
    expect(screen.getByTestId('deck-outline')).toBeTruthy()
    expect(screen.getAllByTestId(/^deck-outline-item-/)).toHaveLength(3)
    expect(first.textContent).toContain('Judul Besar')
    expect(first.textContent).toContain('Title')
    expect(screen.getByTestId('deck-outline-item-1').textContent).toContain('Flow diagram')
    expect(screen.getByTestId('deck-outline-item-2').textContent).toContain('Bar chart')
  })

  test('clicking an outline item selects that slide', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<DeckOutlinePanel />)
    await userEvent.click(await screen.findByTestId('deck-outline-item-2'))
    expect(useDaedalusStore.getState().slideIndex).toBe(2)
  })
})

describe('SlideStage', () => {
  test('renders the mocked deck, counts slides, and next/thumb navigation moves the selection', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    expect(await screen.findByTestId('slide-counter')).toBeTruthy()
    expect(screen.getByTestId('slide-stage')).toBeTruthy()
    expect(screen.getByTestId('slide-counter').textContent).toContain('1 / 3')
    expect(screen.getAllByText('Judul Besar').length).toBeGreaterThan(0)
    expect(fileMock).toHaveBeenCalledWith('/ws', 'deck/deck.json')

    await userEvent.click(screen.getByTestId('slide-next'))
    expect(screen.getByTestId('slide-counter').textContent).toContain('2 / 3')
    expect(screen.getAllByText(/Proses/).length).toBeGreaterThan(0)

    await userEvent.click(screen.getByTestId('slide-thumb-2'))
    expect(screen.getByTestId('slide-counter').textContent).toContain('3 / 3')
    expect(useDaedalusStore.getState().slideIndex).toBe(2)
  })

  test('a missing deck shows the honest empty state with a working refresh', async () => {
    fileMock.mockRejectedValue(new Error('404 Not Found'))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    const empty = await screen.findByTestId('slide-empty')
    expect(empty.textContent).toContain('Belum ada deck (deck/deck.json)')
    expect(screen.getByTestId('slide-refresh')).toBeTruthy()
  })

  test('without a workspace the stage explains itself instead of fetching', () => {
    render(<SlideStage />)
    expect(screen.getByTestId('slide-stage').textContent).toContain('Buka workspace dulu')
    expect(fileMock).not.toHaveBeenCalled()
  })
})

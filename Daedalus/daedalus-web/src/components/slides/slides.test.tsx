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
import { SlideTemplatesPanel } from './slide-templates'
import { SlideComposerControls } from '../composer/slide-controls'

const fileMock = vi.fn()
const slideTemplatesMock = vi.fn()
const deckThemeMock = vi.fn()
const deckUpdateSlideMock = vi.fn()
const deckExportMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    file: (...args: unknown[]) => fileMock(...args),
    slideTemplates: (...args: unknown[]) => slideTemplatesMock(...args),
    deckTheme: (...args: unknown[]) => deckThemeMock(...args),
    deckUpdateSlide: (...args: unknown[]) => deckUpdateSlideMock(...args),
    deckAddSlide: vi.fn(async () => ({ root: '/ws', deck: { version: 1, id: 'd', title: 't', theme: {}, slides: [] }, slide_id: 'baru' })),
    deckDeleteSlide: vi.fn(async () => ({ root: '/ws', deck: { version: 1, id: 'd', title: 't', theme: {}, slides: [] } })),
    deckMoveSlide: vi.fn(async () => ({ root: '/ws', deck: { version: 1, id: 'd', title: 't', theme: {}, slides: [] } })),
    deckExport: (...args: unknown[]) => deckExportMock(...args),
    deckDownloadUrl: (root: string, path: string) => `/slides/deck/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    createTask: vi.fn(async () => ({ id: 'task-varian', goal: 'varian', repo_path: '/ws', created_at: '' })),
    list: vi.fn(async () => ({ path: 'deck', items: [] })),
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
  slideTemplatesMock.mockReset()
  slideTemplatesMock.mockResolvedValue({
    templates: [
      { id: 'general', name: 'General', description: 'Default', theme: { background: '#201f26', accent: '#6b50ff', text: '#ecebf0', headingFont: 'Arial', bodyFont: 'Arial' } },
      { id: 'ocean', name: 'Ocean', description: 'Biru laut', theme: { background: '#0e2a47', accent: '#2dd4bf', text: '#e8f4ff', headingFont: 'Verdana', bodyFont: 'Arial' } },
    ],
  })
  deckThemeMock.mockReset()
  deckThemeMock.mockResolvedValue({ root: '/ws', deck: fixtureDeck })
  deckUpdateSlideMock.mockReset()
  deckUpdateSlideMock.mockResolvedValue({ root: '/ws', deck: fixtureDeck })
  deckExportMock.mockReset()
  deckExportMock.mockResolvedValue({ root: '/ws', path: 'deck/deck-uji.pptx', bytes: 2048, slides: 3 })
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

describe('SlideTemplatesPanel', () => {
  test('lists bundled templates and applies the pick to the open deck through the API', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideTemplatesPanel />)

    const ocean = await screen.findByTestId('slide-template-ocean')
    expect(screen.getByTestId('slide-template-general')).toBeTruthy()
    await user.click(ocean)

    expect(deckThemeMock).toHaveBeenCalledWith('/ws', { template_id: 'ocean' })
    expect(useDaedalusStore.getState().slideOptions.templateId).toBe('ocean')
  })

  test('without a deck the pick stays pending for the next task', async () => {
    const user = userEvent.setup()
    fileMock.mockRejectedValue(new Error('404 Not Found'))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideTemplatesPanel />)

    const general = await screen.findByTestId('slide-template-general')
    await user.click(general)

    expect(deckThemeMock).not.toHaveBeenCalled()
    expect(useDaedalusStore.getState().slideOptions.templateId).toBe('general')
  })
})

describe('SlideStage editing', () => {
  test('the Edit toggle opens the editor and saving writes through the slide API', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-edit-toggle'))
    expect(screen.getByTestId('slide-editor')).toBeTruthy()

    const title = screen.getByTestId('slide-editor-title') as HTMLInputElement
    await user.clear(title)
    await user.type(title, 'Judul Baru')
    await user.click(screen.getByTestId('slide-editor-save'))

    expect(deckUpdateSlideMock).toHaveBeenCalledTimes(1)
    const [, slideId, payload] = deckUpdateSlideMock.mock.calls[0] as [string, string, { content: Record<string, unknown>; layout?: string }]
    expect(slideId).toBe('s1')
    expect(payload.content.title).toBe('Judul Baru')
  })

  test('Export calls the deck export endpoint and offers the download', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-export'))

    const note = await screen.findByTestId('slide-exported')
    expect(deckExportMock).toHaveBeenCalledWith('/ws')
    expect(note.textContent).toContain('deck/deck-uji.pptx')
  })
})

describe('SlideComposerControls', () => {
  test('generation, count and language are explicit store-backed controls', async () => {
    const user = userEvent.setup()
    render(<SlideComposerControls />)

    await user.click(screen.getByTestId('slide-gen-smart'))
    expect(useDaedalusStore.getState().slideOptions.generation).toBe('smart')

    await user.selectOptions(screen.getByTestId('slide-count-select'), '10')
    expect(useDaedalusStore.getState().slideOptions.slideCount).toBe(10)

    await user.selectOptions(screen.getByTestId('slide-language-select'), 'Bahasa Indonesia')
    expect(useDaedalusStore.getState().slideOptions.language).toBe('Bahasa Indonesia')

    await user.selectOptions(screen.getByTestId('slide-count-select'), 'auto')
    expect(useDaedalusStore.getState().slideOptions.slideCount).toBeNull()
  })
})

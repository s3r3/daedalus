import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
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
import { SlideWorkspacePanel } from './slide-workspace'

const fileMock = vi.fn()
const slideTemplatesMock = vi.fn()
const deckThemeMock = vi.fn()
const deckUpdateSlideMock = vi.fn()
const deckAddSlideMock = vi.fn()
const deckExportMock = vi.fn()
const deckRegenerateSlideMock = vi.fn()
const listMock = vi.fn()
const deckGenerateMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    file: (...args: unknown[]) => fileMock(...args),
    slideTemplates: (...args: unknown[]) => slideTemplatesMock(...args),
    deckTheme: (...args: unknown[]) => deckThemeMock(...args),
    deckUpdateSlide: (...args: unknown[]) => deckUpdateSlideMock(...args),
    deckAddSlide: (...args: unknown[]) => deckAddSlideMock(...args),
    deckDeleteSlide: vi.fn(async () => ({ root: '/ws', deck: { version: 1, id: 'd', title: 't', theme: {}, slides: [] } })),
    deckMoveSlide: vi.fn(async () => ({ root: '/ws', deck: { version: 1, id: 'd', title: 't', theme: {}, slides: [] } })),
    deckExport: (...args: unknown[]) => deckExportMock(...args),
    deckGenerate: (...args: unknown[]) => deckGenerateMock(...args),
    deckDownloadUrl: (root: string, path: string) => `/slides/deck/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    deckRegenerateSlide: (...args: unknown[]) => deckRegenerateSlideMock(...args),
    list: (...args: unknown[]) => listMock(...args),
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
  deckAddSlideMock.mockReset()
  deckAddSlideMock.mockResolvedValue({ root: '/ws', deck: fixtureDeck, slide_id: 's-copy' })
  deckExportMock.mockReset()
  deckExportMock.mockResolvedValue({ root: '/ws', path: 'deck/deck-uji.pptx', bytes: 2048, slides: 3 })
  deckRegenerateSlideMock.mockReset()
  deckRegenerateSlideMock.mockResolvedValue({ root: '/ws', deck: fixtureDeck, slide_id: 's1' })
  listMock.mockReset()
  listMock.mockImplementation(async (_root: string, path = '.') => {
    if (path === 'deck') {
      return {
        path,
        items: [
          { name: 'deck.json', path: 'deck/deck.json', isDirectory: false, size: 1024 },
          { name: 'deck-uji.pptx', path: 'deck/deck-uji.pptx', isDirectory: false, size: 2048 },
        ],
      }
    }
    if (path === 'src') {
      return { path, items: [{ name: 'index.ts', path: 'src/index.ts', isDirectory: false, size: 512 }] }
    }
    return {
      path,
      items: [
        { name: 'deck', path: 'deck', isDirectory: true },
        { name: 'src', path: 'src', isDirectory: true },
        { name: 'README.md', path: 'README.md', isDirectory: false, size: 2048 },
        { name: 'notes.pptx', path: 'notes.pptx', isDirectory: false, size: 4096 },
      ],
    }
  })
  deckGenerateMock.mockReset()
  deckGenerateMock.mockResolvedValue({
    root: '/ws',
    task_id: 't-1',
    outcome: 'success',
    summary: 'done: 2 slide selesai dan ter-export ke deck/deck-kerangka.pptx (42 KB).',
    exported: { path: 'deck/deck-kerangka.pptx', bytes: 43008, slides: 2 },
  })
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

const stagedDeck: DeckSpec = {
  version: 1,
  id: 'deck-kerangka',
  title: 'Deck Kerangka',
  theme: {},
  slides: [
    { id: 'k1', layout: 'title', content: { title: 'Judul Kerangka' }, status: 'skeleton', keyMessage: 'pembuka' },
    { id: 'k2', layout: 'bullets', content: { title: 'Isi Kerangka' }, status: 'skeleton', keyMessage: 'inti' },
  ],
}

describe('DeckOutlinePanel Buat (staged outline-first generate)', () => {
  test('the Buat button renders only while the deck is staged (skeleton slides)', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    const filled = render(<DeckOutlinePanel />)
    await screen.findByTestId('deck-outline-item-0')
    expect(screen.queryByTestId('deck-generate')).toBeNull()
    filled.unmount()

    fileMock.mockResolvedValue(deckFile(stagedDeck))
    render(<DeckOutlinePanel />)
    const button = await screen.findByTestId('deck-generate')
    expect(button.textContent).toContain('Buat')
    expect(screen.getByTestId('deck-outline-item-1').textContent).toContain('Isi Kerangka')
  })

  test('clicking Buat sends the settled template, disables while generating, then reports the verdict', async () => {
    const user = userEvent.setup()
    fileMock.mockResolvedValue(deckFile(stagedDeck))
    let resolveGenerate: (value: unknown) => void = () => undefined
    deckGenerateMock.mockReturnValue(new Promise((resolve) => { resolveGenerate = resolve }))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    useDaedalusStore.getState().setSlideOptions({ templateId: 'ocean' })
    render(<DeckOutlinePanel />)

    const button = await screen.findByTestId('deck-generate')
    await user.click(button)

    expect(deckGenerateMock).toHaveBeenCalledTimes(1)
    expect(deckGenerateMock).toHaveBeenCalledWith('/ws', { template_id: 'ocean' })
    expect((screen.getByTestId('deck-generate') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      resolveGenerate({
        root: '/ws',
        task_id: 't-1',
        outcome: 'success',
        summary: 'done: 2 slide selesai dan ter-export ke deck/deck-kerangka.pptx (42 KB).',
        exported: { path: 'deck/deck-kerangka.pptx', bytes: 43008, slides: 2 },
      })
    })
    const note = await screen.findByTestId('deck-generate-note')
    expect(note.textContent).toContain('ter-export ke deck/deck-kerangka.pptx')
    expect((screen.getByTestId('deck-generate') as HTMLButtonElement).disabled).toBe(false)
  })

  test('a template already applied to the deck wins over the pending composer pick', async () => {
    const user = userEvent.setup()
    fileMock.mockResolvedValue(deckFile({ ...stagedDeck, theme: { templateId: 'general' } }))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    useDaedalusStore.getState().setSlideOptions({ templateId: 'ocean' })
    render(<DeckOutlinePanel />)

    await user.click(await screen.findByTestId('deck-generate'))
    expect(deckGenerateMock).toHaveBeenCalledWith('/ws', { template_id: 'general' })
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

  test('the filmstrip stays in view: the preview region flexes and the strip cannot shrink away', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    const preview = screen.getByTestId('slide-preview')
    const strip = screen.getByTestId('slide-filmstrip')
    // The preview region is the flexible, height-constrained one, so
    // header + preview + filmstrip always fit the stage cell.
    expect(preview.className).toContain('min-h-0')
    expect(preview.className).toContain('flex-1')
    expect(strip.className).toContain('shrink-0')
    // The filmstrip still follows the preview in flow order.
    expect(preview.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByTestId(/^slide-thumb-/)).toHaveLength(3)
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

  test('the variant button regenerates the slide through the engine endpoint, not a task', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-edit-toggle'))
    await user.click(screen.getByTestId('slide-variant'))

    expect(deckRegenerateSlideMock).toHaveBeenCalledTimes(1)
    expect(deckRegenerateSlideMock.mock.calls[0]?.[0]).toBe('/ws')
    expect(deckRegenerateSlideMock.mock.calls[0]?.[1]).toBe('s1')
    // The run settles: the button is usable again and no error is shown.
    expect((screen.getByTestId('slide-variant') as HTMLButtonElement).disabled).toBe(false)
  })

  test('duplicate copies the current slide right after itself and selects the copy', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-edit-toggle'))
    await user.click(screen.getByTestId('slide-duplicate'))

    expect(deckAddSlideMock).toHaveBeenCalledTimes(1)
    const [, payload] = deckAddSlideMock.mock.calls[0] as [string, { layout: string; content: Record<string, unknown>; index?: number }]
    expect(payload.layout).toBe('title')
    expect(payload.content).toEqual(fixtureDeck.slides[0]?.content)
    expect(payload.content).not.toBe(fixtureDeck.slides[0]?.content)
    expect(payload.index).toBe(1)
    expect(useDaedalusStore.getState().slideIndex).toBe(1)
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

describe('SlideWorkspacePanel', () => {
  test('lists the whole workspace tree, with deck/ open and only presentation artifacts openable', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideWorkspacePanel />)

    // Non-deck entries are listed: folders and plain files alike.
    const filePaths = (await screen.findAllByTestId('slide-ws-file')).map((el) => el.getAttribute('data-path'))
    expect(filePaths).toContain('README.md')
    expect(filePaths).toContain('notes.pptx')
    const dirPaths = (await screen.findAllByTestId('slide-ws-dir')).map((el) => el.getAttribute('data-path'))
    expect(dirPaths).toContain('deck')
    expect(dirPaths).toContain('src')

    // deck/ auto-expands: the deck opens the canvas, the pptx downloads.
    expect(await screen.findByTestId('slide-ws-open-deck')).toBeTruthy()
    const download = screen.getByTestId('slide-download-deck-uji.pptx')
    expect(download.getAttribute('href')).toContain('/slides/deck/download')
    expect(download.getAttribute('href')).toContain(encodeURIComponent('deck/deck-uji.pptx'))
    expect(download.getAttribute('download')).toBe('deck-uji.pptx')
  })

  test('folders expand on demand and their files stay listed-only', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideWorkspacePanel />)

    const dirs = await screen.findAllByTestId('slide-ws-dir')
    const src = dirs.find((el) => el.getAttribute('data-path') === 'src')
    expect(src).toBeTruthy()
    await user.click(src as HTMLElement)
    expect(listMock).toHaveBeenCalledWith('/ws', 'src')

    const files = await screen.findAllByTestId('slide-ws-file')
    const index = files.find((el) => el.getAttribute('data-path') === 'src/index.ts')
    expect(index).toBeTruthy()
    // Listed but not openable: a plain row, not a button, clicking reads no file.
    expect((index as HTMLElement).closest('button')).toBeNull()
    await user.click(index as HTMLElement)
    expect(fileMock).not.toHaveBeenCalled()
    expect(useDaedalusStore.getState().openFilePath).toBeNull()
  })

  test('a pptx outside deck/ is listed but gets no download affordance', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideWorkspacePanel />)

    const files = await screen.findAllByTestId('slide-ws-file')
    const notes = files.find((el) => el.getAttribute('data-path') === 'notes.pptx')
    expect(notes).toBeTruthy()
    expect(screen.queryByTestId('slide-download-notes.pptx')).toBeNull()
  })

  test('the deck row focuses the canvas: deck re-reads and selection returns to slide 1', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    useDaedalusStore.getState().setSlideIndex(2)
    render(<SlideWorkspacePanel />)

    const revisionBefore = useDaedalusStore.getState().workspaceRevision
    await userEvent.click(await screen.findByTestId('slide-ws-open-deck'))
    expect(useDaedalusStore.getState().slideIndex).toBe(0)
    expect(useDaedalusStore.getState().workspaceRevision).toBeGreaterThan(revisionBefore)
  })

  test('without a workspace the panel explains itself and lists nothing', () => {
    render(<SlideWorkspacePanel />)
    expect(screen.getByTestId('slide-workspace').textContent).toContain('Buka workspace dulu')
    expect(listMock).not.toHaveBeenCalled()
  })
})

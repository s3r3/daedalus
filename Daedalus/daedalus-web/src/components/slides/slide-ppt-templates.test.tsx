import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeckSpec } from '@daedalus/core'
import { useDaedalusStore } from '../../state/taskStore'
import { SlidePptTemplatesPanel } from './slide-ppt-templates'

const fileMock = vi.fn()
const pptTemplatesMock = vi.fn()
const pptTemplateUploadMock = vi.fn()
const pptTemplateDeleteMock = vi.fn()
const deckThemeMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    file: (...args: unknown[]) => fileMock(...args),
    pptTemplates: (...args: unknown[]) => pptTemplatesMock(...args),
    pptTemplateUpload: (...args: unknown[]) => pptTemplateUploadMock(...args),
    pptTemplateDelete: (...args: unknown[]) => pptTemplateDeleteMock(...args),
    pptTemplateBackgroundUrl: (root: string, id: string) => `/slides/ppt-templates/background?root=${encodeURIComponent(root)}&id=${encodeURIComponent(id)}`,
    deckTheme: (...args: unknown[]) => deckThemeMock(...args),
  },
}))

const fixtureDeck: DeckSpec = {
  version: 1,
  id: 'deck-uji',
  title: 'Deck Uji',
  theme: {},
  slides: [{ id: 's1', layout: 'title', content: { title: 'Judul Besar' } }],
}

const importedTemplate = {
  id: 'emerald-gold',
  name: 'Emerald Gold',
  sourceFile: 'Emerald Gold.pptx',
  createdAt: '2026-10-09T12:00:00.000Z',
  theme: { background: '#0f2d1e', accent: '#c59a46', text: '#f7f3e8', headingFont: 'Georgia', bodyFont: 'Verdana' },
  slideSize: { cx: 12192000, cy: 6858000, label: '16:9' },
}

function deckFile(deck: DeckSpec = fixtureDeck): { path: string; content: string; size: number } {
  const content = JSON.stringify(deck)
  return { path: 'deck/deck.json', content, size: content.length }
}

beforeEach(() => {
  localStorage.clear()
  fileMock.mockReset()
  fileMock.mockResolvedValue(deckFile())
  pptTemplatesMock.mockReset()
  pptTemplatesMock.mockResolvedValue({ root: '/ws', templates: [importedTemplate] })
  pptTemplateUploadMock.mockReset()
  pptTemplateUploadMock.mockResolvedValue({ root: '/ws', template: { ...importedTemplate, id: 'baru', name: 'Baru' } })
  pptTemplateDeleteMock.mockReset()
  pptTemplateDeleteMock.mockResolvedValue({ root: '/ws', id: 'emerald-gold', deleted: true })
  deckThemeMock.mockReset()
  deckThemeMock.mockResolvedValue({ root: '/ws', deck: fixtureDeck })
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/ws' })
})

afterEach(() => cleanup())

describe('SlidePptTemplatesPanel', () => {
  test('lists imported templates with fonts and slide size', async () => {
    render(<SlidePptTemplatesPanel />)
    const item = await screen.findByTestId('slide-ppt-template-emerald-gold')
    expect(item.textContent).toContain('Emerald Gold')
    expect(item.textContent).toContain('Georgia / Verdana')
    expect(item.textContent).toContain('16:9')
  })

  test('clicking a template applies it to the open deck and clears the bundled pending pick', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setSlideOptions({ templateId: 'ocean' })
    render(<SlidePptTemplatesPanel />)

    await user.click(await screen.findByTestId('slide-ppt-template-emerald-gold'))
    expect(deckThemeMock).toHaveBeenCalledWith('/ws', { custom_template_id: 'emerald-gold' })
    expect(useDaedalusStore.getState().slideOptions.templateId).toBeNull()
  })

  test('upload sends the picked file and refreshes the list', async () => {
    const user = userEvent.setup()
    render(<SlidePptTemplatesPanel />)
    await screen.findByTestId('slide-ppt-template-emerald-gold')

    const input = screen.getByTestId('slide-ppt-template-file') as HTMLInputElement
    await user.upload(input, new File(['pptx-bytes'], 'Baru.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }))

    expect(pptTemplateUploadMock).toHaveBeenCalledTimes(1)
    expect(pptTemplatesMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(await screen.findByTestId('slide-ppt-template-note')).toBeTruthy()
  })

  test('an oversize file is refused in the panel without uploading', async () => {
    const user = userEvent.setup()
    render(<SlidePptTemplatesPanel />)
    await screen.findByTestId('slide-ppt-template-emerald-gold')

    const input = screen.getByTestId('slide-ppt-template-file') as HTMLInputElement
    const big = new File(['pptx-bytes'], 'Raksasa.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
    Object.defineProperty(big, 'size', { value: 150 * 1024 * 1024 })
    await user.upload(input, big)

    expect(pptTemplateUploadMock).not.toHaveBeenCalled()
    expect((await screen.findByText(/melebihi batas 100 MB/)).textContent).toContain('150,0')
  })

  test('delete removes the template through the API and refreshes', async () => {
    const user = userEvent.setup()
    render(<SlidePptTemplatesPanel />)
    await user.click(await screen.findByTestId('slide-ppt-template-delete-emerald-gold'))
    expect(pptTemplateDeleteMock).toHaveBeenCalledWith('/ws', 'emerald-gold')
  })

  test('without a deck, clicking selects the template for the next deck instead of calling the theme endpoint', async () => {
    const user = userEvent.setup()
    fileMock.mockRejectedValue(new Error('404 Not Found'))
    render(<SlidePptTemplatesPanel />)

    await user.click(await screen.findByTestId('slide-ppt-template-emerald-gold'))
    expect(deckThemeMock).not.toHaveBeenCalled()
    expect((await screen.findByTestId('slide-ppt-template-note')).textContent).toContain('dipilih untuk deck berikutnya')
    expect(useDaedalusStore.getState().slideOptions.customTemplateId).toBe('emerald-gold')
    expect(useDaedalusStore.getState().slideOptions.templateId).toBeNull()
  })

  test('a template with parsed pages shows its design summary; a skin-only one invites a re-import', async () => {
    const paged = {
      ...importedTemplate,
      id: 'berhalaman',
      name: 'Berhalaman',
      pages: [
        { kind: 'cover', slots: [] },
        { kind: 'toc', slots: [] },
        { kind: 'section', slots: [] },
        { kind: 'content', slots: [] },
        { kind: 'content', slots: [] },
        { kind: 'closing', slots: [] },
      ],
    }
    pptTemplatesMock.mockResolvedValue({ root: '/ws', templates: [paged, importedTemplate] })
    render(<SlidePptTemplatesPanel />)

    const summary = await screen.findByTestId('slide-ppt-template-pages-berhalaman')
    expect(summary.textContent).toContain('6 halaman')
    expect(summary.textContent).toContain('sampul')
    expect(summary.textContent).toContain('isi ×2')
    expect(summary.textContent).toContain('penutup')

    const skinItem = await screen.findByTestId('slide-ppt-template-emerald-gold')
    expect(skinItem.textContent).toContain('Impor ulang untuk memakai desain halamannya')
    expect(screen.queryByTestId('slide-ppt-template-pages-emerald-gold')).toBeNull()
  })

  test('an applied template shows its active state from the deck theme', async () => {
    fileMock.mockResolvedValue(deckFile({ ...fixtureDeck, theme: { customTemplateId: 'emerald-gold', background: '#0f2d1e' } }))
    render(<SlidePptTemplatesPanel />)
    const item = await screen.findByTestId('slide-ppt-template-emerald-gold')
    expect(item.getAttribute('aria-pressed')).toBe('true')
  })
})

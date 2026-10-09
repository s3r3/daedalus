import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeckSpec } from '@daedalus/core'
import { BUILTIN_TEMPLATES } from '@daedalus/core/slides/builtin-templates'
import { useDaedalusStore } from '../../state/taskStore'
import { SlideBuiltinTemplatesPanel } from './slide-builtin-templates'
import { SlidePptTemplatesPanel } from './slide-ppt-templates'

const fileMock = vi.fn()
const builtinTemplatesMock = vi.fn()
const pptTemplatesMock = vi.fn()
const pptTemplateUploadMock = vi.fn()
const pptTemplateDeleteMock = vi.fn()
const deckThemeMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    file: (...args: unknown[]) => fileMock(...args),
    builtinTemplates: (...args: unknown[]) => builtinTemplatesMock(...args),
    pptTemplates: (...args: unknown[]) => pptTemplatesMock(...args),
    pptTemplateUpload: (...args: unknown[]) => pptTemplateUploadMock(...args),
    pptTemplateDelete: (...args: unknown[]) => pptTemplateDeleteMock(...args),
    pptTemplateBackgroundUrl: (root: string, id: string) => `/slides/ppt-templates/background?root=${encodeURIComponent(root)}&id=${encodeURIComponent(id)}`,
    deckTheme: (...args: unknown[]) => deckThemeMock(...args),
  },
}))

const builtinInfos = BUILTIN_TEMPLATES.map((template) => ({
  id: template.id,
  name: template.name,
  description: template.description,
  skinId: template.skinId,
  theme: template.theme,
  design: template.design,
  furniture: template.furniture,
  typography: template.typography,
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
  builtinTemplatesMock.mockReset()
  builtinTemplatesMock.mockResolvedValue({ templates: builtinInfos })
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

describe('Template gallery (Template bawaan + Template impor)', () => {
  test('both sections render: built-in design cards beside the imported list', async () => {
    render(
      <>
        <SlideBuiltinTemplatesPanel />
        <SlidePptTemplatesPanel />
      </>,
    )
    expect(await screen.findByTestId('slide-builtin-templates')).toBeTruthy()
    expect(await screen.findByTestId('slide-ppt-templates')).toBeTruthy()
    for (const id of ['standar', 'editorial', 'arena', 'cendekia', 'galeri', 'verve']) {
      expect(await screen.findByTestId(`slide-builtin-template-${id}`)).toBeTruthy()
    }
    expect(await screen.findByTestId('slide-ppt-template-emerald-gold')).toBeTruthy()
  })

  test('clicking a built-in card applies the design to the open deck and retires a pending PPT pick', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setSlideOptions({ customTemplateId: 'emerald-gold' })
    render(<SlideBuiltinTemplatesPanel />)

    await user.click(await screen.findByTestId('slide-builtin-template-galeri'))
    expect(deckThemeMock).toHaveBeenCalledWith('/ws', { design_id: 'galeri' })
    const options = useDaedalusStore.getState().slideOptions
    expect(options.designId).toBe('galeri')
    expect(options.customTemplateId).toBeNull()
  })

  test('without a deck, clicking a built-in card selects it for the next generation only', async () => {
    const user = userEvent.setup()
    fileMock.mockRejectedValue(new Error('404 Not Found'))
    render(<SlideBuiltinTemplatesPanel />)

    await user.click(await screen.findByTestId('slide-builtin-template-arena'))
    expect(deckThemeMock).not.toHaveBeenCalled()
    expect(useDaedalusStore.getState().slideOptions.designId).toBe('arena')
  })
})

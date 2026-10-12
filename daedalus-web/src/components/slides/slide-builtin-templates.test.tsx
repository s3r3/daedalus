import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeckSpec } from '@daedalus/core'
import { BUILTIN_TEMPLATES } from '@daedalus/core/slides/builtin-templates'
import { useDaedalusStore } from '../../state/taskStore'
import { SlideDesignPanel } from './slide-design-panel'

const fileMock = vi.fn()
const builtinTemplatesMock = vi.fn()
const slideTemplatesMock = vi.fn()
const deckThemeMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    file: (...args: unknown[]) => fileMock(...args),
    builtinTemplates: (...args: unknown[]) => builtinTemplatesMock(...args),
    slideTemplates: (...args: unknown[]) => slideTemplatesMock(...args),
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

const skinInfos = [
  { id: 'general', name: 'General', description: 'Default', theme: { background: '#201f26', accent: '#6b50ff', text: '#ecebf0', headingFont: 'Arial', bodyFont: 'Arial' } },
  { id: 'ocean', name: 'Ocean', description: 'Biru laut', theme: { background: '#0e2a47', accent: '#2dd4bf', text: '#e8f4ff', headingFont: 'Verdana', bodyFont: 'Arial' } },
]

const fixtureDeck: DeckSpec = {
  version: 1,
  id: 'deck-uji',
  title: 'Deck Uji',
  theme: {},
  slides: [{ id: 's1', layout: 'title', content: { title: 'Judul Besar' } }],
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
  slideTemplatesMock.mockReset()
  slideTemplatesMock.mockResolvedValue({ templates: skinInfos })
  deckThemeMock.mockReset()
  deckThemeMock.mockResolvedValue({ root: '/ws', deck: fixtureDeck })
  useDaedalusStore.getState().reset()
  useDaedalusStore.getState().setWorkspace({ root: '/ws' })
})

afterEach(() => cleanup())

describe('SlideDesignPanel (merged Desain panel)', () => {
  test('renders one panel with both sections: Desain bawaan cards and Warna & Font skins', async () => {
    render(<SlideDesignPanel />)

    const panel = await screen.findByTestId('slide-design-panel')
    expect(panel.textContent).toContain('Desain')
    expect(screen.getByText('Desain bawaan')).toBeTruthy()
    expect(screen.getByText('Warna & Font')).toBeTruthy()
    // The old standalone panel titles are gone: one merged panel only.
    expect(screen.queryByText('Template bawaan')).toBeNull()
    expect(screen.queryByText('Template impor')).toBeNull()

    for (const id of ['standar', 'editorial', 'arena', 'cendekia', 'galeri', 'verve']) {
      expect(await screen.findByTestId(`slide-builtin-template-${id}`)).toBeTruthy()
    }
    expect(await screen.findByTestId('slide-template-general')).toBeTruthy()
    expect(await screen.findByTestId('slide-template-ocean')).toBeTruthy()
  })

  test('clicking a built-in card applies the design to the open deck and retires a pending PPT pick', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setSlideOptions({ customTemplateId: 'emerald-gold' })
    render(<SlideDesignPanel />)

    await user.click(await screen.findByTestId('slide-builtin-template-galeri'))
    expect(deckThemeMock).toHaveBeenCalledWith('/ws', { design_id: 'galeri' })
    const options = useDaedalusStore.getState().slideOptions
    expect(options.designId).toBe('galeri')
    expect(options.customTemplateId).toBeNull()
  })

  test('clicking a skin applies it through the same API, keeping the design layer', async () => {
    const user = userEvent.setup()
    render(<SlideDesignPanel />)

    await user.click(await screen.findByTestId('slide-template-ocean'))
    expect(deckThemeMock).toHaveBeenCalledWith('/ws', { template_id: 'ocean' })
    expect(useDaedalusStore.getState().slideOptions.templateId).toBe('ocean')
  })

  test('without a deck, picks select for the next generation only', async () => {
    const user = userEvent.setup()
    fileMock.mockRejectedValue(new Error('404 Not Found'))
    render(<SlideDesignPanel />)

    await user.click(await screen.findByTestId('slide-builtin-template-arena'))
    expect(deckThemeMock).not.toHaveBeenCalled()
    expect(useDaedalusStore.getState().slideOptions.designId).toBe('arena')

    await user.click(await screen.findByTestId('slide-template-general'))
    expect(deckThemeMock).not.toHaveBeenCalled()
    expect(useDaedalusStore.getState().slideOptions.templateId).toBe('general')
  })
})

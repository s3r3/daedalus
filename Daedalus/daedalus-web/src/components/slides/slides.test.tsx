import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeckSpec, Slide } from '@daedalus/core'
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
const builtinTemplatesMock = vi.fn()
const deckRegenerateSlideMock = vi.fn()
const listMock = vi.fn()
const deckGenerateMock = vi.fn()
const deckUploadAssetMock = vi.fn()
const pptTemplatesMock = vi.fn()
const deckPreviewMock = vi.fn()
const deckPreviewRenderMock = vi.fn()

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
    builtinTemplates: (...args: unknown[]) => builtinTemplatesMock(...args),
    deckGenerate: (...args: unknown[]) => deckGenerateMock(...args),
    deckDownloadUrl: (root: string, path: string) => `/slides/deck/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    deckRegenerateSlide: (...args: unknown[]) => deckRegenerateSlideMock(...args),
    deckUploadAsset: (...args: unknown[]) => deckUploadAssetMock(...args),
    deckAssetUrl: (root: string, name: string) => `/slides/deck/asset?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`,
    deckPreview: (...args: unknown[]) => deckPreviewMock(...args),
    deckPreviewRender: (...args: unknown[]) => deckPreviewRenderMock(...args),
    deckPreviewPageUrl: (root: string, key: string, page: number) => `/slides/deck/preview/page?root=${encodeURIComponent(root)}&key=${key}&page=${page}`,
    pptTemplates: (...args: unknown[]) => pptTemplatesMock(...args),
    pptTemplateAssetUrl: (root: string, id: string, file: string) => `/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`,
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
  builtinTemplatesMock.mockReset()
  builtinTemplatesMock.mockResolvedValue({
    templates: [
      {
        id: 'galeri',
        name: 'Galeri Mono',
        description: 'Hitam-putih tegas, bingkai emas tipis.',
        skinId: 'mono-luxe',
        theme: { background: '#101014', accent: '#d4af37', text: '#f4f1ea', headingFont: 'Georgia', bodyFont: 'Arial' },
        design: { cover: ['title'], toc: ['agenda-toc'], section: ['section'], content: ['bullets'], visual: ['image-side'], chart: ['chart-bar'], closing: ['closing'] },
        furniture: { elements: [], pageChip: null, titleTreatment: 'underline' },
        typography: { titleScale: 1.15 },
      },
    ],
  })
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
  deckUploadAssetMock.mockReset()
  deckUploadAssetMock.mockResolvedValue({ root: '/ws', name: 'foto-unggahan.png', path: 'deck/assets/foto-unggahan.png', size: 4321 })
  pptTemplatesMock.mockReset()
  pptTemplatesMock.mockResolvedValue({ root: '/ws', templates: [] })
  deckPreviewMock.mockReset()
  deckPreviewMock.mockResolvedValue({ root: '/ws', available: true, status: 'idle', key: 'c'.repeat(64), pages: 0 })
  deckPreviewRenderMock.mockReset()
  deckPreviewRenderMock.mockResolvedValue({ root: '/ws', available: true, status: 'rendering', key: 'c'.repeat(64), pages: 0 })
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

describe('SlideRenderer new layouts (library expansion)', () => {
  const renderLayout = (layout: string, content: Record<string, unknown>): void => {
    const slide: Slide = { id: `t-${layout}`, layout, content }
    render(<SlideRenderer slide={slide} theme={{}} />)
    expect(screen.getByTestId('slide-renderer').getAttribute('data-layout')).toBe(layout)
  }

  test('numbered-steps renders zero-padded numbers and step copy', () => {
    renderLayout('numbered-steps', {
      title: 'Agenda Rapat',
      steps: [
        { title: 'Pembukaan', desc: 'Sambutan ketua' },
        { title: 'Pembahasan', desc: 'Materi utama' },
      ],
    })
    expect(screen.getByText('01')).toBeTruthy()
    expect(screen.getByText('02')).toBeTruthy()
    expect(screen.getByText('Pembukaan')).toBeTruthy()
    expect(screen.getByText('Materi utama')).toBeTruthy()
  })

  test('code-focus renders the code text and language tag', () => {
    renderLayout('code-focus', { title: 'Inti Kode', code: 'const jawaban = 42;', language: 'ts', points: ['Konstanta murni'] })
    expect(screen.getByText(/const jawaban = 42;/)).toBeTruthy()
    expect(screen.getByText('ts')).toBeTruthy()
    expect(screen.getByText('Konstanta murni')).toBeTruthy()
  })

  test('chevron-process renders every stage title and description', () => {
    renderLayout('chevron-process', {
      title: 'Alur',
      steps: [{ title: 'Pengajuan', desc: 'Usulan masuk' }, { title: 'Telaah', desc: 'Diperiksa tim' }, { title: 'Sah', desc: 'Diterbitkan' }],
    })
    expect(screen.getByText('Pengajuan')).toBeTruthy()
    expect(screen.getByText('Telaah')).toBeTruthy()
    expect(screen.getByText('Diperiksa tim')).toBeTruthy()
  })

  test('diagram-pyramid renders tier labels top to bottom', () => {
    renderLayout('diagram-pyramid', { title: 'Tingkatan', tiers: [{ label: 'Visi' }, { label: 'Strategi' }, { label: 'Operasi' }] })
    expect(screen.getByText('Visi')).toBeTruthy()
    expect(screen.getByText('Strategi')).toBeTruthy()
    expect(screen.getByText('Operasi')).toBeTruthy()
  })

  test('roadmap renders phase labels and their items', () => {
    renderLayout('roadmap', {
      title: 'Peta Jalan',
      phases: [
        { label: 'Fase Fondasi', items: ['Riset awal'] },
        { label: 'Fase Bangun', items: ['Fitur inti'] },
        { label: 'Fase Rilis', items: ['Beta publik'] },
      ],
    })
    expect(screen.getByText('Fase Fondasi')).toBeTruthy()
    expect(screen.getByText('Riset awal')).toBeTruthy()
    expect(screen.getByText('Beta publik')).toBeTruthy()
  })

  test('versus renders both panels, the VS badge and the verdict', () => {
    renderLayout('versus', {
      title: 'Duel',
      left: { title: 'Opsi Lama', points: ['Manual'] },
      right: { title: 'Opsi Baru', points: ['Otomatis'] },
      verdict: 'Opsi baru menang',
    })
    expect(screen.getByText('Opsi Lama')).toBeTruthy()
    expect(screen.getByText('Opsi Baru')).toBeTruthy()
    expect(screen.getByText('VS')).toBeTruthy()
    expect(screen.getByText('Opsi baru menang')).toBeTruthy()
  })

  test('matrix-quadrant renders axes and quadrant content', () => {
    renderLayout('matrix-quadrant', {
      title: 'Matriks',
      xAxis: 'Sumbu dampak',
      yAxis: 'Sumbu upaya',
      quadrants: [
        { label: 'Kerjakan Dulu', items: ['Perbaikan kritis'] },
        { label: 'Jadwalkan', items: ['Fitur besar'] },
        { label: 'Delegasikan', items: ['Tugas rutin'] },
        { label: 'Singkirkan', items: ['Eksperimen lama'] },
      ],
    })
    expect(screen.getByText('Sumbu dampak')).toBeTruthy()
    expect(screen.getByText('Sumbu upaya')).toBeTruthy()
    expect(screen.getByText('Kerjakan Dulu')).toBeTruthy()
    expect(screen.getByText('Eksperimen lama')).toBeTruthy()
  })

  test('big-stat renders the hero value, label and supporting points', () => {
    renderLayout('big-stat', { title: 'Hasil', value: '92%', label: 'Tugas tuntas', points: ['Konteks angka'] })
    expect(screen.getByText('92%')).toBeTruthy()
    expect(screen.getByText('Tugas tuntas')).toBeTruthy()
    expect(screen.getByText('Konteks angka')).toBeTruthy()
  })

  test('testimonial renders quote, person and metric chips', () => {
    renderLayout('testimonial', {
      text: 'Alurnya mengubah cara kami bekerja.',
      name: 'Andini Prameswari',
      role: 'Ketua Tim',
      metrics: [{ value: '3x', label: 'Lebih cepat' }],
    })
    expect(screen.getByText(/mengubah cara kami bekerja/)).toBeTruthy()
    expect(screen.getByText('Andini Prameswari')).toBeTruthy()
    expect(screen.getByText('AP')).toBeTruthy()
    expect(screen.getByText(/Lebih cepat/)).toBeTruthy()
  })

  test('profile-cards renders names, roles, notes and initials', () => {
    renderLayout('profile-cards', {
      title: 'Tim',
      people: [
        { name: 'Andini Prameswari', role: 'Ketua Tim', note: 'Menjaga arah' },
        { name: 'Bagas Nugraha', role: 'Insinyur', note: 'Memegang inti' },
        { name: 'Citra Lestari', role: 'Desainer', note: 'Merancang alur' },
      ],
    })
    expect(screen.getByText('Bagas Nugraha')).toBeTruthy()
    expect(screen.getByText('BN')).toBeTruthy()
    expect(screen.getByText('Merancang alur')).toBeTruthy()
  })

  test('glossary renders terms and definitions', () => {
    renderLayout('glossary', {
      title: 'Istilah',
      terms: [
        { term: 'Agent', definition: 'Pelaksana langkah kerja' },
        { term: 'Prompt', definition: 'Instruksi pengguna' },
        { term: 'Deck', definition: 'Kumpulan slide' },
        { term: 'Layout', definition: 'Tata letak slide' },
      ],
    })
    expect(screen.getByText('Agent')).toBeTruthy()
    expect(screen.getByText('Pelaksana langkah kerja')).toBeTruthy()
    expect(screen.getByText('Tata letak slide')).toBeTruthy()
  })

  test('mosaic renders honest placeholders and the caption', () => {
    renderLayout('mosaic', {
      title: 'Galeri',
      caption: 'Dokumentasi lapangan',
      tiles: [
        { image: 'utama.png', alt: 'Tampilan utama' },
        { image: 'detail.png', alt: 'Detail' },
        { image: 'proses.png', alt: 'Proses' },
        { image: 'hasil.png', alt: 'Hasil' },
      ],
    })
    expect(screen.getByText('utama.png')).toBeTruthy()
    expect(screen.getByText('Tampilan utama')).toBeTruthy()
    expect(screen.getByText('Dokumentasi lapangan')).toBeTruthy()
  })
})

describe('SlideRenderer 50-expansion layouts', () => {
  const renderLayout = (layout: string, content: Record<string, unknown>): void => {
    const slide: Slide = { id: `t-${layout}`, layout, content }
    render(<SlideRenderer slide={slide} theme={{}} />)
    expect(screen.getByTestId('slide-renderer').getAttribute('data-layout')).toBe(layout)
  }

  test('agenda-toc renders numbered rows with page pills', () => {
    renderLayout('agenda-toc', {
      title: 'Agenda',
      items: [{ label: 'Bab Konteks', page: '02' }, { label: 'Bab Bukti', page: '05' }, { label: 'Bab Usulan', page: '09' }],
    })
    expect(screen.getByText('01')).toBeTruthy()
    expect(screen.getByText('Bab Bukti')).toBeTruthy()
    expect(screen.getByText('09')).toBeTruthy()
  })

  test('kpi-band renders values, labels and delta chips', () => {
    renderLayout('kpi-band', {
      title: 'Kinerja',
      kpis: [
        { value: '92,4%', label: 'Tugas tuntas', delta: '+6,1 pt', deltaUp: true },
        { value: '31 mnt', label: 'Median selesai', delta: '-8 mnt', deltaUp: false },
        { value: '4,7/5', label: 'Kepuasan', delta: '+0,3', deltaUp: true },
      ],
    })
    expect(screen.getByText('92,4%')).toBeTruthy()
    expect(screen.getByText(/\+6,1 pt/)).toBeTruthy()
    expect(screen.getByText(/-8 mnt/)).toBeTruthy()
  })

  test('funnel renders stage labels, percentages and descriptions', () => {
    renderLayout('funnel', {
      title: 'Corong',
      stages: [
        { label: 'Prompt masuk', value: 100, desc: 'Semua diterima' },
        { label: 'Outline', value: 78, desc: 'Terstruktur' },
        { label: 'PPTX terkirim', value: 41, desc: 'Final' },
      ],
    })
    expect(screen.getByText('Prompt masuk')).toBeTruthy()
    expect(screen.getByText('78%')).toBeTruthy()
    expect(screen.getByText('Terstruktur')).toBeTruthy()
  })

  test('gantt-bars renders bar labels, axis labels and notes', () => {
    renderLayout('gantt-bars', {
      title: 'Jadwal',
      startLabel: 'Minggu 1',
      endLabel: 'Minggu 16',
      bars: [
        { label: 'Riset', start: 0, span: 25, note: 'bab 1' },
        { label: 'Implementasi', start: 15, span: 38, note: 'mesin' },
        { label: 'Uji', start: 62, span: 22, note: 'responden' },
      ],
    })
    expect(screen.getByText('Implementasi')).toBeTruthy()
    expect(screen.getByText('Minggu 16')).toBeTruthy()
    expect(screen.getByText('responden')).toBeTruthy()
  })

  test('org-chart renders the root, reports and member chips', () => {
    renderLayout('org-chart', {
      title: 'Struktur',
      root: { name: 'Andini Prameswari', role: 'Ketua' },
      reports: [
        { name: 'Bagas Nugraha', role: 'Mesin', members: ['Raka', 'Sinta'] },
        { name: 'Citra Lestari', role: 'Desain', members: ['Dewi'] },
      ],
    })
    expect(screen.getByText('Andini Prameswari')).toBeTruthy()
    expect(screen.getByText('Bagas Nugraha')).toBeTruthy()
    expect(screen.getByText('Sinta')).toBeTruthy()
  })

  test('pros-cons renders both columns with their headings and points', () => {
    renderLayout('pros-cons', {
      title: 'Timbang',
      pros: { title: 'Keuntungan', points: ['Terisolasi rapi'] },
      cons: { title: 'Biaya', points: ['Dua mesin dirawat'] },
    })
    expect(screen.getByText('Keuntungan')).toBeTruthy()
    expect(screen.getByText('Terisolasi rapi')).toBeTruthy()
    expect(screen.getByText('Dua mesin dirawat')).toBeTruthy()
  })

  test('pricing-tiers renders names, prices, features and the featured tag', () => {
    renderLayout('pricing-tiers', {
      title: 'Paket',
      tiers: [
        { name: 'Dasar', price: 'Rp0', features: ['Inti'] },
        { name: 'Tim', price: 'Rp149rb', features: ['Lengkap'], featured: true },
        { name: 'Institusi', price: 'Kontak', features: ['Semua'] },
      ],
    })
    expect(screen.getByText('Rp149rb')).toBeTruthy()
    expect(screen.getByText('Paling dipilih')).toBeTruthy()
    expect(screen.getByText('Lengkap')).toBeTruthy()
  })

  test('faq renders questions and answers', () => {
    renderLayout('faq', {
      title: 'Tanya Jawab',
      items: [
        { q: 'Mengapa dipisah?', a: 'Agar terisolasi.' },
        { q: 'Tema apa saja?', a: 'Lima tema bawaan.' },
        { q: 'Bisa unggah gambar?', a: 'Klik placeholder.' },
      ],
    })
    expect(screen.getByText('Mengapa dipisah?')).toBeTruthy()
    expect(screen.getByText('Lima tema bawaan.')).toBeTruthy()
  })

  test('steps-cards renders card titles and descriptions', () => {
    renderLayout('steps-cards', {
      title: 'Langkah',
      steps: [
        { icon: 'pen-line', title: 'Tulis prompt', desc: 'Topik dipilih' },
        { icon: 'list-tree', title: 'Tinjau outline', desc: 'Kerangka tampil' },
        { icon: 'download', title: 'Unduh PPTX', desc: 'Siap presentasi' },
      ],
    })
    expect(screen.getByText(/Tulis prompt/)).toBeTruthy()
    expect(screen.getByText('Kerangka tampil')).toBeTruthy()
  })

  test('split-visual-quote renders the quote, author and image placeholder', () => {
    renderLayout('split-visual-quote', {
      quote: 'Argumen bisa diperiksa sebelum dipresentasikan.',
      author: 'Dr. Ratna Wulandari',
      role: 'Pembimbing',
      alt: 'Foto bimbingan',
    })
    expect(screen.getByText(/Argumen bisa diperiksa/)).toBeTruthy()
    expect(screen.getByText('Dr. Ratna Wulandari')).toBeTruthy()
    expect(screen.getByText('Foto bimbingan')).toBeTruthy()
  })

  test('banner-cta renders the statement, both CTA chips and the small print', () => {
    renderLayout('banner-cta', {
      title: 'Siap Mencoba?',
      subtitle: 'Satu prompt saja.',
      primary: 'Mulai Buat Deck',
      secondary: 'Lihat Contoh',
      note: 'Tanpa kartu kredit.',
    })
    expect(screen.getByText('Mulai Buat Deck')).toBeTruthy()
    expect(screen.getByText('Lihat Contoh')).toBeTruthy()
    expect(screen.getByText('Tanpa kartu kredit.')).toBeTruthy()
  })

  test('logo-wall renders monogram tiles with names', () => {
    renderLayout('logo-wall', {
      title: 'Dipercaya',
      logos: [{ name: 'Lab Sistem' }, { name: 'Klinik Bahasa' }, { name: 'Pusat Karier' }, { name: 'Studio Desain' }, { name: 'Komunitas Data' }, { name: 'Unit Film' }],
    })
    expect(screen.getByText('Klinik Bahasa')).toBeTruthy()
    expect(screen.getByText('LS')).toBeTruthy()
  })

  test('year-markers renders giant years with labels', () => {
    renderLayout('year-markers', {
      title: 'Perjalanan',
      years: [
        { year: '2024', label: 'Fondasi', desc: 'Agen pertama' },
        { year: '2025', label: 'Canvas', desc: 'Editor web' },
        { year: '2026', label: 'Lima Puluh', desc: 'Perpustakaan layout' },
      ],
    })
    expect(screen.getByText('2025')).toBeTruthy()
    expect(screen.getByText('Lima Puluh')).toBeTruthy()
  })

  test('stat-duel renders both numbers and the delta pill', () => {
    renderLayout('stat-duel', {
      title: 'Duel',
      left: { value: '38%', label: 'Sebelum validator' },
      right: { value: '94%', label: 'Sesudah validator' },
      delta: '+56 pt',
    })
    expect(screen.getByText('38%')).toBeTruthy()
    expect(screen.getByText('94%')).toBeTruthy()
    expect(screen.getByText('+56 pt')).toBeTruthy()
  })

  test('waterfall-steps renders descending step labels', () => {
    renderLayout('waterfall-steps', {
      title: 'Tangga',
      steps: [
        { label: 'Topik diterima', desc: 'Semua masuk' },
        { label: 'Outline disetujui', desc: 'Kerangka tetap' },
        { label: 'Deck final', desc: 'Siap tampil' },
      ],
    })
    expect(screen.getByText('Topik diterima')).toBeTruthy()
    expect(screen.getByText('Deck final')).toBeTruthy()
  })

  test('feature-highlight renders title, lead and checkmarks', () => {
    renderLayout('feature-highlight', {
      title: 'Validator Kepadatan',
      icon: 'shield-check',
      lead: 'Setiap slide diperiksa sebelum tampil.',
      checks: ['Menolak poin berlebih', 'Aset diverifikasi'],
    })
    expect(screen.getByText('Validator Kepadatan')).toBeTruthy()
    expect(screen.getByText('Menolak poin berlebih')).toBeTruthy()
  })

  test('callout renders headline, body and points', () => {
    renderLayout('callout', {
      title: 'Perhatian: Aset Harus Ada',
      body: 'Slide bergambar gagal validasi bila asetnya hilang.',
      tone: 'warning',
      points: ['Format PNG didukung'],
    })
    expect(screen.getByText('Perhatian: Aset Harus Ada')).toBeTruthy()
    expect(screen.getByText(/gagal validasi/)).toBeTruthy()
    expect(screen.getByText('Format PNG didukung')).toBeTruthy()
  })

  test('ranking-list renders ranked labels and values', () => {
    renderLayout('ranking-list', {
      title: 'Peringkat',
      entries: [
        { label: 'Pembuka judul', value: 96, note: 'utama' },
        { label: 'Poin berurutan', value: 88, note: 'isi' },
        { label: 'Diagram alur', value: 74, note: 'visual' },
      ],
    })
    expect(screen.getByText('Pembuka judul')).toBeTruthy()
    expect(screen.getByText('96')).toBeTruthy()
  })

  test('hero-image-caption renders the image placeholder, title and caption', () => {
    renderLayout('hero-image-caption', {
      image: 'hero-workshop.png',
      alt: 'Lokakarya',
      title: 'Lokakarya Perdana',
      caption: 'Dua puluh peserta hadir.',
    })
    expect(screen.getByText('hero-workshop.png')).toBeTruthy()
    expect(screen.getByText('Lokakarya Perdana')).toBeTruthy()
    expect(screen.getByText('Dua puluh peserta hadir.')).toBeTruthy()
  })

  test('quote-wall renders three testimonial cards', () => {
    renderLayout('quote-wall', {
      title: 'Kata Mereka',
      quotes: [
        { text: 'Sangat membantu proses bimbingan.', name: 'Sari Melati', role: 'Asisten' },
        { text: 'Jauh lebih rapi dari sebelumnya.', name: 'Raka Pradana', role: 'Mahasiswa' },
        { text: 'Klik placeholder dan selesai.', name: 'Gita Savitri', role: 'Staf' },
      ],
    })
    expect(screen.getByText('Sari Melati')).toBeTruthy()
    expect(screen.getByText('Klik placeholder dan selesai.')).toBeTruthy()
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
    expect(deckGenerateMock).toHaveBeenCalledWith('/ws', { template_id: 'ocean', design_id: 'standar' })
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
    expect(deckGenerateMock).toHaveBeenCalledWith('/ws', { template_id: 'general', design_id: 'standar' })
  })
})

describe('DeckOutlinePanel staged refresh (2026-10-09 hang regression)', () => {
  test('a deck read that failed before staging recovers when the run announces its write; Buat renders without a manual refresh', async () => {
    fileMock.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat '/ws/deck/deck.json'"))
    fileMock.mockResolvedValue(deckFile(stagedDeck))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<DeckOutlinePanel />)

    // The incident state: the pre-run read failed and latched — no
    // outline, no Buat, the staged run waits unreachable.
    expect(await screen.findByText(/Tidak ada deck/)).toBeTruthy()
    expect(screen.queryByTestId('deck-generate')).toBeNull()

    // The engine announces the staged deck write (FILE_CHANGED); the
    // store turns it into the refresh signal and the panel re-reads on
    // its own — the button the engine waits for finally renders.
    act(() => {
      useDaedalusStore.getState().appendEvent({
        task_id: 't-hang',
        seq: 1,
        type: 'FILE_CHANGED',
        payload: { call_id: 'slide-deck-1', path: 'deck/deck.json', tool: 'slide-engine', operation: 'created', added: 24, removed: 0, lines: [], patch: '' },
        ts: new Date().toISOString(),
      } as never)
    })

    const button = await screen.findByTestId('deck-generate')
    expect(button.textContent).toContain('Buat')
    expect(screen.getByTestId('deck-outline-item-1').textContent).toContain('Isi Kerangka')
  })

  test('later task activity re-reads a deck whose first read failed (no signal missed can latch)', async () => {
    fileMock.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat '/ws/deck/deck.json'"))
    fileMock.mockResolvedValue(deckFile(stagedDeck))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<DeckOutlinePanel />)
    expect(await screen.findByText(/Tidak ada deck/)).toBeTruthy()
    expect(screen.queryByTestId('deck-generate')).toBeNull()

    // A plain progress event (no FILE_CHANGED): task activity alone
    // re-reads while a run is active, so a missed signal cannot leave
    // the checkpoint hidden behind the latched error.
    act(() => {
      useDaedalusStore.getState().appendEvent({
        task_id: 't-hang',
        seq: 2,
        type: 'THOUGHT',
        payload: { text: 'Outline selesai dan tersimpan sebagai kerangka deck' },
        ts: new Date().toISOString(),
      } as never)
    })

    expect(await screen.findByTestId('deck-generate')).toBeTruthy()
  })

  test('the failed deck read offers a retry that re-reads and reveals the staged outline', async () => {
    const user = userEvent.setup()
    fileMock.mockRejectedValueOnce(new Error("ENOENT: no such file or directory, stat '/ws/deck/deck.json'"))
    fileMock.mockResolvedValue(deckFile(stagedDeck))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<DeckOutlinePanel />)

    const retry = await screen.findByTestId('deck-outline-retry')
    await user.click(retry)
    expect(await screen.findByTestId('deck-generate')).toBeTruthy()
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

describe('SlideStage Pratinjau Asli', () => {
  test('toggle switches to the true-preview view; without LibreOffice it shows the honest unavailable state and no edit affordances', async () => {
    deckPreviewMock.mockResolvedValue({ root: '/ws', available: false, status: 'unavailable', key: 'a'.repeat(64), pages: 0 })
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    expect(screen.getByTestId('slide-preview')).toBeTruthy()
    await user.click(screen.getByTestId('slide-view-preview'))

    const unavailable = await screen.findByTestId('slide-preview-unavailable')
    expect(unavailable.textContent).toContain('LibreOffice')
    expect(deckPreviewMock).toHaveBeenCalledWith('/ws')
    // The editable canvas and its edit affordances leave the stage.
    expect(screen.queryByTestId('slide-preview')).toBeNull()
    expect(screen.queryByTestId('slide-edit-toggle')).toBeNull()
    expect(screen.queryByTestId('slide-preview-render')).toBeNull()
    expect(screen.getByTestId('slide-preview-caption').textContent).toContain('LibreOffice')
  })

  test('ready render shows page images; filmstrip switches pages; Perbarui re-renders on demand', async () => {
    const key = 'b'.repeat(64)
    const pageUrls = [1, 2, 3].map((page) => `/slides/deck/preview/page?root=%2Fws&key=${key}&page=${page}`)
    const ready = { root: '/ws', available: true, status: 'ready', key, pages: 3, pageUrls }
    deckPreviewMock.mockResolvedValue(ready)
    deckPreviewRenderMock.mockResolvedValue(ready)
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-view-preview'))

    const image = (await screen.findByTestId('slide-preview-image')) as HTMLImageElement
    expect(image.getAttribute('src')).toContain('page=1')
    expect(screen.getAllByTestId(/^slide-preview-thumb-/)).toHaveLength(3)

    await user.click(screen.getByTestId('slide-preview-thumb-2'))
    const switched = screen.getByTestId('slide-preview-image') as HTMLImageElement
    expect(switched.getAttribute('src')).toContain('page=3')

    const renderButton = screen.getByTestId('slide-preview-render')
    expect(renderButton.textContent).toContain('Perbarui pratinjau')
    await user.click(renderButton)
    expect(deckPreviewRenderMock).toHaveBeenCalledWith('/ws')

    // Back to Edit: the canvas returns.
    await user.click(screen.getByTestId('slide-view-edit'))
    expect(await screen.findByTestId('slide-preview')).toBeTruthy()
  })

  test('an idle preview offers Buat pratinjau and starts the render from the button only', async () => {
    deckPreviewRenderMock.mockResolvedValue({ root: '/ws', available: true, status: 'rendering', key: 'c'.repeat(64), pages: 0 })
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-view-preview'))

    const button = await screen.findByTestId('slide-preview-render')
    expect(button.textContent).toContain('Buat pratinjau')
    expect(deckPreviewRenderMock).not.toHaveBeenCalled()
    await user.click(button)
    expect(deckPreviewRenderMock).toHaveBeenCalledWith('/ws')
    expect(await screen.findByTestId('slide-preview-rendering')).toBeTruthy()
  })
})

describe('SlideTemplatesPanel', () => {
  test('lists bundled templates under the Warna & Font title and applies the pick to the open deck through the API', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideTemplatesPanel />)

    expect(screen.getByText('Warna & Font')).toBeTruthy()
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

  test('drag & drop canon: variant sends the composer model and provider', async () => {
    // The Missing-model fix: regenerate carries the same selection a
    // task run would send, because dynamic providers (9Router) store no
    // model list for the server-side fallback chain to find.
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    useDaedalusStore.getState().setComposer({ providerId: 'nine-router', model: 'kr/claude-sonnet-4.5' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-edit-toggle'))
    await user.click(screen.getByTestId('slide-variant'))

    expect(deckRegenerateSlideMock).toHaveBeenCalledTimes(1)
    expect(deckRegenerateSlideMock.mock.calls[0]?.[2]).toEqual({ model: 'kr/claude-sonnet-4.5', provider_id: 'nine-router' })
  })

  test('drag & drop canon: a positioned block renders at its stored fractions', async () => {
    const positioned: DeckSpec = {
      ...fixtureDeck,
      slides: fixtureDeck.slides.map((slide) =>
        slide.id === 's2' ? { ...slide, positions: { title: { x: 0.34, y: 0.4, w: 0.3, h: 0.12 } } } : slide,
      ),
    }
    fileMock.mockResolvedValue(deckFile(positioned))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    // s1 is selected first; jump to s2 via its filmstrip thumbnail.
    const user = userEvent.setup()
    await user.click(screen.getByTestId('slide-thumb-1'))
    const stage = screen.getByTestId('slide-preview')
    const placed = await within(stage).findByTestId('slide-block-title')
    expect(placed.style.left).toBe('34%')
    expect(placed.style.top).toBe('40%')
    expect(placed.style.width).toBe('30%')
  })

  test('drag & drop canon: dragging a block in edit mode persists its new fractions', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-thumb-1'))
    await user.click(screen.getByTestId('slide-edit-toggle'))

    // jsdom has no layout engine: fake the slide box at 1000x562.5 and
    // the title block at (60, 40) sized 500x60.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = (left: number, top: number, width: number, height: number) =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
      if (this.dataset?.testid === 'slide-renderer') return rect(0, 0, 1000, 562.5)
      if (this.dataset?.blockKey) return rect(60, 40, 500, 60)
      return rect(0, 0, 0, 0)
    })
    try {
      const stage = screen.getByTestId('slide-preview')
      const wrapper = stage.querySelector('[data-block-key="title"]')
      expect(wrapper).not.toBeNull()
      // userEvent delivers a real primary-button pointerdown (jsdom's
      // fireEvent cannot fill PointerEvent fields); the window-level
      // move/up listeners then receive the same events a browser sends.
      await user.pointer({ keys: '[MouseLeft>]', target: wrapper!, coords: { x: 100, y: 50 } })
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 260, clientY: 50 }))
      window.dispatchEvent(new MouseEvent('pointerup', {}))
      await waitFor(() => expect(deckUpdateSlideMock).toHaveBeenCalled())
      const call = deckUpdateSlideMock.mock.calls.at(-1)
      expect(call?.[0]).toBe('/ws')
      expect(call?.[1]).toBe('s2')
      const positions = (call?.[2] as { positions: Record<string, { x: number; y: number }> }).positions
      expect(positions.title?.x).toBeCloseTo(0.22, 3)
      expect(positions.title?.y).toBeCloseTo(40 / 562.5, 3)
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('drag & drop canon: Reset posisi clears the slide positions through the update endpoint', async () => {
    const positioned: DeckSpec = {
      ...fixtureDeck,
      slides: fixtureDeck.slides.map((slide) =>
        slide.id === 's2' ? { ...slide, positions: { title: { x: 0.3, y: 0.4 } } } : slide,
      ),
    }
    fileMock.mockResolvedValue(deckFile(positioned))
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-thumb-1'))
    await user.click(screen.getByTestId('slide-edit-toggle'))
    await user.click(await screen.findByTestId('slide-reset-positions'))

    expect(deckUpdateSlideMock).toHaveBeenCalledWith('/ws', 's2', { positions: null })
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

  test('export picker exports through a picked built-in design without touching the plain button contract', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-export-menu'))
    await user.click(await screen.findByTestId('slide-export-builtin-galeri'))

    expect(deckExportMock).toHaveBeenCalledWith('/ws', { design_id: 'galeri' })
    expect(await screen.findByTestId('slide-exported')).toBeTruthy()
  })
})

describe('Slide image upload (clickable placeholders)', () => {
  const imageDeck: DeckSpec = {
    version: 1,
    id: 'd-img',
    title: 'Deck Bergambar',
    theme: {},
    slides: [
      { id: 's-img', layout: 'image-side', content: { title: 'Bergambar', points: ['Poin satu'], image: 'foto-lama.png', alt: 'Foto lama' } },
      {
        id: 's-mz',
        layout: 'mosaic',
        content: {
          title: 'Galeri',
          tiles: [
            { image: 'a.png', alt: 'A' },
            { image: 'b.png', alt: 'B' },
            { image: 'c.png', alt: 'C' },
            { image: 'd.png', alt: 'D' },
          ],
        },
      },
    ],
  }

  test('renderer shows the real image when the resolver maps the asset name', () => {
    const slide = imageDeck.slides[0]!
    render(<SlideRenderer slide={slide} theme={{}} resolveImageSrc={(name) => `/slides/deck/asset?name=${name}`} />)
    const img = screen.getByAltText('Foto lama') as HTMLImageElement
    expect(img.src).toContain('/slides/deck/asset?name=foto-lama.png')
  })

  test('without a resolver the local asset stays an honest placeholder', () => {
    const slide = imageDeck.slides[0]!
    render(<SlideRenderer slide={slide} theme={{}} />)
    expect(screen.getByText('foto-lama.png')).toBeTruthy()
    expect(screen.queryByAltText('Foto lama')).toBeNull()
  })

  test('edit-mode placeholder click reports the block, a drag does not', async () => {
    const user = userEvent.setup()
    const onImagePick = vi.fn()
    const slide = imageDeck.slides[0]!
    render(<SlideRenderer slide={slide} theme={{}} editable onImagePick={onImagePick} />)
    const button = screen.getByTestId('slide-image-upload-image')
    await user.click(button)
    expect(onImagePick).toHaveBeenCalledTimes(1)
    expect(onImagePick).toHaveBeenCalledWith('image')
    // A press that travels (a block drag starting on the placeholder)
    // must not also open the picker.
    await user.pointer({ keys: '[MouseLeft>]', target: button, coords: { x: 10, y: 10 } })
    await user.pointer({ keys: '[/MouseLeft]', coords: { x: 90, y: 10 } })
    expect(onImagePick).toHaveBeenCalledTimes(1)
  })

  const pickAndUpload = async (user: ReturnType<typeof userEvent.setup>, testId: string): Promise<File> => {
    await user.click(screen.getByTestId('slide-edit-toggle'))
    await user.click(screen.getByTestId(testId))
    const input = screen.getByTestId('slide-image-input') as HTMLInputElement
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'foto.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
    return file
  }

  test('stage flow: clicking the placeholder uploads and points the slide at the stored asset', async () => {
    const user = userEvent.setup()
    fileMock.mockResolvedValue(deckFile(imageDeck))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    const file = await pickAndUpload(user, 'slide-image-upload-image')

    await waitFor(() => expect(deckUpdateSlideMock).toHaveBeenCalled())
    expect(deckUploadAssetMock).toHaveBeenCalledWith('/ws', file)
    expect(deckUpdateSlideMock).toHaveBeenCalledWith('/ws', 's-img', { content: { image: 'foto-unggahan.png' } })
  })

  test('stage flow: a mosaic tile upload rewrites only that tile', async () => {
    const user = userEvent.setup()
    fileMock.mockResolvedValue(deckFile(imageDeck))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await user.click(screen.getByTestId('slide-thumb-1'))
    await pickAndUpload(user, 'slide-image-upload-tile-1')

    await waitFor(() => expect(deckUpdateSlideMock).toHaveBeenCalled())
    const call = deckUpdateSlideMock.mock.calls.at(-1) as unknown as [string, string, { content: { tiles: Array<{ image: string }> } }]
    expect(call[1]).toBe('s-mz')
    expect(call[2].content.tiles.map((tile) => tile.image)).toEqual(['a.png', 'foto-unggahan.png', 'c.png', 'd.png'])
  })

  test('stage flow: a rejected upload surfaces the error and never touches the slide', async () => {
    const user = userEvent.setup()
    fileMock.mockResolvedValue(deckFile(imageDeck))
    deckUploadAssetMock.mockRejectedValue(new Error('unsupported_image_type'))
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    await pickAndUpload(user, 'slide-image-upload-image')

    const error = await screen.findByTestId('slide-upload-error')
    expect(error.textContent).toContain('Upload gambar gagal')
    expect(deckUpdateSlideMock).not.toHaveBeenCalled()
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

  test('revision bumps and the refresh button re-read the tree without reopening the panel', async () => {
    const user = userEvent.setup()
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideWorkspacePanel />)

    await screen.findByTestId('slide-ws-open-deck')
    const rootLists = () => listMock.mock.calls.filter((call) => (call as unknown[])[1] === '.').length
    const initial = rootLists()
    expect(initial).toBeGreaterThanOrEqual(1)

    // A task-side write lands as a revision bump: the root listing is
    // re-read so a new deck/ folder appears on its own.
    act(() => useDaedalusStore.getState().bumpWorkspaceRevision())
    await waitFor(() => expect(rootLists()).toBe(initial + 1))

    // The manual refresh button does the same on demand.
    await user.click(screen.getByTestId('slide-ws-refresh'))
    await waitFor(() => expect(rootLists()).toBe(initial + 2))
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

describe('template slides (imported PPT designs)', () => {
  const contentPage = {
    kind: 'content' as const,
    background: { color: '#0b3d2e' },
    slots: [
      { key: 's0', kind: 'text' as const, rect: { x: 0.06, y: 0.06, w: 0.6, h: 0.12 }, sampleText: 'Judul Sampel', fontSizePt: 28, bold: true, color: '#ffd97a', fontFamily: 'Georgia', lineCount: 1, maxChars: 60 },
      { key: 's1', kind: 'text' as const, rect: { x: 0.06, y: 0.25, w: 0.5, h: 0.5 }, sampleText: 'Isi sampel', fontSizePt: 14, bold: false, lineCount: 3, maxChars: 200 },
      { key: 's2', kind: 'image' as const, rect: { x: 0.62, y: 0.2, w: 0.32, h: 0.6 }, imageFile: 'emerald.page-3.pic-0.png' },
    ],
  }
  const coverPage = {
    kind: 'cover' as const,
    background: { imageFile: 'emerald.page-0.background.png' },
    slots: [
      { key: 's0', kind: 'text' as const, rect: { x: 0.1, y: 0.3, w: 0.8, h: 0.25 }, sampleText: 'Judul Besar', fontSizePt: 44, bold: true, color: '#ffd97a', fontFamily: 'Georgia', align: 'center' as const, lineCount: 1, maxChars: 66 },
    ],
  }
  const templateSlide: Slide = {
    id: 't1',
    layout: 'template-page',
    templateRef: { templateId: 'emerald', page: 3 },
    content: { title: 'Keluarga Virus', slots: { s0: 'Keluarga Virus', s1: 'Isi tentang virus', s2: '' } },
    status: 'filled',
  }
  const templateDeck: DeckSpec = {
    version: 1,
    id: 'deck-template',
    title: 'Deck Template',
    theme: { customTemplateId: 'emerald', background: '#0b3d2e', text: '#f5efdb' },
    slides: [templateSlide],
  }
  const assetSrc = (file: string): string => `/tpl-assets/${file}`

  test('renderer draws the template page: slot words at their rects, original picture in the image slot', () => {
    render(<SlideRenderer slide={templateSlide} theme={templateDeck.theme} templateSlide={{ page: contentPage, assetSrc }} />)
    const layer = screen.getByTestId('template-slide')
    expect(layer.getAttribute('data-page-kind')).toBe('content')
    const title = screen.getByTestId('template-slot-s0')
    expect(title.textContent).toBe('Keluarga Virus')
    expect(title.style.left).toBe('6%')
    expect(title.style.top).toBe('6%')
    expect(title.style.color).toBe('rgb(255, 217, 122)')
    expect(title.style.fontFamily).toContain('Georgia')
    const imageSlot = screen.getByTestId('template-slot-s2')
    const img = imageSlot.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/tpl-assets/emerald.page-3.pic-0.png')
    expect(screen.getByTestId('slide-renderer').textContent).toContain('Halaman template')
  })

  test('renderer paints a page background image full-bleed from the template store', () => {
    const coverSlide: Slide = {
      id: 't0',
      layout: 'template-page',
      templateRef: { templateId: 'emerald', page: 0 },
      content: { title: 'Taksonomi Virus', slots: { s0: 'Taksonomi Virus' } },
      status: 'filled',
    }
    render(<SlideRenderer slide={coverSlide} theme={templateDeck.theme} templateSlide={{ page: coverPage, assetSrc }} />)
    const root = screen.getByTestId('slide-renderer')
    expect(root.style.backgroundImage).toContain('/tpl-assets/emerald.page-0.background.png')
    expect(screen.getByTestId('template-slot-s0').textContent).toBe('Taksonomi Virus')
  })

  test('edit mode: clicking the image slot reports its slot key; a chosen asset replaces the picture', async () => {
    const user = userEvent.setup()
    const onImagePick = vi.fn()
    render(<SlideRenderer slide={templateSlide} theme={templateDeck.theme} editable onImagePick={onImagePick} templateSlide={{ page: contentPage, assetSrc }} />)
    await user.click(screen.getByTestId('slide-image-upload-s2'))
    expect(onImagePick).toHaveBeenCalledTimes(1)
    expect(onImagePick).toHaveBeenCalledWith('s2')

    const chosen: Slide = {
      ...templateSlide,
      content: { title: 'Keluarga Virus', slots: { s0: 'Keluarga Virus', s1: 'Isi tentang virus', s2: 'foto-ku.png' } },
    }
    render(
      <SlideRenderer
        slide={chosen}
        theme={templateDeck.theme}
        templateSlide={{ page: contentPage, assetSrc }}
        resolveImageSrc={(name) => `/slides/deck/asset?root=%2Fws&name=${encodeURIComponent(name)}`}
      />,
    )
    const imgs = document.querySelectorAll('[data-testid="template-slot-s2"] img')
    const srcs = [...imgs].map((img) => img.getAttribute('src'))
    expect(srcs.some((src) => src?.includes('foto-ku.png'))).toBe(true)
  })

  test('an unresolved template page degrades honestly instead of a fake design', () => {
    render(<SlideRenderer slide={templateSlide} theme={templateDeck.theme} />)
    const fallback = screen.getByTestId('template-slide-fallback')
    expect(fallback.textContent).toContain('Keluarga Virus')
    expect(fallback.textContent).toContain('Desain template tidak terbaca')
  })

  test('group-origin slots and decor render at their transformed slide rects', () => {
    // A grouped TOC card as the parser now reports it: card body decor
    // plus title/body texts whose rects came out of the group's
    // child-space transform (small, right-of-center — where the winding
    // roadmap cards sit), not the page top-left they collapsed to when
    // group children were invisible.
    const groupedPage = {
      kind: 'toc' as const,
      background: { color: '#f8f7ff' },
      shapes: [
        { type: 'shape' as const, rect: { x: 0.11, y: 0.275, w: 0.25, h: 0.1 }, fill: '#4f46e5', geom: 'roundRect' as const },
      ],
      slots: [
        { key: 's0', kind: 'text' as const, rect: { x: 0.06, y: 0.05, w: 0.5, h: 0.12 }, sampleText: 'Daftar Isi', fontSizePt: 32, bold: true, lineCount: 1, maxChars: 40 },
        { key: 's1', kind: 'text' as const, rect: { x: 0.12, y: 0.2875, w: 0.225, h: 0.0375 }, sampleText: 'Project Progress A', fontSizePt: 20, bold: true, color: '#ffffff', lineCount: 1, maxChars: 21 },
        { key: 's2', kind: 'image' as const, rect: { x: 0.3625, y: 0.275, w: 0.05, h: 0.075 }, imageFile: 'peta.page-1.pic-0.png' },
      ],
    }
    const groupedSlide: Slide = {
      id: 'g1',
      layout: 'template-page',
      templateRef: { templateId: 'peta', page: 1 },
      content: { title: 'Daftar Isi', slots: { s0: 'Daftar Isi', s1: 'Kemajuan Bab Satu', s2: '' } },
      status: 'filled',
    }
    render(<SlideRenderer slide={groupedSlide} theme={templateDeck.theme} templateSlide={{ page: groupedPage, assetSrc }} />)
    const cardTitle = screen.getByTestId('template-slot-s1')
    expect(cardTitle.textContent).toBe('Kemajuan Bab Satu')
    expect(parseFloat(cardTitle.style.left)).toBeCloseTo(12)
    expect(parseFloat(cardTitle.style.top)).toBeCloseTo(28.75)
    expect(parseFloat(cardTitle.style.width)).toBeCloseTo(22.5)
    const decor = screen.getByTestId('template-decor-shape')
    expect(parseFloat(decor.style.left)).toBeCloseTo(11)
    expect(parseFloat(decor.style.top)).toBeCloseTo(27.5)
    expect(decor.style.backgroundColor).toBe('rgb(79, 70, 229)')
    const pic = screen.getByTestId('template-slot-s2')
    expect(pic.querySelector('img')?.getAttribute('src')).toBe('/tpl-assets/peta.page-1.pic-0.png')
  })

  test('gradient decor renders, frame decor marks its footprint, year slot wraps instead of clipping', () => {
    // A Nexora-style page after the theme-resolved parse: a gradient
    // card, a radial freeform, a chart footprint, and a narrow year
    // slot whose text previously clipped mid-token ("1185").
    const premiumPage = {
      kind: 'content' as const,
      background: { color: '#f5f5f5' },
      shapes: [
        {
          type: 'shape' as const,
          rect: { x: 0.09, y: 0.42, w: 0.17, h: 0.42 },
          fill: '#f5f5f5',
          geom: 'roundRect' as const,
          gradient: { kind: 'linear' as const, angleDeg: 90, stops: [{ pos: 0, color: '#f5f5f5' }, { pos: 1, color: '#ececec' }] },
        },
        {
          type: 'path' as const,
          rect: { x: 0.3, y: 0.42, w: 0.17, h: 0.42 },
          fill: '#ffffff',
          d: 'M 0 0 L 1000 0 L 500 1000 Z',
          box: { w: 1000, h: 1000 },
          gradient: { kind: 'radial' as const, angleDeg: 0, stops: [{ pos: 0, color: '#ffffff' }, { pos: 1, color: '#d9d9d9' }] },
        },
        { type: 'frame' as const, rect: { x: 0.55, y: 0.42, w: 0.28, h: 0.3 } },
      ],
      slots: [
        { key: 's0', kind: 'text' as const, rect: { x: 0.1, y: 0.44, w: 0.04, h: 0.06 }, sampleText: '1185', fontSizePt: 20, bold: true, lineCount: 1, maxChars: 4 },
      ],
    }
    const premiumSlide: Slide = {
      id: 'n1',
      layout: 'template-page',
      templateRef: { templateId: 'nexora', page: 5 },
      content: { title: 'Periode Samurai', slots: { s0: '1185' } },
      status: 'filled',
    }
    render(<SlideRenderer slide={premiumSlide} theme={templateDeck.theme} templateSlide={{ page: premiumPage, assetSrc }} />)
    const card = screen.getByTestId('template-decor-shape')
    expect(card.style.background).toContain('linear-gradient')
    expect(card.style.background).toContain('#f5f5f5')
    expect(card.style.background).toContain('#ececec')
    const blob = screen.getByTestId('template-decor-path')
    expect(blob.querySelector('radialGradient')).not.toBeNull()
    expect(blob.querySelector('path')?.getAttribute('fill')).toMatch(/^url\(#/)
    expect(screen.getByTestId('template-decor-frame')).toBeTruthy()
    const year = screen.getByTestId('template-slot-s0')
    expect(year.textContent).toBe('1185')
    expect(year.style.overflowWrap).toBe('anywhere')
    expect(year.className).not.toContain('overflow-hidden')
  })

  test('stage flow: image upload on a template slide records the asset under its slot key', async () => {
    const user = userEvent.setup()
    fileMock.mockResolvedValue(deckFile(templateDeck))
    pptTemplatesMock.mockResolvedValue({
      root: '/ws',
      templates: [
        {
          id: 'emerald',
          name: 'Emerald',
          sourceFile: 'Emerald.pptx',
          createdAt: '2026-10-09T12:00:00.000Z',
          theme: { background: '#0b3d2e', accent: '#0e7a5f', text: '#f5efdb' },
          pages: [coverPage, { kind: 'toc', slots: [] }, { kind: 'section', slots: [] }, contentPage],
        },
      ],
    })
    useDaedalusStore.getState().setWorkspace({ root: '/ws' })
    render(<SlideStage />)

    await screen.findByTestId('slide-counter')
    expect((await screen.findAllByTestId('template-slide')).length).toBeGreaterThanOrEqual(1)
    await user.click(screen.getByTestId('slide-edit-toggle'))
    await user.click(screen.getByTestId('slide-image-upload-s2'))
    const input = screen.getByTestId('slide-image-input') as HTMLInputElement
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'foto.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => expect(deckUpdateSlideMock).toHaveBeenCalled())
    expect(deckUploadAssetMock).toHaveBeenCalledWith('/ws', file)
    expect(deckUpdateSlideMock).toHaveBeenCalledWith('/ws', 't1', {
      content: { slots: { s0: 'Keluarga Virus', s1: 'Isi tentang virus', s2: 'foto-unggahan.png' } },
    })
  })
})

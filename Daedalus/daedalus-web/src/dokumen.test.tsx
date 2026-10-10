import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useDaedalusStore } from './state/taskStore'
import { domainFromPathname, pathForDomain } from './state/prefs'
import { DomainSwitch } from './components/layout/domain-switch'
import { Composer } from './components/composer/composer'
import { DokumenPanel } from './components/dokumen/dokumen-panel'
import { DokumenReportPanel } from './components/dokumen/dokumen-report'
import { DokumenStage } from './components/dokumen/dokumen-stage'

const createTask = vi.fn()
const dokumenDocument = vi.fn()
const dokumenBlocks = vi.fn()
const dokumenPreview = vi.fn()
const dokumenPreviewRender = vi.fn()

vi.mock('./api/client', () => ({
  api: {
    listTasks: vi.fn(async () => ({ tasks: [] })),
    task: vi.fn(async () => ({ events: [], report: null, running: false })),
    taskAttachments: vi.fn(async () => ({ attachments: [] })),
    getConversation: vi.fn(async () => ({ conversation: null })),
    cancelTask: vi.fn(async () => ({ cancelled: true, cancel_requested: true, task_id: 'task-1' })),
    createTask: (...args: unknown[]) => createTask(...args),
    createConversation: vi.fn(async () => ({ conversation: null })),
    setMode: vi.fn(async () => ({ session: {} })),
    setAutoApprove: vi.fn(async () => ({ session: {} })),
    updateSession: vi.fn(async () => ({ session: {} })),
    models: vi.fn(async () => ({ models: [] })),
    providers: vi.fn(async () => ({ providers: [], presets: [] })),
    settings: vi.fn(async () => ({ session: {}, settings: {} })),
    extensionsStatus: vi.fn(async () => ({ root: '', mcp: [], skills: [], agents: [], lsp: [], problems: [] })),
    testProvider: vi.fn(async () => ({ message: 'ok' })),
    upload: vi.fn(async () => ({ files: [], attachments: [], destination: '' })),
    files: vi.fn(async () => ({ files: [] })),
    list: vi.fn(async () => ({ items: [] })),
    review: vi.fn(async () => ({ raw: '' })),
    updateSettings: vi.fn(async () => ({ session: {} })),
    dokumenDocument: (...args: unknown[]) => dokumenDocument(...args),
    dokumenBlocks: (...args: unknown[]) => dokumenBlocks(...args),
    dokumenSources: vi.fn(async () => ({ document: null })),
    dokumenSchema: vi.fn(async () => ({ document: null })),
    dokumenRelease: vi.fn(async () => ({ released: true })),
    dokumenField: vi.fn(async () => ({ document: null, record: null })),
    dokumenOutline: vi.fn(async () => ({ document: null })),
    dokumenSection: vi.fn(async () => ({ document: null })),
    dokumenExportData: vi.fn(async () => ({ result: { recordCount: 0, heldBack: 0, path: '' }, document: null })),
    dokumenExportDocument: vi.fn(async () => ({ result: { recordCount: 0, heldBack: 0, path: '' }, document: null })),
    dokumenPreview: (...args: unknown[]) => dokumenPreview(...args),
    dokumenPreviewRender: (...args: unknown[]) => dokumenPreviewRender(...args),
    dokumenPreviewPageUrl: (root: string, key: string, page: number) => `/dokumen/preview/page?root=${root}&key=${key}&page=${page}`,
  },
  dokumenSourceFileUrl: (root: string, sourceId: string) => `/dokumen/source-file?root=${root}&sourceId=${sourceId}`,
}))

const seededDocument = {
  version: 1,
  id: 'doc-1',
  kind: 'extract',
  title: 'Invoice Oktober',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  sources: [{ id: 'src-1', filename: 'invoice.txt', sha256: 'abc', bytes: 100, pages: 1, parseMode: 'native', status: 'parsed', docType: 'invoice' }],
  schema: {
    version: 1,
    approved: false,
    extractionTarget: 'per_doc',
    fields: [
      { name: 'vendor', type: 'string', required: true },
      { name: 'total', type: 'money', required: true },
    ],
  },
  records: [
    {
      id: 'rec-1',
      sourceId: 'src-1',
      decision: 'flag',
      checks: [{ rule: 'arithmetic-total', passed: false, detail: 'total terbaca 999, hasil hitung kode 1110 — selisih -111' }],
      fields: {
        vendor: { value: 'CV Sinar', confidence: 0.95, status: 'auto', provenance: { page: 1, quote: 'CV Sinar' } },
        total: { value: 999, confidence: 0.9, status: 'flagged', note: 'total tidak cocok dengan hitungan kode', provenance: { page: 1, quote: 'Total: Rp 999' } },
      },
    },
  ],
  sections: [],
  styleOps: [],
  exports: [],
  citations: {},
}

beforeEach(() => {
  localStorage.clear()
  window.history.pushState(null, '', '/')
  useDaedalusStore.getState().reset()
  useDaedalusStore.setState({ domain: 'dokumen', workspace: { ...useDaedalusStore.getState().workspace, root: '/ws' } })
  createTask.mockReset()
  createTask.mockResolvedValue({ id: 'task-dok' })
  dokumenDocument.mockReset()
  dokumenDocument.mockResolvedValue({ root: '/ws', document: seededDocument })
  dokumenBlocks.mockReset()
  dokumenBlocks.mockResolvedValue({ pages: 1, pageSizes: [{ width: 0, height: 0 }], blocks: [{ page: 1, text: 'CV Sinar — Total: Rp 999' }] })
  dokumenPreview.mockReset()
  dokumenPreview.mockResolvedValue({ root: '/ws', available: false, status: 'unavailable', engine: null, kind: 'compose', key: null, pages: 0 })
  dokumenPreviewRender.mockReset()
  dokumenPreviewRender.mockResolvedValue({ root: '/ws', available: true, status: 'idle', engine: 'libreoffice', kind: 'compose', key: null, pages: 0 })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('dokumen domain routing', () => {
  test('/dokumen names the dokumen domain; switch pushes the URL', () => {
    expect(domainFromPathname('/dokumen')).toBe('dokumen')
    expect(domainFromPathname('/slide')).toBe('slide')
    expect(domainFromPathname('/')).toBe('coding')
    expect(pathForDomain('dokumen')).toBe('/dokumen')
    render(<DomainSwitch />)
    fireEvent.click(screen.getByTestId('domain-dokumen'))
    expect(useDaedalusStore.getState().domain).toBe('dokumen')
    expect(window.location.pathname).toBe('/dokumen')
  })
})

describe('dokumen composer', () => {
  test('submit carries domain dokumen + sub_mode; the Ekstrak|Susun switch flips it', async () => {
    useDaedalusStore.setState({ dokumenOptions: { subMode: 'ekstrak', sources: ['invoice.txt'], docxPath: null } })
    render(<Composer />)
    expect(screen.getByTestId('dokumen-mode-badge')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dokumen-submode-susun'))
    expect(useDaedalusStore.getState().dokumenOptions.subMode).toBe('susun')
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: 'susun makalah tentang framework' } })
    fireEvent.click(screen.getByTestId('composer-submit'))
    await waitFor(() => expect(createTask).toHaveBeenCalled())
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'dokumen', dokumen: expect.objectContaining({ sub_mode: 'susun', sources: ['invoice.txt'] }) }),
    )
  })
})

const seededComposeDocument = {
  ...seededDocument,
  kind: 'compose',
  title: 'Makalah: Agentic Framework',
  sources: [],
  schema: null,
  records: [],
  sections: [
    {
      id: 'sec-flag',
      title: 'Pendahuluan',
      thesisPoints: ['Latar belakang'],
      citations: ['SRC-1'],
      prose: 'Draf bab pembuka tentang framework. [SRC-1]\n\nParagraf kedua draf yang tetap harus terbaca.',
      status: 'critic-flagged',
      criticIssues: ['sitasi belum menunjang klaim utama', 'judul bab tidak cocok dengan isi'],
    },
    { id: 'sec-staged', title: 'Penutup', thesisPoints: ['Kesimpulan'], citations: [], prose: '', status: 'staged' },
  ],
  citations: { 'SRC-1': { id: 'SRC-1', title: 'Sumber Contoh' } },
}

describe('dokumen compose canvas', () => {
  test('critic-flagged section renders its kept draft + critic issues, never "Belum ditulis"', async () => {
    dokumenDocument.mockResolvedValue({ root: '/ws', document: seededComposeDocument })
    render(<DokumenStage />)
    const card = await screen.findByTestId('dokumen-section-sec-flag')
    expect(within(card).getByText(/Draf bab pembuka/)).toBeTruthy()
    expect(within(card).getByText(/Paragraf kedua draf/)).toBeTruthy()
    expect(within(card).getByText(/DITANDAI KRITIKUS — periksa/)).toBeTruthy()
    expect(within(card).getByText(/sitasi belum menunjang klaim utama/)).toBeTruthy()
    expect(within(card).queryByText(/Belum ditulis/)).toBeNull()
  })

  test('genuinely staged section still shows the "Belum ditulis" placeholder', async () => {
    dokumenDocument.mockResolvedValue({ root: '/ws', document: seededComposeDocument })
    render(<DokumenStage />)
    const card = await screen.findByTestId('dokumen-section-sec-staged')
    expect(within(card).getByText(/Belum ditulis/)).toBeTruthy()
  })
})

describe('dokumen panels', () => {
  test('Panel Skema shows the staged schema with the Ekstrak release button', async () => {
    render(<DokumenPanel />)
    expect(await screen.findByTestId('dokumen-schema-staged')).toBeTruthy()
    expect(screen.getByTestId('dokumen-extract-release')).toBeTruthy()
    expect(screen.getByTestId('dokumen-sources-panel')).toBeTruthy()
    expect(screen.getByText('invoice.txt')).toBeTruthy()
  })

  test('canvas grid is decision-colored, click focuses provenance, Laporan counts the held-back record', async () => {
    render(
      <>
        <DokumenStage />
        <DokumenReportPanel />
      </>,
    )
    const cell = await screen.findByTestId('dokumen-cell-rec-1-total')
    expect(cell.className).toContain('bg-amber-500/15')
    fireEvent.click(cell)
    expect(useDaedalusStore.getState().dokumenFocus?.field).toBe('total')
    expect(await screen.findByTestId('dokumen-provenance')).toBeTruthy()
    expect(screen.getByTestId('dokumen-decision-counts')).toBeTruthy()
    expect(screen.getByTestId('dokumen-held-list')).toBeTruthy()
  })
})

const seededComposeDocument = {
  ...seededDocument,
  id: 'doc-2',
  kind: 'compose',
  title: 'Makalah Panel',
  sources: [],
  records: [],
  schema: undefined,
  sections: [
    { id: 'sec-1', title: 'Pendahuluan', thesisPoints: [], citations: [], prose: 'Isi pendahuluan yang sudah tertulis.', status: 'drafted' },
  ],
}

const seededStyleDocument = {
  ...seededDocument,
  id: 'doc-3',
  kind: 'extract',
  title: 'Tata ulang Panel',
  sources: [],
  records: [],
  schema: undefined,
  styleTarget: 'laporan.docx',
  styleOps: [{ id: 'op-1', target: 'font', before: 'Calibri', after: 'Cambria', applied: true }],
}

describe('dokumen pratinjau (Tulis | Pratinjau)', () => {
  test('compose canvas defaults to Tulis (no preview fetch); Pratinjau shows the honest unavailable state', async () => {
    dokumenDocument.mockResolvedValue({ root: '/ws', document: seededComposeDocument })
    render(<DokumenStage />)
    expect(await screen.findByTestId('dokumen-view-preview')).toBeTruthy()
    expect(dokumenPreview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dokumen-view-preview'))
    expect(await screen.findByTestId('dokumen-preview-unavailable')).toBeTruthy()
    expect(dokumenPreview).toHaveBeenCalledWith('/ws', 'compose')
  })

  test('ready preview shows rendered pages with a pager; Perbarui asks the server to render again', async () => {
    dokumenDocument.mockResolvedValue({ root: '/ws', document: seededComposeDocument })
    dokumenPreview.mockResolvedValue({
      root: '/ws',
      available: true,
      status: 'ready',
      engine: 'libreoffice',
      kind: 'compose',
      key: 'a'.repeat(64),
      pages: 2,
      pageUrls: ['/dokumen/preview/page?root=%2Fws&page=1', '/dokumen/preview/page?root=%2Fws&page=2'],
    })
    render(<DokumenStage />)
    fireEvent.click(await screen.findByTestId('dokumen-view-preview'))
    expect(await screen.findByTestId('dokumen-preview-image')).toBeTruthy()
    expect(screen.getByTestId('dokumen-preview-pager').textContent).toContain('Halaman 1 dari 2')
    expect(screen.getByTestId('dokumen-preview-caption').textContent).toContain('LibreOffice')
    fireEvent.click(screen.getByTestId('dokumen-preview-next'))
    expect(screen.getByTestId('dokumen-preview-pager').textContent).toContain('Halaman 2 dari 2')
    fireEvent.click(screen.getByTestId('dokumen-preview-render'))
    await waitFor(() => expect(dokumenPreviewRender).toHaveBeenCalledWith('/ws', 'compose'))
  })

  test('style result state carries its own Tulis | Pratinjau toggle (kind=style)', async () => {
    dokumenDocument.mockResolvedValue({ root: '/ws', document: seededStyleDocument })
    dokumenPreview.mockResolvedValue({
      root: '/ws',
      available: true,
      status: 'error',
      engine: 'libreoffice',
      kind: 'style',
      key: null,
      pages: 0,
      error: 'belum ada DOCX hasil tata ulang — tekan Terapkan dulu sebelum pratinjau.',
    })
    render(<DokumenStage />)
    expect(await screen.findByTestId('dokumen-style-view')).toBeTruthy()
    fireEvent.click(screen.getByTestId('dokumen-view-preview'))
    expect(await screen.findByTestId('dokumen-preview-status')).toBeTruthy()
    expect(screen.getByText(/belum ada DOCX hasil tata ulang/)).toBeTruthy()
    expect(dokumenPreview).toHaveBeenCalledWith('/ws', 'style')
  })
})

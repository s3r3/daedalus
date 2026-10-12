import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useDaedalusStore } from '../../state/taskStore'
import { ResearchComposerControls } from '../composer/research-controls'
import { ResearchPlanPanel } from './plan-panel'
import { ResearchReportView } from './report-view'
import { ResearchSourcesPanel } from './sources-panel'
import { ResearchVerifyPanel } from './verify-panel'
import { ResearchSummaryPanel } from './summary-panel'
import { ResearchSourcePreview } from './source-preview'
import type { ResearchPlanSpec, ResearchReportView as ReportView } from '../../api/client'

const researchPlanMock = vi.fn()
const researchRunMock = vi.fn()
const researchGetPlanMock = vi.fn()
const researchGetReportMock = vi.fn()
const researchProgressMock = vi.fn()
const researchSourceContentMock = vi.fn()

vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number
    data: unknown
    constructor(status: number, message: string, data?: unknown) {
      super(message)
      this.name = 'ApiError'
      this.status = status
      this.data = data
    }
  },
  api: {
    researchPlan: (...args: unknown[]) => researchPlanMock(...args),
    researchRun: (...args: unknown[]) => researchRunMock(...args),
    researchGetPlan: (...args: unknown[]) => researchGetPlanMock(...args),
    researchGetReport: (...args: unknown[]) => researchGetReportMock(...args),
    researchProgress: (...args: unknown[]) => researchProgressMock(...args),
    researchSourceContent: (...args: unknown[]) => researchSourceContentMock(...args),
  },
}))

const fixturePlan: ResearchPlanSpec = {
  planId: 'plan-1',
  question: 'Apa itu Sinta?',
  language: 'id',
  subQuestions: [
    { id: 'sq1', text: 'Apa itu Sinta Kemdikbud?', rationale: 'definisi' },
    { id: 'sq2', text: 'Bagaimana peringkat Sinta 1-6?', rationale: 'peringkat' },
  ],
  sourceStrategy: 'sumber resmi Kemdikbud',
  budget: { maxQueries: 4, maxSources: 8 },
  createdAt: '2026-10-12T00:00:00.000Z',
}

const fixtureReport: ReportView = {
  reportId: 'r1',
  question: 'Apa itu Sinta?',
  language: 'id',
  sections: [{ id: 'sec1', title: 'Gambaran', claimIds: ['c1'] }],
  claims: [{
    id: 'c1',
    text: 'Sinta memeringkat jurnal dari 1 sampai 6.',
    sourceIds: ['s1'],
    excerpts: ['Sinta memeringkat jurnal dari 1 sampai 6'],
    confidence: 'high',
    status: 'verified',
  }],
  sources: [{
    id: 's1',
    url: 'https://sinta.kemdikbud.go.id/tentang',
    title: 'Tentang Sinta',
    fetchedAt: '2026-10-12T00:00:00.000Z',
    credibility: { tier: 'sinta2', verified: true, detail: 'Sinta 2 — sinta.kemdikbud.go.id' },
  }],
  conflicts: [{ topic: 'Cakupan', positions: [{ sourceId: 's1', stance: 'Nasional' }] }],
  limitations: ['Uji terbatas.'],
  summary: 'Sinta adalah indeks jurnal Indonesia.',
  bibliography: { apa: ['Sinta. (2026). Tentang Sinta. https://sinta.kemdikbud.go.id/tentang'], ieee: ['[1] "Tentang Sinta," 2026.'] },
  budget: { queriesUsed: 2, sourcesFetched: 1 },
  verification: { claimsVerified: 1, claimsDropped: 0, gatePassed: true },
}

beforeEach(() => {
  vi.clearAllMocks()
  researchPlanMock.mockResolvedValue({ planId: 'plan-1', plan: fixturePlan, question: fixturePlan.question })
  researchProgressMock.mockResolvedValue({ events: [] })
  useDaedalusStore.getState().clearResearch()
  useDaedalusStore.getState().setComposer({ goal: '' })
})

afterEach(() => {
  cleanup()
})

describe('ResearchComposerControls', () => {
  test('renders badge + plan button; creating a plan stages it in the store', async () => {
    render(<ResearchComposerControls />)
    expect(screen.getByTestId('research-mode-badge')).toBeTruthy()
    expect(screen.queryByTestId('research-plan-chip')).toBeNull()

    useDaedalusStore.getState().setComposer({ goal: 'Apa itu Sinta?' })
    await waitFor(() => expect((screen.getByTestId('research-plan-create') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByTestId('research-plan-create'))
    await waitFor(() => expect(researchPlanMock).toHaveBeenCalledWith('Apa itu Sinta?'))
    await waitFor(() => expect(screen.getByTestId('research-plan-chip')).toBeTruthy())
    expect(useDaedalusStore.getState().researchPlanId).toBe('plan-1')
  })
})

describe('ResearchPlanPanel (left)', () => {
  test('empty state explains the flow', () => {
    render(<ResearchPlanPanel />)
    expect(screen.getByTestId('research-plan-empty')).toBeTruthy()
  })

  test('staged plan renders sub-questions, budget, and the run gate', async () => {
    useDaedalusStore.getState().setResearchPlan('plan-1', fixturePlan)
    render(<ResearchPlanPanel />)
    await waitFor(() => expect(screen.getByTestId('research-plan-staged')).toBeTruthy())
    expect(screen.getAllByTestId('research-plan-subquestion')).toHaveLength(2)
    expect(screen.getByTestId('research-plan-budget').textContent).toContain('4')
    expect(screen.getByTestId('research-run')).toBeTruthy()
  })

  test('"Jalankan riset" runs the staged plan and stores the report', async () => {
    researchRunMock.mockResolvedValue({ report: fixtureReport })
    useDaedalusStore.getState().setResearchPlan('plan-1', fixturePlan)
    render(<ResearchPlanPanel />)
    fireEvent.click(screen.getByTestId('research-run'))
    await waitFor(() => expect(researchRunMock).toHaveBeenCalledWith('plan-1'))
    await waitFor(() => expect(useDaedalusStore.getState().researchReport?.reportId).toBe('r1'))
  })
})

describe('ResearchReportView (center)', () => {
  test('empty state explains the flow', () => {
    render(<ResearchReportView />)
    expect(screen.getByTestId('research-report-empty')).toBeTruthy()
  })

  test('report renders sections, clickable claims, and confidence badges', async () => {
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    render(<ResearchReportView />)
    await waitFor(() => expect(screen.getByTestId('research-report')).toBeTruthy())
    expect(screen.getByTestId('research-report-question').textContent).toContain('Apa itu Sinta?')
    expect(screen.getByTestId('research-claim')).toBeTruthy()
    expect(screen.getByTestId('research-claim-confidence').textContent).toContain('Tinggi')
    // Jejak klaim: klik klaim -> sumber menyala di store.
    fireEvent.click(screen.getByTestId('research-claim-trace'))
    expect(useDaedalusStore.getState().researchTraceSourceIds).toEqual(['s1'])
    // Kutipan verbatim expandable.
    fireEvent.click(screen.getByText('kutipan'))
    await waitFor(() => expect(screen.getByTestId('research-claim-excerpts')).toBeTruthy())
  })
})

describe('ResearchSourcesPanel (right)', () => {
  test('renders nothing without a report; with report shows tier badge + exports', async () => {
    const { rerender } = render(<ResearchSourcesPanel />)
    expect(screen.queryByTestId('research-sources-panel')).toBeNull()

    useDaedalusStore.getState().setResearchReport(fixtureReport)
    rerender(<ResearchSourcesPanel />)
    await waitFor(() => expect(screen.getByTestId('research-sources-panel')).toBeTruthy())
    expect(screen.getByTestId('research-source-tier').textContent).toContain('Sinta 2')
    expect(screen.getByTestId('research-export-bibtex')).toBeTruthy()
    expect(screen.getByTestId('research-export-ris')).toBeTruthy()
    expect(screen.getByTestId('research-bibliography')).toBeTruthy()
  })
})

describe('ResearchVerifyPanel + ResearchSummaryPanel (right)', () => {
  test('verify panel shows gate verdict and conflicts', async () => {
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    render(<ResearchVerifyPanel />)
    await waitFor(() => expect(screen.getByTestId('research-verify-panel')).toBeTruthy())
    expect(screen.getByTestId('research-verify-summary').textContent).toContain('LULUS')
    expect(screen.getByTestId('research-verify-conflicts')).toBeTruthy()
  })

  test('summary panel shows the executive summary', async () => {
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    render(<ResearchSummaryPanel />)
    await waitFor(() => expect(screen.getByTestId('research-summary-panel')).toBeTruthy())
    expect(screen.getByTestId('research-summary-text').textContent).toContain('indeks jurnal Indonesia')
  })
})

describe('ResearchSourcePreview (center)', () => {
  beforeEach(() => {
    useDaedalusStore.getState().clearResearch()
    researchSourceContentMock.mockReset()
  })

  test('clicking [sN] in the report opens the inline preview (reader mode when not frameable)', async () => {
    researchSourceContentMock.mockResolvedValue({
      content: { url: 'https://sinta.kemdikbud.go.id/tentang', title: 'Tentang Sinta', text: 'Paragraf satu.\n\nParagraf dua.', cached: true, isPdf: false, frameable: false },
    })
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    render(<ResearchReportView />)
    fireEvent.click(screen.getByTestId('research-claim-source-link'))
    expect(useDaedalusStore.getState().researchPreviewSourceId).toBe('s1')

    render(<ResearchSourcePreview />)
    await waitFor(() => expect(screen.getByTestId('research-preview-reader')).toBeTruthy())
    expect(screen.getByTestId('research-preview-reader').textContent).toContain('Paragraf satu')
    expect(researchSourceContentMock).toHaveBeenCalledWith('r1', 's1')
  })

  test('frameable source embeds the real page like a browser tab', async () => {
    researchSourceContentMock.mockResolvedValue({
      content: { url: 'https://sinta.kemdikbud.go.id/tentang', title: 'Tentang Sinta', text: 'Isi.', cached: true, isPdf: false, frameable: true },
    })
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    useDaedalusStore.getState().setResearchPreviewSourceId('s1')
    render(<ResearchSourcePreview />)
    await waitFor(() => expect(screen.getByTestId('research-preview-embed')).toBeTruthy())
    expect((screen.getByTestId('research-preview-embed') as HTMLIFrameElement).src).toContain('sinta.kemdikbud.go.id')
    // toggle to reader mode and back
    fireEvent.click(screen.getByTestId('research-preview-view-reader'))
    await waitFor(() => expect(screen.getByTestId('research-preview-reader')).toBeTruthy())
    fireEvent.click(screen.getByTestId('research-preview-view-embed'))
    await waitFor(() => expect(screen.getByTestId('research-preview-embed')).toBeTruthy())
  })

  test('back button returns to the report', async () => {
    researchSourceContentMock.mockResolvedValue({
      content: { url: 'https://sinta.kemdikbud.go.id/tentang', title: 'Tentang Sinta', text: 'Isi.', cached: true, isPdf: false, frameable: false },
    })
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    useDaedalusStore.getState().setResearchPreviewSourceId('s1')
    render(<ResearchSourcePreview />)
    await waitFor(() => expect(screen.getByTestId('research-source-preview')).toBeTruthy())
    fireEvent.click(screen.getByTestId('research-preview-back'))
    expect(useDaedalusStore.getState().researchPreviewSourceId).toBeNull()
  })

  test('PDF source embeds an iframe without fetching content', async () => {
    const pdfReport: ReportView = {
      ...fixtureReport,
      sources: [{ ...fixtureReport.sources[0]!, url: 'https://contoh.id/paper.pdf', title: 'Paper PDF' }],
    }
    researchSourceContentMock.mockResolvedValue({
      content: { url: 'https://contoh.id/paper.pdf', title: 'Paper PDF', text: '', cached: false, isPdf: true, frameable: true },
    })
    useDaedalusStore.getState().setResearchReport(pdfReport)
    useDaedalusStore.getState().setResearchPreviewSourceId('s1')
    render(<ResearchSourcePreview />)
    await waitFor(() => expect(screen.getByTestId('research-preview-embed')).toBeTruthy())
    expect((screen.getByTestId('research-preview-embed') as HTMLIFrameElement).src).toContain('paper.pdf')
  })

  test('fetch failure shows an honest error with the raw url', async () => {
    researchSourceContentMock.mockRejectedValue(new Error('nope'))
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    useDaedalusStore.getState().setResearchPreviewSourceId('s1')
    render(<ResearchSourcePreview />)
    await waitFor(() => expect(screen.getByTestId('research-preview-error')).toBeTruthy())
  })

  test('clicking a source title in the right panel opens the preview too', async () => {
    useDaedalusStore.getState().setResearchReport(fixtureReport)
    render(<ResearchSourcesPanel />)
    await waitFor(() => expect(screen.getByTestId('research-source-open')).toBeTruthy())
    fireEvent.click(screen.getByTestId('research-source-open'))
    expect(useDaedalusStore.getState().researchPreviewSourceId).toBe('s1')
  })
})

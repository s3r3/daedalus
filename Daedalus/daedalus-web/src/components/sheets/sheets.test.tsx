import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { WorkbookSpec } from '@daedalus/core'
import { useDaedalusStore } from '../../state/taskStore'
import { DomainSwitch } from '../layout/domain-switch'
import { BlueprintPanel } from './blueprint-panel'
import { SheetStage } from './sheet-stage'
import { SheetReportPanel } from './report-panel'
import { SheetWorkspacePanel } from './sheet-workspace'

const workbookMock = vi.fn()
const workbookGenerateMock = vi.fn()
const workbookSaveMock = vi.fn()
const workbookExportMock = vi.fn()
const workbookOpenMock = vi.fn()
const workbookSidecarMock = vi.fn()
const listMock = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    workbook: (...args: unknown[]) => workbookMock(...args),
    workbookGenerate: (...args: unknown[]) => workbookGenerateMock(...args),
    workbookSave: (...args: unknown[]) => workbookSaveMock(...args),
    workbookExport: (...args: unknown[]) => workbookExportMock(...args),
    workbookOpen: (...args: unknown[]) => workbookOpenMock(...args),
    workbookSidecar: (...args: unknown[]) => workbookSidecarMock(...args),
    workbookDownloadUrl: (root: string, path: string) => `/sheets/workbook/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    list: (...args: unknown[]) => listMock(...args),
  },
}))

const fixtureWorkbook: WorkbookSpec = {
  version: 1,
  id: 'wb-test',
  title: 'Rekap Uji',
  stage: 'blueprint',
  sheets: [
    {
      id: 's-data',
      name: 'Data',
      cells: {
        A1: { v: 'Kanal', bold: true },
        B1: { v: 'Pendapatan', bold: true },
        C1: { v: 'Biaya', bold: true },
        D1: { v: 'Laba', bold: true },
        A2: { v: 'Online' },
        B2: { v: 100 },
        C2: { v: 40 },
        D2: { f: '=B2-C2' },
      },
    },
    {
      id: 's-asumsi',
      name: 'Asumsi',
      cells: { A1: { v: 'Nama', bold: true }, B1: { v: 'Nilai', bold: true }, A2: { v: 'Pajak' }, B2: { v: 0.11 } },
    },
  ],
  blueprint: {
    goal: 'buatkan rekap',
    sources: ['jualan.csv'],
    assumptions: [{ name: 'Pajak', value: 0.11 }],
    sheets: [
      {
        name: 'Data',
        purpose: 'penjualan',
        columns: [
          { name: 'Kanal', type: 'text', source: 'input' },
          { name: 'Pendapatan', type: 'currency', source: 'input' },
          { name: 'Biaya', type: 'currency', source: 'input' },
          { name: 'Laba', type: 'currency', source: 'formula', formula: '=B{r}-C{r}' },
        ],
      },
    ],
  },
  meta: { createdBy: 'test' },
}

beforeEach(() => {
  vi.clearAllMocks()
  workbookMock.mockResolvedValue({ root: '/ws', workbook: fixtureWorkbook })
  workbookGenerateMock.mockResolvedValue({ root: '/ws', task_id: 't1', outcome: 'success', summary: 'Workbook selesai dibangun.', exported: null })
  workbookSaveMock.mockResolvedValue({ root: '/ws', workbook: fixtureWorkbook })
  workbookExportMock.mockResolvedValue({ root: '/ws', records: [{ at: 'x', path: '/ws/workbook/rekap-uji.xlsx', format: 'xlsx', bytes: 2048, via: 'exceljs' }] })
  workbookSidecarMock.mockResolvedValue({ available: false, version: null, path: null })
  listMock.mockResolvedValue({ path: '.', items: [] })
  useDaedalusStore.getState().setWorkspace({ root: '/ws' })
  useDaedalusStore.getState().setDomain('spreadsheet')
  useDaedalusStore.setState({ events: [], workspaceRevision: 0 })
})

afterEach(() => cleanup())

describe('DomainSwitch spreadsheet entry', () => {
  test('shows Coding/Slide/Spreadsheet and routes to /spreadsheet', () => {
    render(<DomainSwitch />)
    const button = screen.getByTestId('domain-spreadsheet')
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(useDaedalusStore.getState().domain).toBe('spreadsheet')
    expect(window.location.pathname).toBe('/spreadsheet')
  })
})

describe('BlueprintPanel', () => {
  test('staged blueprint renders sheets, columns, assumptions and the Buat flow', async () => {
    render(<BlueprintPanel />)
    await waitFor(() => expect(screen.getByTestId('sheet-blueprint-sheets')).toBeTruthy())
    expect(screen.getByText('Laba')).toBeTruthy()
    expect(screen.getByText('=B{r}-C{r}')).toBeTruthy()
    expect(screen.getByTestId('sheet-blueprint-assumptions')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sheet-blueprint-buat'))
    await waitFor(() => expect(workbookGenerateMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.getByTestId('sheet-blueprint-note').textContent).toContain('selesai dibangun'))
  })
})

describe('SheetStage (Kanvas Grid)', () => {
  test('grid evaluates formulas live, tabs switch, and a commit saves through the API', async () => {
    render(<SheetStage />)
    await waitFor(() => expect(screen.getByTestId('sheet-cell-D2')).toBeTruthy())
    // Formula cell shows the evaluated value (60 = 100 - 40), not the formula text.
    expect(screen.getByTestId('sheet-cell-D2').textContent).toContain('60')
    expect(screen.getByTestId('sheet-cell-D2').textContent).not.toContain('=B2-C2')

    fireEvent.click(screen.getByTestId('sheet-tab-Asumsi'))
    await waitFor(() => expect(screen.getByTestId('sheet-cell-B2').textContent).toContain('0.11'))

    fireEvent.click(screen.getByTestId('sheet-tab-Data'))
    fireEvent.click(screen.getByTestId('sheet-cell-B2'))
    const input = screen.getByTestId('sheet-formula-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '=B2*2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(workbookSaveMock).toHaveBeenCalled())
    const saved = workbookSaveMock.mock.calls[0]?.[1] as WorkbookSpec
    expect(saved.sheets[0]?.cells['B2']?.f).toBe('=B2*2')
  })

  test('export buttons call the export API with the active sheet for CSV', async () => {
    render(<SheetStage />)
    await waitFor(() => expect(screen.getByTestId('sheet-export-xlsx')).toBeTruthy())
    fireEvent.click(screen.getByTestId('sheet-export-xlsx'))
    await waitFor(() => expect(workbookExportMock).toHaveBeenCalledWith('/ws', { format: 'xlsx' }))
    fireEvent.click(screen.getByTestId('sheet-export-csv'))
    await waitFor(() => expect(workbookExportMock).toHaveBeenCalledWith('/ws', { format: 'csv', sheet: 'Data' }))
  })
})

describe('SheetReportPanel', () => {
  test('verify errors, warnings, path honesty, and export record notes render per cell', async () => {
    const withReport: WorkbookSpec = {
      ...fixtureWorkbook,
      stage: 'ready',
      verify: {
        at: '2026-10-10T00:00:00Z',
        path: 'partial',
        ok: false,
        formulasChecked: 12,
        unsupported: 1,
        errors: [{ sheet: 'Data', cell: 'D2', code: 'formula-error', severity: 'error', message: 'formula menghasilkan #REF!' }],
        warnings: [{ sheet: 'Data', cell: 'C3', code: 'frozen-where-formula-expected', severity: 'warning', message: 'angka beku di kolom formula' }],
        summary: 'Verify (partial): 12 formula dievaluasi di core',
      },
      exports: [{ at: 'x', path: '/ws/workbook/rekap-uji.xlsx', format: 'xlsx', bytes: 1024, via: 'exceljs', note: 'native chart tidak disuntikkan (sidecar-tidak-terdeteksi)' }],
    }
    workbookMock.mockResolvedValue({ root: '/ws', workbook: withReport })
    render(<SheetReportPanel />)
    await waitFor(() => expect(screen.getByTestId('sheet-report-errors')).toBeTruthy())
    expect(screen.getByTestId('sheet-report-errors').textContent).toContain('Data!D2')
    expect(screen.getByTestId('sheet-report-warnings').textContent).toContain('Data!C3')
    expect(screen.getByText(/tidak diklaim terverifikasi penuh/)).toBeTruthy()
    expect(screen.getByText(/tidak disuntikkan/)).toBeTruthy()
    const link = screen.getByTestId('sheet-report-download') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('/sheets/workbook/download')
  })
})

const dashboardWorkbookFixture: WorkbookSpec = {
  version: 1,
  id: 'wb-dash',
  title: 'Dashboard Penjualan',
  stage: 'ready',
  sheets: [
    {
      id: 's-data',
      name: 'Data',
      cells: {
        A1: { v: 'Bulan', bold: true },
        B1: { v: 'Region', bold: true },
        C1: { v: 'Total', bold: true },
        A2: { v: 'Jan' },
        B2: { v: 'Barat' },
        C2: { v: 100 },
        A3: { v: 'Feb' },
        B3: { v: 'Timur' },
        C3: { v: 200 },
      },
    },
    {
      id: 's-dash',
      name: 'Dashboard',
      kind: 'dashboard',
      cells: {
        B2: { v: 'Total Revenue', bold: true, fill: '#6B50FF', color: '#FFFFFF' },
        B3: { f: '=SUM(Data!C2:C3)', fmt: '#,##0', bold: true },
      },
      merges: ['B2:D2', 'B3:D4'],
      tiles: [{ id: 'tile-total', label: 'Total Revenue', formula: '=SUM(Data!C2:C3)', fmt: '#,##0', anchor: 'B2', cols: 3, rows: 3 }],
      charts: [{ id: 'chart-region', type: 'column', range: 'Data!A1:C3', sheet: 'Dashboard', anchor: 'B8', title: 'Revenue per Region' }],
      slicers: [{ id: 'slicer-region', field: 'Region', source: 'Data!A1:C3', anchor: 'B24', pivot: 'pivot-region' }],
      pivots: [{ id: 'pivot-region', source: 'Data!A1:C3', target: '_PivotData', anchor: 'A1', rows: ['Region'], values: [{ field: 'Total', agg: 'sum' }] }],
    },
  ],
  blueprint: undefined,
  exports: [{
    at: 'x', path: '/ws/workbook/dashboard-penjualan.xlsx', format: 'xlsx', bytes: 4096, via: 'exceljs+sidecar',
    dashboard: { sheet: 'Dashboard', tiles: 1, charts: 1, slicers: 1 },
    note: '1 chart native + 1 pivot native + 1 slicer native disuntikkan Go sidecar',
  }],
  meta: { createdBy: 'test' },
}

describe('Dashboard canvas (Kanvas Grid, dashboard sheet)', () => {
  test('tiles show evaluated KPI values; charts/slicers render as honest placeholders', async () => {
    workbookMock.mockResolvedValue({ root: '/ws', workbook: dashboardWorkbookFixture })
    render(<SheetStage />)
    fireEvent.click(await screen.findByTestId('sheet-tab-Dashboard'))
    await waitFor(() => expect(screen.getByTestId('sheet-dash-canvas')).toBeTruthy())
    // KPI value is computed live by the evaluator (100 + 200), not frozen text.
    expect(screen.getByTestId('sheet-tile-value-tile-total').textContent).toContain('300')
    expect(screen.getByTestId('sheet-tile-tile-total').textContent).toContain('=SUM(Data!C2:C3)')
    // Chart is named as an export-rendered native, never drawn on canvas.
    expect(screen.getByTestId('sheet-chart-chart-region').textContent).toContain('Dirender sebagai chart native di file .xlsx')
    expect(screen.getByTestId('sheet-slicer-slicer-region').textContent).toContain('Region')
    expect(screen.getByTestId('sheet-dash-pivots').textContent).toContain('_PivotData')
    // Grid remains reachable for raw cell edits.
    fireEvent.click(screen.getByTestId('sheet-dash-view-grid'))
    await waitFor(() => expect(screen.getByTestId('sheet-grid')).toBeTruthy())
  })
})

describe('Dashboard in Panel Blueprint + Laporan', () => {
  test('blueprint dashboard section lists tiles and natives; report counts composed pieces', async () => {
    const staged: WorkbookSpec = {
      ...dashboardWorkbookFixture,
      stage: 'blueprint',
      blueprint: {
        goal: 'buatkan dashboard penjualan',
        sources: ['penjualan.csv'],
        assumptions: [],
        sheets: [{ name: 'Data', columns: [{ name: 'Total', type: 'currency', source: 'input' }] }],
        dashboard: {
          sheet: 'Dashboard',
          tiles: [{ id: 'tile-total', label: 'Total Revenue', formula: '=SUM(Data!C2:C3)', anchor: 'B2' }],
          charts: [{ id: 'chart-region', type: 'column', range: 'Data!A1:C3', anchor: 'B8', title: 'Revenue per Region' }],
          slicers: [{ id: 'slicer-region', field: 'Region', source: 'Data!A1:C3', anchor: 'B24' }],
        },
      },
    }
    workbookMock.mockResolvedValue({ root: '/ws', workbook: staged })
    render(<BlueprintPanel />)
    await waitFor(() => expect(screen.getByTestId('sheet-blueprint-dashboard')).toBeTruthy())
    expect(screen.getByTestId('sheet-blueprint-dashboard-tiles').textContent).toContain('Total Revenue')
    expect(screen.getByTestId('sheet-blueprint-dashboard-natives').textContent).toContain('1 chart')
    expect(screen.getByTestId('sheet-blueprint-dashboard-natives').textContent).toContain('1 slicer (Region)')

    workbookMock.mockResolvedValue({ root: '/ws', workbook: dashboardWorkbookFixture })
    render(<SheetReportPanel />)
    await waitFor(() => expect(screen.getByTestId('sheet-report-dashboard')).toBeTruthy())
    expect(screen.getByTestId('sheet-report-dashboard').textContent).toContain('1 kartu KPI · 1 chart · 1 slicer')
  })
})

describe('SheetWorkspacePanel', () => {
  test('lists everything but only spreadsheet files can be opened', async () => {
    listMock.mockImplementation(async (_root: string, path: string) => {
      if (path === 'workbook') return { path, items: [{ name: 'workbook.json', path: 'workbook/workbook.json', isDirectory: false }] }
      return {
        path,
        items: [
          { name: 'jualan.csv', path: 'jualan.csv', isDirectory: false },
          { name: 'catatan.txt', path: 'catatan.txt', isDirectory: false },
          { name: 'workbook', path: 'workbook', isDirectory: true },
        ],
      }
    })
    workbookOpenMock.mockResolvedValue({ root: '/ws', workbook: fixtureWorkbook })
    render(<SheetWorkspacePanel />)
    await waitFor(() => expect(screen.getByText('jualan.csv')).toBeTruthy())
    expect(screen.getByText('catatan.txt')).toBeTruthy()
    const openButtons = screen.getAllByTestId('sheet-ws-open')
    expect(openButtons).toHaveLength(1)
    fireEvent.click(openButtons[0] as HTMLElement)
    await waitFor(() => expect(workbookOpenMock).toHaveBeenCalledWith('/ws', 'jualan.csv'))
  })
})

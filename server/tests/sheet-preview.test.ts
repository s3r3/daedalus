import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newSheet, newWorkbook, writeWorkbook, type WorkbookSpec } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'
import {
  SheetPreviewService,
  buildExcelExportScript,
  createExcelConverter,
  detectSheetPreviewEngines,
  resolveSheetPreviewEngine,
  type ExcelScriptRunner,
  type SheetPreviewConverter,
  type SheetPreviewDeps,
} from '../src/sheet-preview.ts'

/**
 * Pratinjau (workbook preview) routes + engine layer: the exported
 * .xlsx rendered by a real engine (Excel on Windows via COM, or
 * LibreOffice) into per-page PNGs cached by a hash of workbook.json.
 * Converters/exports/probes are injected fakes, so the suite is
 * deterministic without Excel or Windows. The Excel COM path is
 * asserted as script text + runner semantics only — it never executes
 * in this Linux VM, exactly like the PowerPoint engine before it.
 */

// 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  channel?.close()
  channel = undefined
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

function fakeConverter(pages = 2): { converter: SheetPreviewConverter; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    converter: async ({ workDir }) => {
      calls += 1
      const paths: string[] = []
      for (let i = 1; i <= pages; i += 1) {
        const file = join(workDir, `page-${i}.png`)
        writeFileSync(file, PNG_BYTES)
        paths.push(file)
      }
      return paths
    },
  }
}

const fakeExport: SheetPreviewDeps['exportXlsx'] = async (root) => {
  const path = join(root, '.daedalus', 'fake-export.xlsx')
  mkdirSync(join(root, '.daedalus'), { recursive: true })
  writeFileSync(path, Buffer.from('fake-xlsx'))
  return { path, cleanup: async () => rmSync(path, { force: true }) }
}

function serviceWith(overrides: Partial<SheetPreviewDeps>): SheetPreviewService {
  return new SheetPreviewService({
    availability: () => ({ excel: false, libreOffice: true }),
    exportXlsx: fakeExport,
    ...overrides,
  })
}

async function listen(service?: SheetPreviewService): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-sheet-preview-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-sheet-preview-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace, ...(service ? { sheetPreview: service } : {}) })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function seedWorkbook(root: string, cellValue = 100): Promise<WorkbookSpec> {
  const wb = newWorkbook('Rekap Pratinjau', { createdBy: 'test' })
  const data = newSheet('Data')
  data.cells['A1'] = { v: 'Total' }
  data.cells['B1'] = { v: cellValue }
  wb.sheets.push(data)
  wb.stage = 'ready'
  await writeWorkbook(root, wb)
  return wb
}

async function reqJson(base: string, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function statusPath(root: string): string {
  return `/sheets/workbook/preview?root=${encodeURIComponent(root)}`
}

async function waitForStatus(base: string, root: string, wanted: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await reqJson(base, 'GET', statusPath(root))
    if (body.status === wanted) return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`sheet preview never reached status ${wanted}`)
}

describe('/sheets/workbook/preview (Pratinjau)', () => {
  test('missing workbook is an honest 404, exactly like the other sheet routes', async () => {
    const { base, root } = await listen(serviceWith({}))
    const status = await reqJson(base, 'GET', statusPath(root))
    expect(status.status).toBe(404)
    expect(status.body.error).toBe('workbook_not_found')
    const render = await reqJson(base, 'POST', '/sheets/workbook/preview', { root })
    expect(render.status).toBe(404)
    expect(render.body.error).toBe('workbook_not_found')
  })

  test('unavailable when neither engine is installed — a state, never a 500', async () => {
    const fake = fakeConverter()
    const { base, root } = await listen(
      serviceWith({ availability: () => ({ excel: false, libreOffice: false }), converters: { libreoffice: fake.converter } }),
    )
    await seedWorkbook(root)
    const status = await reqJson(base, 'GET', statusPath(root))
    expect(status.status).toBe(200)
    expect(status.body.available).toBe(false)
    expect(status.body.status).toBe('unavailable')
    expect(status.body.engine).toBeNull()
    expect(status.body.engineLabel).toBeNull()
    const render = await reqJson(base, 'POST', '/sheets/workbook/preview', { root })
    expect(render.status).toBe(200)
    expect(render.body.status).toBe('unavailable')
    expect(fake.calls()).toBe(0)
  })

  test('idle → render → ready via LibreOffice, naming the engine; pages serve as PNG', async () => {
    const fake = fakeConverter(2)
    const { base, root } = await listen(serviceWith({ converters: { libreoffice: fake.converter } }))
    await seedWorkbook(root)
    const idle = await reqJson(base, 'GET', statusPath(root))
    expect(idle.body.status).toBe('idle')
    expect(idle.body.engine).toBe('libreoffice')
    expect(idle.body.engineLabel).toBe('LibreOffice')

    const render = await reqJson(base, 'POST', '/sheets/workbook/preview', { root })
    expect(render.status).toBe(200)
    expect(render.body.status).toBe('rendering')
    const ready = await waitForStatus(base, root, 'ready')
    expect(ready.pages).toBe(2)
    expect(ready.engineLabel).toBe('LibreOffice')
    const pageUrls = ready.pageUrls as string[]
    expect(pageUrls[0]).toContain('/sheets/workbook/preview/page')
    expect(pageUrls[0]).toContain(`key=${ready.key as string}`)

    const pageRes = await fetch(new URL(pageUrls[0] as string, base))
    expect(pageRes.status).toBe(200)
    expect(pageRes.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await pageRes.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    const badKey = await fetch(new URL(`/sheets/workbook/preview/page?root=${encodeURIComponent(root)}&key=zzz&page=1`, base))
    expect(badKey.status).toBe(404)
    const badPage = await reqJson(base, 'GET', `/sheets/workbook/preview/page?root=${encodeURIComponent(root)}&key=${ready.key as string}&page=0`)
    expect(badPage.status).toBe(400)
    expect(fake.calls()).toBe(1)
  })

  test('on win32 availability the Excel engine wins and is named', async () => {
    const excelFake = fakeConverter(1)
    const libreFake = fakeConverter(1)
    const { base, root } = await listen(
      serviceWith({ availability: () => ({ excel: true, libreOffice: true }), converters: { excel: excelFake.converter, libreoffice: libreFake.converter } }),
    )
    await seedWorkbook(root)
    await reqJson(base, 'POST', '/sheets/workbook/preview', { root })
    const ready = await waitForStatus(base, root, 'ready')
    expect(ready.engine).toBe('excel')
    expect(ready.engineLabel).toBe('Excel')
    expect(excelFake.calls()).toBe(1)
    expect(libreFake.calls()).toBe(0)
  })

  test('a workbook edit after render reports stale, not the old pages', async () => {
    const fake = fakeConverter(1)
    const { base, root } = await listen(serviceWith({ converters: { libreoffice: fake.converter } }))
    const wb = await seedWorkbook(root)
    await reqJson(base, 'POST', '/sheets/workbook/preview', { root })
    await waitForStatus(base, root, 'ready')
    const sheet = wb.sheets[0] as WorkbookSpec['sheets'][number]
    sheet.cells['B1'] = { v: 999 }
    await writeWorkbook(root, wb)
    const stale = await reqJson(base, 'GET', statusPath(root))
    expect(stale.body.status).toBe('stale')
    expect(stale.body.pages).toBe(0)
  })

  test('a converter failure lands as error status with the message', async () => {
    const { base, root } = await listen(
      serviceWith({ converters: { libreoffice: async () => { throw new Error('soffice meledak') } } }),
    )
    await seedWorkbook(root)
    await reqJson(base, 'POST', '/sheets/workbook/preview', { root })
    const failed = await waitForStatus(base, root, 'error')
    expect(failed.error).toContain('soffice meledak')
  })
})

describe('sheet preview engine layer', () => {
  test('detection order: Excel (win32 COM) → LibreOffice → unavailable', async () => {
    expect(resolveSheetPreviewEngine({ excel: true, libreOffice: true })).toBe('excel')
    expect(resolveSheetPreviewEngine({ excel: false, libreOffice: true })).toBe('libreoffice')
    expect(resolveSheetPreviewEngine({ excel: false, libreOffice: false })).toBeNull()

    const seams = (probe: boolean) => ({
      platform: 'win32' as NodeJS.Platform,
      env: { Path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' },
      fileExists: (path: string) => path.endsWith('powershell.exe') || path.endsWith('soffice.exe') || path.endsWith('pdftoppm.exe'),
      probeExcelCom: async () => probe,
    })
    expect(await detectSheetPreviewEngines(seams(true))).toEqual({ excel: true, libreOffice: true })
    expect(await detectSheetPreviewEngines(seams(false))).toEqual({ excel: false, libreOffice: true })
  })

  test('Excel is never probed off Windows, even with a willing COM seam', async () => {
    let probed = false
    const verdict = await detectSheetPreviewEngines({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      fileExists: (path) => path.endsWith('/soffice') || path.endsWith('/pdftoppm'),
      probeExcelCom: async () => { probed = true; return true },
    })
    expect(verdict).toEqual({ excel: false, libreOffice: true })
    expect(probed).toBe(false)
  })

  test('the Excel script snapshots pids, opens read-only, prints to PDF, quits only its own instance', () => {
    const script = buildExcelExportScript({ xlsxPath: 'C:\\tmp\\book.xlsx', pdfPath: 'C:\\tmp\\book.pdf', pidFile: 'C:\\tmp\\pids.txt' })
    // pre-existing instances are snapshotted BEFORE activation and never quit/killed
    expect(script).toContain('Get-Process -Name EXCEL')
    expect(script.indexOf('$preExisting = @(Get-ExcelPids)')).toBeLessThan(script.indexOf('New-Object -ComObject Excel.Application'))
    expect(script).toContain('[IO.File]::WriteAllLines($pidFile')
    expect(script).toContain('if ($preExisting.Count -eq 0) { try { $excel.Quit() } catch { } }')
    // read-only open (UpdateLinks=0, ReadOnly=$true), close WITHOUT saving, print to PDF (type 0)
    expect(script).toContain('$excel.Workbooks.Open($xlsxPath, 0, $true)')
    expect(script).toContain('$workbook.ExportAsFixedFormat(0, $pdfPath)')
    expect(script).toContain('$workbook.Close($false)')
    expect(script).toContain("Excel.Application")
  })

  test('createExcelConverter goes script → PDF → pdftoppm pages (runner injected, never a real Excel)', async () => {
    const minimalPdf = Buffer.from([
      '%PDF-1.1',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
      '',
    ].join('\n'))
    const xlsxPath = join(mkdtempSync(join(tmpdir(), 'daedalus-excel-conv-')), 'book.xlsx')
    writeFileSync(xlsxPath, Buffer.from('fake'))
    const workDir = mkdtempSync(join(tmpdir(), 'daedalus-excel-work-'))
    const runner: ExcelScriptRunner = async ({ scriptPath, pidFile, timeoutMs }) => {
      expect(timeoutMs).toBe(120_000)
      expect(readFileSync(scriptPath, 'utf8')).toContain('ExportAsFixedFormat')
      expect(pidFile).toContain('excel-pids.txt')
      writeFileSync(join(workDir, 'book.pdf'), minimalPdf)
    }
    const converter = createExcelConverter(runner, () => 'powershell.exe')
    const pages = await converter({ xlsxPath, workDir, profileDir: workDir })
    expect(pages).toHaveLength(1)
    expect(readFileSync(pages[0] as string).subarray(0, 4).toString('latin1')).toBe('\x89PNG')
    rmSync(workDir, { recursive: true, force: true })
  })
})

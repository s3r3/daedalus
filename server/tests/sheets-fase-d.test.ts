import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newWorkbook, newSheet, writeWorkbook, formatCellRef } from '@daedalus/core'
import { createContext, createApp } from '../src/app.ts'

/**
 * Dae Captain v2 Fase D — server routes:
 * POST /sheets/dashboard/quick (D1: Dashboard 1 perintah) and
 * POST /sheets/qa (D2: tanya jawab data, deterministic).
 * Both are additive routes; the existing sheets surface is untouched.
 */

let server: ReturnType<typeof createApp> | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  workspace = undefined
})

// S6: daemon token for mutation routes, set by listen() (GET/OPTIONS ignore it).
let daemonToken = ''

async function listen(): Promise<string> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-fased-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-fased-ws-'))
  const store = new TaskStore(join(tmp!, 'state'))
  const ctx = createContext({ store, bus: new EventBus(), cwd: workspace! })
  server = createApp(ctx)
  daemonToken = ctx.daemonToken ?? ''
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

async function post(base: string, path: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

function seedSalesWorkbook() {
  const wb = newWorkbook('Penjualan', { createdBy: 'fased-test' })
  const sheet = newSheet('Data')
  const headers = ['Tanggal', 'Produk', 'Kanal', 'Qty', 'Total']
  headers.forEach((h, i) => { sheet.cells[formatCellRef(i, 0)] = { v: h, bold: true } })
  const products = ['Kopi Tubruk', 'Teh Manis', 'Pisang Goreng']
  const qtys = [3, 2, 3, 6, 1, 2, 5, 4, 1, 4, 3, 4]
  for (let i = 0; i < 24; i += 1) {
    const r = i + 1
    sheet.cells[formatCellRef(0, r)] = { v: `2026-01-${String((i % 24) + 1).padStart(2, '0')}` }
    sheet.cells[formatCellRef(1, r)] = { v: products[i % 3] as string }
    sheet.cells[formatCellRef(2, r)] = { v: i % 2 === 0 ? 'Online' : 'Toko' }
    sheet.cells[formatCellRef(3, r)] = { v: qtys[i % 12] as number }
    sheet.cells[formatCellRef(4, r)] = { v: (qtys[i % 12] as number) * 25000 }
  }
  wb.sheets.push(sheet)
  wb.stage = 'ready'
  return writeWorkbook(workspace!, wb)
}

describe('POST /sheets/qa', () => {
  test('answers deterministically from the dataset', async () => {
    const base = await listen()
    await seedSalesWorkbook()
    const { status, body } = await post(base, '/sheets/qa', {
      root: workspace,
      question: 'Berapa total penjualan bulan Januari?',
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.intent).toBe('sum')
    expect(body.value).toBe(76 * 25000)
    expect(body.method).toContain('24 baris')
  })

  test('honest when the question is unanswerable', async () => {
    const base = await listen()
    await seedSalesWorkbook()
    const { status, body } = await post(base, '/sheets/qa', {
      root: workspace,
      question: 'Siapa nama direktur perusahaan ini?',
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.answer).toContain('tidak mengenali maksud')
  })

  test('404 when no workbook exists', async () => {
    const base = await listen()
    const { status, body } = await post(base, '/sheets/qa', { root: workspace, question: 'Berapa total penjualan?' })
    expect(status).toBe(404)
    expect(body.error).toBe('workbook_not_found')
  })
})

describe('POST /sheets/dashboard/quick', () => {
  test('builds the Dashboard sheet and exports a downloadable xlsx', async () => {
    const base = await listen()
    await seedSalesWorkbook()
    const { status, body } = await post(base, '/sheets/dashboard/quick', { root: workspace })
    expect(status).toBe(200)
    expect(body.dashboardSheet).toBe('Dashboard')
    expect(body.measureColumn).toBe('Total')
    expect(body.kpis).toHaveLength(4)
    expect(body.categories).toEqual(['Kopi Tubruk', 'Teh Manis', 'Pisang Goreng'])
    expect(body.downloadPath).toMatch(/^workbook\/.*\.xlsx$/)

    // The [📥 XLSX] button's URL serves the real file.
    const dl = await fetch(new URL(`/sheets/workbook/download?root=${encodeURIComponent(workspace!)}&path=${encodeURIComponent(body.downloadPath)}`, base))
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toContain('spreadsheetml.sheet')
    const buf = Buffer.from(await dl.arrayBuffer())
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 2).toString()).toBe('PK') // zip = real xlsx

    // The Dashboard sheet persisted into workbook.json.
    const wbRes = await fetch(new URL(`/sheets/workbook?root=${encodeURIComponent(workspace!)}`, base))
    const wbBody = (await wbRes.json()) as any
    expect(wbBody.workbook.sheets.map((s: any) => s.name)).toContain('Dashboard')
  })

  test('400 dashboard_not_possible without a numeric column', async () => {
    const base = await listen()
    const wb = newWorkbook('Teks', { createdBy: 'fased-test' })
    const sheet = newSheet('Data')
    sheet.cells['A1'] = { v: 'Nama' }
    sheet.cells['A2'] = { v: 'Budi' }
    wb.sheets.push(sheet)
    wb.stage = 'ready'
    await writeWorkbook(workspace!, wb)
    const { status, body } = await post(base, '/sheets/dashboard/quick', { root: workspace })
    expect(status).toBe(400)
    expect(body.error).toBe('dashboard_not_possible')
  })

  test('404 when no workbook exists', async () => {
    const base = await listen()
    const { status } = await post(base, '/sheets/dashboard/quick', { root: workspace })
    expect(status).toBe(404)
  })
})

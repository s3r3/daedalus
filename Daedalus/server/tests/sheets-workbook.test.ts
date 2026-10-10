import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newWorkbook, newSheet, readWorkbook } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Agentic Spreadsheet server surface: /sheets/workbook* routes mirror
 * the deck routes (validated canvas saves, Buat release, new-chat
 * archive, open/import, on-demand export + confined download), and
 * POST /tasks accepts domain:'spreadsheet' while unknown domains and
 * skill invocations stay named 400s.
 */

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let fake: HttpServer | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  channel?.close()
  channel = undefined
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (fake) await new Promise<void>((resolve) => fake?.close(() => resolve()))
  fake = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

const BLUEPRINT = JSON.stringify({
  title: 'Rekap Uji',
  sheets: [{
    name: 'Data',
    columns: [
      { name: 'Kanal', type: 'text', source: 'input' },
      { name: 'Total', type: 'currency', source: 'input' },
    ],
  }],
  assumptions: [],
})

async function startFakeProvider(): Promise<string> {
  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      let content = 'Siap.'
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> }
        const system = parsed.messages?.[0]?.content ?? ''
        const user = parsed.messages?.[1]?.content ?? ''
        if (system.includes('blueprint stage')) content = BLUEPRINT
        else if (system.includes('You fill the input columns')) content = JSON.stringify({ rows: [['Online', 100], ['Toko', 200]] })
        else if (user.includes('blueprint')) content = BLUEPRINT
      } catch { /* plain reply */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-sheets-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-sheets-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  const baseUrl = await startFakeProvider()
  ctx.providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'fake-key', models: ['fake-model'], defaultModel: 'fake-model', enabled: true })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function req(base: string, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { status: res.status, body: { raw: text } }
  }
}

async function waitForStagedWorkbook(root: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const wb = await readWorkbook(root).catch(() => null)
    if (wb?.blueprint && wb.stage === 'blueprint') return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('blueprint never staged')
}

async function waitForTask(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const got = await req(base, 'GET', `/tasks/${id}`)
    const record = (got.body.state ?? got.body) as Record<string, unknown>
    if (record.status === 'done' || record.status === 'failed') return record
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`task ${id} did not settle`)
}

describe('/sheets/workbook routes', () => {
  test('open a CSV: typed workbook becomes ready; GET returns it', async () => {
    const { base, root } = await listen()
    const missing = await req(base, 'GET', `/sheets/workbook?root=${encodeURIComponent(root)}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('workbook_not_found')

    writeFileSync(join(root, 'jualan.csv'), 'Kanal,Total\nOnline,100\nToko,200\n')
    const opened = await req(base, 'POST', '/sheets/workbook/open', { root, path: 'jualan.csv' })
    expect(opened.status).toBe(200)
    const got = await req(base, 'GET', `/sheets/workbook?root=${encodeURIComponent(root)}`)
    expect(got.status).toBe(200)
    const workbook = got.body.workbook as { stage: string; sheets: Array<{ cells: Record<string, { v?: unknown }> }> }
    expect(workbook.stage).toBe('ready')
    expect(workbook.sheets[0]?.cells['B2']?.v).toBe(100)

    const badPath = await req(base, 'POST', '/sheets/workbook/open', { root, path: '../outside.csv' })
    expect(badPath.status).toBe(400)
    expect(badPath.body.error).toBe('invalid_open_path')
  })

  test('canvas save: invalid workbook is 422 and nothing lands; valid save round-trips', async () => {
    const { base, root } = await listen()
    const wb = newWorkbook('Manual', { createdBy: 'test' })
    const sheet = newSheet('Data')
    sheet.cells['A1'] = { v: 'x', f: '=1+1' } // both: structurally invalid
    wb.sheets.push(sheet)
    const invalid = await req(base, 'POST', '/sheets/workbook', { root, workbook: wb })
    expect(invalid.status).toBe(422)
    expect(invalid.body.error).toBe('invalid_workbook')
    expect(existsSync(join(root, 'workbook', 'workbook.json'))).toBe(false)

    sheet.cells['A1'] = { v: 'x' }
    const valid = await req(base, 'POST', '/sheets/workbook', { root, workbook: wb })
    expect(valid.status).toBe(200)
    const got = await req(base, 'GET', `/sheets/workbook?root=${encodeURIComponent(root)}`)
    expect((got.body.workbook as { title: string }).title).toBe('Manual')
  })

  test('export then download is confined to workbook/ exports', async () => {
    const { base, root } = await listen()
    const wb = newWorkbook('Ekspor', { createdBy: 'test' })
    wb.stage = 'ready'
    const sheet = newSheet('Data')
    sheet.cells['A1'] = { v: 'Kanal', bold: true }
    sheet.cells['A2'] = { v: 'Online' }
    sheet.cells['B1'] = { v: 'Total', bold: true }
    sheet.cells['B2'] = { v: 100 }
    wb.sheets.push(sheet)
    const saved = await req(base, 'POST', '/sheets/workbook', { root, workbook: wb })
    expect(saved.status).toBe(200)

    const exported = await req(base, 'POST', '/sheets/workbook/export', { root, format: 'xlsx' })
    expect(exported.status).toBe(200)
    const records = exported.body.records as Array<{ path: string; format: string }>
    expect(records[0]?.format).toBe('xlsx')
    expect(existsSync(records[0]?.path as string)).toBe(true)

    const rel = `workbook/${records[0]?.path.split('/').pop()}`
    const download = await fetch(new URL(`/sheets/workbook/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`, base))
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('spreadsheetml')

    const escape = await req(base, 'GET', `/sheets/workbook/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent('../secret.xlsx')}`)
    expect(escape.status).toBe(400)
  })

  test('reset archives the whole workbook dir; a second reset is a no-op', async () => {
    const { base, root } = await listen()
    const wb = newWorkbook('Lama', { createdBy: 'test' })
    wb.stage = 'ready'
    wb.sheets.push(newSheet('Data'))
    await req(base, 'POST', '/sheets/workbook', { root, workbook: wb })
    await req(base, 'POST', '/sheets/workbook/export', { root, format: 'xlsx' })

    const reset = await req(base, 'POST', '/sheets/workbook/reset', { root })
    expect(reset.status).toBe(200)
    const archived = String(reset.body.archived ?? '')
    expect(archived).toMatch(/^\.daedalus\/workbook-archive\//)
    expect(existsSync(join(root, 'workbook'))).toBe(false)
    const archiveDir = join(root, ...archived.split('/'))
    expect(readdirSync(archiveDir)).toContain('workbook.json')

    const again = await req(base, 'POST', '/sheets/workbook/reset', { root })
    expect(again.status).toBe(200)
    expect(again.body.archived).toBeNull()
  })
})

describe('spreadsheet domain tasks', () => {
  test('POST /tasks accepts domain spreadsheet; unknown domain and skills are named 400s', async () => {
    const { base } = await listen()
    const created = await req(base, 'POST', '/tasks', { goal: 'buatkan rekap penjualan', provider_id: 'fake', domain: 'spreadsheet' })
    expect(created.status).toBe(201)
    expect(created.body.domain).toBe('spreadsheet')
    const id = String(created.body.id ?? '')
    await waitForStagedWorkbook((created.body.repo_path as string) ?? workspace as string).catch(() => undefined)
    void id

    const unknown = await req(base, 'POST', '/tasks', { goal: 'halo', provider_id: 'fake', domain: 'bogus' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe('invalid_domain')

    const skills = await req(base, 'POST', '/tasks', { goal: 'halo', provider_id: 'fake', domain: 'spreadsheet', skills: ['ponytail'] })
    expect(skills.status).toBe(400)
    expect(skills.body.error).toBe('skills_not_in_spreadsheet_domain')
  }, 60_000)

  test('Buat releases the staged run; reset settles a staged run honestly', async () => {
    const { base, root } = await listen()
    const created = await req(base, 'POST', '/tasks', { goal: 'buatkan rekap penjualan', provider_id: 'fake', domain: 'spreadsheet' })
    expect(created.status).toBe(201)
    const id = String(created.body.id ?? '')
    await waitForStagedWorkbook(root)

    const generated = await req(base, 'POST', '/sheets/workbook/generate', { root })
    expect(generated.status).toBe(200)
    expect(generated.body.outcome).toBe('success')
    expect(generated.body.task_id).toBe(id)
    const record = await waitForTask(base, id)
    expect(record.status).toBe('done')
    const wb = await readWorkbook(root)
    expect(wb?.stage).toBe('ready')

    // New-chat reset archives the built workbook (no staged run now).
    const resetBuilt = await req(base, 'POST', '/sheets/workbook/reset', { root })
    expect(resetBuilt.status).toBe(200)
    expect(resetBuilt.body.staged_abandoned).toBe(false)
    expect(String(resetBuilt.body.archived ?? '')).toMatch(/workbook-archive/)
    expect(await readWorkbook(root)).toBeNull()

    // A fresh prompt stages a new blueprint; resetting mid-stage
    // settles that run honestly instead of leaving it parked.
    const second = await req(base, 'POST', '/tasks', { goal: 'buatkan rekap lain', provider_id: 'fake', domain: 'spreadsheet' })
    expect(second.status).toBe(201)
    const secondId = String(second.body.id ?? '')
    await waitForStagedWorkbook(root)
    const reset = await req(base, 'POST', '/sheets/workbook/reset', { root })
    expect(reset.status).toBe(200)
    expect(reset.body.staged_abandoned).toBe(true)
    const secondRecord = await waitForTask(base, secondId)
    expect(secondRecord.status).toBe('failed')
    expect(secondRecord.last_error).toBe('staged_superseded')
    const archiveDir = join(root, ...String(reset.body.archived ?? '').split('/'))
    expect(readFileSync(join(archiveDir, 'workbook.json'), 'utf8')).toContain('Rekap Uji')
  }, 120_000)
})

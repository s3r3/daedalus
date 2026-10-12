import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newSheet, newWorkbook, readWorkbook, writeWorkbook } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Spreadsheet panel additions (server surface): POST /sheets/workbook/verify
 * runs the deterministic gate on demand; GET /sheets/workbook/checkpoints
 * lists previous workbook.json states; POST /sheets/workbook/restore brings
 * one back — never destructively (the current state is snapshotted first).
 */

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

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-sheets-panels-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-sheets-panels-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
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

async function seedWorkbook(root: string, title: string): Promise<void> {
  const wb = newWorkbook(title, { createdBy: 'test' })
  const sheet = newSheet('Data')
  sheet.cells['A1'] = { v: 1 }
  sheet.cells['B1'] = { f: '=A1*2' }
  wb.sheets = [sheet]
  wb.stage = 'ready'
  await writeWorkbook(root, wb)
}

describe('/sheets/workbook/verify', () => {
  test('runs the deterministic gate and persists the verdict on workbook.verify', async () => {
    const { base, root } = await listen()
    await seedWorkbook(root, 'Rekap Uji')
    const res = await req(base, 'POST', '/sheets/workbook/verify', { root })
    expect(res.status).toBe(200)
    const verify = res.body.verify as Record<string, unknown>
    expect(verify.ok).toBe(true)
    expect(verify.formulasChecked).toBe(1)
    // Whatever path ran, it must be one of the honest gate paths.
    expect(['core', 'partial', 'core+libreoffice']).toContain(verify.path)
    const persisted = await readWorkbook(root)
    expect((persisted?.verify as unknown as Record<string, unknown> | undefined)?.ok).toBe(true)
    // The export the verify ran against is recorded like any other export.
    expect(persisted?.exports?.length).toBeGreaterThan(0)
  })

  test('404 when no workbook exists', async () => {
    const { base, root } = await listen()
    const res = await req(base, 'POST', '/sheets/workbook/verify', { root })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('workbook_not_found')
  })
})

describe('/sheets/workbook/checkpoints + /restore', () => {
  test('every save leaves its predecessor; restore is never destructive', async () => {
    const { base, root } = await listen()
    await seedWorkbook(root, 'Versi 1')
    const wb2 = (await readWorkbook(root))!
    wb2.title = 'Versi 2'
    await writeWorkbook(root, wb2)
    const wb3 = (await readWorkbook(root))!
    wb3.title = 'Versi 3'
    await writeWorkbook(root, wb3)

    const listed = await req(base, 'GET', `/sheets/workbook/checkpoints?root=${encodeURIComponent(root)}`)
    expect(listed.status).toBe(200)
    expect(listed.body.count).toBe(2)
    const checkpoints = listed.body.checkpoints as Array<{ name: string; title: string | null }>
    expect(checkpoints[0]?.title).toBe('Versi 2')
    expect(checkpoints[1]?.title).toBe('Versi 1')

    // Restore the oldest: the current "Versi 3" must survive as a checkpoint.
    const restored = await req(base, 'POST', '/sheets/workbook/restore', { root, name: checkpoints[1]!.name })
    expect(restored.status).toBe(200)
    expect((await readWorkbook(root))?.title).toBe('Versi 1')

    const after = await req(base, 'GET', `/sheets/workbook/checkpoints?root=${encodeURIComponent(root)}`)
    const titles = (after.body.checkpoints as Array<{ title: string | null }>).map((c) => c.title)
    expect(titles).toContain('Versi 3')
  })

  test('invalid name is 400, missing checkpoint is 404', async () => {
    const { base, root } = await listen()
    await seedWorkbook(root, 'Rekap Uji')
    const bad = await req(base, 'POST', '/sheets/workbook/restore', { root, name: '../evil.json' })
    expect(bad.status).toBe(400)
    const missing = await req(base, 'POST', '/sheets/workbook/restore', { root, name: 'nope.json' })
    expect(missing.status).toBe(404)
  })

  test('empty history returns an empty list, not an error', async () => {
    const { base, root } = await listen()
    const listed = await req(base, 'GET', `/sheets/workbook/checkpoints?root=${encodeURIComponent(root)}`)
    expect(listed.status).toBe(200)
    expect(listed.body.count).toBe(0)
  })
})

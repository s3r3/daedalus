import { afterEach, describe, expect, test } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Fase C — Fitur Dokumen Dae Captain v2 (desain 4.1–4.3 + Q&A dokumen)
 * di permukaan HTTP: semua route di sini deterministik (tanpa LLM),
 * jadi tidak butuh fake provider.
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
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-fasec-srv-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-fasec-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
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

describe('Fase C1 — GET /dokumen/doc-templates (desain 4.1)', () => {
  test('returns the 4 built-in templates with sections', async () => {
    const { base, root } = await listen()
    const got = await req(base, 'GET', `/dokumen/doc-templates?root=${encodeURIComponent(root)}`)
    expect(got.status).toBe(200)
    const templates = got.body.templates as Array<{ id: string; name: string; sections: Array<{ title: string; contentPrompt: string }> }>
    expect(templates).toHaveLength(4)
    expect(templates.map((t) => t.id).sort()).toEqual(['laporan', 'makalah', 'proposal', 'surat-resmi'])
    for (const t of templates) {
      expect(t.sections.length).toBeGreaterThanOrEqual(5)
      for (const s of t.sections) {
        expect(s.title.trim().length).toBeGreaterThan(0)
        expect(s.contentPrompt.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('Fase C2 — POST /dokumen/compare (desain 4.2)', () => {
  const V1 = `KONTRAK KERJA SAMA\n\nPasal 1: Para pihak sepakat bekerja sama.\n\nPasal 2: Nilai kontrak sebesar Rp 100.000.000.\n\nPasal 3: Jangka waktu 12 bulan.`
  const V2 = `KONTRAK KERJA SAMA\n\nPasal 1: Para pihak sepakat bekerja sama.\n\nPasal 2: Nilai kontrak sebesar Rp 150.000.000.\n\nPasal 4: Denda keterlambatan 2% per hari.`

  test('diffs two workspace text files paragraph by paragraph', async () => {
    const { base, root } = await listen()
    writeFileSync(join(root, 'kontrak-v1.txt'), V1)
    writeFileSync(join(root, 'kontrak-v2.txt'), V2)
    const got = await req(base, 'POST', '/dokumen/compare', { root, pathA: 'kontrak-v1.txt', pathB: 'kontrak-v2.txt' })
    expect(got.status).toBe(200)
    expect(got.body.fileA).toBe('kontrak-v1.txt')
    expect(got.body.fileB).toBe('kontrak-v2.txt')
    const cmp = got.body.comparison as { counts: { added: number; removed: number; changed: number; same: number }; summary: string[]; blocks: unknown[] }
    expect(cmp.counts.changed).toBe(1)
    expect(cmp.counts.added).toBe(1)
    expect(cmp.counts.removed).toBe(1)
    expect(cmp.counts.same).toBe(2)
    expect(cmp.summary.some((s) => s.startsWith('~'))).toBe(true)
  })

  test('identical files produce zero changes', async () => {
    const { base, root } = await listen()
    writeFileSync(join(root, 'sama.txt'), V1)
    const got = await req(base, 'POST', '/dokumen/compare', { root, pathA: 'sama.txt', pathB: 'sama.txt' })
    expect(got.status).toBe(200)
    const cmp = got.body.comparison as { counts: { added: number; removed: number; changed: number }; summary: string[] }
    expect(cmp.counts).toMatchObject({ added: 0, removed: 0, changed: 0 })
    expect(cmp.summary).toEqual([])
  })

  test('missing paths and outside-workspace paths are rejected honestly', async () => {
    const { base, root } = await listen()
    const missing = await req(base, 'POST', '/dokumen/compare', { root })
    expect(missing.status).toBe(400)
    writeFileSync(join(root, 'a.txt'), 'x')
    const outside = await req(base, 'POST', '/dokumen/compare', { root, pathA: 'a.txt', pathB: '../evil.txt' })
    expect(outside.status).toBe(400)
  })
})

describe('Fase C3 — POST /dokumen/batch-extract (desain 4.3)', () => {
  async function seedExtractedDoc(root: string, filename: string, lowConf: boolean): Promise<string> {
    const { newDocument, writeDocument } = await import('@daedalus/core')
    const doc = newDocument('extract', filename)
    doc.sources.push({
      id: 'src-1', filename, sha256: 'x', bytes: 10, pages: 1,
      parseMode: 'native', status: 'parsed',
    })
    doc.schema = {
      version: 1, approved: true, extractionTarget: 'per_doc',
      fields: [
        { name: 'vendor', type: 'string', required: true },
        { name: 'total', type: 'money', required: true },
      ],
    }
    doc.records.push({
      id: 'rec-1', sourceId: 'src-1',
      fields: {
        vendor: { value: 'CV Sinar', confidence: lowConf ? 0.4 : 0.95, status: 'auto' },
        total: { value: 555000, confidence: 0.95, status: 'auto' },
      },
      checks: [], decision: 'auto-clear',
    })
    await writeDocument(root, doc)
    return doc.id
  }

  async function postBatch(base: string, root: string, docIds: string[]): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
    const res = await fetch(new URL('/dokumen/batch-extract', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, docIds }),
    })
    const text = await res.text()
    const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
    return { status: res.status, events }
  }

  test('streams progress per file then merges into one CSV with review flags', async () => {
    const { base, root } = await listen()
    const id1 = await seedExtractedDoc(root, 'inv-001.pdf', false)
    const id2 = await seedExtractedDoc(root, 'inv-002.pdf', true)
    const { status, events } = await postBatch(base, root, [id1, id2])
    expect(status).toBe(200)
    const progress = events.filter((e) => e.type === 'progress')
    expect(progress).toHaveLength(2)
    expect(progress[0]).toMatchObject({ done: 1, total: 2 })
    expect(progress[1]).toMatchObject({ done: 2, total: 2 })
    const result = events.find((e) => e.type === 'result') as unknown as {
      fileCount: number; recordCount: number; fieldCount: number
      csvPath: string; reviewCount: number; failed: unknown[]
    }
    expect(result).toBeDefined()
    expect(result.fileCount).toBe(2)
    expect(result.recordCount).toBe(2)
    expect(result.fieldCount).toBe(4)
    expect(result.reviewCount).toBe(1) // inv-002 vendor confidence 0.4
    expect(result.failed).toEqual([])
    expect(result.csvPath).toMatch(/\.daedalus\/documents\/batch\/exports\/batch-.*\.csv/)
    expect(existsSync(join(root, result.csvPath))).toBe(true)
    const csv = readFileSync(join(root, result.csvPath), 'utf8')
    expect(csv.split('\n')[0]).toBe('_file,vendor,total,_decision,_review')
    expect(csv).toContain('inv-001.pdf')
    expect(csv).toContain('perlu review')
  })

  test('documents without extraction results are reported as failed, not merged silently', async () => {
    const { base, root } = await listen()
    const id1 = await seedExtractedDoc(root, 'ok.pdf', false)
    const { status, events } = await postBatch(base, root, [id1, 'tidak-ada'])
    expect(status).toBe(200)
    const result = events.find((e) => e.type === 'result') as unknown as { fileCount: number; failed: Array<{ file: string; error: string }> }
    expect(result.fileCount).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.error).toMatch(/tidak ditemukan/)
  })

  test('empty docIds are rejected', async () => {
    const { base, root } = await listen()
    const { status } = await postBatch(base, root, [])
    expect(status).toBe(400)
  })
})

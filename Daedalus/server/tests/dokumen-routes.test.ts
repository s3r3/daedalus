import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, createActiveDocument, exportDocumentDocx } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Dokumen domain at the HTTP surface: panel routes over document.json,
 * the staged schema gate released by POST /dokumen/release (the task
 * completes through its own run), the export gate, style inspection,
 * and the new-chat archive reset. A fake OpenAI-compatible provider
 * answers the pipeline seats by system-prompt marker.
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

const INVOICE = `PT Maju Bersama — Invoice INV-9
Tanggal: 2 Februari 2026
Subtotal: Rp 500.000
PPN: Rp 55.000
Total: Rp 555.000`

async function stageReply(body: string): Promise<string> {
  let system = ''
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
    const systemMessage = (parsed.messages ?? []).find((m) => m.role === 'system')
    system = typeof systemMessage?.content === 'string' ? systemMessage.content : ''
  } catch { /* plain reply */ }
  if (system.includes('classify a document')) return '{"docType":"invoice"}'
  if (system.includes('propose an extraction schema')) {
    return '{"fields":[{"name":"vendor","type":"string","required":true},{"name":"date","type":"date","required":true},{"name":"subtotal","type":"money"},{"name":"tax","type":"money"},{"name":"total","type":"money","required":true}]}'
  }
  if (system.includes('extract structured fields')) {
    return JSON.stringify({
      fields: {
        vendor: { value: 'PT Maju Bersama', confidence: 0.97, quote: 'PT Maju Bersama' },
        date: { value: '2 Februari 2026', confidence: 0.95, quote: 'Tanggal: 2 Februari 2026' },
        subtotal: { value: 'Rp 500.000', confidence: 0.95, quote: 'Subtotal: Rp 500.000' },
        tax: { value: 'Rp 55.000', confidence: 0.95, quote: 'PPN: Rp 55.000' },
        total: { value: 'Rp 555.000', confidence: 0.95, quote: 'Total: Rp 555.000' },
      },
    })
  }
  return 'Siap.'
}

async function startFakeProvider(): Promise<string> {
  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      void stageReply(body).then((content) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }))
      })
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-dokumen-srv-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-dokumen-ws-'))
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

type Doc = {
  id: string
  kind: string
  schema?: { approved?: boolean; fields: Array<{ name: string }> }
  sources: Array<{ filename: string; status: string; pages: number }>
  records: Array<{ id: string; decision: string; fields: Record<string, { value: unknown; status: string }> }>
  sections: Array<{ title: string; status: string }>
  exports: Array<{ format: string; path: string }>
}

async function getDocument(base: string, root: string): Promise<Doc | null> {
  const got = await req(base, 'GET', `/dokumen/document?root=${encodeURIComponent(root)}`)
  return (got.body.document as Doc | null) ?? null
}

async function untilDocument(base: string, root: string, pred: (doc: Doc) => boolean, tries = 150): Promise<Doc> {
  for (let i = 0; i < tries; i++) {
    const doc = await getDocument(base, root)
    if (doc && pred(doc)) return doc
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('document condition not met in time')
}

async function waitForTask(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const got = await req(base, 'GET', `/tasks/${id}`)
    const record = (got.body.state ?? got.body) as Record<string, unknown>
    if (record.status === 'done' || record.status === 'failed') return record
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`task ${id} did not settle`)
}

describe('Dokumen panel routes', () => {
  test('sources ingest + parse immediately; reset archives', async () => {
    const { base, root } = await listen()
    writeFileSync(join(root, 'invoice.txt'), INVOICE)
    const posted = await req(base, 'POST', '/dokumen/sources', { root, paths: ['invoice.txt'] })
    expect(posted.status).toBe(200)
    const doc = posted.body.document as Doc
    expect(doc.sources).toHaveLength(1)
    expect(doc.sources[0]!.status).toBe('parsed')
    expect(doc.sources[0]!.pages).toBe(1)

    const blocks = await req(base, 'GET', `/dokumen/blocks?root=${encodeURIComponent(root)}&sourceId=${doc.sources[0] ? '' : ''}`)
    expect(blocks.status).toBe(404) // unknown source id is an honest 404

    const reset = await req(base, 'POST', '/dokumen/reset', { root })
    expect(reset.status).toBe(200)
    expect(reset.body.archived).toContain('.daedalus/dokumen-archive/')
    expect(existsSync(join(root, String(reset.body.archived), 'document.json'))).toBe(true)
    expect(await getDocument(base, root)).toBeNull()
  })

  test('schema save + offline release approves on disk', async () => {
    const { base, root } = await listen()
    writeFileSync(join(root, 'invoice.txt'), INVOICE)
    await req(base, 'POST', '/dokumen/sources', { root, paths: ['invoice.txt'] })
    const saved = await req(base, 'POST', '/dokumen/schema', {
      root,
      schema: { fields: [{ name: 'vendor', type: 'string', required: true }, { name: 'total', type: 'money', required: true }], extraction_target: 'per_doc' },
    })
    expect(saved.status).toBe(200)
    const released = await req(base, 'POST', '/dokumen/release', { root })
    expect(released.status).toBe(200)
    expect(released.body.applied).toBe('schema-approved')
    const doc = await getDocument(base, root)
    expect(doc?.schema?.approved).toBe(true)
    // Second release has nothing staged anymore.
    const again = await req(base, 'POST', '/dokumen/release', { root })
    expect(again.status).toBe(409)
  })

  test('style-inspect proposes deterministic ops for a DOCX', async () => {
    const { base, root } = await listen()
    const doc = await createActiveDocument(root, 'compose', 'Inspeksi')
    const exported = await exportDocumentDocx(root, {
      ...doc,
      sections: [{ id: 's1', title: 'Bab 1', thesisPoints: [], citations: [], prose: 'Isi bab yang cukup panjang untuk dirender sebagai paragraf dokumen.', status: 'drafted' }],
    })
    const rel = exported.path
    const inspected = await req(base, 'POST', '/dokumen/style-inspect', { root, path: rel, instruction: 'margin 4-3-3-3, font Times New Roman 12pt, spasi 1.5' })
    expect(inspected.status).toBe(200)
    const ops = inspected.body.ops as Array<{ target: string }>
    expect(ops.map((o) => o.target)).toEqual(expect.arrayContaining(['margin', 'font', 'lineSpacing']))
  })
})

describe('Dokumen task flow (staged schema gate over HTTP)', () => {
  test('extract runs only after the panel releases the schema; correction + export follow', async () => {
    const { base, root } = await listen()
    writeFileSync(join(root, 'invoice.txt'), INVOICE)
    const created = await req(base, 'POST', '/tasks', {
      goal: 'ekstrak invoice ini',
      domain: 'dokumen',
      repo_path: root,
      provider_id: 'fake',
      model: 'fake-model',
      dokumen: { sub_mode: 'ekstrak', sources: ['invoice.txt'] },
    })
    expect(created.status).toBe(201)
    const taskId = String(created.body.id)

    // Schema is staged for review — nothing extracted yet.
    const staged = await untilDocument(base, root, (d) => Boolean(d.schema && !d.schema.approved))
    expect(staged.records).toHaveLength(0)

    const released = await req(base, 'POST', '/dokumen/release', { root })
    expect(released.status).toBe(200)
    expect(released.body.released).toBe(true)

    const state = await waitForTask(base, taskId)
    expect(state.status).toBe('done')

    const doc = await getDocument(base, root)
    expect(doc?.records).toHaveLength(1)
    expect(doc?.records[0]!.decision).toBe('auto-clear')
    expect(doc?.records[0]!.fields.total!.value).toBe(555000)

    // Human correction in the grid.
    const corrected = await req(base, 'POST', '/dokumen/field', { root, record_id: doc!.records[0]!.id, field: 'vendor', value: 'PT Maju Bersama (revisi)' })
    expect(corrected.status).toBe(200)
    const record = (corrected.body.record as Doc['records'][number])
    expect(record.fields.vendor!.status).toBe('corrected')
    expect(record.fields.vendor!.value).toBe('PT Maju Bersama (revisi)')

    // Export passes the gate (auto-clear already verified).
    const exported = await req(base, 'POST', '/dokumen/export-data', { root, format: 'json' })
    expect(exported.status).toBe(200)
    const result = exported.body.result as { recordCount: number; heldBack: number; path: string }
    expect(result.recordCount).toBe(1)
    expect(result.heldBack).toBe(0)
    const rows = JSON.parse(readFileSync(join(root, result.path), 'utf8')) as Array<Record<string, unknown>>
    expect(rows[0]!.vendor).toBe('PT Maju Bersama (revisi)')
  })

  test('invalid dokumen parameters are named 400s', async () => {
    const { base, root } = await listen()
    const badDomain = await req(base, 'POST', '/tasks', { goal: 'x', domain: 'bogus', repo_path: root })
    expect(badDomain.status).toBe(400)
    expect(badDomain.body.error).toBe('invalid_domain')
    const badSub = await req(base, 'POST', '/tasks', { goal: 'x', domain: 'dokumen', repo_path: root, dokumen: { sub_mode: 'acak' } })
    expect(badSub.status).toBe(400)
    expect(badSub.body.error).toBe('invalid_dokumen_submode')
  })
})

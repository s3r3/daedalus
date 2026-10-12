import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Slide core separation at the HTTP surface: a slide-domain task runs to
 * completion through the SlideEngine (deck + .pptx on disk, no agent
 * loop), and the editor's variant calls POST /slides/deck/regenerate
 * instead of creating a task.
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

/** Content-aware fake provider: answers the engine's stage prompts with valid stage JSON. */
function stageReply(body: string): string {
  let system = ''
  let user = ''
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
    const messages = parsed.messages ?? []
    const systemMessage = messages.find((message) => message.role === 'system')
    system = typeof systemMessage?.content === 'string' ? systemMessage.content : ''
    user = typeof messages[1]?.content === 'string' ? messages[1].content : ''
  } catch { /* fall through to the plain reply */ }
  if (system.includes('OUTLINE stage')) {
    const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 2)
    return JSON.stringify(Array.from({ length: count }, (_, index) => ({
      title: `Slide ${index + 1}`,
      layoutId: index === 0 ? 'title' : 'bullets',
      keyMessage: `poin ${index + 1}`,
    })))
  }
  if (system.includes('FILL stage')) {
    if (user.includes('layout: title')) return JSON.stringify({ title: 'Judul Server', subtitle: 'Sub' })
    return JSON.stringify({ title: 'Varian Baru', points: ['segar', 'baru'] })
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
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: stageReply(body) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-slideengine-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-slideengine-ws-'))
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
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
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

describe('slide task through the engine (server level)', () => {
  test('POST /tasks domain slide completes with a filled deck and a .pptx on disk', async () => {
    const { base, root } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan deck tentang arsitektur server',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'smart', slide_count: 2 },
    })
    expect(created.status).toBe(201)
    const id = String(created.body.id ?? '')
    expect(id).toBeTruthy()

    const record = await waitForTask(base, id)
    expect(record.status).toBe('done')

    const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: Array<{ status: string }> }
    expect(deck.slides).toHaveLength(2)
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true)
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(true)
  })
})

async function waitForSkeletonFile(root: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: Array<{ status: string }> }
      if (deck.slides.length === count && deck.slides.every((slide) => slide.status === 'skeleton')) return
    } catch { /* deck not persisted yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('staged skeleton deck never appeared')
}

describe('POST /slides/deck/generate (outline-first Buat button)', () => {
  test('a Standard task stages its outline; Buat releases it and the original task completes', async () => {
    const { base, root } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan deck tentang arsitektur server',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'standard', slide_count: 2 },
    })
    expect(created.status).toBe(201)
    const id = String(created.body.id ?? '')
    expect(id).toBeTruthy()

    await waitForSkeletonFile(root, 2)
    // Parked at the staging gate: not done, not failed, no export yet.
    const parked = await req(base, 'GET', `/tasks/${id}`)
    const parkedRecord = (parked.body.state ?? parked.body) as Record<string, unknown>
    expect(parkedRecord.status).not.toBe('done')
    expect(parkedRecord.status).not.toBe('failed')
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(false)

    const generated = await req(base, 'POST', '/slides/deck/generate', { root, template_id: 'ocean' })
    expect(generated.status).toBe(200)
    expect(generated.body.task_id).toBe(id)
    expect(generated.body.outcome).toBe('success')

    const record = await waitForTask(base, id)
    expect(record.status).toBe('done')
    const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { theme: { templateId?: string }; slides: Array<{ status: string }> }
    expect(deck.theme.templateId).toBe('ocean')
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true)
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(true)
  })

  test('nothing staged is an honest error; an unknown template is a 400', async () => {
    const { base, root } = await listen()
    const noDeck = await req(base, 'POST', '/slides/deck/generate', { root })
    expect(noDeck.status).toBe(404)
    expect(noDeck.body.error).toBe('deck_not_found')

    const deck = newDeck('Deck Penuh')
    deck.slides.push({ id: 's-1', layout: 'bullets', content: { title: 'Isi', points: ['a'] }, status: 'filled' })
    await writeDeck(root, deck)
    const filled = await req(base, 'POST', '/slides/deck/generate', { root })
    expect(filled.status).toBe(409)
    expect(filled.body.error).toBe('no_staged_outline')

    const badTemplate = await req(base, 'POST', '/slides/deck/generate', { root, template_id: 'tidak-ada' })
    expect(badTemplate.status).toBe(400)
    expect(badTemplate.body.error).toBe('unknown_slide_template')
  })

  test('Buat with no live run fills the staged skeleton directly', async () => {
    const { base, root } = await listen()
    const deck = newDeck('Deck Kerangka')
    deck.slides.push(
      { id: 's-1', layout: 'title', content: { title: 'Judul' }, status: 'skeleton', keyMessage: 'pembuka' },
      { id: 's-2', layout: 'bullets', content: { title: 'Isi' }, status: 'skeleton', keyMessage: 'inti' },
    )
    await writeDeck(root, deck)

    const generated = await req(base, 'POST', '/slides/deck/generate', { root })
    expect(generated.status).toBe(200)
    expect(generated.body.outcome).toBe('success')
    const after = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: Array<{ status: string }> }
    expect(after.slides.every((slide) => slide.status === 'filled')).toBe(true)
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(true)
  })
})

describe('POST /slides/deck/regenerate (editor variant)', () => {
  test('regenerates the one slide in place; unknown slide and missing deck are honest errors', async () => {
    const { base, root } = await listen()
    const deck = newDeck('Deck Varian')
    deck.slides.push(
      { id: 's-1', layout: 'bullets', content: { title: 'Lama', points: ['a'] }, status: 'filled' },
      { id: 's-2', layout: 'bullets', content: { title: 'Tetap', points: ['b'] }, status: 'filled' },
    )
    await writeDeck(root, deck)

    const regenerated = await req(base, 'POST', '/slides/deck/regenerate', { root, slide_id: 's-1', provider_id: 'fake' })
    expect(regenerated.status).toBe(200)
    const after = regenerated.body.deck as { slides: Array<{ id: string; content: { title?: string } }> }
    expect(after.slides.find((slide) => slide.id === 's-1')?.content.title).toBe('Varian Baru')
    expect(after.slides.find((slide) => slide.id === 's-2')?.content.title).toBe('Tetap')
    const onDisk = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: Array<{ id: string; content: { title?: string } }> }
    expect(onDisk.slides.find((slide) => slide.id === 's-1')?.content.title).toBe('Varian Baru')

    const missing = await req(base, 'POST', '/slides/deck/regenerate', { root, slide_id: 'tidak-ada', provider_id: 'fake' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('slide_not_found')

    const emptyRoot = join(root, 'sub', 'belum-ada-deck')
    mkdirSync(emptyRoot, { recursive: true })
    const noDeck = await req(base, 'POST', '/slides/deck/regenerate', { root: emptyRoot, slide_id: 's-1' })
    expect(noDeck.status).toBe(404)
    expect(noDeck.body.error).toBe('deck_not_found')
    expect(existsSync(join(emptyRoot, 'deck'))).toBe(false)
  })
})

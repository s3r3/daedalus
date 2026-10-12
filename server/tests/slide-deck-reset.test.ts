import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Slide new-chat reset at the HTTP surface (Farid: "pas tekan new chat ke
 * reset semua"): POST /slides/deck/reset archives the current deck into
 * .daedalus/deck-archive/<timestamp> — preserved, never deleted — so the
 * next prompt starts from an empty deck. A staged run is settled through
 * the runtime seam; a run actively filling is a 409, never a yanked file.
 */

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let fake: HttpServer | undefined
let tmp: string | undefined
let workspace: string | undefined

/** Fill-stage gate: while armed, FILL replies wait for the test to release them. */
let holdFill = false
let fillArrivals = 0
let fillRelease: (() => void) | undefined
let fillGate: Promise<void> | undefined

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
  holdFill = false
  fillArrivals = 0
  fillRelease = undefined
  fillGate = undefined
})

function armFillGate(): void {
  holdFill = true
  fillArrivals = 0
  fillGate = new Promise<void>((resolve) => {
    fillRelease = resolve
  })
}

async function stageReply(body: string): Promise<string> {
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
    fillArrivals += 1
    if (holdFill && fillGate) await fillGate
    if (user.includes('layout: title')) return JSON.stringify({ title: 'Judul Server', subtitle: 'Sub' })
    return JSON.stringify({ title: 'Isi Baru', points: ['segar', 'baru'] })
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
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-deckreset-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-deckreset-ws-'))
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

async function waitForFillArrival(): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (fillArrivals > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('fill stage never started')
}

describe('POST /slides/deck/reset (slide new-chat reset)', () => {
  test('archives deck.json + exported .pptx into .daedalus/deck-archive; a second reset is a no-op', async () => {
    const { base, root } = await listen()
    const deck = newDeck('Deck Lama')
    deck.slides.push({ id: 's-1', layout: 'bullets', content: { title: 'Isi', points: ['a'] }, status: 'filled' })
    await writeDeck(root, deck)
    writeFileSync(join(root, 'deck', 'deck-lama.pptx'), 'fake-pptx-bytes')

    const reset = await req(base, 'POST', '/slides/deck/reset', { root })
    expect(reset.status).toBe(200)
    expect(reset.body.staged_abandoned).toBe(false)
    const archived = String(reset.body.archived ?? '')
    expect(archived).toMatch(/^\.daedalus\/deck-archive\//)

    // The deck moved aside whole: nothing deleted, deck/ itself gone.
    expect(existsSync(join(root, 'deck'))).toBe(false)
    const archiveDir = join(root, ...archived.split('/'))
    expect(readdirSync(archiveDir).sort()).toEqual(['assets', 'deck-lama.pptx', 'deck.json'])
    const preserved = JSON.parse(readFileSync(join(archiveDir, 'deck.json'), 'utf8')) as { title: string }
    expect(preserved.title).toBe('Deck Lama')
    expect(readFileSync(join(archiveDir, 'deck-lama.pptx'), 'utf8')).toBe('fake-pptx-bytes')

    const again = await req(base, 'POST', '/slides/deck/reset', { root })
    expect(again.status).toBe(200)
    expect(again.body.archived).toBeNull()
  })

  test('no deck anywhere is an honest no-op success (nothing created)', async () => {
    const { base, root } = await listen()
    const reset = await req(base, 'POST', '/slides/deck/reset', { root })
    expect(reset.status).toBe(200)
    expect(reset.body.archived).toBeNull()
    expect(reset.body.staged_abandoned).toBe(false)
    expect(existsSync(join(root, '.daedalus', 'deck-archive'))).toBe(false)
  })

  test('settles a staged Standard run honestly and archives its skeleton', async () => {
    const { base, root } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan deck tentang reset',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'standard', slide_count: 2 },
    })
    expect(created.status).toBe(201)
    const id = String(created.body.id ?? '')
    await waitForSkeletonFile(root, 2)

    const reset = await req(base, 'POST', '/slides/deck/reset', { root })
    expect(reset.status).toBe(200)
    expect(reset.body.staged_abandoned).toBe(true)
    const archived = String(reset.body.archived ?? '')
    expect(archived).toMatch(/^\.daedalus\/deck-archive\//)
    expect(existsSync(join(root, 'deck'))).toBe(false)
    const skeleton = JSON.parse(readFileSync(join(root, ...archived.split('/'), 'deck.json'), 'utf8')) as { slides: Array<{ status: string }> }
    expect(skeleton.slides).toHaveLength(2)
    expect(skeleton.slides.every((slide) => slide.status === 'skeleton')).toBe(true)

    const record = await waitForTask(base, id)
    expect(record.status).toBe('failed')
    expect(record.last_error).toBe('staged_superseded')
  })

  test('refuses with 409 while a generation is actively filling; files stay put', async () => {
    const { base, root } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan deck tentang pengisian',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'standard', slide_count: 2 },
    })
    expect(created.status).toBe(201)
    await waitForSkeletonFile(root, 2)

    armFillGate()
    const generatePromise = req(base, 'POST', '/slides/deck/generate', { root })
    await waitForFillArrival()

    const reset = await req(base, 'POST', '/slides/deck/reset', { root })
    expect(reset.status).toBe(409)
    expect(reset.body.error).toBe('slide_run_in_progress')
    expect(existsSync(join(root, 'deck', 'deck.json'))).toBe(true)

    fillRelease?.()
    const generated = await generatePromise
    expect(generated.status).toBe(200)
    expect(generated.body.outcome).toBe('success')
    const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: Array<{ status: string }> }
    expect(deck.slides.every((slide) => slide.status === 'filled')).toBe(true)
  })

  test('an empty sub-workspace path inside root also resets cleanly', async () => {
    const { base, root } = await listen()
    const sub = join(root, 'sub')
    mkdirSync(sub, { recursive: true })
    const reset = await req(base, 'POST', '/slides/deck/reset', { root: sub })
    expect(reset.status).toBe(200)
    expect(reset.body.archived).toBeNull()
  })
})

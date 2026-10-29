import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Dae Captain Fase B — slide endpoints: per-slide design variants and
 * smart template recommendation.
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

async function startFakeProvider(): Promise<string> {
  fake = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Siap.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

// S6: daemon token for mutation routes, set by listen() (GET/OPTIONS ignore it).
let daemonToken = ''

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-faseb-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-faseb-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  const baseUrl = await startFakeProvider()
  ctx.providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'fake-key', models: ['fake-model'], defaultModel: 'fake-model', enabled: true })
  server = createApp(ctx)
  daemonToken = ctx.daemonToken ?? ''
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function req(base: string, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json', ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedDeck(root: string): Promise<void> {
  const deck = newDeck('Deck Fase B')
  deck.slides.push({ id: 's-1', layout: 'bullets', content: { title: 'Sidang Skripsi', points: ['Latar belakang', 'Metode'] } })
  deck.slides.push({ id: 's-2', layout: 'image-side', content: { title: 'Hasil', points: ['Naik 3x'], image: 'foto.png' } })
  await writeDeck(root, deck)
  // The image asset must really exist, or validateDeck rejects the deck.
  mkdirSync(join(root, 'deck', 'assets'), { recursive: true })
  writeFileSync(join(root, 'deck', 'assets', 'foto.png'), 'fake-png')
}

describe('Fase B slide endpoints', () => {
  test('POST /slides/deck/slide/variants returns 3 sane variants', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    const res = await req(base, 'POST', '/slides/deck/slide/variants', { root, slide_id: 's-1' })
    expect(res.status).toBe(200)
    const variants = res.body.variants as Array<{ id: string; label: string; positions: Record<string, unknown> }>
    expect(variants).toHaveLength(3)
    expect(variants.map((v) => v.id)).toEqual(['klasik', 'terpusat', 'melebar'])
    for (const v of variants) {
      expect(typeof v.label).toBe('string')
      for (const p of Object.values(v.positions) as Array<{ x: number; y: number; w?: number }>) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x + (p.w ?? 0)).toBeLessThanOrEqual(1)
      }
    }
  })

  test('POST /slides/deck/slide/variants 404s an unknown slide', async () => {
    const { base, root } = await listen()
    await seedDeck(root)
    const res = await req(base, 'POST', '/slides/deck/slide/variants', { root, slide_id: 'nope' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('slide_not_found')
  })

  test('applying a variant via slide/update validates and persists', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    const res = await req(base, 'POST', '/slides/deck/slide/variants', { root, slide_id: 's-1' })
    const variant = (res.body.variants as Array<{ id: string; positions: Record<string, unknown> }>)[1]!
    const upd = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: 's-1', positions: variant.positions })
    expect(upd.status).toBe(200)
    const deck = (upd.body.deck ?? {}) as { slides: Array<{ positions?: unknown }> }
    expect(deck.slides[0]?.positions).toEqual(variant.positions)
  })

  test('GET /slides/recommend-template recommends Cendekia for a sidang deck', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    const res = await fetch(new URL(`/slides/recommend-template?root=${encodeURIComponent(root)}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { template_id: string; name: string; reason: string }
    expect(body.template_id).toBe('cendekia')
    expect(body.name).toBe('Naskah Cendekia')
    expect(body.reason).toContain('sidang')
  })

  test('GET /slides/recommend-template 404s when there is no deck', async () => {
    const { base, root } = await listen()
    const res = await fetch(new URL(`/slides/recommend-template?root=${encodeURIComponent(root)}`, base))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('deck_not_found')
  })
})

import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Agentic Slide v2 server surface: bundled templates, core-gated deck
 * editing (validateDeck rejects, nothing written), export, and the slide
 * composer params on POST /tasks (validated, then forwarded to core).
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

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-slidesdeck-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-slidesdeck-ws-'))
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

async function seedDeck(root: string): Promise<void> {
  const deck = newDeck('Deck Uji')
  deck.slides.push({ id: 's-1', layout: 'bullets', content: { title: 'Satu', points: ['a'] } })
  await writeDeck(root, deck)
}

describe('/slides deck endpoints', () => {
  test('templates are listed and a missing deck is an honest 404', async () => {
    const { base, root } = await listen()
    const templates = await req(base, 'GET', '/slides/templates')
    expect(templates.status).toBe(200)
    expect(JSON.stringify(templates.body)).toContain('midnight-scholar')

    const missing = await req(base, 'GET', `/slides/deck?root=${encodeURIComponent(root)}`)
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('deck_not_found')
  })

  test('theme, slide add/update/move/delete, and export round-trip through core validation', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    const themed = await req(base, 'POST', '/slides/deck/theme', { root, template_id: 'ocean' })
    expect(themed.status).toBe(200)
    const deckAfterTheme = themed.body.deck as { theme: { templateId?: string; accent?: string } }
    expect(deckAfterTheme.theme.templateId).toBe('ocean')
    expect(deckAfterTheme.theme.accent).toBe('#2dd4bf')

    const badTemplate = await req(base, 'POST', '/slides/deck/theme', { root, template_id: 'nope' })
    expect(badTemplate.status).toBe(400)

    const added = await req(base, 'POST', '/slides/deck/slide/add', { root, layout: 'bullets', content: { title: 'Dua', points: ['b'] } })
    expect(added.status).toBe(200)
    const newId = added.body.slide_id as string
    expect(newId).toBeTruthy()

    const invalid = await req(base, 'POST', '/slides/deck/slide/add', { root, layout: 'layout-ngawur', content: {} })
    expect(invalid.status).toBe(422)
    expect(invalid.body.error).toBe('deck_invalid')

    const updated = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: newId, content: { points: ['b1', 'b2'] } })
    expect(updated.status).toBe(200)
    const deckAfterUpdate = updated.body.deck as { slides: Array<{ id: string; content: { points?: string[] } }> }
    expect(deckAfterUpdate.slides.find((s) => s.id === newId)?.content.points).toEqual(['b1', 'b2'])

    const moved = await req(base, 'POST', '/slides/deck/slide/move', { root, slide_id: newId, to_index: 0 })
    expect(moved.status).toBe(200)
    const deckAfterMove = moved.body.deck as { slides: Array<{ id: string }> }
    expect(deckAfterMove.slides[0]?.id).toBe(newId)

    const exported = await req(base, 'POST', '/slides/deck/export', { root })
    expect(exported.status).toBe(200)
    expect(String(exported.body.path)).toMatch(/\.pptx$/)
    expect(existsSync(join(root, String(exported.body.path)))).toBe(true)

    const deleted = await req(base, 'POST', '/slides/deck/slide/delete', { root, slide_id: newId })
    expect(deleted.status).toBe(200)
    const deckAfterDelete = deleted.body.deck as { slides: Array<{ id: string }> }
    expect(deckAfterDelete.slides.map((s) => s.id)).toEqual(['s-1'])
  })

  test('export refuses an invalid deck and an empty deck instead of reporting success', async () => {
    const { base, root } = await listen()
    const invalid = newDeck('Rusak')
    invalid.slides.push({ id: 's-x', layout: 'layout-ngawur', content: { title: 'X' } })
    await writeDeck(root, invalid)
    const refused = await req(base, 'POST', '/slides/deck/export', { root })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toBe('deck_invalid')

    const empty = newDeck('Kosong')
    await writeDeck(root, empty)
    const refusedEmpty = await req(base, 'POST', '/slides/deck/export', { root })
    expect(refusedEmpty.status).toBe(422)
    expect(refusedEmpty.body.error).toBe('deck_invalid')
    expect(JSON.stringify(refusedEmpty.body)).toContain('empty-deck')
  })
})

describe('POST /tasks slide params', () => {
  test('valid slide params are accepted and stored', async () => {
    const { base } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan slide tentang keamanan anak',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'standard', slide_count: 10, language: 'Bahasa Indonesia', template_id: 'general' },
    })
    expect(created.status).toBe(201)
    expect(created.body.domain).toBe('slide')
  })

  test('an unknown generation is a named 400', async () => {
    const { base } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan slide tentang keamanan anak',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'turbo' },
    })
    expect(created.status).toBe(400)
    expect(created.body.error).toBe('invalid_slide_generation')
  })

  test('an unknown template is a named 400', async () => {
    const { base } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan slide tentang keamanan anak',
      provider_id: 'fake',
      domain: 'slide',
      slide: { template_id: 'tidak-ada' },
    })
    expect(created.status).toBe(400)
    expect(created.body.error).toBe('unknown_slide_template')
  })

  test('an out-of-range slide count is a named 400', async () => {
    const { base } = await listen()
    const created = await req(base, 'POST', '/tasks', {
      goal: 'buatkan slide tentang keamanan anak',
      provider_id: 'fake',
      domain: 'slide',
      slide: { slide_count: 99 },
    })
    expect(created.status).toBe(400)
    expect(created.body.error).toBe('invalid_slide_count')
  })
})

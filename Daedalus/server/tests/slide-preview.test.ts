import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'
import { SlidePreviewService, type PreviewConverter, type SlidePreviewDeps } from '../src/slide-preview.ts'

/**
 * Pratinjau Asli (True Preview) routes: LibreOffice renders the
 * exported .pptx to per-page PNGs cached by a hash of everything the
 * export depends on. All converter/export seams are injected fakes,
 * so the suite is deterministic on machines without LibreOffice.
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

function fakeConverter(pages = 2, delayMs = 5): { converter: PreviewConverter; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    converter: async ({ workDir }) => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, delayMs))
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

const fakeExport: SlidePreviewDeps['exportPptx'] = async (root) => {
  const path = join(root, '.daedalus', 'fake-export.pptx')
  mkdirSync(join(root, '.daedalus'), { recursive: true })
  writeFileSync(path, Buffer.from('fake-pptx'))
  return { path, cleanup: async () => rmSync(path, { force: true }) }
}

function serviceWith(overrides: Partial<SlidePreviewDeps>): SlidePreviewService {
  return new SlidePreviewService({
    availability: () => ({ soffice: true, pdftoppm: true }),
    exportPptx: fakeExport,
    ...overrides,
  })
}

async function listen(service?: SlidePreviewService): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-preview-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-preview-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace, ...(service ? { slidePreview: service } : {}) })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function seedDeck(root: string, title = 'Deck Pratinjau'): Promise<void> {
  const deck = newDeck(title)
  deck.slides.push({ id: 's-1', layout: 'title', content: { title: 'Judul', subtitle: 'Subjudul' } })
  deck.slides.push({ id: 's-2', layout: 'bullets', content: { title: 'Isi', points: ['satu', 'dua'] } })
  await writeDeck(root, deck)
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
  return `/slides/deck/preview?root=${encodeURIComponent(root)}`
}

async function waitForStatus(base: string, root: string, wanted: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await reqJson(base, 'GET', statusPath(root))
    if (body.status === wanted) return body
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`preview never reached status ${wanted}`)
}

describe('/slides/deck/preview (Pratinjau Asli)', () => {
  test('missing deck is an honest 404, exactly like the other deck routes', async () => {
    const { base, root } = await listen(serviceWith({}))
    const status = await reqJson(base, 'GET', statusPath(root))
    expect(status.status).toBe(404)
    expect(status.body.error).toBe('deck_not_found')
    const render = await reqJson(base, 'POST', '/slides/deck/preview', { root })
    expect(render.status).toBe(404)
    expect(render.body.error).toBe('deck_not_found')
  })

  test('unavailable when soffice or pdftoppm is missing — a state, never a 500', async () => {
    const fake = fakeConverter()
    const { base, root } = await listen(
      serviceWith({ availability: () => ({ soffice: false, pdftoppm: true }), converter: fake.converter }),
    )
    await seedDeck(root)
    const status = await reqJson(base, 'GET', statusPath(root))
    expect(status.status).toBe(200)
    expect(status.body.available).toBe(false)
    expect(status.body.status).toBe('unavailable')
    const render = await reqJson(base, 'POST', '/slides/deck/preview', { root })
    expect(render.status).toBe(200)
    expect(render.body.status).toBe('unavailable')
    expect(fake.calls()).toBe(0)
  })

  test('POST renders once; GET reports ready with page URLs; pages are served as PNG', async () => {
    const fake = fakeConverter(2)
    const { base, root } = await listen(serviceWith({ converter: fake.converter }))
    await seedDeck(root)

    const idle = await reqJson(base, 'GET', statusPath(root))
    expect(idle.body.status).toBe('idle')
    expect(idle.body.pages).toBe(0)

    const posted = await reqJson(base, 'POST', '/slides/deck/preview', { root })
    expect(posted.status).toBe(200)
    expect(['rendering', 'ready']).toContain(posted.body.status)

    // A duplicate POST while the same state renders must not re-render.
    await reqJson(base, 'POST', '/slides/deck/preview', { root })
    const ready = await waitForStatus(base, root, 'ready')
    expect(fake.calls()).toBe(1)
    expect(ready.pages).toBe(2)
    const pageUrls = ready.pageUrls as string[]
    expect(Array.isArray(pageUrls)).toBe(true)
    expect(pageUrls).toHaveLength(2)
    expect(pageUrls[0]).toContain('/slides/deck/preview/page?')
    expect(pageUrls[0]).toContain(`key=${ready.key as string}`)

    const pageRes = await fetch(new URL(pageUrls[0]!, base))
    expect(pageRes.status).toBe(200)
    expect(pageRes.headers.get('content-type')).toBe('image/png')
    const bytes = Buffer.from(await pageRes.arrayBuffer())
    expect(bytes.equals(PNG_BYTES)).toBe(true)

    // Rendering again while ready is a no-op read of the cache.
    const again = await reqJson(base, 'POST', '/slides/deck/preview', { root })
    expect(again.body.status).toBe('ready')
    expect(fake.calls()).toBe(1)
  })

  test('deck changes make the cached render stale under a new key', async () => {
    const fake = fakeConverter(2)
    const { base, root } = await listen(serviceWith({ converter: fake.converter }))
    await seedDeck(root)
    await reqJson(base, 'POST', '/slides/deck/preview', { root })
    const ready = await waitForStatus(base, root, 'ready')

    await seedDeck(root, 'Deck Berubah Total')
    const after = await reqJson(base, 'GET', statusPath(root))
    expect(after.body.status).toBe('stale')
    expect(after.body.pages).toBe(0)
    expect(after.body.key).not.toBe(ready.key)
  })

  test('a failed render surfaces as an error state with the converter message', async () => {
    const failing: PreviewConverter = async () => {
      throw new Error('soffice meledak di tengah jalan')
    }
    const { base, root } = await listen(serviceWith({ converter: failing }))
    await seedDeck(root)
    await reqJson(base, 'POST', '/slides/deck/preview', { root })
    const errored = await waitForStatus(base, root, 'error')
    expect(String(errored.error)).toContain('soffice meledak')
  })

  test('page serving refuses malformed keys, bad pages, and traversal', async () => {
    const fake = fakeConverter(1)
    const { base, root } = await listen(serviceWith({ converter: fake.converter }))
    await seedDeck(root)
    await reqJson(base, 'POST', '/slides/deck/preview', { root })
    const ready = await waitForStatus(base, root, 'ready')
    const key = ready.key as string

    const badKey = await fetch(new URL(`/slides/deck/preview/page?root=${encodeURIComponent(root)}&key=..%2F..%2Fdeck&page=1`, base))
    expect(badKey.status).toBe(404)
    expect(badKey.headers.get('content-type')).not.toBe('image/png')

    const unknownKey = await fetch(new URL(`/slides/deck/preview/page?root=${encodeURIComponent(root)}&key=${'0'.repeat(64)}&page=1`, base))
    expect(unknownKey.status).toBe(404)

    const badPage = await fetch(new URL(`/slides/deck/preview/page?root=${encodeURIComponent(root)}&key=${key}&page=abc`, base))
    expect(badPage.status).toBe(400)

    const missingPage = await fetch(new URL(`/slides/deck/preview/page?root=${encodeURIComponent(root)}&key=${key}&page=99`, base))
    expect(missingPage.status).toBe(404)
  })
})

describe('SlidePreviewService cache key', () => {
  test('stable for identical state; changes when deck bytes or asset bytes change', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'daedalus-preview-key-'))
    const root = join(tmp, 'ws')
    mkdirSync(root, { recursive: true })
    const service = serviceWith({})
    await seedDeck(root)
    const deck = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as Parameters<SlidePreviewService['computeKey']>[1]

    const key1 = await service.computeKey(root, deck)
    expect(await service.computeKey(root, deck)).toBe(key1)

    mkdirSync(join(root, 'deck', 'assets'), { recursive: true })
    writeFileSync(join(root, 'deck', 'assets', 'fig.png'), PNG_BYTES)
    const key2 = await service.computeKey(root, deck)
    expect(key2).not.toBe(key1)

    writeFileSync(join(root, 'deck', 'assets', 'fig.png'), Buffer.concat([PNG_BYTES, Buffer.from('x')]))
    expect(await service.computeKey(root, deck)).not.toBe(key2)
  })
})

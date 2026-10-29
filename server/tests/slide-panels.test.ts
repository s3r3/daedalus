import { afterEach, describe, expect, test } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, newDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'
import { convertPptxToPdf, SofficeMissingError } from '../src/slide-preview.ts'

/**
 * Slide panel consolidation additions: speaker notes on the slide update
 * endpoint, the deck archive browser + restore endpoints, and the PDF
 * export endpoint.
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

// S6: daemon token for mutation routes, set by listen() (GET/OPTIONS ignore it).
let daemonToken = ''

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-slidepanels-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-slidepanels-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
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

async function seedDeck(root: string, title = 'Deck Uji'): Promise<void> {
  const deck = newDeck(title)
  deck.slides.push({ id: 's-1', layout: 'bullets', content: { title: 'Satu', points: ['a'] } })
  await writeDeck(root, deck)
}

type SlideView = { id: string; notes?: unknown }

describe('speaker notes on /slides/deck/slide/update', () => {
  test('notes round-trip: set, persist, clear with "" and null, reject a non-string', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    const noted = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: 's-1', notes: 'Buka dengan lelucon.' })
    expect(noted.status).toBe(200)
    const after = (noted.body.deck as { slides: SlideView[] }).slides.find((s) => s.id === 's-1')
    expect(after?.notes).toBe('Buka dengan lelucon.')
    const onDisk = JSON.parse(readFileSync(join(root, 'deck', 'deck.json'), 'utf8')) as { slides: SlideView[] }
    expect(onDisk.slides[0]?.notes).toBe('Buka dengan lelucon.')

    // notes-only updates need no content
    const cleared = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: 's-1', notes: '' })
    expect(cleared.status).toBe(200)
    const afterClear = (cleared.body.deck as { slides: SlideView[] }).slides.find((s) => s.id === 's-1')
    expect(afterClear?.notes).toBeUndefined()
    expect('notes' in (afterClear ?? {})).toBe(false)

    const renoted = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: 's-1', notes: 'sekali lagi' })
    expect(renoted.status).toBe(200)
    const nulled = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: 's-1', notes: null })
    expect(nulled.status).toBe(200)
    const afterNull = (nulled.body.deck as { slides: SlideView[] }).slides.find((s) => s.id === 's-1')
    expect(afterNull?.notes).toBeUndefined()

    // A non-string is a 400, never a silent write.
    const bad = await req(base, 'POST', '/slides/deck/slide/update', { root, slide_id: 's-1', notes: 42 })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_notes')
  })
})

describe('deck archive browser + restore', () => {
  test('empty archive lists nothing; reset archives; restore brings the deck back', async () => {
    const { base, root } = await listen()

    const empty = await fetch(new URL(`/slides/deck/archive?root=${encodeURIComponent(root)}`, base))
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { archives: unknown[] }).archives).toEqual([])

    await seedDeck(root, 'Deck Asli')
    const reset = await req(base, 'POST', '/slides/deck/reset', { root })
    expect(reset.status).toBe(200)
    expect(existsSync(join(root, 'deck'))).toBe(false)

    const listed = (await (await fetch(new URL(`/slides/deck/archive?root=${encodeURIComponent(root)}`, base))).json()) as {
      archives: Array<{ name: string; title: string; slides: number; archivedAt: string }>
    }
    expect(listed.archives).toHaveLength(1)
    const entry = listed.archives[0]!
    expect(entry.title).toBe('Deck Asli')
    expect(entry.slides).toBe(1)
    expect(typeof entry.archivedAt).toBe('string')

    const restored = await req(base, 'POST', '/slides/deck/archive/restore', { root, name: entry.name })
    expect(restored.status).toBe(200)
    const deck = restored.body.deck as { title: string; slides: unknown[] }
    expect(deck.title).toBe('Deck Asli')
    expect(deck.slides).toHaveLength(1)
    // Non-destructive: the archive entry is still there (it was copied).
    expect(existsSync(join(root, '.daedalus', 'deck-archive', entry.name, 'deck.json'))).toBe(true)
    expect(existsSync(join(root, 'deck', 'deck.json'))).toBe(true)
  })

  test('restoring over a current deck archives the current deck aside first', async () => {
    const { base, root } = await listen()
    await seedDeck(root, 'Deck Pertama')
    await req(base, 'POST', '/slides/deck/reset', { root })
    await seedDeck(root, 'Deck Kedua')

    const listed = (await (await fetch(new URL(`/slides/deck/archive?root=${encodeURIComponent(root)}`, base))).json()) as {
      archives: Array<{ name: string; title: string }>
    }
    const restore = await req(base, 'POST', '/slides/deck/archive/restore', { root, name: listed.archives[0]!.name })
    expect(restore.status).toBe(200)
    expect((restore.body.deck as { title: string }).title).toBe('Deck Pertama')

    // The second deck was archived aside, not deleted: two archives now.
    const relisted = (await (await fetch(new URL(`/slides/deck/archive?root=${encodeURIComponent(root)}`, base))).json()) as {
      archives: Array<{ name: string; title: string }>
    }
    expect(relisted.archives).toHaveLength(2)
    expect(relisted.archives.map((a) => a.title).sort()).toEqual(['Deck Kedua', 'Deck Pertama'])
  })

  test('traversal names are rejected and missing archives are honest 404s', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    for (const name of ['../deck.json', '..', '.', '', 'a/b', 'a\\b', '/absen']) {
      const rejected = await req(base, 'POST', '/slides/deck/archive/restore', { root, name })
      expect(rejected.status).toBe(400)
      expect(rejected.body.error).toBe('invalid_archive_name')
    }
    const missing = await req(base, 'POST', '/slides/deck/archive/restore', { root, name: 'tidak-ada' })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('archive_not_found')
    // The workspace deck is untouched by the failed restores.
    const deck = (await (await fetch(new URL(`/slides/deck?root=${encodeURIComponent(root)}`, base))).json()) as { deck: { title: string } }
    expect(deck.deck.title).toBe('Deck Uji')
  })

  test('a broken archive entry is omitted from the list and refused on restore without touching the workspace', async () => {
    const { base, root } = await listen()
    await seedDeck(root, 'Deck Baik')
    await req(base, 'POST', '/slides/deck/reset', { root })

    // Plant a corrupt entry beside the real one.
    const corrupt = join(root, '.daedalus', 'deck-archive', 'rusak')
    rmSync(corrupt, { recursive: true, force: true })
    mkdirSync(corrupt, { recursive: true })
    writeFileSync(join(corrupt, 'deck.json'), '{bukan json', 'utf8')

    const listed = (await (await fetch(new URL(`/slides/deck/archive?root=${encodeURIComponent(root)}`, base))).json()) as {
      archives: Array<{ name: string; title: string }>
    }
    expect(listed.archives).toHaveLength(1)
    expect(listed.archives[0]!.title).toBe('Deck Baik')

    await seedDeck(root, 'Deck Baru')
    const refused = await req(base, 'POST', '/slides/deck/archive/restore', { root, name: 'rusak' })
    expect(refused.status).toBe(422)
    expect(refused.body.error).toBe('archive_invalid')
    const kept = (await (await fetch(new URL(`/slides/deck?root=${encodeURIComponent(root)}`, base))).json()) as { deck: { title: string } }
    expect(kept.deck.title).toBe('Deck Baru')
  })
})

describe('POST /slides/deck/export-pdf', () => {
  test('an empty or invalid deck is refused with the same codes as the pptx export', async () => {
    const { base, root } = await listen()

    const missing = await req(base, 'POST', '/slides/deck/export-pdf', { root })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('deck_not_found')

    const empty = newDeck('Kosong')
    await writeDeck(root, empty)
    const refusedEmpty = await req(base, 'POST', '/slides/deck/export-pdf', { root })
    expect(refusedEmpty.status).toBe(422)
    expect(refusedEmpty.body.error).toBe('deck_invalid')
    expect(JSON.stringify(refusedEmpty.body)).toContain('empty-deck')
  })

  test('without soffice the route answers an honest 503, never a crash', async () => {
    const { base, root } = await listen()
    await seedDeck(root)
    const savedPath = process.env.PATH
    try {
      process.env.PATH = join(tmpdir(), 'daedalus-tanpa-soffice')
      const res = await req(base, 'POST', '/slides/deck/export-pdf', { root })
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('pdf_unavailable')
      expect(typeof res.body.message).toBe('string')
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
  })
})

describe('convertPptxToPdf seams', () => {
  test('throws SofficeMissingError when soffice cannot be found', async () => {
    await expect(convertPptxToPdf('/tmp/x.pptx', '/tmp', { findSoffice: () => null })).rejects.toBeInstanceOf(SofficeMissingError)
  })

  test('a stubbed conversion wires pptx → pdf naming and returns the written path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daedalus-pdfseam-'))
    try {
      const pptx = join(dir, 'deck-uji.pptx')
      writeFileSync(pptx, 'palsu', 'utf8')
      const pdf = await convertPptxToPdf(pptx, dir, {
        findSoffice: () => '/usr/bin/soffice',
        runConversion: async (_soffice, input, outDir) => {
          const { basename } = await import('node:path')
          writeFileSync(join(outDir, `${basename(input).replace(/\.pptx$/i, '')}.pdf`), '%PDF-1.4 palsu', 'utf8')
        },
      })
      expect(pdf).toBe(join(dir, 'deck-uji.pdf'))
      expect(existsSync(pdf)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

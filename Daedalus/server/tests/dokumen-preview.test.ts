import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createActiveDocument, readActiveDocument, writeDocument, type DocumentState } from '@daedalus/core'
import { createApp, createContext } from '../src/app.ts'
import { DokumenPreviewService, styleResultPath, type DokumenPreviewDeps } from '../src/dokumen-preview.ts'

/**
 * Dokumen Pratinjau end to end on this Linux box: the endpoints, the
 * state-hash cache under `.daedalus/dokumen-preview/`, stale
 * detection, section-edit invalidation, and the Tata ulang result
 * kind. The renderer a converter would invoke is injected as a fake
 * (no LibreOffice in tests), Availability is injected as LibreOffice;
 * the compose DOCX bytes are REAL (built by the core exporter), so
 * the full loop — document.json → DOCX → per-page images — is proven.
 * The Word engine itself is never executed here (Windows only); only
 * its detection/script logic is unit-tested in
 * dokumen-preview-engines.test.ts.
 */

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

type PreviewStatus = {
  available: boolean
  status: string
  engine: string | null
  kind: string
  key: string | null
  pages: number
  pageUrls?: string[]
  error?: string
}

async function waitStatus(base: string, search: string): Promise<PreviewStatus> {
  for (let i = 0; i < 100; i += 1) {
    const response = await fetch(`${base}/dokumen/preview?${search}`)
    expect(response.status).toBe(200)
    const status = (await response.json()) as PreviewStatus
    if (status.status !== 'rendering') return status
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('preview stayed rendering')
}

describe('Dokumen Pratinjau endpoints', () => {
  let ws: string

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'daedalus-dokumen-preview-'))
  })

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  async function boot(deps: DokumenPreviewDeps): Promise<string> {
    const ctx = createContext({ cwd: ws })
    ctx.dokumenPreview = new DokumenPreviewService(deps)
    const server = createApp(ctx)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    if (addr === null || typeof addr === 'string') throw new Error('no port')
    return `http://127.0.0.1:${addr.port}`
  }

  async function seedComposed(pages = 1): Promise<DocumentState> {
    const document = await createActiveDocument(ws, 'compose', 'Makalah Uji')
    document.sections = Array.from({ length: pages }, (_, index) => ({
      id: `s${index + 1}`,
      title: `Bab ${index + 1}`,
      thesisPoints: [],
      citations: [],
      status: 'drafted' as const,
      prose: `Isi bab ${index + 1} yang cukup panjang untuk dirender.`,
    }))
    await writeDocument(ws, document)
    return (await readActiveDocument(ws))!
  }

  const fakeConverterDeps = (overrides: Partial<DokumenPreviewDeps> = {}): DokumenPreviewDeps => ({
    availability: () => ({ libreOffice: true, word: false }),
    converter: async ({ workDir }) => {
      for (let i = 1; i <= 2; i += 1) writeFileSync(join(workDir, `page-${i}.png`), PNG_BYTES)
      return [join(workDir, 'page-1.png'), join(workDir, 'page-2.png')]
    },
    ...overrides,
  })

  test('no document -> 404 document_not_found; unknown kind -> 400', async () => {
    const base = await boot(fakeConverterDeps())
    const response = await fetch(`${base}/dokumen/preview?root=${encodeURIComponent(ws)}`)
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe('document_not_found')

    await seedComposed()
    const badKind = await fetch(`${base}/dokumen/preview?root=${encodeURIComponent(ws)}&kind=bogus`)
    expect(badKind.status).toBe(400)
    expect(((await badKind.json()) as { error: string }).error).toBe('invalid_preview_kind')
  })

  test('idle -> POST render -> ready with pages + page bytes; default kind is compose', async () => {
    const base = await boot(fakeConverterDeps())
    await seedComposed()
    const idle = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(idle).toMatchObject({ available: true, status: 'idle', engine: 'libreoffice', kind: 'compose' })
    expect(idle.key).toMatch(/^[a-f0-9]{64}$/)

    const started = await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws }),
    })
    expect(started.status).toBe(200)
    const ready = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(ready.status).toBe('ready')
    expect(ready.engine).toBe('libreoffice')
    expect(ready.pages).toBe(2)
    expect(ready.key).toMatch(/^[a-f0-9]{64}$/)
    expect(ready.pageUrls).toEqual([
      `/dokumen/preview/page?root=${encodeURIComponent(ws)}&key=${ready.key}&page=1`,
      `/dokumen/preview/page?root=${encodeURIComponent(ws)}&key=${ready.key}&page=2`,
    ])
    const cacheDir = join(ws, '.daedalus', 'dokumen-preview', ready.key!)
    expect(readFileSync(join(cacheDir, 'page-2.png')).equals(PNG_BYTES)).toBe(true)
    expect(JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf8'))).toMatchObject({ key: ready.key, pages: 2 })

    const pageRes = await fetch(`${base}${ready.pageUrls![1]}`)
    expect(pageRes.status).toBe(200)
    expect(pageRes.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await pageRes.arrayBuffer()).equals(PNG_BYTES)).toBe(true)

    // Serving without root defaults to the server workspace.
    const byDefault = await fetch(`${base}${ready.pageUrls![0].replace(`root=${encodeURIComponent(ws)}`, 'root=')}`)
    expect(byDefault.status).toBe(200)
  })

  test('malformed page requests are rejected; wildly off-root pages 404', async () => {
    const base = await boot(fakeConverterDeps())
    await seedComposed()
    const noKey = await fetch(`${base}/dokumen/preview/page?root=${encodeURIComponent(ws)}&page=1`)
    expect(noKey.status).toBe(400)
    const badPage = await fetch(`${base}/dokumen/preview/page?root=${encodeURIComponent(ws)}&key=${'a'.repeat(64)}&page=0`)
    expect(badPage.status).toBe(400)
    const ghost = await fetch(`${base}/dokumen/preview/page?root=${encodeURIComponent(ws)}&key=${'b'.repeat(64)}&page=1`)
    expect(ghost.status).toBe(404)
    const evil = await fetch(`${base}/dokumen/preview/page?root=${encodeURIComponent(ws)}&key=..%2F..%2Fsecret&page=1`)
    expect(evil.status).toBe(404)
  })

  test('stale after a prose edit through the real dokumen endpoints, then renders again', async () => {
    const base = await boot(fakeConverterDeps())
    await seedComposed()
    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws }),
    })
    const ready = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(ready.status).toBe('ready')

    // Edit section prose via the same endpoint the web editor uses.
    const edited = await fetch(`${base}/dokumen/section`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws, id: 's1', prose: 'Isi bab 1 yang sudah diubah.' }),
    })
    expect(edited.status).toBe(200)

    const stale = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(stale.status).toBe('stale')
    expect(stale.error).toBeUndefined()

    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws, kind: 'compose' }),
    })
    const refreshed = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(refreshed.status).toBe('ready')
    expect(refreshed.key).not.toBe(ready.key)
  }, 15_000)

  test('unavailable when no engine exists on this machine', async () => {
    const base = await boot({ availability: () => ({ libreOffice: false, word: false }), converter: async () => [] })
    await seedComposed()
    const status = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(status).toMatchObject({ available: false, status: 'unavailable', engine: null })
  })

  test('word engine is named when available (Windows preference, detected not executed)', async () => {
    const base = await boot(fakeConverterDeps({ availability: () => ({ libreOffice: true, word: true }) }))
    await seedComposed()
    const idle = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(idle.engine).toBe('word')
  })

  test('a failing converter surfaces an error status and the reason', async () => {
    const base = await boot(
      fakeConverterDeps({
        converter: async () => {
          throw new Error('Stale rendering tidak bisa dibuat.')
        },
      }),
    )
    await seedComposed()
    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws }),
    })
    const errored = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(errored.status).toBe('error')
    expect(errored.error).toContain('tidak bisa')
  })

  test('compose without written sections refuses the render honestly', async () => {
    const base = await boot(fakeConverterDeps())
    const document = await createActiveDocument(ws, 'compose', 'Belum ada isinya')
    document.sections = [{ id: 's1', title: 'Bab 1', thesisPoints: [], citations: [], status: 'staged', prose: '' }]
    await writeDocument(ws, document)
    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws }),
    })
    const errored = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(errored.status).toBe('error')
    expect(errored.error).toContain('belum ada bab tertulis')
  })

  test('the converter receives REAL exporter bytes; the preview records NO export', async () => {
    let seenBytes: Buffer | null = null
    const base = await boot(
      fakeConverterDeps({
        converter: async ({ docxPath, workDir }) => {
          seenBytes = readFileSync(docxPath)
          writeFileSync(join(workDir, 'page-1.png'), PNG_BYTES)
          return [join(workDir, 'page-1.png')]
        },
      }),
    )
    const seeded = await seedComposed()
    const before = (await readActiveDocument(ws))!
    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws }),
    })
    const ready = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(ready.status).toBe('ready')
    expect(seenBytes).not.toBeNull()
    expect(seenBytes!.subarray(0, 2).toString()).toBe('PK')
    // No user export was registered and no exports directory created.
    const after = (await readActiveDocument(ws))!
    expect(after.exports).toEqual(before.exports)
    expect(existsSync(join(ws, '.daedalus', 'documents', seeded.id, 'exports'))).toBe(false)
  })

  test('style kind: no result file -> honest error; with result -> ready', async () => {
    const base = await boot(fakeConverterDeps())
    const document = await createActiveDocument(ws, 'extract', 'Tata ulang uji')
    document.styleTarget = 'dokumen-asli.docx'
    document.styleOps = [{ id: 'op1', target: 'font', before: 'Calibri', after: 'Cambria', applied: true }]
    await writeDocument(ws, document)

    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws, kind: 'style' }),
    })
    const errored = await waitStatus(base, `root=${encodeURIComponent(ws)}&kind=style`)
    expect(errored.status).toBe('error')
    expect(errored.error).toContain('belum ada DOCX hasil tata ulang')

    // Terapkan's result file appears at the canonical path.
    const canonicalPath = join(ws, '.daedalus', 'documents', document.id, 'exports', 'dokumen-asli-tata-ulang.docx')
    expect(styleResultPath(ws, (await readActiveDocument(ws))!)).toBeNull()
    mkdirSync(dirname(canonicalPath), { recursive: true })
    writeFileSync(canonicalPath, Buffer.from('fake docx bytes'))
    expect(styleResultPath(ws, (await readActiveDocument(ws))!)).toBe(canonicalPath)

    await fetch(`${base}/dokumen/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: ws, kind: 'style' }),
    })
    const ready = await waitStatus(base, `root=${encodeURIComponent(ws)}&kind=style`)
    expect(ready.status).toBe('ready')
    expect(ready.kind).toBe('style')
    expect(ready.pages).toBe(2)

    // Compose state hashes a different family than the style state.
    const composeIdle = await waitStatus(base, `root=${encodeURIComponent(ws)}`)
    expect(composeIdle.key).toMatch(/^[a-f0-9]{64}$/)
    expect(composeIdle.key).not.toBe(ready.key)
  })

  test('the service composes DOCX bytes directly (default path, no exports directory)', async () => {
    const service = new DokumenPreviewService(fakeConverterDeps())
    await seedComposed()
    const document = (await readActiveDocument(ws))!
    const pageUrl = (key: string, page: number) => `/p/${key}/${page}`
    await service.render(ws, document, 'compose', pageUrl)
    let status = await service.status(ws, document, 'compose', pageUrl)
    for (let i = 0; i < 100 && status.status === 'rendering'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      status = await service.status(ws, document, 'compose', pageUrl)
    }
    expect(status.status).toBe('ready')
    const exportsDir = join(ws, '.daedalus', 'documents', document.id, 'exports')
    expect(existsSync(exportsDir)).toBe(false)
  })

  test('styleResultPath is null until the Terapkan result file exists, then resolves it', async () => {
    const document = await createActiveDocument(ws, 'extract', 'Tanpa target')
    expect(styleResultPath(ws, document)).toBeNull()
    document.styleTarget = 'somedoc.docx'
    expect(styleResultPath(ws, document)).toBeNull()
    const canonicalPath = join(ws, '.daedalus', 'documents', document.id, 'exports', 'somedoc-tata-ulang.docx')
    mkdirSync(dirname(canonicalPath), { recursive: true })
    writeFileSync(canonicalPath, Buffer.from('fake'))
    expect(styleResultPath(ws, document)).toBe(canonicalPath)
  })
})

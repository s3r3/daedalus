import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { EventBus, TaskStore, loadSettings } from '@daedalus/core'
import { createApp, createContext } from '../src/app.ts'
import {
  cacheFetchedPage,
  clearFetchedPageCacheForTest,
  clearResearchDocCacheForTest,
  defaultResearchHooks,
  detectResearchDocKind,
  expireStagedResearchPlanForTest,
  parseDdgHits,
  probeFrameable,
  storeResearchReport,
  type ResearchCoreHooks,
  type ResearchDocHooks,
  type ResearchPlan,
  type ResearchReport,
} from '../src/research.ts'

/**
 * Agentic Research at the HTTP surface:
 * POST /research/plan stages a plan (the single confirmation gate),
 * GET /research/plan/:planId reads it back,
 * POST /research/run executes it through the engine,
 * GET /research/report/:reportId reads a completed report, and
 * GET /research/progress/:planId streams live progress events.
 *
 * The core research modules are exercised through injected fakes
 * (AppContext.researchHooks) — routes run end to end over real HTTP
 * without touching the network.
 */

function stubPlan(): ResearchPlan {
  return {
    planId: 'p1',
    question: 'Apa itu Sinta?',
    language: 'id',
    subQuestions: [{ id: 'sq1', text: 'Apa itu Sinta Kemdikbud?' }],
    sourceStrategy: 'sumber resmi',
    budget: { maxQueries: 4, maxSources: 8 },
    createdAt: '2026-10-12T00:00:00.000Z',
  }
}

function stubReport(): ResearchReport {
  return {
    reportId: 'r1',
    question: 'Apa itu Sinta?',
    language: 'id',
    sections: [{ id: 'sec1', title: 'Gambaran', claimIds: ['c1'] }],
    claims: [{
      id: 'c1',
      text: 'Sinta memeringkat jurnal dari 1 sampai 6.',
      sourceIds: ['s1'],
      excerpts: ['Sinta memeringkat jurnal dari 1 sampai 6'],
      confidence: 'moderate',
      status: 'verified',
    }],
    sources: [{
      id: 's1',
      url: 'https://sinta.kemdikbud.go.id/tentang',
      title: 'Tentang Sinta',
      fetchedAt: '2026-10-12T00:00:00.000Z',
      credibility: { tier: 'web', verified: false },
    }],
    conflicts: [],
    limitations: ['Uji.'],
    summary: 'Sinta adalah indeks jurnal Indonesia.',
    bibliography: { apa: ['Sinta. (2026). Tentang Sinta. https://sinta.kemdikbud.go.id/tentang'], ieee: [] },
    budget: { queriesUsed: 1, sourcesFetched: 1 },
    verification: { claimsVerified: 1, claimsDropped: 0, gatePassed: true },
  }
}

function fakeHooks(overrides: Partial<ResearchCoreHooks> = {}): ResearchCoreHooks {
  return {
    planResearch: async ({ question }) => ({ ...stubPlan(), question }),
    createEngine: () => ({
      planResearch: async (question: string) => ({ ...stubPlan(), question }),
      runResearch: async () => ({ report: stubReport(), gate: { ok: true } }) as never,
    }),
    searchWeb: async () => [],
    fetchPage: async () => null,
    ...overrides,
  }
}

function verifyFailingHooks(): ResearchCoreHooks {
  const verifyError = Object.assign(new Error('verify gate menolak klaim'), {
    code: 'verify_failed',
    issues: [{ rule: 4, claimId: 'c1', message: 'token tanpa sitasi' }],
  })
  return fakeHooks({
    createEngine: () => ({
      planResearch: async (question: string) => ({ ...stubPlan(), question }),
      runResearch: async () => {
        throw verifyError
      },
    }),
  })
}

let server: ReturnType<typeof createApp> | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function listen(hooks: ResearchCoreHooks): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-research-srv-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-research-ws-'))
  const settings = loadSettings()
  const ctx = createContext({
    store: new TaskStore(join(tmp, 'state')),
    bus: new EventBus(),
    cwd: workspace,
    researchHooks: hooks,
    settings: {
      ...settings,
      llm: { ...settings.llm, baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model' },
    },
  })
  server = createApp(ctx)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
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

async function stagePlan(base: string, root: string): Promise<string> {
  const res = await req(base, 'POST', '/research/plan', { question: 'Apa itu Sinta?', root })
  expect(res.status).toBe(200)
  return res.body.planId as string
}

describe('POST /research/plan', () => {
  test('stages a plan and returns planId + plan', async () => {
    const { base, root } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/research/plan', { question: 'Apa itu Sinta?', root })
    expect(res.status).toBe(200)
    expect(typeof res.body.planId).toBe('string')
    expect((res.body.plan as Record<string, unknown>).question).toBe('Apa itu Sinta?')
  })

  test('rejects a missing question', async () => {
    const { base, root } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/research/plan', { root })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('question_required')
  })
})

describe('GET /research/plan/:planId', () => {
  test('returns the staged plan for review', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const res = await req(base, 'GET', `/research/plan/${planId}`)
    expect(res.status).toBe(200)
    expect(res.body.planId).toBe(planId)
  })

  test('410 on the run gate when the plan expired', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    expect(expireStagedResearchPlanForTest(planId)).toBe(true)
    const res = await req(base, 'POST', '/research/run', { planId })
    expect(res.status).toBe(410)
    expect(res.body.error).toBe('plan_expired')
  })

  test('404 when the plan is unknown', async () => {
    const { base } = await listen(fakeHooks())
    const res = await req(base, 'GET', '/research/plan/does-not-exist')
    expect(res.status).toBe(404)
  })
})

describe('POST /research/run', () => {
  test('runs the staged plan and returns the verified report', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const res = await req(base, 'POST', '/research/run', { planId })
    expect(res.status).toBe(200)
    const report = res.body.report as Record<string, unknown>
    expect(report.reportId).toBe('r1')
    expect((report.verification as Record<string, unknown>).gatePassed).toBe(true)
  })

  test('verify failure surfaces as 422 with issues, no report', async () => {
    const { base, root } = await listen(verifyFailingHooks())
    const planId = await stagePlan(base, root)
    const res = await req(base, 'POST', '/research/run', { planId })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('verify_failed')
    expect(Array.isArray(res.body.issues)).toBe(true)
    expect(res.body.report).toBeUndefined()
  })

  test('the staged plan is single-use', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const first = await req(base, 'POST', '/research/run', { planId })
    expect(first.status).toBe(200)
    const second = await req(base, 'POST', '/research/run', { planId })
    expect(second.status).toBe(410)
  })

  test('double-submit while running -> 409 already_running (not 410)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slowHooks = fakeHooks({
      createEngine: () => ({
        planResearch: async (question: string) => ({ ...stubPlan(), question }),
        runResearch: async () => { await gate; return { report: stubReport(), gate: { ok: true } } as never },
      }),
    })
    const { base, root } = await listen(slowHooks)
    const planId = await stagePlan(base, root)
    const first = req(base, 'POST', '/research/run', { planId })
    // beri waktu agar run pertama masuk in-progress
    await new Promise((r) => setTimeout(r, 150))
    const statusRunning = await req(base, 'GET', `/research/run-status/${planId}`)
    expect(statusRunning.status).toBe(200)
    expect(statusRunning.body.status).toBe('running')
    const second = await req(base, 'POST', '/research/run', { planId })
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('already_running')
    release()
    const firstRes = await first
    expect(firstRes.status).toBe(200)
    // setelah selesai: plan dikonsumsi, run-status -> done + reportId
    const statusDone = await req(base, 'GET', `/research/run-status/${planId}`)
    expect(statusDone.body.status).toBe('done')
    expect(statusDone.body.reportId).toBe('r1')
    const third = await req(base, 'POST', '/research/run', { planId })
    expect(third.status).toBe(410)
  })

  test('run-status unknown plan -> idle', async () => {
    const { base } = await listen(fakeHooks())
    const res = await req(base, 'GET', '/research/run-status/tidak-ada')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('idle')
  })
})

describe('GET /research/report/:reportId/source/:sourceId/document', () => {
  const fakePdf = Buffer.from('%PDF-1.4 fake')

  function fakeDocHooks(overrides: Partial<ResearchDocHooks> = {}) {
    return {
      fetchBytes: async (url: string) => ({
        bytes: Buffer.from(`bytes:${url}`),
        contentType: url.endsWith('.pdf') ? 'application/pdf' : 'text/html',
      }),
      officeToPdf: async () => fakePdf,
      htmlToPdf: async () => fakePdf,
      ...overrides,
    }
  }

  async function listenWithDocHooks(docHooks: ResearchDocHooks) {
    tmp = mkdtempSync(join(tmpdir(), 'daedalus-research-doc-'))
    workspace = mkdtempSync(join(tmpdir(), 'daedalus-research-docws-'))
    const settings = loadSettings()
    const ctx = createContext({
      store: new TaskStore(join(tmp, 'state')),
      bus: new EventBus(),
      cwd: workspace,
      researchHooks: fakeHooks(),
      researchDocHooks: docHooks,
      settings: {
        ...settings,
        llm: { ...settings.llm, baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model' },
      },
    })
    server = createApp(ctx)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  test('serves a PDF source as application/pdf', async () => {
    clearResearchDocCacheForTest()
    const base = await listenWithDocHooks(fakeDocHooks())
    const pdfReport: ResearchReport = {
      ...stubReport(),
      reportId: 'rdoc',
      sources: [{ ...stubReport().sources[0]!, id: 'spdf', url: 'https://contoh.id/paper.pdf' }],
    }
    storeResearchReport(pdfReport)
    const res = await fetch(`${base}/research/report/rdoc/source/spdf/document`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/pdf')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.toString()).toContain('bytes:https://contoh.id/paper.pdf')
  })

  test('converts an office source via the doc hooks', async () => {
    clearResearchDocCacheForTest()
    const converted = Buffer.from('%PDF-1.4 converted')
    const base = await listenWithDocHooks(fakeDocHooks({
      fetchBytes: async () => ({ bytes: Buffer.from('docx-bytes'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      officeToPdf: async () => converted,
    }))
    const docReport: ResearchReport = {
      ...stubReport(),
      reportId: 'rdoc2',
      sources: [{ ...stubReport().sources[0]!, id: 'sdoc', url: 'https://contoh.id/paper.docx' }],
    }
    storeResearchReport(docReport)
    const res = await fetch(`${base}/research/report/rdoc2/source/sdoc/document`)
    expect(res.status).toBe(200)
    const buf = Buffer.from(await res.arrayBuffer())
    expect(buf.equals(converted)).toBe(true)
  })

  test('404/415/502 are honest', async () => {
    clearResearchDocCacheForTest()
    const base = await listenWithDocHooks(fakeDocHooks())
    expect((await fetch(`${base}/research/report/nope/source/s1/document`)).status).toBe(404)
    storeResearchReport(stubReport())
    expect((await fetch(`${base}/research/report/r1/source/nope/document`)).status).toBe(404)
    // unknown type
    const weirdHooks = fakeDocHooks({
      fetchBytes: async () => ({ bytes: Buffer.from('weird'), contentType: 'application/x-unknown' }),
    })
    const weirdBase = await listenWithDocHooks(weirdHooks)
    const weird: ResearchReport = {
      ...stubReport(),
      reportId: 'rweird',
      sources: [{ ...stubReport().sources[0]!, id: 'sw', url: 'https://contoh.id/file.xyz' }],
    }
    storeResearchReport(weird)
    const unsup = await fetch(`${weirdBase}/research/report/rweird/source/sw/document`)
    expect(unsup.status).toBe(415)
    // fetch failure
    const failBase = await listenWithDocHooks(fakeDocHooks({ fetchBytes: async () => null }))
    storeResearchReport(stubReport())
    const fail = await fetch(`${failBase}/research/report/r1/source/s1/document`)
    expect(fail.status).toBe(502)
  })

  test('detectResearchDocKind classifies by content-type and extension', async () => {
    expect(detectResearchDocKind('https://a.id/x.pdf')).toBe('pdf')
    expect(detectResearchDocKind('https://a.id/x', 'application/pdf')).toBe('pdf')
    expect(detectResearchDocKind('https://a.id/x.docx')).toBe('office')
    expect(detectResearchDocKind('https://a.id/x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('office')
    expect(detectResearchDocKind('https://a.id/artikel')).toBe('html')
    expect(detectResearchDocKind('https://a.id/x', 'text/html')).toBe('html')
    expect(detectResearchDocKind('https://a.id/file.xyz')).toBe('unknown')
  })
})

describe('defaultSearchWeb (DuckDuckGo)', () => {
  test('parseDdgHits mengekstrak url dari pola uddg', () => {
    const html = `<html><body>
      <a href="/l/?uddg=https%3A%2F%2Fcontoh.id%2Fartikel&rut=abc">Judul Artikel</a>
      <a href="https://langsung.id/x">Langsung</a>
      <a href="/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy">skip ddg</a>
    </body></html>`
    const hits = parseDdgHits(html)
    expect(hits.map((h) => h.url)).toEqual(['https://contoh.id/artikel', 'https://langsung.id/x'])
    expect(hits[0]!.title).toBe('Judul Artikel')
  })

  test('parseDdgHits: HTML challenge/kosong -> []', () => {
    expect(parseDdgHits('<html><title>Just a moment...</title></html>')).toEqual([])
    expect(parseDdgHits('')).toEqual([])
  })

  test('retry + fallback: lite gagal -> coba html endpoint', async () => {
    const goodHtml = '<html><body>' + 'x'.repeat(1200) +
      '<a href="/l/?uddg=https%3A%2F%2Fcontoh.id%2Fok">OK</a></body></html>'
    const calls: string[] = []
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url))
      if (String(url).includes('lite.duckduckgo.com')) throw new Error('timeout')
      return new Response(goodHtml, { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof fetch
    try {
      const hooks = defaultResearchHooks()
      const hits = await hooks.searchWeb('uji coba')
      expect(hits.length).toBe(1)
      expect(hits[0]!.url).toBe('https://contoh.id/ok')
      expect(calls.some((u) => u.includes('lite.duckduckgo.com'))).toBe(true)
      expect(calls.some((u) => u.includes('html.duckduckgo.com'))).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('semua endpoint gagal -> [] (tidak throw)', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('down'); }) as typeof fetch
    try {
      const hits = await defaultResearchHooks().searchWeb('uji coba')
      expect(hits).toEqual([])
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('probeFrameable', () => {
  test('DENY / SAMEORIGIN / frame-ancestors block embedding; open pages allow it', async () => {
    const { createServer } = await import('node:http')
    const srv = createServer((req, res) => {
      if (req.url === '/deny') res.setHeader('X-Frame-Options', 'DENY')
      if (req.url === '/same') res.setHeader('X-Frame-Options', 'SAMEORIGIN')
      if (req.url === '/csp') res.setHeader('Content-Security-Policy', "frame-ancestors 'self'")
      res.end('ok')
    })
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
    const port = (srv.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    try {
      expect(await probeFrameable(`${base}/deny`)).toBe(false)
      expect(await probeFrameable(`${base}/same`)).toBe(false)
      expect(await probeFrameable(`${base}/csp`)).toBe(false)
      expect(await probeFrameable(`${base}/open`)).toBe(true)
      expect(await probeFrameable('bukan-url')).toBe(false)
    } finally {
      srv.close()
    }
  })
})

describe('GET /research/report/:reportId/source/:sourceId/content', () => {
  beforeEach(() => {
    clearFetchedPageCacheForTest()
  })

  test('returns cached page content for a known source', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const run = await req(base, 'POST', '/research/run', { planId })
    expect(run.status).toBe(200)
    const reportId = (run.body.report as Record<string, unknown>).reportId as string
    cacheFetchedPage('https://sinta.kemdikbud.go.id/tentang', 'Tentang Sinta', 'Sinta memeringkat jurnal.')
    const got = await req(base, 'GET', `/research/report/${reportId}/source/s1/content`)
    expect(got.status).toBe(200)
    const content = got.body.content as Record<string, unknown>
    expect(content.cached).toBe(true)
    expect(content.isPdf).toBe(false)
    expect(content.text).toContain('Sinta memeringkat jurnal')
  })

  test('live-fetches and caches when the cache misses', async () => {
    const hooks = fakeHooks({
      fetchPage: async (url: string) => ({ url, status: 200, title: 'Live', text: 'teks live halaman' }),
    })
    const { base, root } = await listen(hooks)
    const planId = await stagePlan(base, root)
    const run = await req(base, 'POST', '/research/run', { planId })
    const reportId = (run.body.report as Record<string, unknown>).reportId as string
    const got = await req(base, 'GET', `/research/report/${reportId}/source/s1/content`)
    expect(got.status).toBe(200)
    expect((got.body.content as Record<string, unknown>).cached).toBe(false)
    expect((got.body.content as Record<string, unknown>).text).toContain('teks live halaman')
    // second read now hits the cache
    const again = await req(base, 'GET', `/research/report/${reportId}/source/s1/content`)
    expect((again.body.content as Record<string, unknown>).cached).toBe(true)
  })

  test('502 when the page cannot be fetched', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const run = await req(base, 'POST', '/research/run', { planId })
    const reportId = (run.body.report as Record<string, unknown>).reportId as string
    const got = await req(base, 'GET', `/research/report/${reportId}/source/s1/content`)
    expect(got.status).toBe(502)
    expect(got.body.error).toBe('source_unavailable')
  })

  test('404 for unknown report and unknown source', async () => {
    const { base } = await listen(fakeHooks())
    const missingReport = await req(base, 'GET', '/research/report/nope/source/s1/content')
    expect(missingReport.status).toBe(404)
    storeResearchReport(stubReport())
    const missingSource = await req(base, 'GET', '/research/report/r1/source/nope/content')
    expect(missingSource.status).toBe(404)
  })

  test('PDF source is flagged isPdf without fetching', async () => {
    const { base } = await listen(fakeHooks())
    const pdfReport: ResearchReport = {
      ...stubReport(),
      reportId: 'rpdf',
      sources: [{ ...stubReport().sources[0]!, id: 'spdf', url: 'https://contoh.id/paper.pdf', title: 'Paper PDF' }],
    }
    storeResearchReport(pdfReport)
    const got = await req(base, 'GET', '/research/report/rpdf/source/spdf/content')
    expect(got.status).toBe(200)
    const content = got.body.content as Record<string, unknown>
    expect(content.isPdf).toBe(true)
    expect(content.url).toBe('https://contoh.id/paper.pdf')
  })
})

describe('GET /research/report/:reportId + /research/progress/:planId', () => {
  test('completed report is retrievable; progress endpoint answers', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const run = await req(base, 'POST', '/research/run', { planId })
    expect(run.status).toBe(200)
    const reportId = (run.body.report as Record<string, unknown>).reportId as string
    const got = await req(base, 'GET', `/research/report/${reportId}`)
    expect(got.status).toBe(200)
    expect((got.body.report as Record<string, unknown>).reportId).toBe(reportId)
    const missing = await req(base, 'GET', '/research/report/nope')
    expect(missing.status).toBe(404)
    const progress = await req(base, 'GET', `/research/progress/${planId}`)
    expect(progress.status).toBe(200)
    expect(Array.isArray(progress.body.events)).toBe(true)
  })
})

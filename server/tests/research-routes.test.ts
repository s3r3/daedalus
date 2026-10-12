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
  expireStagedResearchPlanForTest,
  storeResearchReport,
  type ResearchCoreHooks,
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

import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { EventBus, TaskStore, loadSettings, writeWorkbook, newWorkbook, type WorkbookSpec } from '@daedalus/core'
import { createApp, createContext } from '../src/app.ts'
import { expireStagedAnalysisPlanForTest, type AnalysisCoreHooks } from '../src/sheets-analyze.ts'

/**
 * Mode Analis (Agentic Spreadsheet) at the HTTP surface:
 * POST /sheets/analyze/plan stages a plan (the single confirmation gate),
 * GET /sheets/analyze/plan/:planId reads it back, and
 * POST /sheets/analyze/run executes it through the engine.
 *
 * The parallel core worker's modules (analysis-profile/plan, runAnalysis)
 * do not exist yet, so the core seam is injected as fakes through
 * AppContext.analysisHooks — the routes are exercised end to end over
 * real HTTP without touching the network.
 */

const CSV = `region,produk,pendapatan
jakarta,kopi,1200000
bandung,teh,800000
jakarta,teh,450000`

function stubWorkbook(title: string): WorkbookSpec {
  const wb = newWorkbook(title, { createdBy: 'test' })
  return wb
}

function fakeHooks(overrides: Partial<AnalysisCoreHooks> = {}): AnalysisCoreHooks {
  return {
    importCsv: (title) => stubWorkbook(title),
    importXlsx: (title) => stubWorkbook(title),
    profileWorkbook: () => [{ rowCount: 3, columns: ['region', 'produk', 'pendapatan'] }] as never,
    classifyIntent: ({ question }) => ({ kind: 'sales-summary', complexity: 'simple', question }),
    generatePlan: ({ question, intent }) => ({
      question,
      metrics: ['total_pendapatan'],
      groupBys: ['region'],
      comparisons: [],
      charts: [{ type: 'bar', metric: 'total_pendapatan', groupBy: 'region' }],
      assumptions: [],
      steps: ['aggregate'],
      complexity: intent.complexity,
    }) as never,
    createEngine: () => ({
      runAnalysis: async ({ question, plan }) => ({
        workbook: stubWorkbook('hasil-analisis'),
        verify: { ok: true, summary: 'LULUS', errors: [], warnings: [] },
        report: { question, plan, insights: [{ text: 'Jakarta memimpin.', cells: ['B2'] }] } as never,
        exported: { path: 'workbook/analisis.xlsx', downloadUrl: '/sheets/workbook/download?path=workbook/analisis.xlsx' },
      }),
    }),
    ...overrides,
  }
}

function verifyFailingHooks(): AnalysisCoreHooks {
  const verifyError = Object.assign(new Error('verify gate menolak hasil'), {
    code: 'verify_failed',
    issues: [{ cell: 'B2', message: 'formula tidak konsisten' }],
  })
  return fakeHooks({
    createEngine: () => ({
      runAnalysis: async () => {
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

// S6: daemon token for mutation routes, set by listen() (GET/OPTIONS ignore it).
let daemonToken = ''

async function listen(hooks: AnalysisCoreHooks): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-analis-srv-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-analis-ws-'))
  const settings = loadSettings()
  const ctx = createContext({
    store: new TaskStore(join(tmp, 'state')),
    bus: new EventBus(),
    cwd: workspace,
    analysisHooks: hooks,
    settings: {
      ...settings,
      llm: { ...settings.llm, baseUrl: 'http://127.0.0.1:1', apiKey: 'test-key', model: 'test-model' },
    },
  })
  server = createApp(ctx)
  daemonToken = ctx.daemonToken ?? ''
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
    headers: { 'content-type': 'application/json', ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { status: res.status, body: { raw: text } }
  }
}

async function stagePlan(base: string, root: string, question = 'berapa total pendapatan per region?'): Promise<string> {
  const res = await req(base, 'POST', '/sheets/analyze/plan', {
    question,
    root,
    dataset: { kind: 'csv', text: CSV, name: 'penjualan' },
  })
  expect(res.status).toBe(200)
  const planId = res.body.planId as string
  expect(typeof planId).toBe('string')
  return planId
}

describe('POST /sheets/analyze/plan', () => {
  test('stages a plan for a csv dataset and returns planId + plan + profiles', async () => {
    const { base, root } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/sheets/analyze/plan', {
      question: 'berapa total pendapatan per region?',
      root,
      dataset: { kind: 'csv', text: CSV, name: 'penjualan' },
    })
    expect(res.status).toBe(200)
    expect(typeof res.body.planId).toBe('string')
    expect((res.body.plan as Record<string, unknown>).question).toBe('berapa total pendapatan per region?')
    expect((res.body.plan as Record<string, unknown>).metrics).toEqual(['total_pendapatan'])
    expect(res.body.profiles[0]).toMatchObject({ rowCount: 3 })
    expect(res.body.complexity).toBe('simple')
  })

  test('rejects a missing question', async () => {
    const { base, root } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/sheets/analyze/plan', {
      root,
      dataset: { kind: 'csv', text: CSV },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('question_required')
  })

  test('rejects an unknown dataset kind', async () => {
    const { base, root } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/sheets/analyze/plan', {
      question: 'q?',
      root,
      dataset: { kind: 'parquet' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_dataset')
  })

  test('loads an existing workbook by key', async () => {
    const { base, root } = await listen(fakeHooks())
    await writeWorkbook(root, stubWorkbook('arsip'))
    const res = await req(base, 'POST', '/sheets/analyze/plan', {
      question: 'ringkas data arsip',
      dataset: { kind: 'workbook', key: root },
    })
    expect(res.status).toBe(200)
    expect(typeof res.body.planId).toBe('string')
  })

  test('404 when the workbook key has no workbook', async () => {
    const { base, root } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/sheets/analyze/plan', {
      question: 'ringkas data',
      dataset: { kind: 'workbook', key: root },
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('workbook_not_found')
  })
})

describe('GET /sheets/analyze/plan/:planId', () => {
  test('returns the staged plan for review', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const res = await req(base, 'GET', `/sheets/analyze/plan/${planId}`)
    expect(res.status).toBe(200)
    expect(res.body.planId).toBe(planId)
    expect(res.body.question).toBe('berapa total pendapatan per region?')
    expect(res.body.profiles[0]).toMatchObject({ rowCount: 3 })
    expect((res.body.plan as Record<string, unknown>).groupBys).toEqual(['region'])
  })

  test('404 for an unknown planId', async () => {
    const { base } = await listen(fakeHooks())
    const res = await req(base, 'GET', '/sheets/analyze/plan/00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('plan_not_found')
  })
})

describe('POST /sheets/analyze/run', () => {
  test('runs the staged plan and returns verify + report + exported', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const res = await req(base, 'POST', '/sheets/analyze/run', { planId, root })
    expect(res.status).toBe(200)
    expect(res.body.verify).toMatchObject({ ok: true, summary: 'LULUS' })
    expect((res.body.report as Record<string, unknown>).question).toBe('berapa total pendapatan per region?')
    expect(res.body.exported).toMatchObject({ path: 'workbook/analisis.xlsx' })
  })

  test('the staged plan is single-use: a second run answers 410', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    const first = await req(base, 'POST', '/sheets/analyze/run', { planId, root })
    expect(first.status).toBe(200)
    const second = await req(base, 'POST', '/sheets/analyze/run', { planId, root })
    expect(second.status).toBe(410)
    expect(second.body.error).toBe('plan_expired')
  })

  test('unknown planId answers 410 plan_expired', async () => {
    const { base } = await listen(fakeHooks())
    const res = await req(base, 'POST', '/sheets/analyze/run', { planId: 'tidak-ada' })
    expect(res.status).toBe(410)
    expect(res.body.error).toBe('plan_expired')
    expect(res.body.message).toBe('rencana kedaluwarsa, buat ulang')
  })

  test('an expired staged plan answers 410', async () => {
    const { base, root } = await listen(fakeHooks())
    const planId = await stagePlan(base, root)
    expect(expireStagedAnalysisPlanForTest(planId)).toBe(true)
    const res = await req(base, 'POST', '/sheets/analyze/run', { planId, root })
    expect(res.status).toBe(410)
    expect(res.body.error).toBe('plan_expired')
    const get = await req(base, 'GET', `/sheets/analyze/plan/${planId}`)
    expect(get.status).toBe(404)
  })

  test('a verify failure inside the engine answers 422 with issues and no report', async () => {
    const { base, root } = await listen(verifyFailingHooks())
    const planId = await stagePlan(base, root)
    const res = await req(base, 'POST', '/sheets/analyze/run', { planId, root })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('verify_failed')
    expect(res.body.issues).toEqual([{ cell: 'B2', message: 'formula tidak konsisten' }])
    expect(res.body.report).toBeUndefined()
  })
})

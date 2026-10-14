import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EventBus,
  ProviderRegistryStore,
  TaskStore,
  WorkflowRunStore,
  appendTurn,
  createWorkflowRun,
  loadSettings,
} from '@daedalus/core'
import { createContext, createApp } from '../src/app.ts'

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

async function listen(): Promise<{ base: string; home: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-workflow-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-workflow-ws-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  // Relative daedalusHome resolves under the workspace root, so the
  // WorkflowRunStore lives inside the tmp workspace — never the real home.
  const baseSettings = loadSettings()
  const settings = {
    ...baseSettings,
    daedalusHome: '.daedalus-test-home',
    // Scrub the LLM endpoint too: researchProviderFromRequest falls back to
    // settings.llm.baseUrl when the registry is empty.
    llm: { ...baseSettings.llm, baseUrl: '', apiKey: '' },
  }
  const ctx = createContext({
    store: new TaskStore(join(tmp, 'state')),
    bus: new EventBus(),
    cwd: workspace,
    settings,
    // Empty provider registry: layer-B is skipped (→ chat-first fallback) and
    // research staging fails as no_provider_configured — deterministic on
    // any machine, with or without a real ~/.daedalus.
    providerStore: new ProviderRegistryStore(join(tmp, 'providers-home')),
  })
  // Skip the settings-seeded provider: ensureProvidersLoaded would
  // otherwise always inject one from settings.llm (even with an empty
  // baseUrl). createContext does not copy providersReady from overrides,
  // so it is set directly — the registry stays empty for these tests.
  ctx.providersReady = Promise.resolve()
  server = createApp(ctx)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, home: join(workspace!, '.daedalus-test-home') }
}

async function postChat(base: string, body: Record<string, unknown>) {
  const res = await fetch(new URL('/workflow/chat', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('POST /workflow/chat', () => {
  test('clear coding message routes and dispatches a task', async () => {
    const { base } = await listen()
    const { status, body } = await postChat(base, { message: 'buatkan landing page pakai vue' })
    expect(status).toBe(201)
    expect(body.engine).toBe('coding')
    expect(typeof body.task_id).toBe('string')
    expect(typeof body.run_id).toBe('string')
    expect(body.router).toMatchObject({ layer: 'rules' })
  })

  test('continuation resolves the previous artifact ("tadi")', async () => {
    const { base } = await listen()
    const first = await postChat(base, { message: 'buatkan landing page pakai vue' })
    expect(first.status).toBe(201)

    const second = await postChat(base, {
      message: 'dari landing page tadi buatkan slide presentasi',
      run_id: first.body.run_id,
    })
    expect(second.status).toBe(201)
    expect(second.body.engine).toBe('slide')
    expect(second.body.run_id).toBe(first.body.run_id)
    const resolved = second.body.resolved_artifacts as Array<{ label: string }>
    expect(resolved.length).toBeGreaterThan(0)
    expect(resolved[0]!.label).toContain('landing page')
  })

  test('explicit engine override wins over the rules', async () => {
    const { base } = await listen()
    const { status, body } = await postChat(base, {
      message: 'buatkan laporan keuangan',
      engine_override: 'spreadsheet',
    })
    expect(status).toBe(201)
    expect(body.engine).toBe('spreadsheet')
    expect(body.router).toMatchObject({ rule: 'engine_override' })
  })

  test('ambiguous message → chat reply (chat-first, no layer-B without a provider)', async () => {
    const { base } = await listen()
    const { status, body } = await postChat(base, { message: 'tolong bereskan ini' })
    expect(status).toBe(200)
    expect(body.kind).toBe('chat')
    expect(typeof body.text).toBe('string')
    expect(body.needs_clarify).toBeUndefined()
    expect(typeof body.run_id).toBe('string')
  })

  test('research dispatch goes through plan staging (400 without a provider)', async () => {
    const { base } = await listen()
    const { status, body } = await postChat(base, {
      message: 'riset apakah landing page saya sudah benar',
      engine_override: 'research',
    })
    // Routed to research; staging fails honestly without a provider.
    expect(status).toBe(400)
    expect(body.error).toBe('no_provider_configured')
  })

  test('rejects missing message, invalid engine, unknown run', async () => {
    const { base } = await listen()
    const missing = await postChat(base, {})
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('message_required')

    const badEngine = await postChat(base, { message: 'x', engine_override: 'photoshop' })
    expect(badEngine.status).toBe(400)
    expect(badEngine.body.error).toBe('invalid_engine')

    const badRun = await postChat(base, { message: 'buatkan slide', run_id: 'tidak-ada' })
    expect(badRun.status).toBe(404)
    expect(badRun.body.error).toBe('run_not_found')
  })
})

describe('GET /workflow/runs', () => {
  test('lists runs and shows turns', async () => {
    const { base } = await listen()
    const chat = await postChat(base, { message: 'buatkan landing page pakai vue' })
    expect(chat.status).toBe(201)

    const res = await fetch(new URL('/workflow/runs', base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: Array<{ run_id: string; turns: unknown[] }> }
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]!.run_id).toBe(chat.body.run_id)
    expect(body.runs[0]!.turns).toHaveLength(1)
  })

  test('reconciles vanished tasks as failed instead of spinning', async () => {
    const { base, home } = await listen()
    const runs = new WorkflowRunStore(home)
    const run = createWorkflowRun(workspace!)
    appendTurn(run, {
      engine: 'coding',
      task_id: 'task-tidak-ada',
      goal: 'tugas hantu',
      status: 'running',
    })
    appendTurn(run, {
      engine: 'research',
      task_id: 'plan-tidak-ada',
      goal: 'riset hantu',
      status: 'running',
    })
    runs.saveRun(run)

    const res = await fetch(new URL(`/workflow/runs/${run.run_id}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      run: { turns: Array<{ status: string; note?: string }> }
    }
    expect(body.run.turns).toHaveLength(2)
    for (const turn of body.run.turns) {
      expect(turn.status).toBe('failed')
      expect(typeof turn.note).toBe('string')
    }
  })

  test('unknown run id → 404', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/workflow/runs/tidak-ada', base))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('run_not_found')
  })
})

describe('GET /workflow/runs/:id failed-turn note', () => {
  test('failed task error surfaces on the turn note', async () => {
    const { base, home } = await listen()
    const runs = new WorkflowRunStore(home)
    const run = createWorkflowRun(workspace!)
    appendTurn(run, {
      engine: 'coding',
      task_id: 'task-gagal',
      goal: 'tugas gagal',
      status: 'running',
    })
    runs.saveRun(run)
    // Seed a failed task state with the runner's error.
    const store = new TaskStore(home)
    store.saveState('task-gagal', {
      status: 'failed',
      last_error: 'provider_timeout: model did not respond',
    })

    const res = await fetch(new URL(`/workflow/runs/${run.run_id}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      run: { turns: Array<{ status: string; note?: string }> }
    }
    expect(body.run.turns).toHaveLength(1)
    expect(body.run.turns[0]!.status).toBe('failed')
    expect(body.run.turns[0]!.note).toContain('provider_timeout')
  })
})

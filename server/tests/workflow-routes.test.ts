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

// S6: daemon token for mutation routes, set by listen() (GET/OPTIONS ignore it).
let daemonToken = ''

async function listen(): Promise<{ base: string; home: string; ctx: ReturnType<typeof createContext> }> {
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
  daemonToken = ctx.daemonToken ?? ''
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, home: join(workspace!, '.daedalus-test-home'), ctx }
}

async function postChat(base: string, body: Record<string, unknown>) {
  const res = await fetch(new URL('/workflow/chat', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(daemonToken ? { authorization: `Bearer ${daemonToken}` } : {}) },
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

  test('explanatory questions stay conversational (no agentic dispatch)', async () => {
    const { base } = await listen()
    for (const message of [
      'Bagaimana cara membuat landing page?',
      'Apa perbedaan React dan Vue?',
      'Jelaskan kode ini tanpa mengubahnya.',
    ]) {
      const { status, body } = await postChat(base, { message })
      expect(status).toBe(200)
      expect(body.kind).toBe('chat')
      expect(typeof body.text).toBe('string')
    }
  })

  test('messages without run_id start isolated runs (/clear session boundary)', async () => {
    const { base } = await listen()
    const first = await postChat(base, { message: 'halo' })
    const second = await postChat(base, { message: 'halo lagi' })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    // Distinct server runs: the second message carries no turns from the first.
    expect(first.body.run_id).not.toBe(second.body.run_id)

    const res = await fetch(new URL('/workflow/runs', base))
    const body = (await res.json()) as { runs: Array<{ run_id: string; turns: unknown[] }> }
    expect(body.runs).toHaveLength(2)
  })

  test('explicit execution requests still dispatch', async () => {
    const { base } = await listen()
    const { status, body } = await postChat(base, {
      message: 'Buatkan landing page HTML tentang AI di folder huhu.',
    })
    expect(status).toBe(201)
    expect(body.engine).toBe('coding')
    expect(typeof body.task_id).toBe('string')
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

  test('pending questions carry text + options for the companion card', async () => {
    const { base, home, ctx } = await listen()
    const { TaskRunner } = await import('@daedalus/core')
    const runs = new WorkflowRunStore(home)
    const run = createWorkflowRun(workspace!)
    appendTurn(run, { engine: 'coding', task_id: 'tq-card', goal: 'buat web', status: 'running' })
    runs.saveRun(run)
    const runner = new TaskRunner({ workspaceRoot: workspace!, bus: ctx.bus, store: ctx.store })
    ctx.activeRunners.set('tq-card', runner)
    // Leave pending (do not await): the card must show while the agent waits.
    void runner.questions.ask({
      id: 'q-card-1',
      taskId: 'tq-card',
      question: 'Pakai stack apa?',
      options: [{ label: 'Vue' }, { label: 'React', description: 'ekosistem besar' }],
      allowFreeText: true,
      createdAt: new Date().toISOString(),
    })

    const res = await fetch(new URL(`/workflow/runs/${run.run_id}?workspace_root=${encodeURIComponent(workspace!)}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      run: { turns: Array<{ pending_questions?: Array<{ id: string; question: string; options: Array<{ label: string }>; allow_free_text: boolean }> }> }
    }
    const pending = body.run.turns[0]!.pending_questions ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      id: 'q-card-1',
      question: 'Pakai stack apa?',
      allow_free_text: true,
    })
    expect(pending[0]!.options.map((o) => o.label)).toEqual(['Vue', 'React'])
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

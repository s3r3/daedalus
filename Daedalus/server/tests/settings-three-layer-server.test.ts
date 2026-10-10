import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * SERVER layer of the 3-layer settings restructure:
 * - PATCH /settings accepts the new layer-1 keys (llm.temperature,
 *   llm.promptCaching, llm.models, llm.modelStrategy, domains,
 *   session.thinkingLevel) in camelCase and snake_case, with named 400s;
 *   round-robin coerces to failover (migration, no error).
 * - thinkingLevel is accepted/exposed on the session (GET+POST /session,
 *   POST /settings); the deprecated `thinking` boolean still works and
 *   maps false → 'off' only when no level was given.
 * - POST /tasks accepts token_budget/tokenBudget and
 *   tool_rules/toolRules (named 400s) and echoes them on the task record.
 * - POST/PUT /providers validate contextWindows/context_windows
 *   (named 400 invalid_context_windows).
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
  fake = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    )
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(withFakeProvider = false): Promise<{ base: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-settings3-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-settings3-ws-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  if (withFakeProvider) {
    const baseUrl = await startFakeProvider()
    ctx.providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'fake-key', models: ['fake-model'], defaultModel: 'fake-model', enabled: true })
  }
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}` }
}

async function patchSettings(base: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL('/settings', base), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function getSettings(base: string): Promise<Record<string, unknown>> {
  const res = await fetch(new URL('/settings', base))
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

function llmOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body.settings as Record<string, unknown>).llm as Record<string, unknown>
}

function sessionOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.session as Record<string, unknown>
}

describe('PATCH /settings — llm layer-1 keys', () => {
  test('llm.temperature and llm_temperature update the global temperature', async () => {
    const { base } = await listen()
    let res = await patchSettings(base, { llm: { temperature: 0.3 } })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).temperature).toBe(0.3)

    res = await patchSettings(base, { llm_temperature: 1.5 })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).temperature).toBe(1.5)

    const after = await getSettings(base)
    expect(llmOf(after).temperature).toBe(1.5)
  })

  test('out-of-range or non-numeric temperature is a named 400', async () => {
    const { base } = await listen()
    for (const body of [{ llm: { temperature: 2.5 } }, { llm: { temperature: -0.1 } }, { llm_temperature: 'hot' }, { llm: { temperature: Number.NaN } }]) {
      const res = await patchSettings(base, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_temperature')
    }
  })

  test('llm.promptCaching and llm_prompt_caching toggle prompt caching', async () => {
    const { base } = await listen()
    let res = await patchSettings(base, { llm: { promptCaching: true } })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).promptCaching).toBe(true)

    res = await patchSettings(base, { llm_prompt_caching: false })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).promptCaching).toBe(false)
  })

  test('llm.models accepts a comma-separated string or an array', async () => {
    const { base } = await listen()
    let res = await patchSettings(base, { llm: { models: 'a, b, a ,,c' } })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).models).toEqual(['a', 'b', 'c'])

    res = await patchSettings(base, { llm_models: ['x', 'y'] })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).models).toEqual(['x', 'y'])
  })

  test('empty model list is a named 400', async () => {
    const { base } = await listen()
    for (const body of [{ llm: { models: '' } }, { llm_models: [] }, { llm: { models: ' , ,' } }, { llm_models: [42] }]) {
      const res = await patchSettings(base, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_llm_models')
    }
  })

  test('llm.modelStrategy accepts failover and coerces round-robin (migration)', async () => {
    const { base } = await listen()
    let res = await patchSettings(base, { llm: { modelStrategy: 'failover' } })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).modelStrategy).toBe('failover')

    res = await patchSettings(base, { llm_model_strategy: 'round-robin' })
    expect(res.status).toBe(200)
    expect(llmOf(res.body).modelStrategy).toBe('failover')

    const after = await getSettings(base)
    expect(llmOf(after).modelStrategy).toBe('failover')
  })

  test('unknown model strategy is a named 400', async () => {
    const { base } = await listen()
    const res = await patchSettings(base, { llm: { modelStrategy: 'random' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_model_strategy')
  })

  test('tailor.modelRouting and tailor.qualityEscalation still apply', async () => {
    const { base } = await listen()
    const res = await patchSettings(base, { tailor: { modelRouting: false, qualityEscalation: true } })
    expect(res.status).toBe(200)
    const tailor = (res.body.settings as Record<string, unknown>).tailor as Record<string, unknown>
    expect(tailor.modelRouting).toBe(false)
    expect(tailor.qualityEscalation).toBe(true)
  })
})

describe('PATCH /settings — domains', () => {
  test('domains sets per-domain overrides and merges per field', async () => {
    const { base } = await listen()
    let res = await patchSettings(base, { domains: { coding: { model: 'm1', temperature: 0.2, maxIterations: 10 } } })
    expect(res.status).toBe(200)
    let domains = (res.body.settings as Record<string, unknown>).domains as Record<string, Record<string, unknown>>
    expect(domains.coding).toMatchObject({ model: 'm1', temperature: 0.2, maxIterations: 10 })

    // Merge: updating one field keeps the others.
    res = await patchSettings(base, { domain_settings: { coding: { temperature: 0.9 } } })
    expect(res.status).toBe(200)
    domains = (res.body.settings as Record<string, unknown>).domains as Record<string, Record<string, unknown>>
    expect(domains.coding).toMatchObject({ model: 'm1', temperature: 0.9, maxIterations: 10 })
  })

  test('empty-string model unsets the override (follow-global)', async () => {
    const { base } = await listen()
    await patchSettings(base, { domains: { slide: { model: 'm1' } } })
    const res = await patchSettings(base, { domains: { slide: { model: '' } } })
    expect(res.status).toBe(200)
    const domains = (res.body.settings as Record<string, unknown>).domains as Record<string, Record<string, unknown>>
    expect(domains.slide.model).toBeUndefined()
  })

  test('domain temperature out of range is a named 400', async () => {
    const { base } = await listen()
    for (const body of [{ domains: { coding: { temperature: 3 } } }, { domain_settings: { slide: { temperature: 'warm' } } }]) {
      const res = await patchSettings(base, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_domain_temperature')
    }
  })

  test('domain maxIterations outside 1..100 is a named 400', async () => {
    const { base } = await listen()
    for (const body of [{ domains: { coding: { maxIterations: 0 } } }, { domains: { dokumen: { max_iterations: 101 } } }, { domains: { spreadsheet: { maxIterations: 2.5 } } }]) {
      const res = await patchSettings(base, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_domain_max_iterations')
    }
  })

  test('unknown domain keys and non-object values are named 400s', async () => {
    const { base } = await listen()
    for (const body of [{ domains: { bogus: {} } }, { domains: 'nope' }, { domains: { coding: 'm1' } }, { domain_settings: { CODING: {} } }]) {
      const res = await patchSettings(base, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_domain_settings')
    }
  })

  test('non-string domain model is a named 400', async () => {
    const { base } = await listen()
    const res = await patchSettings(base, { domains: { coding: { model: 42 } } })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_domain_settings')
  })
})

describe('thinkingLevel on the session', () => {
  test('GET /session exposes thinkingLevel with the medium default', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/session', base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: Record<string, unknown> }
    expect(body.session.thinkingLevel).toBe('medium')
    expect(body.session.thinking).toBe(true)
  })

  test('POST /session accepts thinkingLevel (both casings)', async () => {
    const { base } = await listen()
    let res = await fetch(new URL('/session', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: 'low' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { session: Record<string, unknown> }).session.thinkingLevel).toBe('low')

    res = await fetch(new URL('/session', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking_level: 'high' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { session: Record<string, unknown> }).session.thinkingLevel).toBe('high')
  })

  test('POST /session rejects an unknown level with a named 400', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/session', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinkingLevel: 'ultra' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_thinking_level')
  })

  test('deprecated thinking=false maps to off only when no level was given', async () => {
    const { base } = await listen()
    let res = await fetch(new URL('/session', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: false }),
    })
    expect(res.status).toBe(200)
    let session = ((await res.json()) as { session: Record<string, unknown> }).session
    expect(session.thinking).toBe(false)
    expect(session.thinkingLevel).toBe('off')

    // An explicit level wins over the boolean.
    res = await fetch(new URL('/session', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: false, thinkingLevel: 'high' }),
    })
    expect(res.status).toBe(200)
    session = ((await res.json()) as { session: Record<string, unknown> }).session
    expect(session.thinkingLevel).toBe('high')
  })

  test('PATCH /settings accepts nested session.thinkingLevel and top-level thinking_level', async () => {
    const { base } = await listen()
    let res = await patchSettings(base, { session: { thinkingLevel: 'low' } })
    expect(res.status).toBe(200)
    expect(sessionOf(res.body).thinkingLevel).toBe('low')
    expect(((res.body.settings as Record<string, unknown>).session as Record<string, unknown>).thinkingLevel).toBe('low')

    res = await patchSettings(base, { thinking_level: 'high' })
    expect(res.status).toBe(200)
    expect(sessionOf(res.body).thinkingLevel).toBe('high')
  })
})

describe('POST /tasks — token budget and tool rules', () => {
  test('token_budget / tokenBudget is echoed on the task record', async () => {
    const { base } = await listen(true)
    for (const body of [
      { goal: 'write a budget report', domain: 'slide', provider_id: 'fake', token_budget: 5000 },
      { goal: 'write another report', domain: 'slide', provider_id: 'fake', tokenBudget: 100 },
    ]) {
      const res = await fetch(new URL('/tasks', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(201)
      const task = (await res.json()) as Record<string, unknown>
      expect(task.token_budget).toBe(body.token_budget ?? body.tokenBudget)
      // Full task path (not the fast path): no `intent` stamp on the record.
      expect(task.intent).toBeUndefined()
    }
  })

  test('non-positive-integer token budgets are named 400s', async () => {
    const { base } = await listen()
    // (NaN can't survive JSON — it arrives as null, which ?? treats as
    // absent like the file's other optional numeric fields.)
    for (const token_budget of [0, -5, 1.5, 'lots']) {
      const res = await fetch(new URL('/tasks', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'budgeted work', token_budget }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_token_budget')
    }
  })

  test('tool_rules / toolRules are parsed and echoed on the task record', async () => {
    const { base } = await listen(true)
    const res = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'locked-down work',
        domain: 'slide',
        provider_id: 'fake',
        tool_rules: { allow: ['*', '*'], ask: [], deny: ['run_command', ' run_command '] },
      }),
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as Record<string, unknown>
    expect(task.tool_rules).toEqual({ allow: ['*'], ask: [], deny: ['run_command'] })

    const camel = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'more locked-down work', domain: 'slide', provider_id: 'fake', toolRules: { ask: ['write_file'] } }),
    })
    expect(camel.status).toBe(201)
    expect(((await camel.json()) as Record<string, unknown>).tool_rules).toEqual({ allow: [], ask: ['write_file'], deny: [] })
  })

  test('unusable tool rules are named 400s', async () => {
    const { base } = await listen()
    for (const tool_rules of [{ deny: 'nope' }, { allow: [42] }, {}, 'nope', []] as unknown[]) {
      const res = await fetch(new URL('/tasks', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'ruled work', tool_rules }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_tool_rules')
    }
  })

  test('one-shot model override still flows onto the task record', async () => {
    const { base } = await listen(true)
    const res = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'override the model', domain: 'slide', provider_id: 'fake', model: 'one-shot-model' }),
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Record<string, unknown>).model).toBe('one-shot-model')
  })
})

describe('providers — contextWindows', () => {
  test('POST /providers accepts contextWindows and the snake_case alias', async () => {
    const { base } = await listen()
    let res = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Win', baseUrl: 'https://example.com/v1', contextWindows: { 'm1': 128000, ' m2 ': 64000 } }),
    })
    expect(res.status).toBe(201)

    res = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Win2', baseUrl: 'https://example.com/v1', context_windows: { 'm1': 32000 } }),
    })
    expect(res.status).toBe(201)
  })

  test('invalid contextWindows values are named 400s', async () => {
    const { base } = await listen()
    for (const contextWindows of [{ 'm1': -5 }, { 'm1': 0 }, { 'm1': 1.5 }, { 'm1': '128000' }, 'lots', [{ 'm1': 8 }], { 'm1': Number.NaN }] as unknown[]) {
      const res = await fetch(new URL('/providers', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bad', baseUrl: 'https://example.com/v1', contextWindows }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_context_windows')
    }
  })

  test('PUT /providers/{id} validates contextWindows too', async () => {
    const { base } = await listen()
    const created = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Up', baseUrl: 'https://example.com/v1' }),
    })
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { provider: { id: string } }).provider.id

    const bad = await fetch(new URL(`/providers/${id}`, base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextWindows: { 'm1': -1 } }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_context_windows')

    const ok = await fetch(new URL(`/providers/${id}`, base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextWindows: { 'm1': 200000 } }),
    })
    expect(ok.status).toBe(200)
  })
})

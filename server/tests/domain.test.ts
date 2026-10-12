import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Domain plumbing (Web Coding|Slide switch → POST /tasks → core): a submit
 * from the Slide page must carry `domain: 'slide'`, be stored/returned on
 * the task record, and always take the full task path — the fast answer
 * paths have no tool loop, so they could never touch the deck tools. An
 * unknown domain is a named 400. Harness follows fast-path.test.ts.
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
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Siap, deck dibuat.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(): Promise<{ base: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-domain-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-domain-ws-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(workspace, 'README.md'), '# Fixture Repo\n')
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  const baseUrl = await startFakeProvider()
  ctx.providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'fake-key', models: ['fake-model'], defaultModel: 'fake-model', enabled: true })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}` }
}

async function postTask(base: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL('/tasks', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('POST /tasks domain plumbing', () => {
  test("domain 'slide' is stored on the task record and forces the full task path", async () => {
    const { base } = await listen()
    // This goal classifies as conversational without a domain; with
    // domain 'slide' it must NOT take the fast path (the task record for
    // the full path carries no `intent` field, the fast path stamps one).
    const created = await postTask(base, { goal: 'hai, apa kabar?', provider_id: 'fake', domain: 'slide' })
    expect(created.status).toBe(201)
    expect(created.body.domain).toBe('slide')
    expect(created.body.intent).toBeUndefined()
  })

  test("domain 'coding' is stored on the task record", async () => {
    const { base } = await listen()
    const created = await postTask(base, { goal: 'buatkan file src/health.ts', provider_id: 'fake', domain: 'coding' })
    expect(created.status).toBe(201)
    expect(created.body.domain).toBe('coding')
  })

  test('an unknown domain is a 400 invalid_domain', async () => {
    const { base } = await listen()
    const created = await postTask(base, { goal: 'buatkan sesuatu', provider_id: 'fake', domain: 'banana' })
    expect(created.status).toBe(400)
    expect(created.body.error).toBe('invalid_domain')
  })

  test('no domain: behaviour is unchanged (conversational goal still fast-paths)', async () => {
    const { base } = await listen()
    const created = await postTask(base, { goal: 'hai, apa kabar?', provider_id: 'fake' })
    expect(created.status).toBe(201)
    expect(created.body.domain).toBeUndefined()
    expect(created.body.intent).toBe('conversational')
  })
})

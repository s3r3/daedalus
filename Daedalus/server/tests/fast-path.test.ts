import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, type Event } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'
import { classifyWebIntent, isPureQuestion } from '../src/fast-path.ts'

/**
 * Fast-path behaviour (Crush/Cline pattern): a plain message goes straight
 * to the model and the reply is the result. These tests drive the real HTTP
 * surface against a controllable fake OpenAI-compatible provider and assert
 * on the recorded event log — the same log the Web Chat panel renders.
 */

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let fake: HttpServer | undefined
let tmp: string | undefined
let workspace: string | undefined
let requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []

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
  requests = []
})

type FakeReply = { content?: string; toolCalls?: Array<{ name: string; arguments: string }>; delayMs?: number }

async function startFakeProvider(reply: (call: number) => FakeReply): Promise<string> {
  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      let messages: Array<{ role: string; content: unknown }> = []
      try {
        messages = (JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
      } catch {
        /* the request log assert below will catch malformed traffic */
      }
      requests.push({ messages })
      const decision = reply(requests.length)
      const respond = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: decision.content ?? null,
                  ...(decision.toolCalls
                    ? { tool_calls: decision.toolCalls.map((call, index) => ({ id: `call-${requests.length}-${index}`, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
                    : {}),
                },
                finish_reason: decision.toolCalls ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        )
      }
      if (decision.delayMs) setTimeout(respond, decision.delayMs)
      else respond()
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(fakeReply?: (call: number) => FakeReply): Promise<{ base: string; ctx: ReturnType<typeof createContext> }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-fastpath-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-fastpath-ws-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(workspace, 'README.md'), '# Fixture Repo\n\nA tiny fixture repository for fast-path tests.\n')
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture-repo', description: 'fixture description' }))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  if (fakeReply) {
    const baseUrl = await startFakeProvider(fakeReply)
    ctx.providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'fake-key', models: ['fake-model'], defaultModel: 'fake-model', enabled: true })
  }
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, ctx }
}

async function postTask(base: string, body: Record<string, unknown>): Promise<{ status: number; body: { id: string; intent?: string } }> {
  const res = await fetch(new URL('/tasks', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { id: string; intent?: string } }
}

async function waitForEvents(base: string, taskId: string, type: string, timeoutMs = 15_000): Promise<Event[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(new URL(`/tasks/${taskId}/events`, base))
    const body = (await res.json()) as { events: Event[] }
    if (body.events.some((event) => event.type === type)) return body.events
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got ${body.events.map((event) => event.type).join(',')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

describe('classifyWebIntent', () => {
  test("Farid's mixed greeting + identity + repo question is a question, not a task", () => {
    expect(classifyWebIntent('hai kamu siapa dan aku siapa? dan repo ini tentang apa?')).toBe('question')
    expect(classifyWebIntent('repo ini tentang apa?')).toBe('question')
    expect(classifyWebIntent('apa itu repository pattern?')).not.toBe('task')
  })

  test('greetings stay conversational; imperatives stay tasks', () => {
    expect(classifyWebIntent('hai, apa kabar?')).toBe('conversational')
    expect(classifyWebIntent('buatkan file src/health.ts')).toBe('task')
    expect(classifyWebIntent('tolong perbaiki fungsi ini')).toBe('task')
    // Core's classifier owns the explanation semantics: "why is this
    // failing?" is information-seeking (answered directly), while a line
    // that demands a fix is work.
    expect(classifyWebIntent('kenapa test ini gagal?')).toBe('question')
    expect(isPureQuestion('jelaskan kenapa fungsi ini error')).toBe(false)
  })
})

describe('POST /tasks fast paths', () => {
  test('a conversational POST completes with reply events and no plan/tools/validation', async () => {
    const { base } = await listen(() => ({ content: 'Halo! Saya Daedalus, senang ngobrol.' }))
    const created = await postTask(base, { goal: 'hai, apa kabar?', provider_id: 'fake' })
    expect(created.status).toBe(201)
    expect(created.body.intent).toBe('conversational')

    const events = await waitForEvents(base, created.body.id, 'TASK_COMPLETED')
    const types = events.map((event) => event.type)
    expect(types).toContain('TASK_STARTED')
    expect(types).not.toContain('PLAN_CREATED')
    expect(types).not.toContain('TOOL_CALL_STARTED')
    expect(types).not.toContain('VALIDATION_STARTED')
    const finished = events.find((event) => event.type === 'MODEL_REQUEST_FINISHED')
    expect(JSON.stringify(finished?.payload)).toContain('Halo! Saya Daedalus')
    const completed = events.find((event) => event.type === 'TASK_COMPLETED')
    expect(JSON.stringify(completed?.payload)).toContain('"outcome":"success"')
    expect(requests).toHaveLength(1)
  })

  test('a question POST is grounded in the workspace snapshot with a single provider call', async () => {
    const { base } = await listen(() => ({ content: 'Ini repo fixture untuk test.' }))
    const created = await postTask(base, { goal: 'hai kamu siapa dan aku siapa? dan repo ini tentang apa?', provider_id: 'fake' })
    expect(created.status).toBe(201)
    expect(created.body.intent).toBe('question')

    const events = await waitForEvents(base, created.body.id, 'TASK_COMPLETED')
    const types = events.map((event) => event.type)
    expect(types).not.toContain('PLAN_CREATED')
    expect(types).not.toContain('TOOL_CALL_STARTED')
    expect(requests).toHaveLength(1)
    const sentText = JSON.stringify(requests[0]?.messages ?? [])
    expect(sentText).toContain('Fixture Repo')
    expect(sentText).toContain('fixture-repo')
    const finished = events.find((event) => event.type === 'MODEL_REQUEST_FINISHED')
    expect(JSON.stringify(finished?.payload)).toContain('repo fixture')
  })

  test('a task POST still takes the runner path (plan is created)', async () => {
    const { base } = await listen(() => ({ content: 'done: selesai' }))
    const created = await postTask(base, { goal: 'buatkan file src/health.ts yang mengembalikan status ok', provider_id: 'fake' })
    expect(created.status).toBe(201)
    expect(created.body.intent).toBeUndefined()

    const events = await waitForEvents(base, created.body.id, 'TASK_COMPLETED')
    const types = events.map((event) => event.type)
    expect(types).toContain('PLAN_CREATED')
  })

  test('cancelling a running task reaches a stopped terminal state and the loop halts', async () => {
    const { base } = await listen(() => ({ delayMs: 400, toolCalls: [{ name: 'read_file', arguments: '{"path":"src/index.ts"}' }] }))
    const created = await postTask(base, { goal: 'baca file src/index.ts berulang kali dan analisis isinya', provider_id: 'fake', max_iterations: 25 })
    expect(created.status).toBe(201)

    // Let it get going, then stop it mid-flight.
    await waitForEvents(base, created.body.id, 'TOOL_CALL_STARTED')
    const cancelRes = await fetch(new URL(`/tasks/${created.body.id}/cancel`, base), { method: 'POST' })
    const cancelBody = (await cancelRes.json()) as { cancelled: boolean; cancel_requested: boolean }
    expect(cancelBody.cancel_requested).toBe(true)
    expect(cancelBody.cancelled).toBe(true)

    const events = await waitForEvents(base, created.body.id, 'TASK_COMPLETED')
    const completed = events.find((event) => event.type === 'TASK_COMPLETED')
    expect(JSON.stringify(completed?.payload)).toContain('aborted')

    const snapshot = await fetch(new URL(`/tasks/${created.body.id}`, base))
    const snapshotBody = (await snapshot.json()) as { running: boolean }
    expect(snapshotBody.running).toBe(false)

    const settledCount = requests.length
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(requests.length).toBe(settledCount)
  }, 30_000)
})

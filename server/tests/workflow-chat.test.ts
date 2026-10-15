import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EventBus,
  ProviderRegistryStore,
  TaskStore,
  loadSettings,
} from '@daedalus/core'
import { createContext, createApp } from '../src/app.ts'

let server: ReturnType<typeof createApp> | undefined
let providerServer: Server | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (providerServer) await new Promise<void>((resolve) => providerServer?.close(() => resolve()))
  providerServer = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

type ChatMessage = { role: string; content: unknown }

function lastUserText(messages: ChatMessage[]): string {
  const users = messages.filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  if (Array.isArray(last.content)) {
    return last.content
      .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * Fake OpenAI-compatible provider. Non-streaming calls echo how many
 * messages rode along plus the FIRST user text — proving history reaches
 * the model. Streaming calls spell the same echo as real SSE deltas.
 */
async function startFakeProvider(): Promise<string> {
  providerServer = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const body = JSON.parse(raw) as { messages?: ChatMessage[]; stream?: boolean }
        const messages = body.messages ?? []
        const firstUser = messages.find((m) => m.role === 'user')
        const firstText = typeof firstUser?.content === 'string' ? firstUser.content : '[blocks]'
        const echo = `seen:${messages.length} first:${firstText}`
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const mid = Math.ceil(echo.length / 2)
          for (const part of [echo.slice(0, mid), echo.slice(mid)]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: echo }, finish_reason: 'stop' }] }))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => providerServer?.listen(0, '127.0.0.1', resolve))
  const address = providerServer.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/v1`
}

async function listenWithFake(): Promise<{ base: string; fakeBase: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-chat-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-chat-ws-'))
  const baseSettings = loadSettings()
  const settings = {
    ...baseSettings,
    daedalusHome: '.daedalus-test-home',
    llm: { ...baseSettings.llm, baseUrl: '', apiKey: '' },
  }
  const ctx = createContext({
    store: new TaskStore(join(tmp, 'state')),
    bus: new EventBus(),
    cwd: workspace,
    settings,
    providerStore: new ProviderRegistryStore(join(tmp, 'providers-home')),
  })
  ctx.providersReady = Promise.resolve()
  server = createApp(ctx)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  const fakeBase = await startFakeProvider()
  const providerRes = await fetch(new URL('/providers', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'fake', name: 'Fake', baseUrl: fakeBase, apiKey: 'x', models: ['fake-model'] }),
  })
  expect(providerRes.status).toBe(201)
  return { base, fakeBase }
}

async function postChat(base: string, body: Record<string, unknown>) {
  const res = await fetch(new URL('/workflow/chat', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function getRun(base: string, runId: string) {
  const res = await fetch(new URL(`/workflow/runs/${runId}?workspace_root=${encodeURIComponent(workspace!)}`, base))
  return (await res.json()) as {
    run: {
      turns: unknown[]
      chat_turns: number
      chat: Array<{ role: string; text: string }>
    }
  }
}

describe('chat memory', () => {
  test('follow-ups ride the previous turns back into the model', async () => {
    const { base } = await listenWithFake()
    const first = await postChat(base, { message: 'Siapa nama kucing saya? Kucing saya bernama Tomo.' })
    expect(first.status).toBe(200)
    expect(first.body.kind).toBe('chat')
    expect(first.body.text).toContain('seen:2')

    // Same run: system + user + assistant + new user = 4 messages.
    const second = await postChat(base, { message: 'Siapa nama kucing saya?', run_id: first.body.run_id })
    expect(second.status).toBe(200)
    expect(second.body.text).toContain('seen:4')
    expect(second.body.text).toContain('Tomo')

    const run = await getRun(base, first.body.run_id as string)
    expect(run.run.chat_turns).toBe(4)
    expect(run.run.chat.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  test('a new run starts cold (the /clear boundary)', async () => {
    const { base } = await listenWithFake()
    const first = await postChat(base, { message: 'Siapa nama kucing saya? Kucing saya bernama Tomo.' })
    const fresh = await postChat(base, { message: 'Siapa nama kucing saya?' })
    expect(fresh.body.run_id).not.toBe(first.body.run_id)
    expect(fresh.body.text).toContain('seen:2')
    expect(fresh.body.text).not.toContain('Tomo')
  })
})

describe('chat streaming', () => {
  test('SSE deltas spell the full reply and end with done', async () => {
    const { base } = await listenWithFake()
    const res = await fetch(new URL('/workflow/chat/stream', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Apa lelucon favoritmu?' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const deltas: string[] = []
    let done: Record<string, unknown> | undefined
    for (const line of (await res.text()).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      const obj = JSON.parse(payload) as { delta?: string; done?: boolean; run_id?: string; text?: string }
      if (typeof obj.delta === 'string') deltas.push(obj.delta)
      if (obj.done === true) done = obj
    }
    expect(done).toBeDefined()
    expect(deltas.join('')).toBe(done!.text)
    expect(done!.text as string).toContain('seen:')

    // The streamed exchange is persisted like a plain reply.
    const run = await getRun(base, done!.run_id as string)
    expect(run.run.chat_turns).toBe(2)
  })

  test('work messages on the stream route return the identical JSON dispatch', async () => {
    const { base } = await listenWithFake()
    const res = await fetch(new URL('/workflow/chat/stream', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'buatkan landing page pakai vue' }),
    })
    expect(res.status).toBe(201)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { engine: string; task_id: string }
    expect(body.engine).toBe('coding')
    expect(typeof body.task_id).toBe('string')
  })
})

describe('history clipping', () => {
  test('long sessions report clipped context instead of silently forgetting', async () => {
    const { base } = await listenWithFake()
    let runId: string | undefined
    let clipped = false
    // 8 exchanges = 16 turns > the 12-turn window (the 8th prompt
    // sees 14 stored turns, so its oldest pair is dropped).
    for (let i = 0; i < 8; i++) {
      const res = await postChat(base, { message: `Ceritakan fakta nomor ${i}?`, ...(runId ? { run_id: runId } : {}) })
      expect(res.status).toBe(200)
      runId = res.body.run_id as string
      clipped = res.body.clipped === true
      if (i === 0) expect(res.body.clipped).toBe(false)
    }
    expect(clipped).toBe(true)
    const run = await getRun(base, runId!)
    expect(run.run.chat_turns).toBe(16)
  })
})

describe('regenerate', () => {
  test('drops the previous answer instead of stacking a duplicate turn', async () => {
    const { base } = await listenWithFake()
    const first = await postChat(base, { message: 'Siapa nama kucing saya? Kucing saya bernama Tomo.' })
    const runId = first.body.run_id as string
    const second = await postChat(base, { message: 'Siapa nama kucing saya? Kucing saya bernama Tomo.', run_id: runId, regenerate: true })
    expect(second.status).toBe(200)
    const run = await getRun(base, runId)
    // user + answer (the first answer was replaced, not stacked).
    expect(run.run.chat_turns).toBe(2)
    expect(run.run.chat.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(run.run.chat[1]!.text).toBe(second.body.text)
  })
})

const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('chat attachments', () => {
  test('an image rides vision blocks and is persisted with a history marker', async () => {
    const { base } = await listenWithFake()
    const res = await postChat(base, {
      message: 'Apa isi gambar ini?',
      attachments: [{ name: 'a.png', mime: 'image/png', data_url: PIXEL_PNG }],
    })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('chat')
    const run = await getRun(base, res.body.run_id as string)
    expect(run.run.chat[0]!.text).toContain('[lampiran gambar: a.png')
    const dir = join(workspace!, '.daedalus', 'attachments', 'chat')
    expect(existsSync(dir)).toBe(true)
    expect(readdirSync(dir).length).toBeGreaterThan(0)
  })

  test('text files ride inline and unsupported types are rejected honestly', async () => {
    const { base } = await listenWithFake()
    const ok = await postChat(base, {
      message: 'Jelaskan file ini.',
      attachments: [{ name: 'b.txt', mime: 'text/plain', text: 'isi rahasia berkas' }],
    })
    expect(ok.status).toBe(200)
    const run = await getRun(base, ok.body.run_id as string)
    expect(run.run.chat[0]!.text).toContain('isi rahasia berkas')

    const bad = await postChat(base, {
      message: 'Jalankan ini.',
      attachments: [{ name: 'evil.exe', mime: 'application/x-msdownload', text: 'x' }],
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('unsupported_attachment')
  })
})

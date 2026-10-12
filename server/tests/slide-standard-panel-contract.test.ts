import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Regression for the 2026-10-09 Standard-mode hang on Farid's laptop:
 * the engine staged its outline (deck.json on disk, checkpoint message
 * in chat) and parked for the Outline panel's Buat button — but the
 * Web's deck panels re-read deck/deck.json only when a task event of
 * type FILE_CHANGED bumps the workspace revision, and slide pipeline
 * writes never emitted one. The panel kept its pre-deck ENOENT state,
 * Buat could never render, and the task sat RUNNING forever.
 *
 * This test pins the contract at the HTTP surface the Web actually
 * consumes: a staged Standard run announces its deck write with
 * FILE_CHANGED, the panel's data path then serves the skeleton, and
 * the Buat press completes the original task.
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

function stageReply(body: string): string {
  let system = ''
  let user = ''
  try {
    const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
    const messages = parsed.messages ?? []
    const systemMessage = messages.find((message) => message.role === 'system')
    system = typeof systemMessage?.content === 'string' ? systemMessage.content : ''
    user = typeof messages[1]?.content === 'string' ? messages[1].content : ''
  } catch { /* fall through */ }
  if (system.includes('OUTLINE stage')) {
    const count = Number(/slide_count: (\d+)/.exec(user)?.[1] ?? 2)
    return JSON.stringify(Array.from({ length: count }, (_, index) => ({
      title: `Slide ${index + 1}`,
      layoutId: index === 0 ? 'title' : 'bullets',
      keyMessage: `poin ${index + 1}`,
    })))
  }
  if (system.includes('FILL stage')) {
    if (user.includes('layout: title')) return JSON.stringify({ title: 'Judul', subtitle: 'Sub' })
    return JSON.stringify({ title: 'Isi', points: ['a', 'b'] })
  }
  return 'Siap.'
}

async function startFakeProvider(): Promise<string> {
  fake = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: stageReply(body) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    })
  })
  await new Promise<void>((resolve) => fake?.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  return `http://127.0.0.1:${port}/v1`
}

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-panelcontract-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-panelcontract-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  const baseUrl = await startFakeProvider()
  ctx.providerStore.registry.upsert({ id: 'fake', name: 'Fake', baseUrl, apiKey: 'fake-key', models: ['fake-model'], defaultModel: 'fake-model', enabled: true })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function req(base: string, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}

type Ev = { type: string; payload?: { path?: string; operation?: string; text?: string } }

async function taskEvents(base: string, id: string): Promise<Ev[]> {
  const got = await req(base, 'GET', `/tasks/${id}/events`)
  return (got.body.events ?? []) as Ev[]
}

async function waitForTask(base: string, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const got = await req(base, 'GET', `/tasks/${id}`)
    const record = (got.body.state ?? got.body) as Record<string, unknown>
    if (record.status === 'done' || record.status === 'failed') return record
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`task ${id} did not settle`)
}

describe('Standard staging is reachable from the Web panel (hang regression)', () => {
  test('staged run emits FILE_CHANGED; panel data path serves the skeleton; Buat completes the task', async () => {
    const { base, root } = await listen()
    const deckFilePath = `/workspace/file?root=${encodeURIComponent(root)}&path=deck%2Fdeck.json`

    // The panel mounts before the run: honest ENOENT empty state.
    const mount = await req(base, 'GET', deckFilePath)
    expect(mount.status).not.toBe(200)

    const created = await req(base, 'POST', '/tasks', {
      goal: 'buat slide tentang taksonomi virus berbahaya di dunia',
      provider_id: 'fake',
      domain: 'slide',
      slide: { generation: 'standard', slide_count: 3 },
    })
    expect(created.status).toBe(201)
    const id = String(created.body.id ?? '')

    // Wait for the staging gate: checkpoint THOUGHT + skeleton on disk.
    let events: Ev[] = []
    let staged = false
    for (let attempt = 0; attempt < 150 && !staged; attempt++) {
      events = await taskEvents(base, id)
      staged = events.some((e) => e.type === 'THOUGHT' && String(e.payload?.text ?? '').includes('sudah tampil di panel Outline'))
      if (!staged) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(staged).toBe(true)

    // THE contract: the deck write was announced with FILE_CHANGED —
    // the only event that makes the Web re-read deck/deck.json — so the
    // Outline panel's refetch now serves the staged skeleton.
    const changes = events.filter((e) => e.type === 'FILE_CHANGED')
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0]?.payload?.path).toBe('deck/deck.json')
    expect(changes[0]?.payload?.operation).toBe('created')
    const panelRead = await req(base, 'GET', deckFilePath)
    expect(panelRead.status).toBe(200)
    const served = JSON.parse(String(panelRead.body.content ?? '')) as { slides: Array<{ status: string }> }
    expect(served.slides).toHaveLength(3)
    expect(served.slides.every((slide) => slide.status === 'skeleton')).toBe(true)

    // Parked, not settled, nothing exported — the gate itself is fine.
    const parked = await req(base, 'GET', `/tasks/${id}`)
    const parkedState = (parked.body.state ?? {}) as Record<string, unknown>
    expect(['done', 'failed']).not.toContain(parkedState.status)
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(false)

    // Buat (what the now-visible button posts) completes the task.
    const generated = await req(base, 'POST', '/slides/deck/generate', { root })
    expect(generated.status).toBe(200)
    expect(generated.body.task_id).toBe(id)
    expect(generated.body.outcome).toBe('success')

    const record = await waitForTask(base, id)
    expect(record.status).toBe('done')
    expect(readdirSync(join(root, 'deck')).some((name) => name.endsWith('.pptx'))).toBe(true)
    const done = await taskEvents(base, id)
    const allChanges = done.filter((e) => e.type === 'FILE_CHANGED')
    expect((allChanges.at(-1)?.payload as { operation?: string } | undefined)?.operation).toBe('modified')
  })
})

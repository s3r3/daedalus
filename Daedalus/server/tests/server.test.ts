import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, type Event } from '@daedalus/core'
import { WebSocket } from 'ws'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  channel?.close()
  channel = undefined
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function listen(): Promise<{ base: string; wsUrl: string; ctx: ReturnType<typeof createContext> }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-server-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-server-ws-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(workspace, 'README.md'), '# fixture\n')
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/tasks/events`, ctx }
}

describe('server', () => {
  test('GET /health responds with status ok', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/health', base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; service: string }
    expect(body.status).toBe('ok')
    expect(body.service).toBe('daedalus-server')
  })

  test('POST /tasks then GET /tasks/{id} round trip', async () => {
    const { base } = await listen()
    const created = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'add health endpoint' }),
    })
    expect(created.status).toBe(201)
    const task = (await created.json()) as { id: string; goal: string; repo_path: string }

    const fetched = await fetch(new URL(`/tasks/${task.id}`, base))
    expect(fetched.status).toBe(200)
    const body = (await fetched.json()) as { state: { goal?: string; repo_path?: string }; running: boolean }
    expect(body.state?.goal).toBe('add health endpoint')
    expect(body.state?.repo_path).toBe(task.repo_path)
    expect(Array.isArray(body.events)).toBe(true)
  })

  test('POST /tasks rejects missing goal', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  test('POST /tasks accepts a model pool and records it on the task', async () => {
    const { base } = await listen()
    const created = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'pool task', models: ['model-a', 'model-b'], model_strategy: 'round-robin' }),
    })
    expect(created.status).toBe(201)
    const task = (await created.json()) as { id: string; models?: string[]; model_strategy?: string }
    expect(task.models).toEqual(['model-a', 'model-b'])
    expect(task.model_strategy).toBe('round-robin')

    const fetched = await fetch(new URL(`/tasks/${task.id}`, base))
    expect(fetched.status).toBe(200)
    const body = (await fetched.json()) as { state: { models?: string[]; model_strategy?: string } }
    expect(body.state?.models).toEqual(['model-a', 'model-b'])
    expect(body.state?.model_strategy).toBe('round-robin')
  })

  test('POST /tasks rejects an unknown model strategy instead of guessing', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'pool task', models: ['model-a', 'model-b'], model_strategy: 'random' }),
    })
    expect(res.status).toBe(400)
  })

  test('unknown route returns 404', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/nope', base))
    expect(res.status).toBe(404)
  })

  test('GET /tasks lists tasks with their last event', async () => {
    const { base, ctx } = await listen()
    ctx.store.saveState('t1', { status: 'active', spec: { goal: 'first' }, repo_path: workspace })
    ctx.store.append('t1', { seq: 1, task_id: 't1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:00.000Z' })
    ctx.store.append('t1', { seq: 2, task_id: 't1', type: 'PLAN_CREATED', payload: {}, ts: '2026-01-01T00:00:01.000Z' })
    const res = await fetch(new URL('/tasks', base))
    const body = (await res.json()) as { count: number; tasks: Array<{ id: string; last_seq: number; last_event: string; status: string }> }
    expect(body.count).toBe(1)
    expect(body.tasks[0]).toMatchObject({ id: 't1', last_seq: 2, last_event: 'PLAN_CREATED', status: 'active' })
  })

  test('GET /workspace/tree returns nested children and hides ignored directories', async () => {
    const { base } = await listen()
    mkdirSync(join(workspace as string, 'node_modules', 'pkg'), { recursive: true })
    const res = await fetch(new URL('/workspace/tree?root=' + encodeURIComponent(workspace as string) + '&path=.&depth=3', base))
    const body = (await res.json()) as { children: Array<{ name: string; isDirectory: boolean; children?: unknown[] }> }
    const names = body.children.map((c) => c.name)
    expect(names).toContain('src')
    expect(names).toContain('README.md')
    expect(names).not.toContain('node_modules')
    const src = body.children.find((c) => c.name === 'src')
    expect(src?.children?.map((c) => (c as { name: string }).name)).toContain('index.ts')
  })

  test('workspace routes refuse to escape the root', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/workspace/file?root=' + encodeURIComponent(workspace as string) + '&path=../../etc/passwd', base))
    expect(res.status).toBe(404)
  })

  test('GET /workspace/file returns content for a fixture file', async () => {
    const { base } = await listen()
    const res = await fetch(new URL('/workspace/file?root=' + encodeURIComponent(workspace as string) + '&path=src/index.ts', base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string }
    expect(body.content).toContain('export const a = 1')
  })

  test('GET /tasks/{id}/changes lists FILE_CHANGED payloads', async () => {
    const { base, ctx } = await listen()
    ctx.store.saveState('t2', { status: 'active' })
    ctx.store.append('t2', { seq: 1, task_id: 't2', type: 'FILE_CHANGED', payload: { path: 'a.ts', added: 2, removed: 1 }, ts: '2026-01-01T00:00:00.000Z' })
    const res = await fetch(new URL('/tasks/t2/changes', base))
    const body = (await res.json()) as { count: number; changes: Array<{ path: string }> }
    expect(body.count).toBe(1)
    expect(body.changes[0]?.path).toBe('a.ts')
  })

  test('GET /tasks/{id}/report serves the persisted report', async () => {
    const { base, ctx } = await listen()
    ctx.store.saveState('t3', { status: 'done' })
    ctx.store.saveReport('t3', { task_id: 't3', outcome: 'success', diff: '', evidence: [], metrics: { events: 3 } })
    const res = await fetch(new URL('/tasks/t3/report', base))
    const body = (await res.json()) as { report: { outcome: string; metrics: { events: number } } }
    expect(body.report.outcome).toBe('success')
    expect(body.report.metrics.events).toBe(3)
    expect((await fetch(new URL('/tasks/missing/report', base))).status).toBe(404)
  })

  test('POST /tasks/{id}/cancel records a cancellation request', async () => {
    const { base, ctx } = await listen()
    ctx.store.saveState('t4', { status: 'active' })
    const res = await fetch(new URL('/tasks/t4/cancel', base), { method: 'POST' })
    const body = (await res.json()) as { cancelled: boolean; task_id: string }
    expect(body).toEqual({ cancelled: false, task_id: 't4' })
    expect(ctx.store.isCancelRequested('t4')).toBe(true)
  })

  test('POST /tasks/{id}/approve decides a pending approval', async () => {
    const { base, ctx } = await listen()
    ctx.store.saveState('t5', { status: 'active' })
    const pending = ctx.bus
    void pending
    const { TaskRunner } = await import('@daedalus/core')
    const runner = new TaskRunner({ workspaceRoot: workspace as string, bus: ctx.bus, store: ctx.store, approvalPolicy: 'ask' })
    ctx.activeRunners.set('t5', runner)
    const key = { taskId: 't5', tool: 'write_file', action: 'write' as const, path: 'a.ts' }
    const decision = runner.approvals.request(key, 'ask')
    const res = await fetch(new URL('/tasks/t5/approve', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, decision: 'grant', remember: true }),
    })
    const body = (await res.json()) as { success: boolean; decision: string }
    expect(body).toMatchObject({ success: true, decision: 'grant' })
    await expect(decision).resolves.toMatchObject({ decision: 'grant' })
  })
})

describe('websocket channel', () => {
  test('replays only events after the requested seq, then streams live ones', async () => {
    const { wsUrl, ctx } = await listen()
    ctx.store.saveState('t6', { status: 'active' })
    const seeded: Event[] = [1, 2, 3].map((seq) => ({
      seq,
      task_id: 't6',
      type: 'TOOL_CALL_STARTED' as const,
      payload: { call: { id: `c${seq}` } },
      ts: '2026-01-01T00:00:00.000Z',
    }))
    for (const event of seeded) ctx.store.append('t6', event)

    const socket = new WebSocket(wsUrl)
    const messages: Array<Record<string, unknown>> = []
    socket.on('message', (raw: Buffer) => messages.push(JSON.parse(String(raw))))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const hello = await waitFor(messages, (m) => m.kind === 'hello')
    expect(hello.protocol).toBe('daedalus-events')
    expect(hello.version).toBe(1)

    socket.send(JSON.stringify({ kind: 'subscribe', task_id: 't6', since_seq: 2 }))
    const subscribed = await waitFor(messages, (m) => m.kind === 'subscribed')
    expect(subscribed.replayed).toBe(1)

    ctx.bus.publish({ seq: 4, task_id: 't6', type: 'TOOL_CALL_FINISHED', payload: { result: { status: 'ok' } }, ts: '2026-01-01T00:00:02.000Z' })
    await waitFor(messages, (m) => m.kind === 'event' && (m.event as Event).seq === 4)

    const replayed = messages.filter((m) => m.kind === 'event').map((m) => (m.event as Event).seq)
    expect(replayed).toEqual([3, 4])
    socket.close()
  })

  test('rejects malformed and unknown client messages without dropping the socket', async () => {
    const { wsUrl } = await listen()
    const socket = new WebSocket(wsUrl)
    const messages: Array<Record<string, unknown>> = []
    socket.on('message', (raw: Buffer) => messages.push(JSON.parse(String(raw))))
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
    socket.send('not json')
    expect((await waitFor(messages, (m) => m.kind === 'error')).error).toBe('invalid_json')
    socket.send(JSON.stringify({ kind: 'nonsense' }))
    expect((await waitFor(messages, (m) => m.kind === 'error' && m.error === 'unsupported_message')).error).toBe('unsupported_message')
    socket.send(JSON.stringify({ kind: 'ping' }))
    expect(await waitFor(messages, (m) => m.kind === 'pong')).toBeTruthy()
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })
})

async function waitFor(messages: Array<Record<string, unknown>>, predicate: (m: Record<string, unknown>) => boolean, attempts = 50): Promise<Record<string, unknown>> {
  for (let i = 0; i < attempts; i++) {
    const found = messages.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`message never arrived: ${JSON.stringify(messages)}`)
}
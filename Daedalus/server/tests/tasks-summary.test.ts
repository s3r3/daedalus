import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp } from '../src/app.ts'

/**
 * GET /tasks summary correctness after the hot-path fix: summaries are
 * memoized behind a stat fingerprint of each task's files, so this
 * pins that (a) the summary fields still match what the event log
 * says, and (b) a task whose files change between polls is reflected
 * on the very next poll — the memo can never serve a stale history.
 */

let server: ReturnType<typeof createApp> | undefined
let tmp: string | undefined
let workspace: string | undefined
let store: TaskStore | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function listen(): Promise<string> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-summary-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-summary-ws-'))
  store = new TaskStore(join(tmp, 'state'))
  const ctx = createContext({ store, bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}`
}

type Summary = {
  id: string
  status: string
  event_count: number
  last_seq: number
  last_event: string | null
  updated_at: string | null
}

async function summaries(base: string): Promise<Summary[]> {
  const res = await fetch(`${base}/tasks`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tasks: Summary[] }
  return body.tasks
}

describe('GET /tasks summaries (memoized hot path)', () => {
  test('fields match the event log and update on the next poll after a change', async () => {
    const base = await listen()
    const s = store!
    s.saveState('t-1', { id: 't-1', goal: 'tugas satu', repo_path: workspace, mode: 'auto', status: 'active', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p', task_id: 't-1', steps: [], version: 1, status: 'active' }, steps: [] })
    s.append('t-1', { seq: 1, task_id: 't-1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:01Z' } as never)
    s.append('t-1', { seq: 2, task_id: 't-1', type: 'THOUGHT', payload: { text: 'berpikir' }, ts: '2026-01-01T00:00:02Z' } as never)
    s.saveState('t-2', { id: 't-2', goal: 'tugas dua', repo_path: workspace, mode: 'auto', status: 'done', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p2', task_id: 't-2', steps: [], version: 1, status: 'done' }, steps: [] })
    s.saveReport('t-2', { task_id: 't-2', outcome: 'success', diff: '', evidence: [], metrics: {} })
    s.append('t-2', { seq: 1, task_id: 't-2', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:01Z' } as never)
    s.append('t-2', { seq: 2, task_id: 't-2', type: 'TASK_COMPLETED', payload: {}, ts: '2026-01-01T00:03:00Z' } as never)

    const first = await summaries(base)
    const one = first.find((t) => t.id === 't-1')!
    expect(one.event_count).toBe(2)
    expect(one.last_seq).toBe(2)
    expect(one.last_event).toBe('THOUGHT')
    expect(one.updated_at).toBe('2026-01-01T00:00:02Z')
    const two = first.find((t) => t.id === 't-2')!
    expect(two.status).toBe('success')
    expect(two.last_event).toBe('TASK_COMPLETED')

    // The task moves on between polls: one more event + a final state.
    // The very next poll must show it — fingerprint, not TTL, gates this.
    s.append('t-1', { seq: 3, task_id: 't-1', type: 'TASK_COMPLETED', payload: {}, ts: '2026-01-01T00:05:00Z' } as never)
    s.saveState('t-1', { id: 't-1', goal: 'tugas satu', repo_path: workspace, mode: 'auto', status: 'done', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p', task_id: 't-1', steps: [], version: 1, status: 'done' }, steps: [] })

    const second = await summaries(base)
    const moved = second.find((t) => t.id === 't-1')!
    expect(moved.event_count).toBe(3)
    expect(moved.last_seq).toBe(3)
    expect(moved.last_event).toBe('TASK_COMPLETED')
    expect(moved.updated_at).toBe('2026-01-01T00:05:00Z')
    expect(moved.status).toBe('done')
  })
})

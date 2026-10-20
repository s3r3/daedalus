import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp } from '../src/app.ts'

/**
 * Startup reconciliation: a task the previous daemon left mid-run (active
 * state on disk, no final report) must not be displayed as "running"
 * forever by a fresh server — it is settled to `interrupted`, with the
 * event log and recorded work preserved. These tests seed the on-disk
 * history BEFORE the server boots, which is exactly the crash-restart
 * situation; tasks that already ended (report present, or a terminal
 * state) must pass through untouched.
 */

type Server = ReturnType<typeof createApp>

let servers: Server[] = []
let dirs: string[] = []

function trackedTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  servers = servers.filter((candidate) => candidate !== server)
}

afterEach(async () => {
  for (const server of [...servers]) await closeServer(server)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function boot(store: TaskStore, workspace: string): Promise<{ base: string; server: Server }> {
  const ctx = createContext({ store, bus: new EventBus(), cwd: workspace })
  const server = createApp(ctx)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, server }
}

function seed(store: TaskStore, workspace: string): void {
  // The dead run: state says active, two events, no report — the daemon
  // died before the runner could write one.
  store.saveState('dead-1', { id: 'dead-1', goal: 'tugas yang mati di tengah', repo_path: workspace, mode: 'auto', status: 'active', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p-dead', task_id: 'dead-1', steps: [], version: 1, status: 'active' }, steps: [] })
  store.append('dead-1', { seq: 1, task_id: 'dead-1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:01Z' } as never)
  store.append('dead-1', { seq: 2, task_id: 'dead-1', type: 'THOUGHT', payload: { text: 'berpikir' }, ts: '2026-01-01T00:00:02Z' } as never)

  // A completed task: report present, terminal event recorded.
  store.saveState('done-1', { id: 'done-1', goal: 'tugas selesai', repo_path: workspace, mode: 'auto', status: 'done', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p-done', task_id: 'done-1', steps: [], version: 1, status: 'done' }, steps: [] })
  store.append('done-1', { seq: 1, task_id: 'done-1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:01Z' } as never)
  store.append('done-1', { seq: 2, task_id: 'done-1', type: 'TASK_COMPLETED', payload: { outcome: 'success' }, ts: '2026-01-01T00:03:00Z' } as never)
  store.saveReport('done-1', { task_id: 'done-1', outcome: 'success', diff: 'diff --git a/x b/x', evidence: ['ok'], metrics: { turns: 2 } })

  // A failed task without a report: already terminal, already truthful.
  store.saveState('failed-1', { id: 'failed-1', goal: 'tugas gagal', repo_path: workspace, mode: 'auto', status: 'failed', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p-failed', task_id: 'failed-1', steps: [], version: 1, status: 'active' }, steps: [] })
  store.append('failed-1', { seq: 1, task_id: 'failed-1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:01Z' } as never)
  store.append('failed-1', { seq: 2, task_id: 'failed-1', type: 'TASK_COMPLETED', payload: { outcome: 'failed', reason: 'max_errors' }, ts: '2026-01-01T00:04:00Z' } as never)

  // State still says active but a report exists: the report wins (the
  // same precedence summarizeFrom uses) — reconciliation must not touch it.
  store.saveState('reported-1', { id: 'reported-1', goal: 'tugas dengan laporan', repo_path: workspace, mode: 'auto', status: 'active', created_at: '2026-01-01T00:00:00Z', plan: { id: 'p-reported', task_id: 'reported-1', steps: [], version: 1, status: 'active' }, steps: [] })
  store.append('reported-1', { seq: 1, task_id: 'reported-1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:01Z' } as never)
  store.saveReport('reported-1', { task_id: 'reported-1', outcome: 'partial', diff: '', evidence: [], metrics: {} })
}

type Summary = { id: string; status: string; outcome?: string; running: boolean; event_count: number }

async function summaries(base: string): Promise<Summary[]> {
  const res = await fetch(`${base}/tasks`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { tasks: Summary[] }
  return body.tasks
}

describe('startup reconciliation of interrupted tasks', () => {
  test('a dead mid-run task is reported interrupted, not running, with its history preserved', async () => {
    const workspace = trackedTmp('daedalus-reconcile-ws-')
    const store = new TaskStore(join(trackedTmp('daedalus-reconcile-'), 'state'))
    seed(store, workspace)

    const { base } = await boot(store, workspace)

    const list = await summaries(base)
    const dead = list.find((task) => task.id === 'dead-1')!
    expect(dead.status).toBe('interrupted')
    expect(dead.outcome).toBe('interrupted')
    expect(dead.running).toBe(false)
    expect(dead.event_count).toBe(3)

    const detailRes = await fetch(`${base}/tasks/dead-1`)
    expect(detailRes.status).toBe(200)
    const detail = (await detailRes.json()) as {
      running: boolean
      report: { outcome: string } | null
      events: Array<{ type: string; payload: { outcome?: string } }>
    }
    expect(detail.running).toBe(false)
    expect(detail.report?.outcome).toBe('interrupted')
    // Prior events preserved in order; exactly one closing event appended.
    expect(detail.events.map((event) => event.type)).toEqual(['TASK_STARTED', 'THOUGHT', 'TASK_COMPLETED'])
    expect(detail.events[2]?.payload.outcome).toBe('interrupted')

    const reportRes = await fetch(`${base}/tasks/dead-1/report`)
    expect(reportRes.status).toBe(200)
    const { report } = (await reportRes.json()) as { report: { outcome: string; evidence: string[] } }
    expect(report.outcome).toBe('interrupted')
    expect(report.evidence.length).toBeGreaterThan(0)
  })

  test('tasks that already ended are left exactly as recorded', async () => {
    const workspace = trackedTmp('daedalus-reconcile-ws-')
    const store = new TaskStore(join(trackedTmp('daedalus-reconcile-'), 'state'))
    seed(store, workspace)
    const doneEventsBefore = store.replay('done-1')
    const failedEventsBefore = store.replay('failed-1')
    const reportedEventsBefore = store.replay('reported-1')

    const { base } = await boot(store, workspace)

    // No appended events, no rewritten or fabricated reports.
    expect(store.replay('done-1')).toEqual(doneEventsBefore)
    expect(store.replay('failed-1')).toEqual(failedEventsBefore)
    expect(store.replay('reported-1')).toEqual(reportedEventsBefore)
    expect(store.loadReport('done-1')).toMatchObject({ outcome: 'success' })
    expect(store.loadReport('reported-1')).toMatchObject({ outcome: 'partial' })
    expect(store.loadReport('failed-1')).toBeUndefined()

    const list = await summaries(base)
    expect(list.find((task) => task.id === 'done-1')).toMatchObject({ status: 'success', running: false })
    expect(list.find((task) => task.id === 'failed-1')).toMatchObject({ status: 'failed', running: false })
    expect(list.find((task) => task.id === 'reported-1')).toMatchObject({ status: 'partial', running: false })

    const reportRes = await fetch(`${base}/tasks/failed-1/report`)
    expect(reportRes.status).toBe(404)
  })

  test('a server with no recorded tasks boots as a no-op', async () => {
    const workspace = trackedTmp('daedalus-reconcile-ws-')
    const storeRoot = join(trackedTmp('daedalus-reconcile-'), 'state')
    const store = new TaskStore(storeRoot)

    const { base } = await boot(store, workspace)

    const res = await fetch(`${base}/tasks`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number }
    expect(body.count).toBe(0)
    // Reconciliation must not invent a tasks directory or any task files.
    expect(existsSync(join(storeRoot, 'tasks'))).toBe(false)
  })

  test('reconciling twice (restart over the same store) changes nothing the second time', async () => {
    const workspace = trackedTmp('daedalus-reconcile-ws-')
    const store = new TaskStore(join(trackedTmp('daedalus-reconcile-'), 'state'))
    seed(store, workspace)

    const first = await boot(store, workspace)
    const eventsAfterFirst = store.replay('dead-1')
    const reportAfterFirst = store.loadReport('dead-1')
    expect(eventsAfterFirst.map((event) => event.type)).toEqual(['TASK_STARTED', 'THOUGHT', 'TASK_COMPLETED'])
    expect(reportAfterFirst).toMatchObject({ outcome: 'interrupted' })
    await closeServer(first.server)

    const second = await boot(store, workspace)
    expect(store.replay('dead-1')).toEqual(eventsAfterFirst)
    expect(store.loadReport('dead-1')).toEqual(reportAfterFirst)

    const list = await summaries(second.base)
    expect(list.find((task) => task.id === 'dead-1')).toMatchObject({ status: 'interrupted', running: false, event_count: 3 })
  })
})

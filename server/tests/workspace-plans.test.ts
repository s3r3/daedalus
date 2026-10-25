import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
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

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'daedalus-plans-ws-'))
  // One finished Plan-mode output: two markdown documents under a slug.
  const sekolah = join(root, '.daedalus', 'plans', 'website-sekolah')
  mkdirSync(sekolah, { recursive: true })
  writeFileSync(join(sekolah, 'plan.md'), '# Rencana Website Sekolah\n\n1. Scaffold\n2. Build\n')
  writeFileSync(join(sekolah, 'PRD.md'), '# PRD Website Sekolah\n')
  // A slug without any markdown must not surface as a plan.
  mkdirSync(join(root, '.daedalus', 'plans', 'notes-only'), { recursive: true })
  writeFileSync(join(root, '.daedalus', 'plans', 'notes-only', 'scratch.txt'), 'todo\n')
  // A stray markdown at the workspace root must NOT be treated as a plan:
  // only .daedalus/plans/** is scanned.
  writeFileSync(join(root, 'plan.md'), '# stray\n')
  return root
}

async function listen(cwd?: string): Promise<{ base: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-plans-state-'))
  workspace = cwd ?? makeWorkspace()
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}` }
}

describe('GET /workspace/plans', () => {
  test('lists plan folders with their documents, title and timestamp', async () => {
    const { base } = await listen()
    expect(workspace).toBeDefined()
    const res = await fetch(new URL(`/workspace/plans?root=${encodeURIComponent(workspace!)}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      root: string
      plans: Array<{ slug: string; documents: string[]; title: string | null; updatedAt: string | null }>
    }
    expect(body.root).toBe(workspace)
    expect(body.plans).toHaveLength(1)
    const plan = body.plans[0]!
    expect(plan.slug).toBe('website-sekolah')
    expect(plan.documents).toEqual(['.daedalus/plans/website-sekolah/plan.md', '.daedalus/plans/website-sekolah/PRD.md'])
    expect(plan.title).toBe('Rencana Website Sekolah')
    expect(typeof plan.updatedAt).toBe('string')
  })

  test('a workspace without a plans folder returns an empty list', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'daedalus-plans-empty-'))
    const { base } = await listen(empty)
    const res = await fetch(new URL(`/workspace/plans?root=${encodeURIComponent(workspace!)}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plans: unknown[] }
    expect(body.plans).toEqual([])
  })

  test('a root outside the allowed workspaces is rejected', async () => {
    const { base } = await listen()
    const outside = mkdtempSync(join(tmpdir(), 'daedalus-plans-outside-'))
    try {
      const res = await fetch(new URL(`/workspace/plans?root=${encodeURIComponent(outside)}`, base))
      expect(res.status).toBe(403)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test('resolves the producing task from the event log so executions can carry plan_task_id', async () => {
    // Seed the store BEFORE listen(): one plan task wrote the slug's
    // documents (FILE_CHANGED events), an unrelated task did not.
    tmp = mkdtempSync(join(tmpdir(), 'daedalus-plans-state-'))
    workspace = makeWorkspace()
    const store = new TaskStore(join(tmp, 'state'))
    const ev = (taskId: string, type: string, payload: unknown) =>
      ({ task_id: taskId, ts: '2026-10-07T00:00:00.000Z', type, payload }) as never
    store.append('task-plan-1', ev('task-plan-1', 'FILE_CHANGED', { path: '.daedalus/plans/website-sekolah/plan.md' }))
    store.append('task-plan-1', ev('task-plan-1', 'FILE_CHANGED', { path: '.daedalus/plans/website-sekolah/PRD.md' }))
    store.append('task-other', ev('task-other', 'FILE_CHANGED', { path: 'src/index.ts' }))
    const ctx = createContext({ store, bus: new EventBus(), cwd: workspace })
    server = createApp(ctx)
    channel = attachWebSocket(ctx, server)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const res = await fetch(new URL(`/workspace/plans?root=${encodeURIComponent(workspace)}`, `http://127.0.0.1:${port}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { plans: Array<{ slug: string; taskId: string | null }> }
    expect(body.plans).toHaveLength(1)
    expect(body.plans[0]!.taskId).toBe('task-plan-1')
  })
})

import { afterEach, describe, expect, test } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp } from '../src/app.ts'

/**
 * Task checkpoints (the Web surface for the CLI `restore` command):
 * GET /tasks/:id/checkpoints lists the pre-mutation backups the task
 * recorded, and POST /tasks/:id/restore rewinds them — unknown tasks
 * 404, unresolvable roots 400, and only recorded files are ever touched.
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
  store = undefined
})

async function listen(): Promise<{ base: string; token: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-ckpt-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-ckpt-ws-'))
  mkdirSync(join(workspace!, 'src'), { recursive: true })
  writeFileSync(join(workspace!, 'src', 'index.ts'), 'export const a = 1\n')
  store = new TaskStore(join(tmp!, 'state'))
  const ctx = createContext({ store, bus: new EventBus(), cwd: workspace! })
  server = createApp(ctx)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  // createApp mints the daemon token; restore is a sensitive route and
  // requires it (S6: only cancel is exempt from the token guard; pause
  // requires it too).
  return { base: `http://127.0.0.1:${port}`, token: ctx.daemonToken ?? '' }
}

function seedTask(taskId: string, withRepo = true): void {
  store!.saveState(taskId, withRepo ? { repo_path: workspace } : {})
  store!.recordBackup(taskId, 'src/index.ts', 'export const a = 1\n')
  store!.recordBackup(taskId, 'new-file.txt', null)
}

async function get(base: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function post(base: string, path: string, body: Record<string, unknown>, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('task checkpoints', () => {
  test('GET lists the recorded backups; unknown tasks 404', async () => {
    const { base } = await listen()
    seedTask('task-1')

    const found = await get(base, '/tasks/task-1/checkpoints')
    expect(found.status).toBe(200)
    expect(found.body.count).toBe(2)
    expect(found.body.checkpoints).toEqual([
      { path: 'src/index.ts', created: false },
      { path: 'new-file.txt', created: true },
    ])

    const missing = await get(base, '/tasks/nope/checkpoints')
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('not_found')
  })

  test('POST restore rewinds the task files and touches nothing else', async () => {
    const { base, token } = await listen()
    seedTask('task-1')
    writeFileSync(join(workspace!, 'src', 'index.ts'), 'agent edit\n')
    writeFileSync(join(workspace!, 'new-file.txt'), 'brand new\n')
    writeFileSync(join(workspace!, 'untouched.txt'), 'leave me alone\n')

    const res = await post(base, '/tasks/task-1/restore', { root: workspace }, token)
    expect(res.status).toBe(200)
    expect(res.body.restored).toEqual(['src/index.ts'])
    expect(res.body.deleted).toEqual(['new-file.txt'])
    expect(readFileSync(join(workspace!, 'src', 'index.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(existsSync(join(workspace!, 'new-file.txt'))).toBe(false)
    expect(readFileSync(join(workspace!, 'untouched.txt'), 'utf8')).toBe('leave me alone\n')
  })

  test('POST restore falls back to the task-recorded root when no root is given', async () => {
    const { base, token } = await listen()
    seedTask('task-1')
    writeFileSync(join(workspace!, 'src', 'index.ts'), 'agent edit\n')

    const res = await post(base, '/tasks/task-1/restore', {}, token)
    expect(res.status).toBe(200)
    expect(res.body.restored).toEqual(['src/index.ts'])
    expect(readFileSync(join(workspace!, 'src', 'index.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  test('POST restore 404s unknown tasks and 400s when no root is resolvable', async () => {
    const { base, token } = await listen()

    const missing = await post(base, '/tasks/nope/restore', { root: workspace }, token)
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('not_found')

    seedTask('task-2', false)
    const noRoot = await post(base, '/tasks/task-2/restore', {}, token)
    expect(noRoot.status).toBe(400)
    expect(noRoot.body.error).toBe('restore_failed')
  })

  test('POST restore requires the daemon token', async () => {
    const { base } = await listen()
    seedTask('task-1')

    const res = await post(base, '/tasks/task-1/restore', { root: workspace })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('unauthorized')
  })
})

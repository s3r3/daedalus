import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-tailor-server-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-tailor-ws-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const a = 1\n')
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

describe('tailor suite server endpoints', () => {
  test('workspace pins GET/PUT round-trip persists .daedalus/pins.json', async () => {
    const { base, root } = await listen()
    const initial = await fetch(new URL(`/workspace/pins?root=${encodeURIComponent(root)}`, base))
    expect(initial.status).toBe(200)
    expect(((await initial.json()) as { pins: string[] }).pins).toEqual([])

    const saved = await fetch(new URL('/workspace/pins', base), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, pins: ['src/index.ts', '../escape', '/abs', 'src/index.ts'] }),
    })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { pins: string[] }).pins).toEqual(['src/index.ts'])
    expect(existsSync(join(root, '.daedalus', 'pins.json'))).toBe(true)

    const reread = await fetch(new URL(`/workspace/pins?root=${encodeURIComponent(root)}`, base))
    expect(((await reread.json()) as { pins: string[] }).pins).toEqual(['src/index.ts'])

    // Missing root follows the other workspace endpoints: default workspace.
    const defaulted = await fetch(new URL('/workspace/pins', base))
    expect(defaulted.status).toBe(200)
  })

  test('tailor toggles update through POST /settings and show on GET /settings', async () => {
    const { base } = await listen()
    const before = await (await fetch(new URL('/settings', base))).json() as { settings?: { tailor?: { reviewGate?: boolean } } }
    expect(before.settings?.tailor?.reviewGate).toBe(false)

    const updated = await fetch(new URL('/settings', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tailor: { reviewGate: true, modelRouting: false } }),
    })
    expect(updated.status).toBe(200)

    const after = await (await fetch(new URL('/settings', base))).json() as { settings?: { tailor?: { reviewGate?: boolean; modelRouting?: boolean } } }
    expect(after.settings?.tailor?.reviewGate).toBe(true)
    expect(after.settings?.tailor?.modelRouting).toBe(false)
  })
})

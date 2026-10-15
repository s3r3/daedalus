import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
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
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function listen() {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-prov-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-prov-ws-'))
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
  return `http://127.0.0.1:${port}`
}

describe('GET /providers registry location', () => {
  test('exposes the store path and presets so empty lists are explainable', async () => {
    const base = await listen()
    const res = await fetch(new URL('/providers', base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: unknown[]; presets: Array<{ id: string }>; home: string }
    expect(body.providers).toEqual([])
    expect(body.home).toMatch(/providers\.json$/)
    expect(body.presets.map((p) => p.id)).toContain('nine-router')
  })

  test('a newly added provider shows up in the same list', async () => {
    const base = await listen()
    const created = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'manual', name: 'Manual', baseUrl: 'https://example.com/v1', apiKey: 'k', models: ['m'] }),
    })
    expect(created.status).toBe(201)
    const listed = (await (await fetch(new URL('/providers', base))).json()) as { providers: Array<{ id: string }> }
    expect(listed.providers.map((p) => p.id)).toContain('manual')
  })
})

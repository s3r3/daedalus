import { afterEach, describe, expect, test } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * Fase C — Fitur Dokumen Dae Captain v2 (desain 4.1–4.3 + Q&A dokumen)
 * di permukaan HTTP: semua route di sini deterministik (tanpa LLM),
 * jadi tidak butuh fake provider.
 */

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
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-fasec-srv-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-fasec-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

async function req(base: string, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> }
  } catch {
    return { status: res.status, body: { raw: text } }
  }
}

describe('Fase C1 — GET /dokumen/doc-templates (desain 4.1)', () => {
  test('returns the 4 built-in templates with sections', async () => {
    const { base, root } = await listen()
    const got = await req(base, 'GET', `/dokumen/doc-templates?root=${encodeURIComponent(root)}`)
    expect(got.status).toBe(200)
    const templates = got.body.templates as Array<{ id: string; name: string; sections: Array<{ title: string; contentPrompt: string }> }>
    expect(templates).toHaveLength(4)
    expect(templates.map((t) => t.id).sort()).toEqual(['laporan', 'makalah', 'proposal', 'surat-resmi'])
    for (const t of templates) {
      expect(t.sections.length).toBeGreaterThanOrEqual(5)
      for (const s of t.sections) {
        expect(s.title.trim().length).toBeGreaterThan(0)
        expect(s.contentPrompt.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

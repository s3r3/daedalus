import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'
import { listFilesFlat } from '../src/workspace.ts'

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
  const root = mkdtempSync(join(tmpdir(), 'daedalus-files-ws-'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'daedalus-web', 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'deep', 'nested.ts'), 'export const b = 2\n')
  writeFileSync(join(root, 'daedalus-web', 'src', 'app.tsx'), 'export const App = () => null\n')
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = {}\n')
  writeFileSync(join(root, 'dist', 'bundle.js'), 'void 0\n')
  writeFileSync(join(root, '.hidden.txt'), 'secret\n')
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  return root
}

async function listen(): Promise<{ base: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-files-state-'))
  workspace = makeWorkspace()
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}` }
}

describe('GET /workspace/files (flat @-mention index)', () => {
  test('returns sorted relative file and dir entries for the workspace', async () => {
    const { base } = await listen()
    const res = await fetch(new URL(`/workspace/files?root=${encodeURIComponent(workspace!)}`, base))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { root: string; files: Array<{ path: string; type: string }>; truncated: boolean }
    expect(body.truncated).toBe(false)
    const byPath = new Map(body.files.map((entry) => [entry.path, entry.type]))
    expect(byPath.get('README.md')).toBe('file')
    expect(byPath.get('src')).toBe('dir')
    expect(byPath.get('src/deep')).toBe('dir')
    expect(byPath.get('src/index.ts')).toBe('file')
    expect(byPath.get('src/deep/nested.ts')).toBe('file')
    expect(byPath.get('daedalus-web/src/app.tsx')).toBe('file')
    const paths = body.files.map((entry) => entry.path)
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)))
  })

  test('excludes ignored directories and hidden entries', async () => {
    const { base } = await listen()
    const res = await fetch(new URL(`/workspace/files?root=${encodeURIComponent(workspace!)}`, base))
    const body = (await res.json()) as { files: Array<{ path: string }> }
    const paths = body.files.map((entry) => entry.path)
    for (const banned of ['node_modules', '.git', '.github', 'dist', '.hidden.txt', '.daedalus']) {
      expect(paths.some((path) => path === banned || path.startsWith(`${banned}/`))).toBe(false)
    }
  })

  test('rejects roots outside the allowed workspaces', async () => {
    const { base } = await listen()
    const outside = mkdtempSync(join(tmpdir(), 'daedalus-files-outside-'))
    try {
      const res = await fetch(new URL(`/workspace/files?root=${encodeURIComponent(outside)}`, base))
      expect(res.status).toBe(403)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('listFilesFlat', () => {
  test('caps entries and reports truncation', () => {
    const root = makeWorkspace()
    try {
      const capped = listFilesFlat(root, 3)
      expect(capped.files).toHaveLength(3)
      expect(capped.truncated).toBe(true)
      const full = listFilesFlat(root)
      expect(full.truncated).toBe(false)
      expect(full.files.length).toBeGreaterThan(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

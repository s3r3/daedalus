import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, loadSkillConfig } from '@daedalus/core'
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

function writeSkill(root: string, name: string, description: string): void {
  const dir = join(workspace!, '.daedalus', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.`)
}

async function listen(): Promise<string> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-toggle-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-toggle-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

type SkillEntry = { name: string; origin: string; disabled: boolean; shadowedBy?: string }

async function statusSkills(base: string): Promise<SkillEntry[]> {
  const res = await fetch(new URL(`/extensions/status?root=${encodeURIComponent(workspace!)}`, base))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { skills: SkillEntry[] }
  return body.skills
}

async function toggle(base: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL('/extensions/skills/toggle', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('per-workspace skill toggling', () => {
  test('status lists skills with disabled=false, and the toggle persists to .daedalus/skills.json the core reads', async () => {
    const base = await listen()
    writeSkill(workspace!, 'deploy', 'Deploy the thing')

    const before = await statusSkills(base)
    expect(before.find((skill) => skill.name === 'deploy')).toMatchObject({ origin: 'workspace', disabled: false })

    const toggled = await toggle(base, { root: workspace!, name: 'deploy', disabled: true })
    expect(toggled.status).toBe(200)
    expect(toggled.body).toMatchObject({ name: 'deploy', disabled: true })

    // The core reader (the loader's own config path) sees the same state.
    await expect(loadSkillConfig(workspace!)).resolves.toEqual({ disabled: ['deploy'] })

    const after = await statusSkills(base)
    expect(after.find((skill) => skill.name === 'deploy')).toMatchObject({ disabled: true })

    const enabled = await toggle(base, { root: workspace!, name: 'deploy', disabled: false })
    expect(enabled.status).toBe(200)
    await expect(loadSkillConfig(workspace!)).resolves.toEqual({ disabled: [] })
  })

  test('the toggle validates its body and confines root', async () => {
    const base = await listen()
    expect((await toggle(base, { root: workspace!, disabled: true })).status).toBe(400)
    expect((await toggle(base, { root: workspace!, name: 'x' })).status).toBe(400)
    const outside = await toggle(base, { root: '/etc', name: 'x', disabled: true })
    expect(outside.status).toBe(403)
  })

  test('POST /tasks refuses disabled and unknown invoked skills with a named 400, and accepts an enabled one', async () => {
    const base = await listen()
    writeSkill(workspace!, 'deploy', 'Deploy the thing')
    await toggle(base, { root: workspace!, name: 'deploy', disabled: true })

    const create = (skills: string[]) =>
      fetch(new URL('/tasks', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal: 'ship it', repo_path: workspace!, skills }),
      })

    const disabledRes = await create(['deploy'])
    expect(disabledRes.status).toBe(400)
    expect(((await disabledRes.json()) as { error: string }).error).toContain('disabled for this workspace')

    const unknownRes = await create(['ghost'])
    expect(unknownRes.status).toBe(400)
    expect(((await unknownRes.json()) as { error: string }).error).toContain('unknown skill "ghost"')

    await toggle(base, { root: workspace!, name: 'deploy', disabled: false })
    const okRes = await create(['deploy'])
    expect(okRes.status).toBe(201)
    const task = (await okRes.json()) as { skills?: string[] }
    expect(task.skills).toEqual(['deploy'])
  })
})

import { afterEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '@daedalus/core'
import { buildProgram, formatEvent } from '../src/index.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  delete process.env.DAEDALUS_HOME
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('formatEvent additions', () => {
  test('LOOP_WARNING renders tool, repeat count, and the suppressed variant', () => {
    process.env.NO_COLOR = '1'
    const warned = formatEvent({ type: 'LOOP_WARNING', task_id: 't', payload: { tool: 'read_file', repeats: 3, suppressed: false } })
    expect(warned).toContain('Loop warning: read_file repeated 3×')
    expect(warned).not.toContain('suppressed')

    const suppressed = formatEvent({ type: 'LOOP_WARNING', task_id: 't', payload: { tool: 'read_file', repeats: 4, suppressed: true } })
    expect(suppressed).toContain('Loop warning: read_file repeated 4×')
    expect(suppressed).toContain('further repeats suppressed')
    delete process.env.NO_COLOR
  })

  test('TASK_STARTED shows the helper title before the goal when present', () => {
    process.env.NO_COLOR = '1'
    const withTitle = formatEvent({ type: 'TASK_STARTED', task_id: 't', payload: { spec: { goal: 'fix the login crash on startup please', title: 'Fix Login Crash' } } })
    expect(withTitle).toContain('Task: Fix Login Crash — fix the login crash on startup please')
    const without = formatEvent({ type: 'TASK_STARTED', task_id: 't', payload: { spec: { goal: 'plain goal' } } })
    expect(without).toContain('Task: plain goal')
    expect(without).not.toContain('—')
    delete process.env.NO_COLOR
  })
})

describe('restore command', () => {
  test('is registered and listed in help', () => {
    const program = buildProgram()
    expect(program.commands.some((command) => command.name() === 'restore')).toBe(true)
  })

  test('rewinds a task from its recorded checkpoints', async () => {
    const home = tempDir('daedalus-cli-home-')
    const workspace = tempDir('daedalus-cli-ws-')
    const store = new TaskStore(home)
    const taskId = 'task-cli-restore'
    writeFileSync(join(workspace, 'a.txt'), 'original A\n', 'utf8')
    store.recordBackup(taskId, 'a.txt', 'original A\n')
    store.recordBackup(taskId, 'b.txt', null)
    writeFileSync(join(workspace, 'a.txt'), 'edited\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'created\n', 'utf8')

    process.env.DAEDALUS_HOME = home
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      await buildProgram().parseAsync(['node', 'daedalus', 'restore', taskId, '--cwd', workspace])
    } finally {
      spy.mockRestore()
    }
    const out = written.join('')
    expect(out).toContain('restored a.txt')
    expect(out).toContain('deleted b.txt')
    expect(out).toContain('1 restored, 1 deleted')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('original A\n')
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false)
  })
})


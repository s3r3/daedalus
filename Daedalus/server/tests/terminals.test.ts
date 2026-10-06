import { afterEach, describe, expect, test } from 'vitest'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, TaskStore, emitEvent } from '@daedalus/core'
import { WebSocket } from 'ws'
import { createContext, createApp, attachWebSocket, type AppContext, type EventChannel } from '../src/app.ts'
import type { TerminalSessionInfo as TerminalSession } from '../src/terminals.ts'

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let ctx: AppContext | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  ctx?.terminals.dispose()
  channel?.close()
  channel = undefined
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  ctx = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function listen(): Promise<{ base: string; wsUrl: string; ctx: AppContext }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-terminals-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-terminals-ws-'))
  ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/tasks/events`, ctx }
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  for (;;) {
    last = await fn()
    if (predicate(last)) return last
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last=${JSON.stringify(last)?.slice(0, 300)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function createTerminal(base: string, kind?: string): Promise<TerminalSession> {
  const res = await fetch(new URL('/terminals', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: workspace, ...(kind ? { kind } : {}) }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { terminal: TerminalSession }).terminal
}

async function postInput(base: string, id: string, data: string): Promise<number> {
  const res = await fetch(new URL(`/terminals/${id}/input`, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  return res.status
}

async function getOutput(base: string, id: string): Promise<string> {
  const res = await fetch(new URL(`/terminals/${id}`, base))
  expect(res.status).toBe(200)
  return ((await res.json()) as { output: string }).output
}

const TEST_OPTS = 20_000

describe('terminal sessions', () => {
  test(
    'user session runs commands and replays its buffer',
    async () => {
      const { base } = await listen()
      const session = await createTerminal(base)
      expect(session.kind).toBe('user')
      expect(session.status).toBe('running')

      expect(await postInput(base, session.id, 'echo hello-daedalus\n')).toBe(200)
      const output = await waitFor(() => getOutput(base, session.id), (text) => text.includes('hello-daedalus'))
      expect(output).toContain('echo hello-daedalus')

      // Replay: a fresh read of the session returns the earlier lines.
      expect(await getOutput(base, session.id)).toContain('hello-daedalus')
    },
    TEST_OPTS,
  )

  test(
    'a long-running user session is untouched while another session works',
    async () => {
      const { base } = await listen()
      const sleeper = await createTerminal(base)
      const worker = await createTerminal(base)

      expect(await postInput(base, sleeper.id, 'sleep 30\n')).toBe(200)
      expect(await postInput(base, worker.id, 'echo worker-done\n')).toBe(200)
      await waitFor(() => getOutput(base, worker.id), (text) => text.includes('worker-done'))

      const list = (await (await fetch(new URL(`/terminals?root=${encodeURIComponent(workspace!)}`, base))).json()) as { terminals: TerminalSession[] }
      const kinds = list.terminals.map((t) => t.kind).sort()
      expect(kinds).toEqual(['agent', 'user', 'user'])
      expect(list.terminals.find((t) => t.id === sleeper.id)?.status).toBe('running')

      // DELETE kills the sleeper (and only the sleeper) and forgets it.
      const del = await fetch(new URL(`/terminals/${sleeper.id}`, base), { method: 'DELETE' })
      expect(del.status).toBe(200)
      const deleted = (await del.json()) as { killed: boolean; terminal: TerminalSession }
      expect(deleted.killed).toBe(true)
      expect(deleted.terminal.status).toBe('exited')
      await waitFor(
        async () => {
          try {
            process.kill(sleeper.pid!, 0)
            return false
          } catch {
            return true
          }
        },
        (dead) => dead,
      )
      const gone = await fetch(new URL(`/terminals/${sleeper.id}`, base))
      expect(gone.status).toBe(404)
      // The other session is still alive and responsive.
      expect(list.terminals.find((t) => t.id === worker.id)?.status).toBe('running')
      expect(await postInput(base, worker.id, 'echo still-here\n')).toBe(200)
      await waitFor(() => getOutput(base, worker.id), (text) => text.includes('still-here'))
    },
    TEST_OPTS,
  )

  test(
    'agent session is listed per root and refuses input, signals, and deletes',
    async () => {
      const { base } = await listen()
      const agent = await createTerminal(base, 'agent')
      expect(agent.kind).toBe('agent')

      expect(await postInput(base, agent.id, 'echo nope\n')).toBe(403)
      const signal = await fetch(new URL(`/terminals/${agent.id}/signal`, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signal: 'SIGINT' }),
      })
      expect(signal.status).toBe(403)
      const del = await fetch(new URL(`/terminals/${agent.id}`, base), { method: 'DELETE' })
      expect(del.status).toBe(403)

      const list = (await (await fetch(new URL(`/terminals?root=${encodeURIComponent(workspace!)}`, base))).json()) as { terminals: TerminalSession[] }
      expect(list.terminals[0]?.kind).toBe('agent')
    },
    TEST_OPTS,
  )

  test(
    'COMMAND_* events are mirrored into the agent sink',
    async () => {
      const { base, ctx } = await listen()
      const taskId = 'terminal-mirror-task'
      ctx.store.saveState(taskId, { repo_path: workspace, goal: 'mirror me' })

      const target = { bus: ctx.bus, store: ctx.store }
      emitEvent(target, taskId, undefined, 'COMMAND_STARTED', { call_id: 'c1', command: 'echo mirror-hi', tool: 'run_command', cwd: workspace })
      emitEvent(target, taskId, undefined, 'COMMAND_OUTPUT', { call_id: 'c1', chunk: 'mirror-hi\n' })
      emitEvent(target, taskId, undefined, 'COMMAND_FINISHED', { call_id: 'c1', status: 'ok', exit_code: 0, killed: false, truncated: false })
      await ctx.bus.drain()

      const list = (await (await fetch(new URL(`/terminals?root=${encodeURIComponent(workspace!)}`, base))).json()) as { terminals: TerminalSession[] }
      const agent = list.terminals.find((t) => t.kind === 'agent')
      expect(agent).toBeDefined()
      const output = await getOutput(base, agent!.id)
      expect(output).toContain('$ echo mirror-hi')
      expect(output).toContain('mirror-hi')
      expect(output).toContain('[exit 0]')
    },
    TEST_OPTS,
  )

  test(
    'WS terminal_subscribe replays the buffered history on the events socket',
    async () => {
      const { base, wsUrl } = await listen()
      const session = await createTerminal(base)
      expect(await postInput(base, session.id, 'echo replay-me\n')).toBe(200)
      await waitFor(() => getOutput(base, session.id), (text) => text.includes('replay-me'))

      const replayed = await new Promise<string>((resolvePromise, rejectPromise) => {
        const socket = new WebSocket(wsUrl)
        const timer = setTimeout(() => rejectPromise(new Error('no terminal replay received')), 8_000)
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as { kind?: string; session_id?: string; data?: string; replay?: boolean }
          if (message.kind === 'hello') {
            socket.send(JSON.stringify({ kind: 'terminal_subscribe', session_id: session.id }))
            return
          }
          if (message.kind === 'terminal_output' && message.replay === true) {
            clearTimeout(timer)
            socket.close()
            resolvePromise(message.data ?? '')
          }
        })
        socket.on('error', rejectPromise)
      })
      expect(replayed).toContain('replay-me')
    },
    TEST_OPTS,
  )
})

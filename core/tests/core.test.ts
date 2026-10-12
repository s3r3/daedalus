import { describe, expect, onTestFinished, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus, createLogger, loadSettings, redactSettings, TaskStore } from '@daedalus/core'
import type { Event } from '@daedalus/core'

describe('EventBus', () => {
  test('publishes in order to subscribers', async () => {
    const bus = new EventBus()
    const received: string[] = []
    bus.on('TASK_STARTED', (e) => received.push(String(e.seq)))
    bus.on('*', (e) => received.push(`*${e.seq}`))
    const e1: Event = { seq: 1, task_id: 't1', type: 'TASK_STARTED', payload: null, ts: '2026-01-01T00:00:00Z' }
    const e2: Event = { seq: 2, task_id: 't1', type: 'TASK_STARTED', payload: null, ts: '2026-01-01T00:00:01Z' }
    bus.publish(e1)
    bus.publish(e2)
    await bus.drain()
    expect(received).toEqual(['1', '*1', '2', '*2'])
  })

  test('unsubscribes cleanly', async () => {
    const bus = new EventBus()
    const received: string[] = []
    const off = bus.on('TASK_STARTED', (e) => received.push(String(e.seq)))
    off()
    bus.publish({ seq: 1, task_id: 't1', type: 'TASK_STARTED', payload: null, ts: '2026-01-01T00:00:00Z' })
    await bus.drain()
    expect(received).toEqual([])
  })
})

describe('settings', () => {
  test('loads defaults', () => {
    const s = loadSettings({})
    expect(s.llm.baseUrl).toBe('https://llm.ayid.cc.cd/v1')
    expect(s.server.host).toBe('127.0.0.1')
    expect(s.server.port).toBe(3080)
    expect(s.daedalusHome).toBe('.daedalus')
  })

  test('rejects invalid port', () => {
    expect(() => loadSettings({ DAEDALUS_PORT: 'abc' })).toThrow()
    expect(() => loadSettings({ DAEDALUS_PORT: '99999' })).toThrow()
  })

  test('redacts API key', () => {
    const s = loadSettings({ LLM_API_KEY: 'secret' })
    const redacted = redactSettings(s)
    expect(redacted.llm.apiKey).toBe('«redacted»')
  })
})

describe('TaskStore', () => {
  test('append + replay round trip', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'daedalus-core-'))
    const store = new TaskStore(tmp)
    onTestFinished(() => rmSync(tmp, { recursive: true, force: true }))
    const e: Event = { seq: 1, task_id: 't1', type: 'TASK_STARTED', payload: { x: 1 }, ts: '2026-01-01T00:00:00Z' }
    store.append('t1', e)
    expect(store.replay('t1')).toEqual([e])
    store.saveState('t1', { status: 'created' })
    expect(store.loadState('t1')).toEqual({ status: 'created' })
    expect(store.listTasks()).toContain('t1')
  })

  test('eventStats summarizes first/last lines without a full replay; hasEvents stats the file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'daedalus-core-stats-'))
    const store = new TaskStore(tmp)
    onTestFinished(() => rmSync(tmp, { recursive: true, force: true }))

    expect(store.hasEvents('belum-ada')).toBe(false)
    expect(store.eventStats('belum-ada')).toEqual({ count: 0, firstTs: null, lastSeq: 0, lastType: null, lastTs: null })

    store.append('t1', { seq: 1, task_id: 't1', type: 'TASK_STARTED', payload: {}, ts: '2026-01-01T00:00:00Z' })
    store.append('t1', { seq: 2, task_id: 't1', type: 'THOUGHT', payload: { text: 'tengah' }, ts: '2026-01-01T00:01:00Z' })
    store.append('t1', { seq: 3, task_id: 't1', type: 'TASK_COMPLETED', payload: {}, ts: '2026-01-01T00:02:00Z' })

    expect(store.hasEvents('t1')).toBe(true)
    // Matches what a full replay would report for the same fields.
    expect(store.eventStats('t1')).toEqual({
      count: 3,
      firstTs: '2026-01-01T00:00:00Z',
      lastSeq: 3,
      lastType: 'TASK_COMPLETED',
      lastTs: '2026-01-01T00:02:00Z',
    })
    const replayed = store.replay('t1')
    expect(store.eventStats('t1').count).toBe(replayed.length)
  })
})

describe('logger', () => {
  test('filters by level', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'warn', write: (l) => lines.push(l) })
    log.info('skip me')
    log.warn('keep me')
    log.error('also keep')
    expect(lines.some((l) => l.includes('"msg":"keep me"'))).toBe(true)
    expect(lines.some((l) => l.includes('"msg":"skip me"'))).toBe(false)
  })
})
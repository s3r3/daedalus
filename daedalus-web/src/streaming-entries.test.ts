import { describe, expect, test } from 'vitest'
import type { Event } from '@daedalus/core'
import { chatTranscript } from './state/selectors'

/**
 * Live streamed text in the chat: while a turn is in flight its
 * cumulative deltas render as one growing "thinking · live" entry;
 * the moment the turn's finished text exists (THOUGHT or the final
 * reply), the live entry is superseded — never doubled.
 */

const ev = (seq: number, type: string, payload: unknown, turnId?: string): Event =>
  ({ seq, task_id: 'task-1', turn_id: turnId, ts: new Date().toISOString(), type, payload }) as Event

describe('chatTranscript streaming entries', () => {
  test('an in-flight turn renders its latest cumulative text once', () => {
    const events = [
      ev(1, 'TASK_STARTED', { spec: { goal: 'build it' } }),
      ev(2, 'MODEL_TEXT_DELTA', { text: 'Scaf' }, 'turn-1'),
      ev(3, 'MODEL_TEXT_DELTA', { text: 'Scaffolding the app' }, 'turn-1'),
    ] as Event[]
    const entries = chatTranscript(events)
    const live = entries.filter((entry) => entry.status === 'running')
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ role: 'thought', text: 'Scaffolding the app' })
  })

  test('the finished THOUGHT supersedes the live entry', () => {
    const events = [
      ev(1, 'MODEL_TEXT_DELTA', { text: 'Scaffolding the app' }, 'turn-1'),
      ev(2, 'THOUGHT', { text: 'Scaffolding the app', source: 'assistant_tool_call_content' }, 'turn-1'),
      ev(3, 'TOOL_CALL_STARTED', { call: { id: 'c1', task_id: 'task-1', tool: 'run_command', args: {} } }, 'turn-1'),
    ] as Event[]
    const entries = chatTranscript(events)
    expect(entries.filter((entry) => entry.role === 'thought')).toHaveLength(1)
    expect(entries.some((entry) => entry.status === 'running' && entry.role === 'thought')).toBe(false)
  })

  test('the final reply supersedes the live entry', () => {
    const events = [
      ev(1, 'MODEL_TEXT_DELTA', { text: 'All done — the page builds.' }, 'turn-2'),
      ev(2, 'MODEL_REQUEST_FINISHED', { message: { content: 'All done — the page builds.' } }, 'turn-2'),
    ] as Event[]
    const entries = chatTranscript(events)
    expect(entries.filter((entry) => entry.role === 'assistant')).toHaveLength(1)
    expect(entries.some((entry) => entry.status === 'running')).toBe(false)
  })

  test('thinking off hides live entries too', () => {
    const events = [ev(1, 'MODEL_TEXT_DELTA', { text: 'working…' }, 'turn-1')] as Event[]
    expect(chatTranscript(events, false).some((entry) => entry.status === 'running')).toBe(false)
  })
})

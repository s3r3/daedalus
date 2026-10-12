/**
 * Chat transcript dedupe: the loop emits a tool-call turn's prose twice
 * (THOUGHT with source assistant_tool_call_content + the same text in
 * MODEL_REQUEST_FINISHED.message.content), which rendered every
 * <plan>/<notes> block 2–3× in Farid's transcripts. The chat keeps the
 * thought entry and skips the duplicate reply entry.
 */
import { describe, expect, test } from 'vitest'
import type { Event } from '@daedalus/core'
import { chatTranscript } from './state/selectors'

let seq = 0
function ev(type: string, payload: unknown, turnId?: string): Event {
  seq += 1
  return { seq, task_id: 'task-1', ts: new Date().toISOString(), type, payload, ...(turnId ? { turn_id: turnId } : {}) } as Event
}

const PROSE = '<plan>\n1. find a photo\n2. download it\n</plan>'

describe('chatTranscript prose dedupe', () => {
  test('a tool-call thought and its identical reply render once (as the thought)', () => {
    const entries = chatTranscript([
      ev('THOUGHT', { text: PROSE, source: 'assistant_tool_call_content' }, 'turn-1'),
      ev('MODEL_REQUEST_FINISHED', { message: { content: PROSE } }, 'turn-1'),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ role: 'thought', text: PROSE })
  })

  test('a thought that is a prefix of the reply (truncated thought) still dedupes', () => {
    const entries = chatTranscript([
      ev('THOUGHT', { text: '<notes>short</notes>', source: 'assistant_tool_call_content' }, 'turn-1'),
      ev('MODEL_REQUEST_FINISHED', { message: { content: '<notes>short</notes> and the rest of the reply' } }, 'turn-1'),
    ])
    expect(entries.map((entry) => entry.role)).toEqual(['thought'])
  })

  test('reasoning-sourced thoughts keep both entries', () => {
    const entries = chatTranscript([
      ev('THOUGHT', { text: 'thinking about the photo', source: 'reasoning' }, 'turn-1'),
      ev('MODEL_REQUEST_FINISHED', { message: { content: 'Here is the plan.' } }, 'turn-1'),
    ])
    expect(entries.map((entry) => entry.role)).toEqual(['thought', 'assistant'])
  })

  test('with thinking hidden, the reply entry is the only prose — never dropped', () => {
    const entries = chatTranscript(
      [
        ev('THOUGHT', { text: PROSE, source: 'assistant_tool_call_content' }, 'turn-1'),
        ev('MODEL_REQUEST_FINISHED', { message: { content: PROSE } }, 'turn-1'),
      ],
      false,
    )
    expect(entries.map((entry) => entry.role)).toEqual(['assistant'])
  })

  test('a final answer with no thought renders as before', () => {
    const entries = chatTranscript([ev('MODEL_REQUEST_FINISHED', { message: { content: 'All done.' } }, 'turn-9')])
    expect(entries.map((entry) => entry.role)).toEqual(['assistant'])
  })
})

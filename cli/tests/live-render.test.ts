import { describe, expect, test } from 'vitest'
import type { Event } from '@daedalus/core'
import { formatEvent } from '../src/index.ts'
import { DeltaSuffixTracker, SPINNER_FRAMES, scrambleText, spinnerGlyph, tokenSummary } from '../src/live-render.ts'

function event(partial: Partial<Event> & { type: Event['type'] }): Event {
  return { seq: 1, task_id: 't1', ts: new Date().toISOString(), payload: {}, ...partial }
}

describe('tokenSummary', () => {
  test('formats the Web footer line with separators', () => {
    expect(tokenSummary({ tokens_input: 91065, tokens_output: 2263, tokens_total: 93328, model_requests: 6 }))
      .toBe('tokens 91,065 in · 2,263 out · 93,328 total · 6 requests')
  })

  test('undefined when nothing was reported', () => {
    expect(tokenSummary({})).toBeUndefined()
    expect(tokenSummary({ tokens_total: 0, model_requests: 3 })).toBeUndefined()
  })

  test('omits the request count when unknown', () => {
    expect(tokenSummary({ tokens_input: 5, tokens_output: 7, tokens_total: 12 })).toBe('tokens 5 in · 7 out · 12 total')
  })
})

describe('DeltaSuffixTracker', () => {
  test('prints only the new suffix of each cumulative delta', () => {
    const tracker = new DeltaSuffixTracker()
    expect(tracker.push(event({ type: 'MODEL_TEXT_DELTA', turn_id: 'turn-1', payload: { text: 'Hel' } }))).toBe('Hel')
    expect(tracker.push(event({ type: 'MODEL_TEXT_DELTA', turn_id: 'turn-1', payload: { text: 'Hello' } }))).toBe('lo')
    expect(tracker.push(event({ type: 'MODEL_TEXT_DELTA', turn_id: 'turn-1', payload: { text: 'Hello' } }))).toBe('')
    expect(tracker.currentText).toBe('Hello')
  })

  test('a new turn starts fresh; non-delta events are ignored', () => {
    const tracker = new DeltaSuffixTracker()
    tracker.push(event({ type: 'MODEL_TEXT_DELTA', turn_id: 'turn-1', payload: { text: 'abc' } }))
    expect(tracker.push(event({ type: 'MODEL_TEXT_DELTA', turn_id: 'turn-2', payload: { text: 'xy' } }))).toBe('xy')
    expect(tracker.push(event({ type: 'THOUGHT', payload: { text: 'abc' } }))).toBe('')
    tracker.reset()
    expect(tracker.currentText).toBe('')
  })
})


describe('formatEvent parity cases', () => {
  test('events the CLI used to drop now render one honest line', () => {
    expect(formatEvent(event({ type: 'REPLAN_CREATED', payload: { reason: 'validation_failed', plan: { steps: [{}, {}] } } })))
      .toContain('Replan (validation_failed): 2 steps')
    expect(formatEvent(event({ type: 'REVIEW_COMPLETED', payload: { model: 'strong-1', findings: [{}, {}], blocking: 1 } })))
      .toContain('Review by strong-1: 2 findings (1 blocking)')
    expect(formatEvent(event({ type: 'TAILOR_ESCALATED', payload: { reason: 'loop_warning', to_model: 'strong-1' } })))
      .toContain('Escalated to stronger model (strong-1): loop_warning')
    expect(formatEvent(event({ type: 'MODEL_REQUEST_FAILED', payload: { error: 'boom', error_kind: 'timeout', model: 'm1' } })))
      .toContain('Model request failed (m1) [timeout]: boom')
  })

  test('lifecycle and delta events stay silent in formatEvent', () => {
    expect(formatEvent(event({ type: 'MODEL_TEXT_DELTA', payload: { text: 'streamed' } }))).toBe('')
    expect(formatEvent(event({ type: 'MODEL_REQUEST_FINISHED', payload: {} }))).toBe('')
    expect(formatEvent(event({ type: 'APPROVAL_DECIDED', payload: {} }))).toBe('')
  })

  test('child task lines carry tokens when the child reported them', () => {
    const withTokens = formatEvent(event({
      type: 'CHILD_TASK_FINISHED',
      payload: { child: { status: 'done', result_summary: 'wrote file', usage: { total_tokens: 1200 } } },
    }))
    expect(withTokens).toContain('Child task done: wrote file · 1,200 tokens')
    const without = formatEvent(event({
      type: 'CHILD_TASK_FINISHED',
      payload: { child: { status: 'done', result_summary: 'wrote file' } },
    }))
    expect(without).not.toContain('tokens')
  })
})

describe('spinner + scramble (design tokens)', () => {
  test('frames are the Web motion token, byte for byte', () => {
    expect(SPINNER_FRAMES).toBe('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏')
    expect(spinnerGlyph(0)).toBe('⠋')
    expect(spinnerGlyph(1)).toBe('⠙')
    expect(spinnerGlyph(10)).toBe('⠋')
    expect(spinnerGlyph(-1)).toBe('⠏')
  })

  test('scramble resolves left-to-right and holds the settled label', () => {
    const zero = () => 0 // rng pinned: glyph is always 'A'
    expect(scrambleText('thinking', 0, zero)).toBe('AAAAAAAA')
    expect(scrambleText('thinking', 2, zero)).toBe('tAAAAAAA')
    expect(scrambleText('thinking', 99, zero)).toBe('thinking')
    expect(scrambleText('a b.c', 0, zero)).toBe('A A.A')
  })
})



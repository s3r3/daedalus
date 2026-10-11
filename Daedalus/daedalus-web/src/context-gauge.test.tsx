import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Event } from '@daedalus/core'
import { useDaedalusStore } from './state/taskStore'
import type { ProviderPublic } from './api/types'
import { ContextGauge } from './components/agent/context-gauge'

/**
 * Context gauge: the newest model request's own meter (real, from the
 * recorded payload), the provider-reported context window when known,
 * and the cumulative token roll-up. No meter → tokens with no
 * percentage, never an invented one. No requests → no gauge at all.
 */

let seq = 0

function ev(type: string, payload: unknown): Event {
  seq += 1
  return { seq, task_id: 'task-1', ts: new Date().toISOString(), type, payload } as Event
}

const finished = (overrides: Record<string, unknown> = {}): Event =>
  ev('MODEL_REQUEST_FINISHED', {
    message: { content: 'done' },
    usage: { prompt_tokens: 8000, completion_tokens: 2000, total_tokens: 10000 },
    context_percent: 40,
    context_limit_tokens: 20000,
    model: 'kr/auto',
    ...overrides,
  })

beforeEach(() => {
  seq = 0
  useDaedalusStore.setState({
    taskId: 'task-1',
    events: [],
    session: { mode: 'auto', autoApprove: false, thinkingLevel: 'medium', workspaceRoot: '/workspace', model: 'kr/auto' },
    providers: [
      {
        id: 'kr',
        name: 'Kimi Router',
        baseUrl: 'https://example.invalid',
        models: ['kr/auto'],
        enabled: true,
        hasApiKey: true,
        contextWindows: { 'kr/auto': 200000 },
      } as ProviderPublic,
    ],
  })
})

afterEach(() => cleanup())

describe('ContextGauge', () => {
  test('renders nothing when the task made no model requests', () => {
    render(<ContextGauge />)
    expect(screen.queryByTestId('context-gauge')).toBeNull()
  })

  test('shows the reported percentage, the known window, and real token counts', () => {
    useDaedalusStore.setState({ events: [finished()] })
    render(<ContextGauge />)
    expect(screen.getByTestId('context-gauge-label').textContent).toContain('ctx 40%')
    expect(screen.getByTestId('context-gauge-tokens').textContent).toContain('10,000 tokens / 200,000')
  })

  test('uses the newest request meter, not the oldest', () => {
    useDaedalusStore.setState({
      events: [finished({ context_percent: 10, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }), finished({ context_percent: 75 })],
    })
    render(<ContextGauge />)
    expect(screen.getByTestId('context-gauge-label').textContent).toContain('ctx 75%')
  })

  test('with no reported meter it shows tokens but no percentage', () => {
    useDaedalusStore.setState({ events: [ev('MODEL_REQUEST_FINISHED', { message: { content: 'done' } })] })
    render(<ContextGauge />)
    expect(screen.getByTestId('context-gauge-label').textContent).toContain('ctx —')
    expect(screen.getByTestId('context-gauge-tokens').textContent).toBe('0 tokens / 200,000')
  })

  test('without a known window it shows tokens with no window', () => {
    useDaedalusStore.setState({ events: [finished({ model: 'unknown-model' })] })
    render(<ContextGauge />)
    expect(screen.getByTestId('context-gauge-label').textContent).toContain('ctx 40%')
    expect(screen.getByTestId('context-gauge-tokens').textContent).toBe('10,000 tokens')
  })
})

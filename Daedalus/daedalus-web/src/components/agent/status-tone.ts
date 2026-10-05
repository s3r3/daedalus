import type { TaskStatus } from '../../state/selectors'

export type { TaskStatus }

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'primary' | 'secondary'

/** Single mapping from task status to token tones; panels never pick colors. */
export const STATUS_TONE: Record<TaskStatus, Tone> = {
  idle: 'neutral',
  running: 'info',
  'awaiting-approval': 'warning',
  done: 'success',
  partial: 'warning',
  failed: 'error',
}

export const RESULT_TONE: Record<string, Tone> = {
  ok: 'success',
  pass: 'success',
  error: 'error',
  fail: 'error',
  denied: 'warning',
  timeout: 'warning',
  running: 'info',
  skipped: 'neutral',
}

export const KIND_TONE: Record<string, Tone> = {
  thought: 'info',
  action: 'primary',
  observation: 'success',
  plan: 'secondary',
  validation: 'info',
  recovery: 'warning',
  approval: 'warning',
  file: 'success',
  completion: 'success',
  error: 'error',
  system: 'info',
  attachment: 'secondary',
  orchestration: 'secondary',
}

export function toneForResult(status: string | undefined): Tone {
  return RESULT_TONE[status ?? ''] ?? 'neutral'
}
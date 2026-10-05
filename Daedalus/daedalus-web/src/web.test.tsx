import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import { getPalette } from '@daedalus/core/palette'
import type { Event } from '@daedalus/core'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Spinner } from './components/common/spinner'
import { SPINNER_FRAMES } from './theme/motion-tokens'
import { Panel, EmptyState, ErrorState } from './components/common/panel'
import { STATUS_TONE, RESULT_TONE, KIND_TONE, toneForResult } from './components/agent/status-tone'
import { fileChanges, planSteps, pendingApprovals, toolCalls } from './state/selectors'

const SRC = join(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry) || entry === 'setupTests.ts') return []
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

/** §3.4: colors come from theme tokens only, never from a literal in a component. */
describe('style check (§3.4)', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8')
    source.split('\n').forEach((line, i) => {
      if (/#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(/.test(line)) offenders.push(`${file.split('/').pop()}:${i + 1}`)
    })
  }

  test('no component hardcodes a color literal', () => {
    expect(offenders).toEqual([])
  })

  test('the working gradient has a consumer, not just a declaration', () => {
    // The reference paints the in-flight indicator with the working gradient.
    // The tokens exist in the palette and in index.css, so a rule that never
    // reads them would leave the working state colorless without any test
    // failing — which is exactly the drift this check exists to catch.
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    const styles = readFileSync(join(SRC, 'styles/motion.css'), 'utf8')
    for (const alias of ['--color-working-grad-from', '--color-working-grad-to']) {
      expect(css).toContain(`${alias}:`)
      expect(styles).toContain(`var(${alias})`)
    }
  })

  test('index.css declares both themes and mirrors the core palette', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    expect(css).toContain('[data-theme=')

    // Every `--daedalus-<key>` the web reads must resolve to a hex that matches
    // the shared core palette, in both themes. A hex here is the first-paint
    // fallback before applyPaletteVars() runs, so a mismatch would mean the two
    // interfaces paint different colors from the same theme.
    const lightStart = css.indexOf("[data-theme='daedalus-light']")
    const themeBlocks: Array<[('dark' | 'light'), string]> = [
      ['dark', css.slice(0, lightStart)],
      ['light', css.slice(lightStart, css.indexOf('@theme inline'))],
    ]

    for (const [name, block] of themeBlocks) {
      const palette = getPalette(name) as Record<string, string>
      const inBlock = [...block.matchAll(/--daedalus-([A-Za-z]+),\s*(#[0-9a-f]{6})\)/g)]
      expect(inBlock.length).toBeGreaterThan(0)
      for (const [, key, hex] of inBlock) {
        expect(`${key}:${hex}`).toBe(`${key}:${palette[key]}`)
      }
    }
  })

  test('the core palette covers every token the web mirrors', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8')
    const palette = getPalette('dark') as Record<string, string>
    const keys = new Set([...css.matchAll(/--daedalus-([A-Za-z]+)/g)].map((match) => match[1]))
    for (const key of keys) expect(Object.keys(palette)).toContain(key)
  })
})

describe('token-driven primitives', () => {
  test('Badge renders a token tone', () => {
    render(<Badge tone="success">ok</Badge>)
    expect(screen.getByText('ok').className).toContain('border-success')
  })

  test('Button renders a token variant', () => {
    render(<Button variant="danger">deny</Button>)
    expect(screen.getByText('deny').className).toContain('bg-error')
  })

  test('Spinner is one shared glyph cycle', () => {
    render(<Spinner label="thinking" />)
    expect(SPINNER_FRAMES).toBe('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏')
    expect(screen.getByRole('status', { name: 'thinking' }).textContent).toBe(SPINNER_FRAMES[0])
  })
})

describe('panels and states', () => {
  test('Panel renders title, action, and body', () => {
    render(
      <Panel title="timeline" action={<span>act</span>}>
        <EmptyState title="nothing yet" hint="run a task" />
      </Panel>,
    )
    expect(screen.getByText('timeline')).toBeTruthy()
    expect(screen.getByText('act')).toBeTruthy()
    expect(screen.getByText('nothing yet')).toBeTruthy()
  })

  test('ErrorState exposes an alert and a retry affordance', () => {
    let retried = 0
    render(<ErrorState title="stream failed" message="socket closed" onRetry={() => retried++} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    screen.getByText('retry').click()
    expect(retried).toBe(1)
  })
})

describe('status tone mapping', () => {
  test('every task status resolves to a tone', () => {
    for (const status of Object.keys(STATUS_TONE) as Array<keyof typeof STATUS_TONE>) {
      expect(STATUS_TONE[status]).toBeTruthy()
    }
    expect(STATUS_TONE['awaiting-approval']).toBe('warning')
    expect(STATUS_TONE.done).toBe('success')
    expect(STATUS_TONE.failed).toBe('error')
  })

  test('tool results and timeline kinds map to tones', () => {
    expect(toneForResult('ok')).toBe('success')
    expect(toneForResult('denied')).toBe('warning')
    expect(toneForResult('timeout')).toBe('warning')
    expect(toneForResult('nonsense')).toBe('neutral')
    expect(RESULT_TONE.pass).toBe('success')
    expect(KIND_TONE.validation).toBe('info')
    expect(KIND_TONE.recovery).toBe('warning')
  })
})

const ev = (seq: number, type: string, payload: unknown): Event =>
  ({ seq, task_id: 'task-1', type, payload, ts: seq }) as unknown as Event

describe('selectors derive state from the event log', () => {
  test('plan steps come from PLAN_CREATED', () => {
    const events = [
      ev(1, 'PLAN_CREATED', {
        plan: { id: 'p1', task_id: 'task-1', version: 1, status: 'active', steps: [{ id: 's1', intent: 'inspect', status: 'done', evidence: [] }] },
      }),
    ]
    const steps = planSteps(events)
    expect(steps).toHaveLength(1)
    expect(steps[0].intent).toBe('inspect')
  })

  test('fileChanges keeps the latest event per path', () => {
    const events = [
      ev(1, 'FILE_CHANGED', { call_id: 'c1', path: 'a.ts', tool: 'write_file', operation: 'modified', added: 2, removed: 1, lines: [{ kind: 'add', text: 'x' }], patch: '' }),
      ev(2, 'FILE_CHANGED', { call_id: 'c2', path: 'a.ts', tool: 'edit_file', operation: 'modified', added: 3, removed: 0, lines: [{ kind: 'add', text: 'y' }], patch: '' }),
      ev(3, 'FILE_CHANGED', { call_id: 'c3', path: 'b.ts', tool: 'write_file', operation: 'created', added: 1, removed: 0, lines: [{ kind: 'add', text: 'z' }], patch: '' }),
    ]
    const changes = fileChanges(events)
    expect(changes).toHaveLength(2)
    expect(changes.find((c) => c.path === 'a.ts')?.call_id).toBe('c2')
    expect(changes.find((c) => c.path === 'b.ts')?.operation).toBe('created')
  })

  test('tool calls pair each start with its result', () => {
    const events = [
      ev(1, 'TOOL_CALL_STARTED', { call: { id: 'c1', task_id: 'task-1', tool: 'read_file', args: { path: 'a.ts' } } }),
      ev(2, 'TOOL_CALL_FINISHED', {
        call: { id: 'c1', task_id: 'task-1', tool: 'read_file', args: {} },
        result: { call_id: 'c1', status: 'ok', output: 'contents', truncated: false, meta: {} },
      }),
    ]
    const calls = toolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0].result?.status).toBe('ok')
  })

  test('an approval request stays pending until a decision arrives', () => {
    const key = { taskId: 'task-1', tool: 'write_file', action: 'write' as const, path: 'a.ts' }
    const requested = [ev(1, 'APPROVAL_REQUESTED', { key, policy: 'ask' })]
    expect(pendingApprovals(requested)).toHaveLength(1)

    const decided = [...requested, ev(2, 'APPROVAL_DECIDED', { key, decision: 'grant', remember: false })]
    expect(pendingApprovals(decided)).toHaveLength(0)
  })

  test('an empty log yields empty derivations', () => {
    expect(fileChanges([])).toHaveLength(0)
    expect(toolCalls([])).toHaveLength(0)
    expect(pendingApprovals([])).toHaveLength(0)
  })
})
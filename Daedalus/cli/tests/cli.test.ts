import { afterEach, describe, expect, test, vi } from 'vitest'
import { approvalPreviewLine, buildProgram, formatEvent, makeSigintHandler, parseApproval, parsePositiveInt, parseQuestionAnswer, questionPromptText } from '../src/index.ts'
import { VERSION } from '@daedalus/core'
import { exitCodeFor } from '@daedalus/core'

describe('CLI', () => {
  test('--version prints core version', () => {
    const program = buildProgram()
    program.exitOverride()
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      expect(() => program.parse(['node', 'daedalus', '--version'])).toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(written.join('').trim()).toBe(VERSION)
  })

  test('--help lists commands', () => {
    const program = buildProgram()
    program.exitOverride()
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      expect(() => program.parse(['node', 'daedalus', '--help'])).toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(written.join('')).toContain('Usage:')
    expect(written.join('')).toContain('health')
    expect(written.join('')).toContain('run')
    expect(written.join('')).toContain('serve')
    expect(written.join('')).toContain('status')
    expect(written.join('')).toContain('stop')
    expect(written.join('')).toContain('chat')
    expect(written.join('')).toContain('ask')
  })

  test('run help lists execution options', () => {
    const program = buildProgram()
    program.exitOverride()
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      expect(() => program.parse(['node', 'daedalus', 'run', '--help'])).toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(written.join('')).toContain('--json')
    expect(written.join('')).toContain('--yolo')
    expect(written.join('')).toContain('--max-iterations')
  })

  test('run command exists', () => {
    const program = buildProgram()
    expect(program.commands.some((command) => command.name() === 'run')).toBe(true)
  })
})

  describe('parseApproval', () => {
    test('"a" grants without remember', () => {
      expect(parseApproval('a')).toEqual({ decision: 'grant', remember: false })
    })
    test('"A" grants without remember', () => {
      expect(parseApproval('A')).toEqual({ decision: 'grant', remember: false })
    })
    test('"r" grants with remember', () => {
      expect(parseApproval('r')).toEqual({ decision: 'grant', remember: true })
    })
    test('"R " grants with remember', () => {
      expect(parseApproval('R ')).toEqual({ decision: 'grant', remember: true })
    })
    test('"d" denies', () => {
      expect(parseApproval('d')).toEqual({ decision: 'deny', remember: false })
    })
    test('"" denies', () => {
      expect(parseApproval('')).toEqual({ decision: 'deny', remember: false })
    })
    test('"x" denies', () => {
      expect(parseApproval('x')).toEqual({ decision: 'deny', remember: false })
    })
  })

  describe('parseQuestionAnswer', () => {
    const options = [{ label: 'Website e-commerce' }, { label: 'Website e-learning' }, { label: 'Blog' }]

    test('a bare number selects that option label', () => {
      expect(parseQuestionAnswer('2', options)).toBe('Website e-learning')
      expect(parseQuestionAnswer(' 1 ', options)).toBe('Website e-commerce')
    })

    test('an out-of-range number is the user\'s own text, not an option', () => {
      expect(parseQuestionAnswer('7', options)).toBe('7')
      expect(parseQuestionAnswer('0', options)).toBe('0')
    })

    test('anything else passes through verbatim as free text', () => {
      expect(parseQuestionAnswer('Portfolio pribadi untuk fotografi', options)).toBe('Portfolio pribadi untuk fotografi')
      expect(parseQuestionAnswer('2 tapi dark mode', options)).toBe('2 tapi dark mode')
    })

    test('empty input abstains so the caller can re-prompt', () => {
      expect(parseQuestionAnswer('', options)).toBeNull()
      expect(parseQuestionAnswer('   ', options)).toBeNull()
    })
  })

  describe('question rendering', () => {
    test('QUESTION_REQUESTED prints the question with numbered options', () => {
      const out = formatEvent({
        type: 'QUESTION_REQUESTED',
        task_id: 't',
        payload: {
          question: {
            id: 'q-1', taskId: 't', question: 'Website ini untuk apa?', createdAt: '',
            allowFreeText: true,
            options: [{ label: 'Toko online', description: 'Jual produk' }, { label: 'Kursus' }],
          },
        },
      })
      expect(out).toContain('Website ini untuk apa?')
      expect(out).toContain('1. Toko online — Jual produk')
      expect(out).toContain('2. Kursus')
      expect(out).toContain('reply with a number, or type your own answer')
    })

    test('allowFreeText=false drops the free-text hint', () => {
      const text = questionPromptText({ question: 'Stack?', options: [{ label: 'React' }], allowFreeText: false })
      expect(text).toContain('reply with a number')
      expect(text).not.toContain('type your own')
    })

    test('QUESTION_ANSWERED renders the receipt, timeout, and cancellation', () => {
      expect(formatEvent({ type: 'QUESTION_ANSWERED', task_id: 't', payload: { outcome: 'answered', answer: 'Kursus' } })).toContain('You answered: Kursus')
      expect(formatEvent({ type: 'QUESTION_ANSWERED', task_id: 't', payload: { outcome: 'timeout', timed_out: true } })).toContain('continues with stated assumptions')
      expect(formatEvent({ type: 'QUESTION_ANSWERED', task_id: 't', payload: { outcome: 'cancelled', cancelled: true } })).toContain('cancelled')
    })
  })

  describe('tool result rendering', () => {
    test('TOOL_CALL_FINISHED renders the view_image placeholder line, never base64', () => {
      // The loop strips the image bytes before emitting, so the event —
      // and therefore this transcript line — only ever carries the
      // one-line placeholder text.
      const out = formatEvent({
        type: 'TOOL_CALL_FINISHED',
        task_id: 't',
        payload: {
          call: { tool: 'view_image' },
          result: {
            status: 'ok',
            output: 'viewed image pic.png (image/png, 1234 bytes) — the image itself is attached to this conversation; you see it with this result.',
            meta: { image_attached: true },
          },
        },
      })
      expect(out).toContain('view_image -> viewed image pic.png (image/png, 1234 bytes)')
      expect(out).not.toContain('base64')
      expect(out).not.toContain('data:image')
    })

    test('TOOL_CALL_FINISHED renders a fetch_url result as its fetched header line', () => {
      const out = formatEvent({
        type: 'TOOL_CALL_FINISHED',
        task_id: 't',
        payload: {
          call: { tool: 'fetch_url' },
          result: { status: 'ok', output: 'Fetched https://docs.example.com/start (HTTP 200, text/html):\n\nGetting started docs body' },
        },
      })
      expect(out).toContain('fetch_url -> Fetched https://docs.example.com/start')
      expect(out).toContain('(1 more lines)')
    })
  })

  describe('background job rendering', () => {
    test('JOB_STARTED names the job and the command it runs', () => {
      const out = formatEvent({ type: 'JOB_STARTED', task_id: 't', payload: { job_id: 'job-1', command: 'npm install', cwd: 'app', background: true } })
      expect(out).toContain('background job job-1 started: npm install')
    })

    test('JOB_FINISHED shows the terminal state and exit code', () => {
      expect(formatEvent({ type: 'JOB_FINISHED', task_id: 't', payload: { job_id: 'job-1', state: 'exited', exit_code: 0 } })).toContain('background job job-1 exited (exit 0)')
      expect(formatEvent({ type: 'JOB_FINISHED', task_id: 't', payload: { job_id: 'job-2', state: 'killed', exit_code: null } })).toContain('background job job-2 killed')
    })
  })

  describe('orchestration rendering', () => {
    test('ORCHESTRATION_SKIPPED explains the single-path run', () => {
      const out = formatEvent({ type: 'ORCHESTRATION_SKIPPED', task_id: 't', payload: { reason: 'single_path', decomposed_children: 3 } })
      expect(out).toContain('single path')
      expect(out).toContain('running one agent loop directly')
    })
  })

  describe('approvalPreviewLine', () => {
    test('renders a command verbatim so the terminal prompt shows what runs', () => {
      const line = approvalPreviewLine({
        key: { tool: 'run_command' },
        approval: { preview: { kind: 'command', command: 'npm test -- --watch' } },
      })
      expect(line).toBe('$ npm test -- --watch')
    })

    test('renders a write as path plus size, and an edit as path plus patch head', () => {
      expect(
        approvalPreviewLine({ approval: { preview: { kind: 'write', path: 'src/a.ts', content: 'export {}' } } }),
      ).toBe('write src/a.ts (9 chars)')
      const edit = approvalPreviewLine({ approval: { preview: { kind: 'edit', path: 'src/a.ts', patch: '+added\n-removed' } } })
      expect(edit).toContain('edit src/a.ts')
      expect(edit).toContain('+added')
    })

    test('caps long patches and degrades missing previews to undefined', () => {
      const patch = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
      const capped = approvalPreviewLine({ approval: { preview: { kind: 'edit', path: 'x.ts', patch } } })
      expect(capped).toContain('… (6 more lines)')
      expect(approvalPreviewLine({ key: { tool: 'write_file' } })).toBeUndefined()
    })
  })

  describe('color gating', () => {
    const origNoColor = process.env.NO_COLOR
    const origForceColor = process.env.FORCE_COLOR

    afterEach(() => {
      if (origNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = origNoColor
      if (origForceColor === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = origForceColor
    })

    test('NO_COLOR=1 strips ANSI from TASK_STARTED', () => {
      process.env.NO_COLOR = '1'
      delete process.env.FORCE_COLOR
      const out = formatEvent({ type: 'TASK_STARTED', task_id: 't', payload: { spec: { goal: 'build the thing' } } })
      expect(out).not.toContain('\x1b')
      expect(out).toContain('Task:')
      expect(out).toContain('build the thing')
    })

    test('FORCE_COLOR=1 emits ANSI for TASK_STARTED', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '1'
      const out = formatEvent({ type: 'TASK_STARTED', task_id: 't', payload: { spec: { goal: 'build the thing' } } })
      expect(out).toContain('\x1b')
      expect(out).toContain('Task:')
      expect(out).toContain('build the thing')
    })

test('PLAN_CREATED uses ✦ glyph, never 📋', () => {
      delete process.env.NO_COLOR
      process.env.FORCE_COLOR = '1'
      const out = formatEvent({ type: 'PLAN_CREATED', task_id: 't', payload: { plan: { steps: [{ intent: 'step one' }] } } })
      expect(out).not.toContain('📋')
      expect(out).toContain('✦')
      expect(out).toContain('step one')
    })

    test('THOUGHT renders as a dim thinking line', () => {
      process.env.NO_COLOR = '1'
      delete process.env.FORCE_COLOR
      const out = formatEvent({ type: 'THOUGHT', task_id: 't', payload: { text: 'inspect first', source: 'provider_reasoning' } })
      expect(out).toContain('thinking · inspect first')
    })

    test('TOOL_CALL_STARTED is one compact ⚙ line with short args', () => {
      process.env.NO_COLOR = '1'
      delete process.env.FORCE_COLOR
      const out = formatEvent({ type: 'TOOL_CALL_STARTED', task_id: 't', payload: { call: { tool: 'read_file', args: { path: 'src/app.ts' } } } })
      expect(out).toContain('⚙')
      expect(out).toContain('read_file')
      expect(out).toContain('src/app.ts')
      expect(out.trim().split('\n')).toHaveLength(1)
    })

    test('TOOL_CALL_FINISHED is an indented ↳ result truncated with a line count', () => {
      process.env.NO_COLOR = '1'
      delete process.env.FORCE_COLOR
      const output = ['first line', 'second line', 'third line', 'fourth line'].join('\n')
      const out = formatEvent({ type: 'TOOL_CALL_FINISHED', task_id: 't', payload: { call: { tool: 'read_file' }, result: { status: 'ok', output } } })
      expect(out).toContain('↳')
      expect(out).toContain('read_file -> first line')
      expect(out).toContain('… (3 more lines)')
      expect(out).not.toContain('fourth line')
    })
  })

describe('run flags', () => {
  function helpFor(args: string[]): string {
    const program = buildProgram()
    program.exitOverride()
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      expect(() => program.parse(['node', 'daedalus', ...args])).toThrow()
    } finally {
      spy.mockRestore()
    }
    return written.join('')
  }

  test('run --help advertises every execution flag', () => {
    const help = helpFor(['run', '--help'])
    for (const flag of ['--cwd', '--json', '--yolo', '--max-iterations', '--model', '--provider', '--provider-id', '--mode', '--timeout', '--verbose']) {
      expect(help).toContain(flag)
    }
  })

  test('parsePositiveInt accepts a positive integer', () => {
    expect(parsePositiveInt('30000', '--timeout')).toBe(30_000)
  })

  test('parsePositiveInt returns undefined when the flag is absent', () => {
    expect(parsePositiveInt(undefined, '--timeout')).toBeUndefined()
  })

  test('parsePositiveInt rejects zero, negatives, and non-integers', () => {
    expect(() => parsePositiveInt('0', '--timeout')).toThrow(/positive integer/)
    expect(() => parsePositiveInt('-5', '--timeout')).toThrow(/positive integer/)
    expect(() => parsePositiveInt('1.5', '--timeout')).toThrow(/positive integer/)
    expect(() => parsePositiveInt('soon', '--timeout')).toThrow(/positive integer/)
  })
})

describe('SIGINT', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('cancels the active task and exits 130', () => {
    const cancel = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    makeSigintHandler({ cancel }, () => 'task-7', () => true)()

    expect(cancel).toHaveBeenCalledWith('task-7')
    expect(exit).toHaveBeenCalledWith(130)
  })

  test('exits 130 even when no task is active yet', () => {
    const cancel = vi.fn()
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    makeSigintHandler({ cancel }, () => undefined, () => true)()

    expect(cancel).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(130)
  })

  test('stays silent in --json mode', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    makeSigintHandler({ cancel: vi.fn() }, () => 'task-7', () => false)()

    expect(stderr).not.toHaveBeenCalled()
  })
})

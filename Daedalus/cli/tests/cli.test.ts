import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildProgram, formatEvent, makeSigintHandler, parseApproval, parsePositiveInt } from '../src/index.ts'
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
    for (const flag of ['--cwd', '--json', '--yolo', '--max-iterations', '--model', '--provider', '--timeout', '--verbose']) {
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

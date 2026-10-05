import { describe, expect, test } from 'vitest';
import {
  aggregateValidation,
  completionGate,
  decideRecovery,
  discoverChecks,
  normalizeError,
  validationFailed,
  validationPassed,
  type NormalizedError,
  type RecoveryContext,
  type ValidationCheck,
  type ValidationResult,
} from '../src/index.ts';

describe('Validation & Error Recovery — error normalizer', () => {
  test('normalizes TypeScript/compile error diagnostics', () => {
    const check: ValidationCheck = {
      name: 'build',
      cmd: 'npm run build',
      status: 'fail',
      exit_code: 2,
      summary: 'tsc -p tsconfig.json failed',
      diagnostics: [
        { file: 'src/app.ts', line: 12, message: 'src/app.ts(12,5): error TS2322: Type "string" is not assignable to type "number".' },
      ],
    };
    const norm = normalizeError(check);
    expect(norm.category).toBe('compile');
    expect(norm.file).toBe('src/app.ts');
    expect(norm.line).toBe(12);
    expect(norm.fixIntent).toContain('syntax/type error');
  });

  test('normalizes test assertion failures', () => {
    const check: ValidationCheck = {
      name: 'test',
      cmd: 'vitest run',
      status: 'fail',
      exit_code: 1,
      summary: 'FAIL src/math.test.ts > add()',
      diagnostics: [
        { message: 'FAIL src/math.test.ts > add()' },
        { message: 'Expected: 4\nReceived: 5' },
      ],
    };
    const norm = normalizeError(check);
    expect(norm.category).toBe('assertion');
    expect(norm.fixIntent).toContain('failing test');
  });

  test('normalizes missing dependency errors', () => {
    const check: ValidationCheck = {
      name: 'test',
      cmd: 'node index.js',
      status: 'fail',
      exit_code: 1,
      summary: 'Cannot find module "lodash"',
      diagnostics: [{ message: 'Error: Cannot find module "lodash"' }],
    };
    const norm = normalizeError(check);
    expect(norm.category).toBe('dependency');
    expect(norm.fixIntent).toContain('missing module');
  });

  test('normalizes lint errors', () => {
    const check: ValidationCheck = {
      name: 'lint',
      cmd: 'eslint .',
      status: 'fail',
      exit_code: 1,
      summary: 'src/foo.ts:10:2 error unused variable',
      diagnostics: [{ message: 'src/foo.ts:10:2 error "x" is defined but never used' }],
    };
    const norm = normalizeError(check);
    expect(norm.category).toBe('lint');
    expect(norm.fixIntent).toContain('lint violation');
  });
});

describe('Validation & Error Recovery — recovery policy & strategy', () => {
  const err: NormalizedError = {
    category: 'assertion',
    message: 'expected 1 to be 2',
    fixIntent: 'fix math',
    fingerprint: 'assertion:expected#to#be#',
  };

  test('first failure recommends retry', () => {
    const ctx: RecoveryContext = { attempt: 1, retriesUsed: 0, replansUsed: 0, repeats: 1 };
    const action = decideRecovery(err, ctx);
    expect(action.strategy).toBe('retry');
    expect(action.attempt).toBe(1);
  });

  test('exhausted retries triggers replan', () => {
    const ctx: RecoveryContext = { attempt: 4, retriesUsed: 3, replansUsed: 0, repeats: 1 };
    const action = decideRecovery(err, ctx, { maxRetries: 3, maxReplans: 2, maxAttempts: 10, noProgressLimit: 5 });
    expect(action.strategy).toBe('replan');
  });

  test('exhausted replans results in abort', () => {
    const ctx: RecoveryContext = { attempt: 6, retriesUsed: 3, replansUsed: 2, repeats: 1 };
    const action = decideRecovery(err, ctx, { maxRetries: 3, maxReplans: 2, maxAttempts: 10, noProgressLimit: 5 });
    expect(action.strategy).toBe('abort');
  });

  test('stalled loop with no progress aborts under budget', () => {
    const ctx: RecoveryContext = { attempt: 3, retriesUsed: 1, replansUsed: 0, repeats: 4 };
    const action = decideRecovery(err, ctx, { maxRetries: 5, maxReplans: 2, maxAttempts: 10, noProgressLimit: 3 });
    expect(action.strategy).toBe('abort');
  });
});

describe('Validation & Error Recovery — validation gate', () => {
  test('validationPassed checks all pass verdicts', () => {
    const res: ValidationResult = {
      checks: [
        { name: 'test', cmd: 'npm test', status: 'pass', exit_code: 0, summary: 'pass', diagnostics: [] },
        { name: 'lint', cmd: 'npm run lint', status: 'pass', exit_code: 0, summary: 'pass', diagnostics: [] },
      ],
    };
    expect(validationPassed(res)).toBe(true);
    expect(validationFailed(res)).toHaveLength(0);
    expect(aggregateValidation(res).passed).toBe(true);
  });

  test('completionGate permits completion only on passed validation or explicit stop condition', () => {
    const passed: ValidationResult = {
      checks: [{ name: 'test', cmd: 'npm test', status: 'pass', exit_code: 0, summary: 'pass', diagnostics: [] }],
    };
    const failed: ValidationResult = {
      checks: [{ name: 'test', cmd: 'npm test', status: 'fail', exit_code: 1, summary: 'fail', diagnostics: [] }],
    };

    expect(completionGate(passed, undefined)).toEqual({ complete: true, reason: 'validation_passed' });
    expect(completionGate(failed, undefined)).toEqual({ complete: false, reason: 'validation_failed' });
    expect(completionGate(undefined, undefined)).toEqual({ complete: false, reason: 'validation_missing' });
    expect(completionGate(undefined, 'max_iterations')).toEqual({ complete: true, reason: 'stop_condition:max_iterations' });
  });

  test('discoverChecks returns standard npm build/lint/test commands', () => {
    const checks = discoverChecks('.');
    expect(checks.map((c) => c.name)).toEqual(['test', 'lint', 'build']);
  });
});

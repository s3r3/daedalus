import type { RecoveryAction, ValidationCheck, ValidationResult } from '../contracts.ts';

export type ErrorCategory = 'compile' | 'lint' | 'assertion' | 'dependency' | 'timeout' | 'unknown';

export type NormalizedError = {
  category: ErrorCategory;
  message: string;
  file?: string;
  line?: number;
  fixIntent: string;
  fingerprint: string;
};

export type RecoveryPolicy = {
  maxRetries: number;
  maxReplans: number;
  maxAttempts: number;
  noProgressLimit: number;
};

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = { maxRetries: 3, maxReplans: 2, maxAttempts: 8, noProgressLimit: 3 };

const PATTERNS: Array<{ category: ErrorCategory; regex: RegExp; fixIntent: string }> = [
  { category: 'compile', regex: /^(?:.*?)\((\d+),(\d+)\):\s*error\s*([A-Z]+\d+):\s*(.*)$/m, fixIntent: 'fix the reported syntax/type error at the given location' },
  { category: 'compile', regex: /error TS(\d+):\s*(.*)$/m, fixIntent: 'fix the TypeScript error reported by tsc' },
  { category: 'assertion', regex: /^(?:FAIL|●)\s+(.*)$/m, fixIntent: 'inspect the failing test and correct the behaviour it asserts' },
  { category: 'assertion', regex: /Expected:?\s*(.*)\n\s*Received:?\s*(.*)$/m, fixIntent: 'align the implementation with the expected value in the failing assertion' },
  { category: 'dependency', regex: /Cannot find module ['"](.*)['"]/, fixIntent: 'install or correct the missing module reference' },
  { category: 'dependency', regex: /ERR_MODULE_NOT_FOUND|ModuleNotFoundError/, fixIntent: 'install the missing dependency' },
  { category: 'lint', regex: /^\s*(.+?):(\d+):(\d+)\s+(?:error|warning)\s+(.*)$/m, fixIntent: 'fix the reported lint violation' },
];

export function normalizeError(check: ValidationCheck): NormalizedError {
  const text = [...check.diagnostics.map((d) => d.message), check.summary].join('\n');
  for (const { category, regex, fixIntent } of PATTERNS) {
    const match = regex.exec(text);
    if (!match?.[0]) continue;
    const line = check.diagnostics.find((d) => d.line !== undefined)?.line ?? numeric(match[2] ?? match[3]);
    return {
      category,
      message: match[0].trim().split('\n')[0] ?? check.summary,
      file: check.diagnostics.find((d) => d.file)?.file,
      line,
      fixIntent,
      fingerprint: `${category}:${stripNumbers(match[0])}`,
    };
  }
  return { category: 'unknown', message: check.summary, fixIntent: 'inspect the raw check output', fingerprint: `unknown:${check.name}:${stripNumbers(text)}` };
}

function numeric(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function stripNumbers(text: string): string {
  return text.replace(/\d+/g, '#');
}

export type RecoveryContext = {
  attempt: number;
  retriesUsed: number;
  replansUsed: number;
  repeats: number;
};

/** Deterministic recovery decision: retry → fix → replan → abort under hard limits. */
export function decideRecovery(error: NormalizedError, context: RecoveryContext, policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY): RecoveryAction {
  const limits = { maxRetries: policy.maxRetries, maxReplans: policy.maxReplans, maxAttempts: policy.maxAttempts, noProgress: policy.noProgressLimit };
  const exhausted = context.attempt >= policy.maxAttempts;
  const stalled = context.repeats >= policy.noProgressLimit;
  const strategy =
    exhausted || stalled ? 'abort'
    : context.replansUsed >= policy.maxReplans ? 'abort'
    : context.retriesUsed >= policy.maxRetries ? (context.replansUsed < policy.maxReplans ? 'replan' : 'abort')
    : error.category === 'unknown' && context.replansUsed < policy.maxReplans ? 'fix'
    : 'retry';
  return { reason: `${error.category}: ${error.message}`, strategy, attempt: context.attempt, limits };
}

export function validationPassed(result: ValidationResult): boolean {
  return result.checks.length > 0 && result.checks.every((check) => check.status === 'pass');
}

export function validationFailed(result: ValidationResult): ValidationCheck[] {
  return result.checks.filter((check) => check.status !== 'pass');
}

/** Validation gate: a task may only complete on validated evidence. */
export function completionGate(result: ValidationResult | undefined, stopReason: string | undefined): { complete: boolean; reason: string } {
  if (stopReason !== undefined) return { complete: true, reason: `stop_condition:${stopReason}` };
  if (result === undefined) return { complete: false, reason: 'validation_missing' };
  return validationPassed(result) ? { complete: true, reason: 'validation_passed' } : { complete: false, reason: 'validation_failed' };
}
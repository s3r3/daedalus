import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidationCheck, ValidationResult } from '../contracts.ts';
import { runCommandTool } from '../tools/terminal/index.ts';
import {
  completionGate,
  decideRecovery,
  normalizeError,
  validationFailed,
  validationPassed,
  validationSatisfied,
  type NormalizedError,
  type RecoveryContext,
  type RecoveryPolicy,
} from './recovery.ts';

export type ValidationCommand = {
  name: string;
  cmd: string;
  args?: string[];
  parser?: (output: string, exitCode: number | null) => ValidationCheck;
  /** Where the check came from; recorded on every produced ValidationCheck. */
  source?: 'profile' | 'default';
  /** Profile checks may be advisory (`required: false`): reported, never gate-blocking. */
  required?: boolean;
};

export type ValidatorOptions = {
  workspaceRoot: string;
  timeoutMs?: number;
  commands?: ValidationCommand[];
};

export type Validator = {
  validate(options: ValidatorOptions): Promise<ValidationResult>;
};

function defaultParser(command: ValidationCommand, output: string, exitCode: number | null): ValidationCheck {
  const status = exitCode === 0 ? 'pass' : 'fail';
  const diagnostics = output.split('\n').filter(Boolean).slice(-20).map((message) => ({ message }));
  return {
    name: command.name,
    cmd: [command.cmd, ...(command.args ?? [])].join(' '),
    status,
    exit_code: exitCode,
    summary: status === 'pass' ? 'passed' : 'failed',
    diagnostics,
    ...(command.source ? { source: command.source } : {}),
    ...(command.required !== undefined ? { required: command.required } : {}),
  };
}

export class CommandValidator implements Validator {
  async validate(options: ValidatorOptions): Promise<ValidationResult> {
    let commands = options.commands;
    let timeoutMs = options.timeoutMs;
    let source: 'profile' | 'default' = 'default';
    let warning: string | undefined;
    if (!commands) {
      // A workspace may define its own checks in .daedalus/validate.json;
      // those replace the default test/lint/build detection entirely. A
      // malformed profile never breaks validation — it falls back to the
      // defaults and the warning rides along into the report evidence.
      const loaded = loadValidationProfile(options.workspaceRoot);
      warning = loaded.warning;
      if (loaded.profile) {
        commands = profileCommands(loaded.profile);
        source = 'profile';
        timeoutMs = timeoutMs ?? loaded.profile.timeoutMs;
      } else {
        commands = discoverChecks(options.workspaceRoot);
      }
    }
    const checks: ValidationCheck[] = [];
    for (const command of commands) {
      const result = await runCommandTool.execute({ command: command.cmd, args: command.args ?? [] }, { workspaceRoot: options.workspaceRoot, timeoutMs });
      const exitCode = typeof result.meta.exit_code === 'number' ? result.meta.exit_code : result.status === 'ok' ? 0 : null;
      checks.push(command.parser ? command.parser(result.output, exitCode) : defaultParser(command, result.output, exitCode));
    }
    return { checks, source, ...(warning ? { warning } : {}) };
  }
}

export function discoverChecks(workspaceRoot: string): ValidationCommand[] {
  // Default checks mirror the workspace's own package.json scripts: a check
  // is only suggested when the script actually exists. A workspace without
  // package.json (or without test/lint/build scripts — a bare folder, a
  // static HTML site) gets NO default checks, so validation is skipped
  // instead of failing on commands the project never defined.
  let scripts: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { scripts?: unknown }).scripts === 'object' && (parsed as { scripts?: unknown }).scripts !== null) {
      scripts = (parsed as { scripts: Record<string, unknown> }).scripts;
    }
  } catch {
    return [];
  }
  const candidates: ValidationCommand[] = [
    { name: 'test', cmd: 'npm', args: ['test', '--', '--run'], source: 'default' },
    { name: 'lint', cmd: 'npm', args: ['run', 'lint'], source: 'default' },
    { name: 'build', cmd: 'npm', args: ['run', 'build'], source: 'default' },
  ];
  return candidates.filter((check) => typeof scripts[check.name] === 'string' && (scripts[check.name] as string).trim() !== '');
}

export function aggregateValidation(result: ValidationResult): { passed: boolean; result: ValidationResult } {
  return { passed: validationPassed(result), result };
}

/** One check from a workspace validation profile (`.daedalus/validate.json`). */
export type ValidationProfileCheck = {
  name: string;
  command: string;
  required?: boolean;
};

export type ValidationProfile = {
  checks: ValidationProfileCheck[];
  timeoutMs?: number;
};

export const VALIDATION_PROFILE_RELATIVE_PATH = '.daedalus/validate.json';

/**
 * Load `<workspace>/.daedalus/validate.json`:
 * `{ "checks": [{ "name": "check", "command": "node check.mjs", "required": true }], "timeoutMs": 60000 }`.
 * A missing file is normal (defaults apply, no warning). A present but
 * malformed file yields a warning and no profile, so validation falls back
 * to the defaults with the problem visible in the evidence.
 */
export function loadValidationProfile(workspaceRoot: string): { profile?: ValidationProfile; warning?: string } {
  const path = join(workspaceRoot, VALIDATION_PROFILE_RELATIVE_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { warning: `invalid validation profile at ${VALIDATION_PROFILE_RELATIVE_PATH}: ${(error as Error).message}; using default checks` };
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { checks?: unknown }).checks)) {
    return { warning: `invalid validation profile at ${VALIDATION_PROFILE_RELATIVE_PATH}: expected an object with a "checks" array; using default checks` };
  }
  const record = parsed as { checks: unknown[]; timeoutMs?: unknown };
  const checks: ValidationProfileCheck[] = [];
  for (const [index, entry] of record.checks.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return { warning: `invalid validation profile at ${VALIDATION_PROFILE_RELATIVE_PATH}: checks[${index}] must be an object; using default checks` };
    }
    const candidate = entry as { name?: unknown; command?: unknown; required?: unknown };
    if (typeof candidate.name !== 'string' || !candidate.name.trim() || typeof candidate.command !== 'string' || !candidate.command.trim()) {
      return { warning: `invalid validation profile at ${VALIDATION_PROFILE_RELATIVE_PATH}: checks[${index}] needs non-empty string "name" and "command"; using default checks` };
    }
    checks.push({
      name: candidate.name,
      command: candidate.command,
      ...(typeof candidate.required === 'boolean' ? { required: candidate.required } : {}),
    });
  }
  if (checks.length === 0) {
    return { warning: `invalid validation profile at ${VALIDATION_PROFILE_RELATIVE_PATH}: "checks" is empty; using default checks` };
  }
  return {
    profile: {
      checks,
      ...(typeof record.timeoutMs === 'number' && record.timeoutMs > 0 ? { timeoutMs: record.timeoutMs } : {}),
    },
  };
}

/** Map profile checks to runnable commands, tagging their provenance. */
export function profileCommands(profile: ValidationProfile): ValidationCommand[] {
  return profile.checks.map((check) => {
    const { cmd, args } = splitCommandLine(check.command);
    return { name: check.name, cmd, args, source: 'profile' as const, required: check.required !== false };
  });
}

/** Split a profile command line into argv, honouring single/double quotes (no shell expansion). */
export function splitCommandLine(command: string): { cmd: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let hasCurrent = false;
  for (const char of command) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; hasCurrent = true; continue; }
    if (/\s/.test(char)) {
      if (hasCurrent || current.length > 0) { parts.push(current); current = ''; hasCurrent = false; }
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (hasCurrent || current.length > 0) parts.push(current);
  const [cmd = '', ...args] = parts;
  return { cmd, args };
}

export {
  completionGate,
  decideRecovery,
  normalizeError,
  validationFailed,
  validationPassed,
  validationSatisfied,
  type NormalizedError,
  type RecoveryContext,
  type RecoveryPolicy,
};

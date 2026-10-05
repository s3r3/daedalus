import type { ValidationCheck, ValidationResult } from '../contracts.ts';
import { runCommandTool } from '../tools/terminal/index.ts';
import {
  completionGate,
  decideRecovery,
  normalizeError,
  validationFailed,
  validationPassed,
  type NormalizedError,
  type RecoveryContext,
  type RecoveryPolicy,
} from './recovery.ts';

export type ValidationCommand = {
  name: string;
  cmd: string;
  args?: string[];
  parser?: (output: string, exitCode: number | null) => ValidationCheck;
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
  return { name: command.name, cmd: [command.cmd, ...(command.args ?? [])].join(' '), status, exit_code: exitCode, summary: status === 'pass' ? 'passed' : 'failed', diagnostics };
}

export class CommandValidator implements Validator {
  async validate(options: ValidatorOptions): Promise<ValidationResult> {
    const commands = options.commands ?? discoverChecks(options.workspaceRoot);
    const checks: ValidationCheck[] = [];
    for (const command of commands) {
      const result = await runCommandTool.execute({ command: command.cmd, args: command.args ?? [] }, { workspaceRoot: options.workspaceRoot, timeoutMs: options.timeoutMs });
      const exitCode = typeof result.meta.exit_code === 'number' ? result.meta.exit_code : result.status === 'ok' ? 0 : null;
      checks.push(command.parser ? command.parser(result.output, exitCode) : defaultParser(command, result.output, exitCode));
    }
    return { checks };
  }
}

export function discoverChecks(workspaceRoot: string): ValidationCommand[] {
  void workspaceRoot;
  return [
    { name: 'test', cmd: 'npm', args: ['test', '--', '--run'] },
    { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
    { name: 'build', cmd: 'npm', args: ['run', 'build'] },
  ];
}

export function aggregateValidation(result: ValidationResult): { passed: boolean; result: ValidationResult } {
  return { passed: result.checks.length > 0 && result.checks.every((check) => check.status === 'pass'), result };
}

export {
  completionGate,
  decideRecovery,
  normalizeError,
  validationFailed,
  validationPassed,
  type NormalizedError,
  type RecoveryContext,
  type RecoveryPolicy,
};
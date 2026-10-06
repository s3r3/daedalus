import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { ValidationCheck, ValidationResult } from '../contracts.ts';
import { runCommandTool } from '../tools/terminal/index.ts';
import {
  completionGate,
  decideRecovery,
  normalizeError,
  validationFailed,
  validationFailureSignature,
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
  /** Workspace-relative directory to run the check in (a monorepo member package). Runs from the root when unset. */
  cwd?: string;
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
  /**
   * Paths the task changed (relative to the workspace root, or absolute
   * inside it). When given, a monorepo root's aggregate scripts no longer
   * poison unrelated tasks: default checks are scoped to the packages the
   * changes touch (see discoverScopedChecks). No effect when a validation
   * profile or explicit commands are configured.
   */
  changedFiles?: string[];
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
    let note: string | undefined;
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
      } else if (options.changedFiles && options.changedFiles.length > 0) {
        // Changeset-scoped discovery: in a monorepo the root's aggregate
        // test/lint/build scripts say nothing about a task that only touched
        // one member package (or no package at all), so the checks follow
        // the changes instead of the root.
        const scoped = discoverScopedChecks(options.workspaceRoot, options.changedFiles);
        commands = scoped.commands;
        note = scoped.note;
      } else {
        commands = discoverChecks(options.workspaceRoot);
      }
    }
    const checks: ValidationCheck[] = [];
    for (const command of commands) {
      const input = { command: command.cmd, args: command.args ?? [], ...(command.cwd ? { cwd: command.cwd } : {}) };
      const result = await runCommandTool.execute(input, { workspaceRoot: options.workspaceRoot, timeoutMs });
      const exitCode = typeof result.meta.exit_code === 'number' ? result.meta.exit_code : result.status === 'ok' ? 0 : null;
      checks.push(command.parser ? command.parser(result.output, exitCode) : defaultParser(command, result.output, exitCode));
    }
    return { checks, source, ...(warning ? { warning } : {}), ...(note ? { note } : {}) };
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

export type ScopedCheckDiscovery = {
  commands: ValidationCommand[];
  /** True when the root package.json declares npm workspaces and per-package scoping applied. */
  scoped: boolean;
  /** Labels of the packages whose checks were selected, in run order. */
  packages: string[];
  /** Changed files that belong to no package (scoped mode only). */
  outsideFiles: string[];
  /** Why these checks were chosen; recorded on the result (skip reason or scope summary). */
  note?: string;
};

type PackageJson = {
  name?: unknown;
  scripts?: unknown;
  workspaces?: unknown;
};

function readPackageJson(dir: string): PackageJson | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** npm `workspaces` patterns: an array of strings, or `{ packages: [...] }`. */
function workspacePatterns(rootPkg: PackageJson | undefined): string[] {
  const field = rootPkg?.workspaces;
  const list = Array.isArray(field)
    ? field
    : typeof field === 'object' && field !== null && Array.isArray((field as { packages?: unknown }).packages)
      ? (field as { packages: unknown[] }).packages
      : [];
  return list.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * Concrete workspace member directories (relative to the root): exact dir
 * entries and simple `dir/*` globs, kept only when the member really is a
 * package (has its own package.json). Deeper globs are not expanded — a
 * change beneath one still resolves via the nearest-ancestor rule.
 */
function workspaceMemberDirs(workspaceRoot: string, patterns: string[]): string[] {
  const members = new Set<string>();
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim().replace(/\/+$/, '');
    if (!pattern) continue;
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      let entries: string[] = [];
      try {
        entries = readdirSync(base ? join(workspaceRoot, base) : workspaceRoot);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const rel = base ? `${base}/${entry}` : entry;
        if (existsSync(join(workspaceRoot, rel, 'package.json'))) members.add(rel);
      }
    } else if (!pattern.includes('*')) {
      if (existsSync(join(workspaceRoot, pattern, 'package.json'))) members.add(pattern);
    }
  }
  return [...members];
}

/** Normalize a changed path to workspace-relative POSIX form; undefined when it escapes the root. */
function normalizeChangedPath(workspaceRoot: string, file: string): string | undefined {
  let rel = isAbsolute(file) ? relative(workspaceRoot, file) : file;
  rel = rel.split(sep).join('/');
  if (rel === '..' || rel.startsWith('../')) return undefined;
  if (rel.startsWith('./')) rel = rel.slice(2);
  return rel;
}

function posixDirname(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index === -1 ? '' : rel.slice(0, index);
}

/**
 * Which package owns a changed file: (a) the enclosing npm-workspaces
 * member, (b) the nearest ancestor below the root containing a
 * package.json, (c) the root package for root-level files, (d) nothing —
 * a loose folder outside every package (e.g. `ayid/`). Returns the owner's
 * relative dir ('' = root) or null for (d).
 */
function packageOwner(workspaceRoot: string, rel: string, members: string[]): string | null {
  // The directory the change lives in: the path itself when it is a
  // directory on disk (create_dir changes), else its parent.
  let dir = posixDirname(rel);
  if (rel !== '') {
    try {
      if (statSync(join(workspaceRoot, rel)).isDirectory()) dir = rel;
    } catch {
      // Deleted or not-yet-created path: the parent directory stands.
    }
  }
  let best: string | undefined;
  for (const member of members) {
    if (rel === member || rel.startsWith(`${member}/`)) {
      if (best === undefined || member.length > best.length) best = member;
    }
  }
  if (best !== undefined) return best;
  let ancestor = dir;
  while (ancestor !== '') {
    if (existsSync(join(workspaceRoot, ancestor, 'package.json'))) return ancestor;
    ancestor = posixDirname(ancestor);
  }
  return dir === '' ? '' : null;
}

const MAX_OUTSIDE_FILES_IN_NOTE = 5;

function formatPathList(files: string[]): string {
  const shown = files.slice(0, MAX_OUTSIDE_FILES_IN_NOTE);
  const extra = files.length - shown.length;
  return [...shown, ...(extra > 0 ? [`+${extra} more`] : [])].join(', ');
}

/**
 * Changeset-scoped default checks. When the root package.json declares npm
 * `workspaces`, a whole-repo aggregate script run proves nothing about a
 * task that touched one member (or a loose folder): the checks are
 * discovered per affected package and run from that package's directory.
 * Without a `workspaces` field the project is single-package and this is
 * exactly discoverChecks. Packages are deduped, the root package runs last,
 * and check names carry their package (`test (core)`) only when more than
 * one package is checked.
 */
export function discoverScopedChecks(workspaceRoot: string, changedFiles: string[]): ScopedCheckDiscovery {
  const rootPkg = readPackageJson(workspaceRoot);
  const patterns = workspacePatterns(rootPkg);
  if (!rootPkg || patterns.length === 0) {
    return { commands: discoverChecks(workspaceRoot), scoped: false, packages: [], outsideFiles: [] };
  }
  const members = workspaceMemberDirs(workspaceRoot, patterns);
  const affected: string[] = [];
  const seenPackages = new Set<string>();
  const outsideFiles: string[] = [];
  const seenOutside = new Set<string>();
  for (const file of changedFiles) {
    const rel = normalizeChangedPath(workspaceRoot, file);
    if (rel === undefined) {
      if (!seenOutside.has(file)) {
        seenOutside.add(file);
        outsideFiles.push(file);
      }
      continue;
    }
    const owner = rel === '' ? '' : packageOwner(workspaceRoot, rel, members);
    if (owner === null) {
      if (!seenOutside.has(rel)) {
        seenOutside.add(rel);
        outsideFiles.push(rel);
      }
    } else if (!seenPackages.has(owner)) {
      seenPackages.add(owner);
      affected.push(owner);
    }
  }
  const ordered = [...affected.filter((dir) => dir !== ''), ...(seenPackages.has('') ? [''] : [])];
  const multi = ordered.length > 1;
  const labels: string[] = [];
  const commands: ValidationCommand[] = [];
  for (const dir of ordered) {
    const pkg = readPackageJson(dir === '' ? workspaceRoot : join(workspaceRoot, dir));
    const name = typeof pkg?.name === 'string' && pkg.name.trim() !== '' ? pkg.name.trim() : undefined;
    const label = name ?? (dir === '' ? 'root' : basename(dir));
    labels.push(label);
    for (const check of discoverChecks(dir === '' ? workspaceRoot : join(workspaceRoot, dir))) {
      commands.push({
        ...check,
        ...(dir !== '' ? { cwd: dir } : {}),
        ...(multi ? { name: `${check.name} (${label})` } : {}),
      });
    }
  }
  let note: string | undefined;
  if (commands.length === 0) {
    const reasons: string[] = [];
    if (outsideFiles.length > 0) reasons.push(`changes are outside the project's packages (${formatPathList(outsideFiles)})`);
    if (ordered.length > 0) reasons.push(`changed packages define no test/lint/build checks (${labels.join(', ')})`);
    note = reasons.join('; ') || undefined;
  } else {
    note = `checks scoped to ${ordered.length === 1 ? 'package' : 'packages'}: ${labels.join(', ')}`;
  }
  return { commands, scoped: true, packages: labels, outsideFiles, ...(note ? { note } : {}) };
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
  validationFailureSignature,
  validationPassed,
  validationSatisfied,
  type NormalizedError,
  type RecoveryContext,
  type RecoveryPolicy,
};

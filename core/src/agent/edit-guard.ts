import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathInWorkspace } from '../tools/filesystem/index.ts';
import { run } from '../tools/terminal/index.ts';

/**
 * Edit guard: after the agent writes or edits a file, run the fastest honest
 * correctness check available for that file type and attach the outcome to
 * the tool result, so a syntax error is fixed in the same turn instead of
 * surfacing at validation time. Everything here is fail-open and
 * time-bounded: a missing interpreter, a slow language server, or an
 * unreadable file must never hang or fail the run.
 */

export type EditGuardLsp = {
  serverFor: (filePath: string) => unknown;
  diagnostics: (workspaceRoot: string, filePath: string) => Promise<{ server: string; lines: string[] }>;
};

export type EditGuardOptions = {
  workspaceRoot: string;
  enabled: boolean;
  /** Configured language servers, when the workspace has any. */
  lsp?: EditGuardLsp | null;
  syntaxTimeoutMs?: number;
  lspTimeoutMs?: number;
};

export type EditGuardOutcome = {
  /** Line(s) to append to the tool result output; undefined means "say nothing". */
  note?: string;
  ok: boolean;
  issues: string[];
};

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const DEFAULT_SYNTAX_TIMEOUT_MS = 5_000;
const DEFAULT_LSP_TIMEOUT_MS = 2_000;
/** Diagnostics lines shown in an edit result before the "+N more" rollup. */
export const MAX_EDIT_DIAGNOSTIC_LINES = 20;

export async function guardEditedFile(options: EditGuardOptions, relativePath: string): Promise<EditGuardOutcome> {
  if (!options.enabled) return { ok: true, issues: [] };
  try {
    return await inspect(options, relativePath);
  } catch {
    // Fail-open: the guard is an aid, never a gate.
    return { ok: true, issues: [] };
  }
}

async function inspect(options: EditGuardOptions, relativePath: string): Promise<EditGuardOutcome> {
  const absolute = await pathInWorkspace(options.workspaceRoot, relativePath).catch(() => undefined);
  if (!absolute) return { ok: true, issues: [] };
  // A file that vanished between the write and the check (or never landed)
  // is not a syntax problem — stay silent rather than blaming the edit.
  const stats = await stat(absolute).catch(() => undefined);
  if (!stats?.isFile()) return { ok: true, issues: [] };
  const ext = extname(relativePath).toLowerCase();
  const issues: string[] = [];
  let checked = false;

  if (JS_EXTENSIONS.has(ext)) {
    checked = true;
    const result = await run('node', ['--check', absolute], options.workspaceRoot, { timeoutMs: options.syntaxTimeoutMs ?? DEFAULT_SYNTAX_TIMEOUT_MS });
    if (result.status !== 'ok' && !isMissingBinary(result.output)) {
      issues.push(`syntax error in ${relativePath}: ${summarize(result.output)}`);
    }
  } else if (ext === '.json') {
    checked = true;
    try {
      JSON.parse(await readFile(absolute, 'utf8'));
    } catch (error) {
      issues.push(`syntax error in ${relativePath}: ${(error as Error).message}`);
    }
  } else if (ext === '.py') {
    const script = 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")';
    const result = await run('python3', ['-c', script, absolute], options.workspaceRoot, { timeoutMs: options.syntaxTimeoutMs ?? DEFAULT_SYNTAX_TIMEOUT_MS });
    if (isMissingBinary(result.output)) {
      // No python3 on this machine: skip silently, as if unconfigured.
    } else {
      checked = true;
      if (result.status !== 'ok') issues.push(`syntax error in ${relativePath}: ${summarize(result.output)}`);
    }
  }

  const lsp = options.lsp;
  if (lsp && lsp.serverFor(relativePath)) {
    const found = await withTimeout(
      lsp.diagnostics(options.workspaceRoot, relativePath).catch(() => undefined),
      options.lspTimeoutMs ?? DEFAULT_LSP_TIMEOUT_MS,
    );
    if (found && found.lines.length > 0) {
      checked = true;
      const shown = found.lines.slice(0, MAX_EDIT_DIAGNOSTIC_LINES);
      const more = found.lines.length - shown.length;
      issues.push(
        `${found.server} diagnostics for ${relativePath}:\n${shown.join('\n')}${more > 0 ? `\n+${more} more diagnostic${more === 1 ? '' : 's'}` : ''}`,
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, note: `EDIT_GUARD: ${issues.join('\n')}` };
  }
  return { ok: true, issues: [], note: checked ? 'edit guard: ok' : undefined };
}

function isMissingBinary(output: string): boolean {
  return output.includes('ENOENT');
}

function summarize(output: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3);
  const text = lines.join(' ') || 'check failed';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(undefined), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

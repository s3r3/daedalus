/**
 * Command-output compression: semantic, per-command-family filters that
 * shrink noisy `run_command` output BEFORE it enters the model's context.
 *
 * The concept follows rtk-ai/rtk (Apache-2.0) — a CLI proxy that rewrites
 * command output into a compact form — re-implemented here from scratch in
 * TypeScript inside the harness (no RTK code, no Rust binary; provenance in
 * `docs/THIRD_PARTY.md`). Daedalus already had hard caps + spill files
 * (agent/tool-output.ts); compression is the semantic layer in front of
 * them: byte caps alone keep the head and tail of an install log, while
 * these filters keep the lines that carry signal and summarize the rest.
 *
 * Hard rules (non-negotiable, pinned by tests):
 * - Only `run_command` output is compressed — never file reads or other
 *   tools. Application happens in the agent loop before output shaping.
 * - Failure/error lines are kept verbatim in every family; the exit code
 *   and result status ride along untouched (the loop appends the exit
 *   code to its compression note).
 * - Small output passes through byte-identical: compression only engages
 *   above {@link OUTPUT_COMPRESSION_MIN_CHARS} chars or
 *   {@link OUTPUT_COMPRESSION_MIN_LINES} lines, and never returns text
 *   longer than the raw input (no inflation — a signal-dense output that
 *   a filter cannot shrink is passed through untouched).
 * - The caller spills the raw text to the task store and notes the path,
 *   so nothing summarized away is lost.
 */

/** Character floor for compression: at or below this, output passes through. */
export const OUTPUT_COMPRESSION_MIN_CHARS = 2_000;
/** Line floor for compression: at or below this, output passes through. */
export const OUTPUT_COMPRESSION_MIN_LINES = 40;

export type CommandOutputFamily = 'git' | 'test' | 'build' | 'install' | 'listing' | 'generic';

export type CommandOutputCompressionInput = {
  /** The executed command line (`<command> <args…>`), used for family detection. */
  commandLine: string;
  /** Raw combined stdout+stderr text from the executor. */
  output: string;
  /** Tool result status (`ok`, `error`, `timeout`, …). */
  status: string;
  /** Process exit code when the executor reported one. */
  exitCode?: number | null;
};

export type CommandOutputCompression = {
  /** Compressed text, or the raw output when `compressed` is false. */
  text: string;
  /** True when a filter actually shrank the output. */
  compressed: boolean;
  /** Detected filter family; `'none'` on passthrough. */
  family: CommandOutputFamily | 'none';
  /** Chars of the raw input. */
  rawChars: number;
  /** Chars of `text` (equal to `rawChars` on passthrough). */
  compressedChars: number;
};

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Failure/error lines: kept verbatim in every family, always. Deliberately
 * broad — keeping an extra quiet line costs a few chars, while dropping a
 * real failure teaches the model the command succeeded.
 */
const FAILURE_LINE_RE = /(✗|✘|✕|✖|\bfail(?:ed|ing|ure|s)?\b|\berrors?\b|\bexception\b|\bpanic\b|\btraceback\b|\bassert(?:ion)?\b|npm err|\bnot ok\b|\bERR_)/i;

/** Test-runner summary lines (the verdict of the whole run). */
const TEST_SUMMARY_RE = /(\bTest Files\b|\bTest Suites\b|\bTests:|\bTests\s+\d|\btest result:|\bSnapshots:|\d+\s+(?:passing|failing|pending)\b|\d+\s+(?:passed|failed|skipped)\b)/;

/** Build/lint signal beyond failure lines: warnings and the build verdict. */
const BUILD_SIGNAL_RE = /(\bwarn(?:ing)?s?\b|✖|\d+ problems?\b|\bbuilt in\b|\bFinished\b)/i;

/** Package-install signal beyond failure lines: what changed, warnings, audit. */
const INSTALL_SIGNAL_RE = /(\badded \d+ packages?\b|\bremoved \d+ packages?\b|\bchanged \d+ packages?\b|\baudited \d+ packages?\b|\bup to date\b|\bvulnerabilit|\bfunding\b|npm warn|\bdeprecated\b)/i;

/** Git status/diff/log structure lines. */
const GIT_SIGNAL_RE = /^\s*(On branch|Your branch|You are currently|nothing to commit|Changes|Untracked|Unmerged|Untracked files|commit\s|diff --git|index\s|---\s|\+\+\+\s|@@)/;

/** Classify a command line into a filter family (first match wins). */
export function detectCommandOutputFamily(commandLine: string): CommandOutputFamily {
  const cmd = commandLine.trim().replace(/\s+/g, ' ');
  if (/^git\s+(status|diff|log|show)\b/i.test(cmd)) return 'git';
  if (
    /\b(vitest|jest|mocha|ava|pytest|phpunit|rspec)\b/i.test(cmd)
    || /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b/i.test(cmd)
    || /^cargo\s+test\b/i.test(cmd)
    || /^go\s+test\b/i.test(cmd)
  ) return 'test';
  if (
    /\b(npm|pnpm|yarn|bun)\s+(install|ci|add|i|update)\b/i.test(cmd)
    || /\bpip3?\s+install\b/i.test(cmd)
    || /\bcomposer\s+(install|update|require)\b/i.test(cmd)
    || /\bbundle\s+install\b/i.test(cmd)
    || /\bgo\s+mod\s+(download|tidy)\b/i.test(cmd)
  ) return 'install';
  if (
    /\btsc\b/i.test(cmd)
    || /\beslint\b/i.test(cmd)
    || /\b(npm|pnpm|yarn|bun)\s+run\s+build\b/i.test(cmd)
    || /^cargo\s+(build|check|clippy)\b/i.test(cmd)
    || /^go\s+(build|vet)\b/i.test(cmd)
    || /^make\b/i.test(cmd)
    || /\b(next|vite|webpack|rollup|esbuild)\s+build\b/i.test(cmd)
  ) return 'build';
  if (/^(ls|dir|find|tree)\b/i.test(cmd)) return 'listing';
  return 'generic';
}

type LineEntry = { text: string; count: number };

/**
 * Compress one command result for the model. Pure and total: any input is
 * safe, and unshrinkable input returns as passthrough with
 * `compressedChars === rawChars`.
 */
export function compressCommandOutput(input: CommandOutputCompressionInput): CommandOutputCompression {
  const raw = input.output;
  const rawChars = raw.length;
  const rawLineCount = raw.length === 0 ? 0 : raw.split('\n').length;
  const passthrough: CommandOutputCompression = {
    text: raw,
    compressed: false,
    family: 'none',
    rawChars,
    compressedChars: rawChars,
  };
  if (rawChars <= OUTPUT_COMPRESSION_MIN_CHARS && rawLineCount <= OUTPUT_COMPRESSION_MIN_LINES) {
    return passthrough;
  }
  const family = detectCommandOutputFamily(input.commandLine);
  const failed = input.status !== 'ok' || (typeof input.exitCode === 'number' && input.exitCode !== 0);
  const lines = normalizeLines(raw);
  const entries = dedupeRuns(lines);
  const body = renderCompressed(entries, family, failed) + diffSummarySuffix(lines, family);
  if (body.length >= rawChars) return passthrough; // never inflate
  return { text: body, compressed: true, family, rawChars, compressedChars: body.length };
}

/**
 * Terminal normalization: strip ANSI escapes and resolve carriage-return
 * overwrites (progress spinners/bars) to their final rendered segment.
 */
function normalizeLines(raw: string): string[] {
  return raw
    .replace(ANSI_ESCAPE_RE, '')
    .split('\n')
    .map((line) => {
      const segments = line.split('\r').filter((segment) => segment.length > 0);
      const last = segments.length > 0 ? segments[segments.length - 1] : undefined;
      return (last ?? line).replace(/\s+$/, '');
    });
}

/** Fold consecutive identical lines into one entry with a repeat count. */
function dedupeRuns(lines: string[]): LineEntry[] {
  const entries: LineEntry[] = [];
  for (const line of lines) {
    const last = entries[entries.length - 1];
    if (last && last.text === line) last.count += 1;
    else entries.push({ text: line, count: 1 });
  }
  return entries;
}

function isSignalLine(text: string, family: CommandOutputFamily): boolean {
  if (FAILURE_LINE_RE.test(text)) return true;
  switch (family) {
    case 'test': return TEST_SUMMARY_RE.test(text);
    case 'build': return BUILD_SIGNAL_RE.test(text);
    case 'install': return INSTALL_SIGNAL_RE.test(text);
    case 'git': return GIT_SIGNAL_RE.test(text);
    case 'listing': return false;
    default: return false;
  }
}

function renderEntry(entry: LineEntry): string {
  if (entry.text.length === 0) return ''; // folded blank lines stay blank
  return entry.count > 1 ? `${entry.text} (×${entry.count})` : entry.text;
}

/**
 * How many quiet (noise) lines a filter keeps at the head/tail. Signal
 * lines are never counted here — failures are kept in full regardless.
 * Failing generic output earns a wide window (stack frames and error
 * context classify as noise); in the structured families the failure
 * itself is signal, so passing noise stays folded even on failure.
 */
function noiseBudget(family: CommandOutputFamily, failed: boolean): { head: number; tail: number } {
  switch (family) {
    case 'listing': return { head: 25, tail: 5 };
    case 'test': return failed ? { head: 4, tail: 4 } : { head: 3, tail: 3 };
    case 'build': return failed ? { head: 6, tail: 12 } : { head: 4, tail: 6 };
    case 'install': return failed ? { head: 6, tail: 10 } : { head: 6, tail: 8 };
    case 'git': return failed ? { head: 8, tail: 15 } : { head: 6, tail: 8 };
    default: return failed ? { head: 10, tail: 20 } : { head: 6, tail: 8 };
  }
}

/**
 * Keep every signal line verbatim (plus the first two lines for context),
 * keep a bounded head/tail of the quiet lines, and mark each omitted run
 * with one counted marker line.
 */
function renderCompressed(entries: LineEntry[], family: CommandOutputFamily, failed: boolean): string {
  const { head: headKeep, tail: tailKeep } = noiseBudget(family, failed);
  const signal = entries.map((entry) => isSignalLine(entry.text, family));
  const noiseIndexes = entries.map((_entry, i) => (signal[i] ? -1 : i)).filter((i) => i >= 0);
  const keptNoise = new Set<number>([
    ...noiseIndexes.slice(0, headKeep),
    ...(tailKeep > 0 ? noiseIndexes.slice(noiseIndexes.length - tailKeep) : []),
  ]);
  const out: string[] = [];
  let omitted = 0;
  const flushOmitted = () => {
    if (omitted > 0) {
      out.push(`[... ${omitted} line${omitted === 1 ? '' : 's'} omitted by ${family} output compression; failures kept verbatim ...]`);
      omitted = 0;
    }
  };
  entries.forEach((entry, i) => {
    const kept = i < 2 || signal[i] || keptNoise.has(i);
    if (!kept) {
      omitted += entry.count;
      return;
    }
    flushOmitted();
    out.push(renderEntry(entry));
  });
  flushOmitted();
  return out.join('\n');
}

/** Git diffs end with a compact +/- census the model can cite. */
function diffSummarySuffix(lines: string[], family: CommandOutputFamily): string {
  if (family !== 'git') return '';
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('diff --git')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  if (files === 0) return '';
  return `\n[git diff summary: ${files} file${files === 1 ? '' : 's'}, +${added} -${removed} lines]`;
}

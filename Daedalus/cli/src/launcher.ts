import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, resolveDaedalusHome } from '@daedalus/core';
import { detectTray, type TrayStatus } from './tray.ts';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** Strip ANSI escapes, tabs, and control characters from terminal text. */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

/** Terminal cell width of one code point (combining = 0, East Asian wide/fullwidth and emoji = 2). */
function charCellWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // combining diacriticals
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) // Hangul Jamo
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf) // CJK radicals, kana, han
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3) // Hangul syllables
    || (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) // CJK compatibility forms
    || (codePoint >= 0xff00 && codePoint <= 0xff60) // fullwidth forms
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff) // emoji and symbols
    || (codePoint >= 0x20000 && codePoint <= 0x2fffd)
    || (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Visible terminal-cell width of a string (escapes stripped). */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of sanitizeTerminalText(text)) width += charCellWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/**
 * Truncate `text` to at most `width` terminal cells (ellipsis when cut).
 * Escape sequences are stripped rather than sliced, so the result can never
 * contain a partial escape or split a surrogate pair.
 */
export function truncateVisible(text: string, width: number): string {
  if (width <= 0) return '';
  const clean = sanitizeTerminalText(text.replace(/[\r\n]+/g, ' '));
  if (visibleWidth(clean) <= width) return clean;
  if (width === 1) return '…';
  const budget = width - 1;
  let used = 0;
  let out = '';
  for (const ch of clean) {
    const w = charCellWidth(ch.codePointAt(0) ?? 0);
    if (used + w > budget) break;
    used += w;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

export type DaemonState = {
  pid: number;
  host: string;
  port: number;
  started_at: string;
  server_url: string;
  /** Directory the daemon was launched from; its session workspace anchor. */
  workspace?: string;
};

export type DaemonStatus = {
  running: boolean;
  healthy: boolean;
  pid?: number;
  host: string;
  port: number;
  server_url: string;
  started_at?: string;
  /** Workspace the running daemon session is anchored to, when known. */
  workspace?: string;
  state_file: string;
  tray: TrayStatus;
  reason?: string;
};

export type DaemonOptions = {
  home?: string;
  host?: string;
  port?: number;
  /** Invocation directory; a freshly started daemon anchors its session workspace here. */
  cwd?: string;
  fetchImpl?: typeof fetch;
  spawnServer?: (options: { home: string; envHome?: string; host: string; port: number; serverUrl: string; workspace: string }) => Promise<{ pid: number }> | { pid: number };
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type EnsureDaemonResult = {
  status: DaemonStatus;
  started: boolean;
  state?: DaemonState;
};

export function daemonHome(options: DaemonOptions = {}): string {
  // The daemon is launched for the current workspace. Anchoring the default
  // `.daedalus` home to that workspace makes `daedalus`, `daedalus run
  // --cwd <same folder>`, and the Web gateway opened for that folder share
  // one local store. An absolute DAEDALUS_HOME remains an explicit override.
  return resolveDaedalusHome(options.home ?? loadSettings().daedalusHome, options.cwd ?? process.cwd());
}

function daemonEnvHome(options: DaemonOptions = {}): string {
  // Preserve a relative home as relative for the server process: the gateway
  // resolves it per selected workspace, so selecting another shared workspace
  // in the Web uses that folder's `.daedalus` too. Absolute homes are passed
  // through unchanged and win as an explicit override.
  return options.home ?? loadSettings().daedalusHome;
}

export function daemonStatePath(options: DaemonOptions = {}): string {
  return join(daemonHome(options), 'daemon.json');
}

export function daemonLogPath(options: DaemonOptions = {}): string {
  return join(daemonHome(options), 'daemon.log');
}

export function serverUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function serverMainPath(): string {
  return fileURLToPath(new URL('../../server/src/main.ts', import.meta.url));
}

export async function readDaemonState(options: DaemonOptions = {}): Promise<DaemonState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(daemonStatePath(options), 'utf8')) as Partial<DaemonState>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string' || typeof parsed.port !== 'number' || typeof parsed.server_url !== 'string') return undefined;
    return {
      pid: parsed.pid,
      host: parsed.host,
      port: parsed.port,
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : new Date(0).toISOString(),
      server_url: parsed.server_url,
      ...(typeof parsed.workspace === 'string' ? { workspace: parsed.workspace } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function writeDaemonState(state: DaemonState, options: DaemonOptions = {}): Promise<void> {
  const file = daemonStatePath(options);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => undefined);
}

export async function removeDaemonState(options: DaemonOptions = {}): Promise<void> {
  await rm(daemonStatePath(options), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function probeHealth(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL('/health', url), { signal: AbortSignal.timeout(1_200) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { status?: unknown };
    return body.status === undefined || body.status === 'ok';
  } catch {
    return false;
  }
}

export async function getDaemonStatus(options: DaemonOptions = {}): Promise<DaemonStatus> {
  const settings = loadSettings();
  const host = options.host ?? settings.server.host;
  const port = options.port ?? settings.server.port;
  const state = await readDaemonState(options);
  const url = state?.server_url ?? serverUrl(host, port);
  const healthy = await probeHealth(url, options.fetchImpl ?? fetch);
  const alive = state ? (options.isAlive ?? isProcessAlive)(state.pid) : false;
  return {
    running: healthy || alive,
    healthy,
    pid: state?.pid,
    host: state?.host ?? host,
    port: state?.port ?? port,
    server_url: url,
    started_at: state?.started_at,
    workspace: state?.workspace,
    state_file: daemonStatePath(options),
    tray: detectTray(),
    reason: state && !healthy && !alive ? 'stale daemon state; server is not running' : healthy ? undefined : 'server is not reachable',
  };
}

export async function ensureDaemon(options: DaemonOptions = {}): Promise<EnsureDaemonResult> {
  const settings = loadSettings();
  const home = daemonHome(options);
  const host = options.host ?? settings.server.host;
  const port = options.port ?? settings.server.port;
  const url = serverUrl(host, port);
  // The directory `daedalus` was invoked in becomes the daemon session's
  // workspace anchor (the server honours DAEDALUS_WORKSPACE). An existing
  // healthy daemon is reused as-is — never restarted, never re-anchored.
  const workspace = resolve(options.cwd ?? process.cwd());
  const existing = await getDaemonStatus(options);
  if (existing.healthy) {
    return { status: existing, started: false, state: await readDaemonState(options) };
  }

  const spawned = await (options.spawnServer ?? defaultSpawnServer)({ home, envHome: daemonEnvHome(options), host, port, serverUrl: url, workspace });
  const state: DaemonState = {
    pid: spawned.pid,
    host,
    port,
    started_at: new Date().toISOString(),
    server_url: url,
    workspace,
  };
  await writeDaemonState(state, options);

  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getDaemonStatus(options);
    if (status.healthy) return { status, started: true, state };
    if (Date.now() >= deadline) {
      throw new Error(`Daedalus server did not become healthy at ${url} within ${timeoutMs}ms (pid ${spawned.pid}, log: ${daemonLogPath(options)})`);
    }
    await delay(intervalMs);
  }
}

export async function stopDaemon(options: DaemonOptions = {}): Promise<{ stopped: boolean; pid?: number; reason: string; status: DaemonStatus }> {
  const state = await readDaemonState(options);
  if (!state) {
    const status = await getDaemonStatus(options);
    return { stopped: false, reason: status.healthy ? 'server is reachable but is not managed by the daemon state file' : 'daemon is not running', status };
  }
  const alive = (options.isAlive ?? isProcessAlive)(state.pid);
  if (!alive) {
    await removeDaemonState(options);
    const status = await getDaemonStatus(options);
    return { stopped: false, pid: state.pid, reason: 'daemon process was already gone; stale state removed', status };
  }

  const signal = options.signal ?? ((pid, sig) => process.kill(pid, sig));
  const isAlive = options.isAlive ?? isProcessAlive;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.pollIntervalMs ?? 50;
  // Poll until the pid is gone; true when it exited within the window.
  const waitForExit = async (): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!isAlive(state.pid)) return true;
      await delay(intervalMs);
    }
    return !isAlive(state.pid);
  };

  signal(state.pid, 'SIGTERM');
  let exited = await waitForExit();
  let forced = false;
  if (!exited) {
    // The graceful window elapsed: force it. This is the one stop mechanism
    // shared by `daedalus stop` and the launcher's Exit choice.
    signal(state.pid, 'SIGKILL');
    forced = true;
    exited = await waitForExit();
  }
  if (exited) await removeDaemonState(options);
  const status = await getDaemonStatus(options);
  return {
    stopped: exited,
    pid: state.pid,
    reason: exited ? (forced ? 'daemon stopped (forced after the SIGTERM window)' : 'daemon stopped') : 'daemon did not exit before the stop timeout',
    status,
  };
}

export type ForegroundChild = {
  pid?: number;
  kill?: (signal?: NodeJS.Signals) => boolean;
  on: (event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
};

export async function startForegroundServer(options: DaemonOptions & {
  spawnImpl?: (command: string, args: string[], spawnOptions: Record<string, unknown>) => ForegroundChild;
  registerSignalHandlers?: boolean;
} = {}): Promise<number> {
  const settings = loadSettings();
  const home = daemonHome(options);
  const host = options.host ?? settings.server.host;
  const port = options.port ?? settings.server.port;
  const url = serverUrl(host, port);
  await mkdir(home, { recursive: true });
  const spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions as never) as ChildProcess);
  const child = spawnImpl(process.execPath, ['--experimental-strip-types', serverMainPath()], {
    stdio: 'inherit',
    env: { ...process.env, DAEDALUS_HOST: host, DAEDALUS_PORT: String(port), DAEDALUS_HOME: daemonEnvHome(options), DAEDALUS_WORKSPACE: resolve(options.cwd ?? process.cwd()) },
  });
  if (typeof child.pid === 'number') {
    await writeDaemonState({ pid: child.pid, host, port, started_at: new Date().toISOString(), server_url: url, workspace: resolve(options.cwd ?? process.cwd()) }, options);
  }

  const forward = (signal: NodeJS.Signals): void => {
    child.kill?.(signal);
  };
  const register = options.registerSignalHandlers !== false;
  if (register) {
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
  }
  try {
    const code = await new Promise<number>((resolveClose) => {
      child.on('close', (exitCode) => resolveClose(exitCode ?? 0));
    });
    return code;
  } finally {
    if (register) {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    }
    const state = await readDaemonState(options);
    if (state && state.pid === child.pid) await removeDaemonState(options);
  }
}

async function defaultSpawnServer(options: { home: string; envHome?: string; host: string; port: number; serverUrl: string; workspace: string }): Promise<{ pid: number }> {
  await mkdir(options.home, { recursive: true });
  const log = openSync(daemonLogPath({ home: options.home }), 'a');
  try {
    const child = spawn(process.execPath, ['--experimental-strip-types', serverMainPath()], {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        DAEDALUS_HOST: options.host,
        DAEDALUS_PORT: String(options.port),
        DAEDALUS_HOME: options.envHome ?? options.home,
        DAEDALUS_WORKSPACE: options.workspace,
      },
    });
    child.unref();
    if (typeof child.pid !== 'number') throw new Error('failed to start Daedalus server child process');
    return { pid: child.pid };
  } finally {
    closeSync(log);
  }
}

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`refusing to open non-http URL: ${url}`);
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const browser = browserCommand(url, platform);
  const child = spawn(browser.command, browser.args, { detached: true, stdio: 'ignore' });
  child.unref();
  return browser;
}

/** Ask a running daemon which workspace its session is anchored to (undefined when it does not say). */
export async function fetchDaemonWorkspace(url: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(new URL('/health', url), { signal: AbortSignal.timeout(1_200) });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => ({}))) as { workspace_root?: unknown };
    return typeof body.workspace_root === 'string' ? body.workspace_root : undefined;
  } catch {
    return undefined;
  }
}

export type MenuAction = 'web' | 'tray' | 'exit' | 'invalid';
export type LauncherAction = Exclude<MenuAction, 'invalid'>;

export type LauncherMenuItem = {
  key: string;
  action: LauncherAction;
  label: string;
  description: string;
};

/**
 * The three launcher choices, in display order (keys 1–3). The launcher
 * starts the harness and opens its Web workspace; the interactive
 * terminal UI was removed (2026-10-08, Farid's decision) because the
 * harness loses nothing without it — every capability lives in core and
 * the Web carries the surfaces a terminal cannot.
 */
export const LAUNCHER_MENU_ITEMS: LauncherMenuItem[] = [
  { key: '1', action: 'web', label: 'Web UI', description: 'Open in Browser' },
  { key: '2', action: 'tray', label: 'Hide to Tray', description: 'Background' },
  { key: '3', action: 'exit', label: 'Exit', description: '' },
];

export function parseMenuChoice(input: string | null | undefined): MenuAction {
  const normalized = (input ?? '').trim().toLowerCase();
  if (normalized === '1') return 'web';
  if (normalized === '2') return 'tray';
  if (normalized === '3' || normalized === '0' || normalized === 'q' || normalized === 'quit' || normalized === 'exit') return 'exit';
  return 'invalid';
}

function launcherStatusLines(status: DaemonStatus): string[] {
  const serverNote = `${status.healthy ? 'running' : 'not healthy'}${status.pid ? `, pid ${status.pid}` : ''}`;
  return [
    `Server: ${status.server_url} (${serverNote})`,
    `Workspace: ${status.workspace ?? process.cwd()}`,
    `Tray: ${status.tray.reason}`,
    `Tray icon: ${status.tray.icon} (placeholder "D" — Farid's final design comes later)`,
  ];
}

/** Numbered text menu (non-TTY fallback); same numbering as the arrow-key menu. */
export function startupMenuText(status: DaemonStatus): string {
  return [
    'Daedalus',
    ...launcherStatusLines(status),
    '',
    'Choose an interface:',
    ...LAUNCHER_MENU_ITEMS.map((item) => `${item.key}  ${item.label}${item.description ? ` (${item.description})` : ''}`),
    '',
  ].join('\n');
}

/**
 * Arrow-key launcher frame (TTY). The `❯` marker shows the current
 * selection; numbers, Enter, and q act immediately, exactly like the
 * numbered text menu.
 */
export function launcherMenuFrame(selection: number, status: DaemonStatus): string {
  const clamped = Math.max(0, Math.min(LAUNCHER_MENU_ITEMS.length - 1, selection));
  const lines = [
    '╭─ Daedalus',
    ...launcherStatusLines(status).map((line) => `│  ${line}`),
    '│',
    ...LAUNCHER_MENU_ITEMS.map((item, index) => {
      const label = `${item.key}  ${item.label}${item.description ? ` (${item.description})` : ''}`;
      return `│  ${index === clamped ? '❯' : ' '} ${label}`;
    }),
    '╰─ ↑/↓ select · Enter confirm · 1–3 jump · q quit',
  ];
  return lines.join('\n');
}

/** Move the arrow-key selection; unknown keys keep it where it is. */
export function nextLauncherSelection(current: number, key: string): number {
  const count = LAUNCHER_MENU_ITEMS.length;
  const clamped = Math.max(0, Math.min(count - 1, current));
  if (key === 'up') return (clamped + count - 1) % count;
  if (key === 'down') return (clamped + 1) % count;
  return clamped;
}

/** Resolve one launcher key press to an action, if it carries one. */
export function launcherKeyAction(key: string, selection: number): LauncherAction | undefined {
  if (key === 'enter' || key === 'return') {
    const item = LAUNCHER_MENU_ITEMS[Math.max(0, Math.min(LAUNCHER_MENU_ITEMS.length - 1, selection))];
    return item?.action;
  }
  if (key === 'q' || key === 'escape') return 'exit';
  return parseMenuChoice(key) === 'invalid' ? undefined : (parseMenuChoice(key) as LauncherAction);
}

export type InPlaceFrameRenderer = {
  /** Terminal rows the most recent painted frame occupies (0 before the first paint). */
  readonly rows: number;
  paint: (frame: string) => void;
  close: () => void;
};

/**
 * Repaints a text frame in place in the normal terminal buffer. The cursor
 * is hidden on the first paint; every repaint moves up exactly as many rows
 * as the previous frame occupied, erases each row before rewriting it, and
 * erases anything below when the frame shrinks. Every line is clipped to
 * the terminal width first (cell-accurate, via the same helper the
 * fullscreen TUI uses), so a painted line can never wrap and the row count
 * stays exact — resizing is safe because the width is re-read and every row
 * is erased on each paint. `close()` shows the cursor again and steps below
 * the frame, leaving exactly one clean copy of the final frame in the
 * scrollback. `close()` is idempotent.
 */
export function createInPlaceFrameRenderer(deps: {
  write: (text: string) => void;
  columns: () => number;
}): InPlaceFrameRenderer {
  let rows = 0;
  let closed = false;
  const paint = (frame: string): void => {
    if (closed) return;
    const width = Math.max(1, Math.floor(deps.columns()) || 1);
    const lines = frame.split('\n').map((line) => truncateVisible(line, width));
    let out = rows === 0 ? '\x1b[?25l' : `\x1b[${rows - 1}A\r`;
    out += lines.map((line) => `\x1b[K${line}`).join('\r\n');
    if (lines.length < rows) out += '\x1b[J';
    deps.write(out);
    rows = lines.length;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (rows > 0) deps.write('\x1b[?25h\n');
    rows = 0;
  };
  return {
    get rows() {
      return rows;
    },
    paint,
    close,
  };
}

/** Outcome of the one shared stop mechanism (`daedalus stop` / launcher Exit). */
export type StopServerResult = { stopped: boolean; pid?: number; reason: string };

export type LauncherChoiceDeps = {
  status: DaemonStatus;
  print: (text: string) => void;
  openWeb: () => Promise<void>;
  hideToTray?: () => Promise<void> | void;
  /** Stop the background server; the launcher's `Exit` choice goes through this. */
  stopServer: () => Promise<StopServerResult>;
};

/**
 * Carry out one chosen launcher action and print what happens next. The
 * background server keeps running for Web and Tray; `Exit` shuts it down
 * through the same stop mechanism as `daedalus stop`. Returns the action
 * so callers can react further.
 */
export async function runLauncherChoice(action: LauncherAction, deps: LauncherChoiceDeps): Promise<LauncherAction> {
  const url = deps.status.server_url;
  switch (action) {
    case 'web':
      await deps.openWeb();
      deps.print(`Web UI: ${url} (server keeps running in the background; \`daedalus stop\` stops it).\n`);
      return 'web';
    case 'tray':
      await deps.hideToTray?.();
      deps.print(`Background mode: only the server keeps running at ${url}. Tray: ${deps.status.tray.reason}\n`);
      return 'tray';
    case 'exit': {
      let line: string;
      try {
        const result = await deps.stopServer();
        if (result.stopped) line = `Daedalus server stopped${result.pid ? ` (pid ${result.pid})` : ''}. Bye.\n`;
        else if (/not running|already gone/i.test(result.reason)) line = 'No server running. Bye.\n';
        else line = `Could not stop the Daedalus server: ${result.reason}. Bye.\n`;
      } catch (error) {
        line = `Could not stop the Daedalus server: ${error instanceof Error ? error.message : String(error)}. Bye.\n`;
      }
      deps.print(line);
      return 'exit';
    }
  }
}

/** Numbered text menu: loops only on invalid input; every real choice exits the menu. */
export async function runStartupMenu(deps: LauncherChoiceDeps & {
  readChoice: () => Promise<string | null>;
}): Promise<LauncherAction> {
  deps.print(startupMenuText(deps.status));
  for (;;) {
    const action = parseMenuChoice(await deps.readChoice());
    if (action === 'invalid') {
      deps.print('Please choose 1, 2, 3, or q.\n');
      continue;
    }
    return runLauncherChoice(action, deps);
  }
}

/**
 * Arrow-key launcher menu (TTY): re-renders via `render` after every key,
 * one key press at a time, until a choice is made.
 */
export async function runLauncherMenu(deps: LauncherChoiceDeps & {
  readKey: () => Promise<string>;
  render: (frame: string) => void;
  initialSelection?: number;
}): Promise<LauncherAction> {
  let selection = deps.initialSelection ?? 0;
  for (;;) {
    deps.render(launcherMenuFrame(selection, deps.status));
    const key = await deps.readKey();
    if (key === 'up' || key === 'down') {
      selection = nextLauncherSelection(selection, key);
      continue;
    }
    const action = launcherKeyAction(key, selection);
    if (action) return runLauncherChoice(action, deps);
  }
}

export async function runBareLauncher(deps: {
  ensureDaemon: () => Promise<EnsureDaemonResult>;
  readChoice: () => Promise<string | null>;
  print: (text: string) => void;
  openWeb: (url: string) => Promise<void>;
  hideToTray?: () => Promise<void> | void;
  stopServer: () => Promise<StopServerResult>;
}): Promise<LauncherAction> {
  const ensured = await deps.ensureDaemon();
  return runStartupMenu({
    status: ensured.status,
    readChoice: deps.readChoice,
    print: deps.print,
    openWeb: () => deps.openWeb(ensured.status.server_url),
    hideToTray: deps.hideToTray,
    stopServer: deps.stopServer,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

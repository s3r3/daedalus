import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  browserCommand,
  daemonStatePath,
  ensureDaemon,
  getDaemonStatus,
  launcherKeyAction,
  launcherMenuFrame,
  nextLauncherSelection,
  parseMenuChoice,
  readDaemonState,
  runLauncherMenu,
  runStartupMenu,
  startupMenuText,
  stopDaemon,
  writeDaemonState,
  type DaemonState,
} from '../src/launcher.ts';
import { TrayManager, TRAY_ICON_PATH, detectTray, trayMenuItems } from '../src/tray.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function state(pid = 1234): DaemonState {
  return { pid, host: '127.0.0.1', port: 3080, started_at: '2026-10-05T00:00:00.000Z', server_url: 'http://127.0.0.1:3080' };
}

describe('workspace anchoring', () => {
  test('ensureDaemon spawns the daemon anchored at the invocation cwd and records it', async () => {
    const home = temp('daedalus-daemon-anchor-');
    const workspace = temp('daedalus-daemon-ws-');
    let fetches = 0;
    const spawnServer = vi.fn(async () => ({ pid: 7777 }));
    const result = await ensureDaemon({
      home,
      cwd: workspace,
      fetchImpl: async () => healthResponse(++fetches > 1),
      isAlive: () => true,
      spawnServer,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(result.started).toBe(true);
    expect(spawnServer).toHaveBeenCalledWith(expect.objectContaining({ workspace }));
    expect(result.status.workspace).toBe(workspace);
    await expect(readDaemonState({ home })).resolves.toMatchObject({ pid: 7777, workspace });
  });

  test('daemon state round-trips the recorded workspace', async () => {
    const home = temp('daedalus-daemon-ws-state-');
    await writeDaemonState({ ...state(), workspace: '/tmp/somewhere' }, { home });
    await expect(readDaemonState({ home })).resolves.toMatchObject({ workspace: '/tmp/somewhere' });
  });
});

describe('launcher arrow-key menu', () => {
  const frameStatus = {
    running: true,
    healthy: true,
    pid: 42,
    host: '127.0.0.1',
    port: 3080,
    server_url: 'http://127.0.0.1:3080',
    workspace: '/home/you/project',
    state_file: '/tmp/daemon.json',
    tray: detectTray({}, 'linux'),
  };

  test('frame shows the four choices, the selection marker, URL, and workspace', () => {
    const frame = launcherMenuFrame(0, frameStatus);
    expect(frame).toContain('Daedalus');
    expect(frame).toContain('http://127.0.0.1:3080');
    expect(frame).toContain('/home/you/project');
    expect(frame).toContain('❯ 1  Web UI (Open in Browser)');
    expect(frame).toContain('2  Terminal UI (Interactive CLI)');
    expect(frame).toContain('3  Hide to Tray (Background)');
    expect(frame).toContain('4  Exit');
    expect(launcherMenuFrame(2, frameStatus)).toContain('❯ 3  Hide to Tray (Background)');
  });

  test('selection wraps and keys map to actions', () => {
    expect(nextLauncherSelection(0, 'up')).toBe(3);
    expect(nextLauncherSelection(3, 'down')).toBe(0);
    expect(nextLauncherSelection(1, 'down')).toBe(2);
    expect(launcherKeyAction('enter', 0)).toBe('web');
    expect(launcherKeyAction('enter', 1)).toBe('cli');
    expect(launcherKeyAction('3', 0)).toBe('tray');
    expect(launcherKeyAction('q', 2)).toBe('exit');
    expect(launcherKeyAction('escape', 0)).toBe('exit');
    expect(launcherKeyAction('z', 0)).toBeUndefined();
  });

  test('arrow keys navigate, then Enter opens the Web', async () => {
    const openWeb = vi.fn(async () => undefined);
    const openCli = vi.fn(async () => undefined);
    const printed: string[] = [];
    const keys = ['down', 'up', 'enter'];
    const result = await runLauncherMenu({
      status: frameStatus,
      print: (text) => printed.push(text),
      openCli,
      openWeb,
      render: () => undefined,
      readKey: async () => keys.shift() ?? 'enter',
    });
    expect(result).toBe('web');
    expect(openWeb).toHaveBeenCalledTimes(1);
    expect(openCli).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('server keeps running in the background');
  });

  test('number key 3 hides to tray and reports the honest backend note', async () => {
    const hideToTray = vi.fn(async () => undefined);
    const printed: string[] = [];
    const result = await runLauncherMenu({
      status: frameStatus,
      print: (text) => printed.push(text),
      openCli: async () => undefined,
      openWeb: async () => undefined,
      hideToTray,
      render: () => undefined,
      readKey: async () => '3',
    });
    expect(result).toBe('tray');
    expect(hideToTray).toHaveBeenCalledTimes(1);
    expect(printed.join('\n')).toContain('only the server keeps running');
  });
});

function healthResponse(ok: boolean): Response {
  return new Response(JSON.stringify({ status: ok ? 'ok' : 'down' }), { status: ok ? 200 : 503, headers: { 'content-type': 'application/json' } });
}

describe('daemon state', () => {
  test('writes and reads daemon.json', async () => {
    const home = temp('daedalus-daemon-home-');
    await writeDaemonState(state(), { home });
    expect(existsSync(daemonStatePath({ home }))).toBe(true);
    expect(JSON.parse(readFileSync(daemonStatePath({ home }), 'utf8'))).toMatchObject({ pid: 1234 });
    await expect(readDaemonState({ home })).resolves.toMatchObject({ pid: 1234, server_url: 'http://127.0.0.1:3080' });
  });

  test('reports a stale state when the pid is gone and health fails', async () => {
    const home = temp('daedalus-daemon-stale-');
    await writeDaemonState(state(999_999), { home });
    const status = await getDaemonStatus({ home, fetchImpl: async () => healthResponse(false), isAlive: () => false });
    expect(status.healthy).toBe(false);
    expect(status.running).toBe(false);
    expect(status.reason).toContain('stale');
    expect(status.tray.reason).toContain('daedalus status');
  });
});

describe('ensureDaemon', () => {
  test('reuses a healthy server without spawning another one', async () => {
    const home = temp('daedalus-daemon-reuse-');
    await writeDaemonState(state(4321), { home });
    const spawnServer = vi.fn(async () => ({ pid: 9999 }));
    const result = await ensureDaemon({
      home,
      fetchImpl: async () => healthResponse(true),
      isAlive: () => true,
      spawnServer,
    });
    expect(result.started).toBe(false);
    expect(result.status.healthy).toBe(true);
    expect(spawnServer).not.toHaveBeenCalled();
  });

  test('starts exactly one server and waits until healthy', async () => {
    const home = temp('daedalus-daemon-start-');
    let fetches = 0;
    const spawnServer = vi.fn(async () => ({ pid: 2222 }));
    const result = await ensureDaemon({
      home,
      fetchImpl: async () => healthResponse(++fetches > 1),
      isAlive: () => true,
      spawnServer,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(result.started).toBe(true);
    expect(result.state?.pid).toBe(2222);
    expect(spawnServer).toHaveBeenCalledTimes(1);
    await expect(readDaemonState({ home })).resolves.toMatchObject({ pid: 2222 });
  });
});

describe('stopDaemon', () => {
  test('signals the recorded pid and removes state after exit', async () => {
    const home = temp('daedalus-daemon-stop-');
    await writeDaemonState(state(3333), { home });
    let aliveChecks = 0;
    const signal = vi.fn();
    const result = await stopDaemon({
      home,
      fetchImpl: async () => healthResponse(false),
      isAlive: () => ++aliveChecks < 3,
      signal,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(signal).toHaveBeenCalledWith(3333, 'SIGTERM');
    expect(result).toMatchObject({ stopped: true, pid: 3333 });
    expect(existsSync(daemonStatePath({ home }))).toBe(false);
  });

  test('reports when no daemon is running', async () => {
    const home = temp('daedalus-daemon-none-');
    const result = await stopDaemon({ home, fetchImpl: async () => healthResponse(false) });
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain('not running');
  });
});

describe('startup menu', () => {
  test('parses menu choices', () => {
    expect(parseMenuChoice('1')).toBe('web');
    expect(parseMenuChoice('2')).toBe('cli');
    expect(parseMenuChoice('3')).toBe('tray');
    expect(parseMenuChoice('4')).toBe('exit');
    expect(parseMenuChoice('0')).toBe('exit');
    expect(parseMenuChoice('q')).toBe('exit');
    expect(parseMenuChoice('x')).toBe('invalid');
  });

  test('choice 1 opens Web and exits the menu while the server keeps running', async () => {
    const choices = ['x', '1'];
    const printed: string[] = [];
    const openWeb = vi.fn(async () => undefined);
    const openCli = vi.fn(async () => undefined);
    const status = {
      running: true,
      healthy: true,
      pid: 123,
      host: '127.0.0.1',
      port: 3080,
      server_url: 'http://127.0.0.1:3080',
      state_file: '/tmp/daemon.json',
      tray: detectTray({}, 'linux'),
    };
    const result = await runStartupMenu({
      status,
      readChoice: async () => choices.shift() ?? '4',
      print: (text) => printed.push(text),
      openCli,
      openWeb,
    });
    expect(result).toBe('web');
    expect(openWeb).toHaveBeenCalledTimes(1);
    expect(openCli).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('1  Web UI (Open in Browser)');
    expect(printed.join('\n')).toContain('server keeps running in the background');
    expect(startupMenuText(status)).toContain('Choose an interface:');
  });

  test('choice 2 opens the CLI', async () => {
    const openCli = vi.fn(async () => undefined);
    const result = await runStartupMenu({
      status: {
        running: true,
        healthy: true,
        host: '127.0.0.1',
        port: 3080,
        server_url: 'http://127.0.0.1:3080',
        state_file: '/tmp/daemon.json',
        tray: detectTray({}, 'linux'),
      },
      readChoice: async () => '2',
      print: () => undefined,
      openCli,
      openWeb: async () => undefined,
    });
    expect(result).toBe('cli');
    expect(openCli).toHaveBeenCalledTimes(1);
  });

  test('choice 4 exits and reports the server state is unchanged', async () => {
    const printed: string[] = [];
    const result = await runStartupMenu({
      status: {
        running: true,
        healthy: true,
        host: '127.0.0.1',
        port: 3080,
        server_url: 'http://127.0.0.1:3080',
        state_file: '/tmp/daemon.json',
        tray: detectTray({}, 'linux'),
      },
      readChoice: async () => '4',
      print: (text) => printed.push(text),
      openCli: async () => undefined,
      openWeb: async () => undefined,
    });
    expect(result).toBe('exit');
    expect(printed.join('\n')).toContain('server state is unchanged');
  });
});

describe('browser command', () => {
  test('uses the platform opener', () => {
    expect(browserCommand('http://127.0.0.1:3080', 'linux')).toEqual({ command: 'xdg-open', args: ['http://127.0.0.1:3080'] });
    expect(browserCommand('http://127.0.0.1:3080', 'darwin')).toEqual({ command: 'open', args: ['http://127.0.0.1:3080'] });
    expect(browserCommand('http://127.0.0.1:3080', 'win32')).toEqual({ command: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:3080'] });
    expect(() => browserCommand('file:///etc/passwd', 'linux')).toThrow(/non-http/);
  });
});

describe('tray manager', () => {
  test('honestly reports no tray in a headless environment', () => {
    const status = detectTray({}, 'linux');
    expect(status.available).toBe(false);
    expect(status.desktopSession).toBe(false);
    expect(status.reason).toContain('no tray in this environment');
    expect(status.reason).toContain('daedalus stop');
    expect(status.icon.endsWith('tray-icon.svg')).toBe(true);
    expect(existsSync(TRAY_ICON_PATH)).toBe(true);
  });

  test('menu contains Open CLI, Open Web, Status, and Quit', () => {
    expect(trayMenuItems().map((item) => item.label)).toEqual(['Open CLI', 'Open Web', 'Status', 'Quit']);
  });

  test('Quit runs the quit handler before hiding the tray', async () => {
    const order: string[] = [];
    const backend = {
      name: 'fake-tray',
      show: vi.fn(async () => undefined),
      hide: vi.fn(async () => {
        order.push('hide');
      }),
    };
    const tray = new TrayManager(
      {
        onQuit: async () => {
          order.push('quit');
        },
      },
      backend,
      { DISPLAY: ':0' },
      'linux',
    );
    const started = await tray.start();
    expect(started.available).toBe(true);
    expect(backend.show).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ label: 'Quit' })]), expect.any(Function));
    await tray.handleAction('quit');
    expect(order).toEqual(['quit', 'hide']);
    expect(tray.status().available).toBe(false);
  });
});

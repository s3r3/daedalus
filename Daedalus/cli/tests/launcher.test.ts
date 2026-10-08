import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  browserCommand,
  createInPlaceFrameRenderer,
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
import { visibleWidth } from '../src/launcher.ts';
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

  test('frame shows the three choices, the selection marker, URL, and workspace', () => {
    const frame = launcherMenuFrame(0, frameStatus);
    expect(frame).toContain('Daedalus');
    expect(frame).toContain('http://127.0.0.1:3080');
    expect(frame).toContain('/home/you/project');
    expect(frame).toContain('❯ 1  Web UI (Open in Browser)');
    expect(frame).toContain('2  Hide to Tray (Background)');
    expect(frame).toContain('3  Exit');
    expect(launcherMenuFrame(1, frameStatus)).toContain('❯ 2  Hide to Tray (Background)');
  });

  test('selection wraps and keys map to actions', () => {
    expect(nextLauncherSelection(0, 'up')).toBe(2);
    expect(nextLauncherSelection(2, 'down')).toBe(0);
    expect(nextLauncherSelection(1, 'down')).toBe(2);
    expect(launcherKeyAction('enter', 0)).toBe('web');
    expect(launcherKeyAction('enter', 1)).toBe('tray');
    expect(launcherKeyAction('2', 0)).toBe('tray');
    expect(launcherKeyAction('3', 0)).toBe('exit');
    expect(launcherKeyAction('q', 2)).toBe('exit');
    expect(launcherKeyAction('escape', 0)).toBe('exit');
    expect(launcherKeyAction('z', 0)).toBeUndefined();
  });

  const stopServer = vi.fn(async () => ({ stopped: false, reason: 'daemon is not running' }));

  test('arrow keys navigate, then Enter opens the Web', async () => {
    const openWeb = vi.fn(async () => undefined);
    const printed: string[] = [];
    const keys = ['down', 'up', 'enter'];
    const result = await runLauncherMenu({
      status: frameStatus,
      print: (text) => printed.push(text),
      openWeb,
      stopServer,
      render: () => undefined,
      readKey: async () => keys.shift() ?? 'enter',
    });
    expect(result).toBe('web');
    expect(openWeb).toHaveBeenCalledTimes(1);
    expect(stopServer).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('server keeps running in the background');
  });

  test('number key 2 hides to tray and reports the honest backend note', async () => {
    const hideToTray = vi.fn(async () => undefined);
    const printed: string[] = [];
    const result = await runLauncherMenu({
      status: frameStatus,
      print: (text) => printed.push(text),
      openWeb: async () => undefined,
      hideToTray,
      stopServer,
      render: () => undefined,
      readKey: async () => '2',
    });
    expect(result).toBe('tray');
    expect(hideToTray).toHaveBeenCalledTimes(1);
    expect(stopServer).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('only the server keeps running');
  });
});

describe('launcher Exit shuts the server down', () => {
  const exitStatus = {
    running: true,
    healthy: true,
    pid: 4242,
    host: '127.0.0.1',
    port: 3080,
    server_url: 'http://127.0.0.1:3080',
    workspace: '/home/you/project',
    state_file: '/tmp/daemon.json',
    tray: detectTray({}, 'linux'),
  };

  test('pressing q stops the server through the injected mechanism', async () => {
    const printed: string[] = [];
    const stopServer = vi.fn(async () => ({ stopped: true, pid: 4242, reason: 'daemon stopped' }));
    const openWeb = vi.fn(async () => undefined);
    const result = await runLauncherMenu({
      status: exitStatus,
      print: (text) => printed.push(text),
      openWeb,
      stopServer,
      render: () => undefined,
      readKey: async () => 'q',
    });
    expect(result).toBe('exit');
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(openWeb).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('Daedalus server stopped (pid 4242). Bye.');
  });

  test('Exit with no server running says so and still exits cleanly', async () => {
    const printed: string[] = [];
    const stopServer = vi.fn(async () => ({ stopped: false, reason: 'daemon is not running' }));
    const result = await runLauncherMenu({
      status: exitStatus,
      print: (text) => printed.push(text),
      openWeb: async () => undefined,
      stopServer,
      render: () => undefined,
      readKey: async () => '3',
    });
    expect(result).toBe('exit');
    expect(printed.join('\n')).toContain('No server running. Bye.');
  });

  test('a failing stop is reported honestly and the menu still exits', async () => {
    const printed: string[] = [];
    const stopServer = vi.fn(async () => {
      throw new Error('kill EPERM');
    });
    const result = await runLauncherMenu({
      status: exitStatus,
      print: (text) => printed.push(text),
      openWeb: async () => undefined,
      stopServer,
      render: () => undefined,
      readKey: async () => 'q',
    });
    expect(result).toBe('exit');
    expect(printed.join('\n')).toContain('Could not stop the Daedalus server: kill EPERM. Bye.');
  });

  test('a stop that times out is reported honestly', async () => {
    const printed: string[] = [];
    const stopServer = vi.fn(async () => ({ stopped: false, pid: 4242, reason: 'daemon did not exit before the stop timeout' }));
    const result = await runLauncherMenu({
      status: exitStatus,
      print: (text) => printed.push(text),
      openWeb: async () => undefined,
      stopServer,
      render: () => undefined,
      readKey: async () => '3',
    });
    expect(result).toBe('exit');
    expect(printed.join('\n')).toContain('Could not stop the Daedalus server: daemon did not exit before the stop timeout. Bye.');
  });
});

/**
 * Minimal terminal model — just enough (printable writes with auto-wrap
 * pending, CR/LF, CSI A/K/J, cursor visibility ignored) to prove that
 * in-place repaints never grow the occupied rows. Glyphs in the launcher
 * frame are all single-cell, so one code point = one cell here.
 */
function emulateTerminal(output: string, columns: number): string[] {
  const rows: string[] = [];
  let row = 0;
  let col = 0;
  let wrapPending = false;
  const ensure = (r: number): void => {
    while (rows.length <= r) rows.push('');
  };
  const put = (ch: string): void => {
    if (wrapPending) {
      row += 1;
      col = 0;
      wrapPending = false;
    }
    ensure(row);
    const line = rows[row] ?? '';
    rows[row] = `${line.slice(0, col)}${ch}${line.slice(col + 1)}`;
    col += 1;
    if (col >= columns) wrapPending = true;
  };
  let i = 0;
  while (i < output.length) {
    const ch = output[i]!;
    if (ch === '\x1b') {
      const match = /^\x1b\[([0-9;?]*)([A-Za-z@`~])/.exec(output.slice(i, i + 16));
      if (match) {
        const params = match[1] ?? '';
        const final = match[2] ?? '';
        const n = Number.parseInt(params, 10) || 1;
        wrapPending = false;
        if (final === 'A') row = Math.max(0, row - n);
        else if (final === 'K') {
          ensure(row);
          rows[row] = (rows[row] ?? '').slice(0, col);
        } else if (final === 'J') {
          ensure(row);
          rows[row] = (rows[row] ?? '').slice(0, col);
          rows.length = row + 1;
        }
        i += match[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '\r') {
      col = 0;
      wrapPending = false;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 0;
      wrapPending = false;
      i += 1;
      continue;
    }
    put(ch);
    i += 1;
  }
  return rows;
}

describe('in-place frame renderer', () => {
  const menuStatus = {
    running: true,
    healthy: true,
    pid: 42,
    host: '127.0.0.1',
    port: 3080,
    server_url: 'http://127.0.0.1:3080',
    workspace: '/home/xyconix11x/Ayid/xyconix11x/Skripsi/Daedalus',
    state_file: '/tmp/daemon.json',
    tray: detectTray({}, 'linux'),
  };
  const frameRows = launcherMenuFrame(0, menuStatus).split('\n').length;

  test('first paint hides the cursor, repaints move up rows-1 and erase rows', () => {
    const writes: string[] = [];
    const renderer = createInPlaceFrameRenderer({ write: (text) => writes.push(text), columns: () => 100 });
    renderer.paint(launcherMenuFrame(0, menuStatus));
    expect(writes[0]?.startsWith('\x1b[?25l')).toBe(true);
    expect(renderer.rows).toBe(frameRows);
    renderer.paint(launcherMenuFrame(1, menuStatus));
    expect(writes[1]?.startsWith(`\x1b[${frameRows - 1}A\r`)).toBe(true);
    expect(writes[1]).toContain('\x1b[K');
    expect(renderer.rows).toBe(frameRows);
  });

  test('repeated repainting never stacks menu copies in the scrollback', () => {
    let output = '';
    const renderer = createInPlaceFrameRenderer({
      write: (text) => {
        output += text;
      },
      columns: () => 100,
    });
    // The Farid sequence: arrow keys bouncing around the menu.
    for (const selection of [0, 1, 2, 1, 2, 1, 0, 1]) renderer.paint(launcherMenuFrame(selection, menuStatus));
    renderer.close();
    const screen = emulateTerminal(output, 100);
    expect(screen.length).toBe(frameRows);
    expect(screen.filter((line) => line.includes('╭─ Daedalus')).length).toBe(1);
    expect(screen.filter((line) => line.includes('Server: http://127.0.0.1:3080')).length).toBe(1);
    expect(screen.join('\n')).toContain('❯ 2  Hide to Tray (Background)');
    expect(output.match(/\x1b\[\?25l/g)).toHaveLength(1);
    expect(output.match(/\x1b\[\?25h/g)).toHaveLength(1);
    // close() is idempotent: a second close emits nothing more.
    renderer.close();
    expect(output.match(/\x1b\[\?25h/g)).toHaveLength(1);
  });

  test('narrow terminals clip every line, so repaints still occupy one frame', () => {
    let output = '';
    const renderer = createInPlaceFrameRenderer({
      write: (text) => {
        output += text;
      },
      columns: () => 40,
    });
    for (const selection of [0, 1, 2]) renderer.paint(launcherMenuFrame(selection, menuStatus));
    renderer.close();
    const screen = emulateTerminal(output, 40);
    expect(screen.length).toBe(frameRows);
    expect(screen.filter((line) => line.includes('╭─ Daedalus')).length).toBe(1);
    for (const line of screen) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  test('a shrink keeps rows exact because width is re-read and rows erased', () => {
    let columns = 100;
    let output = '';
    const renderer = createInPlaceFrameRenderer({
      write: (text) => {
        output += text;
      },
      columns: () => columns,
    });
    renderer.paint(launcherMenuFrame(0, menuStatus));
    const before = renderer.rows;
    columns = 40; // terminal resized narrower between keypresses
    renderer.paint(launcherMenuFrame(1, menuStatus));
    expect(renderer.rows).toBe(before);
    const repaint = output.slice(output.indexOf(`\x1b[${before - 1}A`));
    for (const line of repaint.split('\r\n')) expect(visibleWidth(line.replace(/\x1b\[[0-9;?]*[A-Za-z@`~]/g, ''))).toBeLessThanOrEqual(40);
    renderer.close();
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

  test('forces with SIGKILL when the daemon ignores SIGTERM', async () => {
    const home = temp('daedalus-daemon-force-');
    await writeDaemonState(state(4444), { home });
    let killed = false;
    const signal = vi.fn((_pid: number, sig: NodeJS.Signals) => {
      if (sig === 'SIGKILL') killed = true;
    });
    const result = await stopDaemon({
      home,
      fetchImpl: async () => healthResponse(false),
      isAlive: () => !killed,
      signal,
      pollIntervalMs: 1,
      timeoutMs: 25,
    });
    expect(signal.mock.calls.map(([, sig]) => sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result).toMatchObject({ stopped: true, pid: 4444 });
    expect(result.reason).toContain('daemon stopped');
    expect(existsSync(daemonStatePath({ home }))).toBe(false);
  });

  test('gives up honestly when even SIGKILL does not reap the pid', async () => {
    const home = temp('daedalus-daemon-unkillable-');
    await writeDaemonState(state(5555), { home });
    const signal = vi.fn();
    const result = await stopDaemon({
      home,
      fetchImpl: async () => healthResponse(false),
      isAlive: () => true,
      signal,
      pollIntervalMs: 1,
      timeoutMs: 25,
    });
    expect(signal.mock.calls.map(([, sig]) => sig)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain('did not exit');
    expect(existsSync(daemonStatePath({ home }))).toBe(true);
  });
});

describe('startup menu', () => {
  test('parses menu choices', () => {
    expect(parseMenuChoice('1')).toBe('web');
    expect(parseMenuChoice('2')).toBe('tray');
    expect(parseMenuChoice('3')).toBe('exit');
    expect(parseMenuChoice('4')).toBe('invalid');
    expect(parseMenuChoice('0')).toBe('exit');
    expect(parseMenuChoice('q')).toBe('exit');
    expect(parseMenuChoice('x')).toBe('invalid');
  });

  test('choice 1 opens Web and exits the menu while the server keeps running', async () => {
    const choices = ['x', '1'];
    const printed: string[] = [];
    const openWeb = vi.fn(async () => undefined);
    const stopServer = vi.fn(async () => ({ stopped: true, pid: 123, reason: 'daemon stopped' }));
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
      readChoice: async () => choices.shift() ?? '3',
      print: (text) => printed.push(text),
      openWeb,
      stopServer,
    });
    expect(result).toBe('web');
    expect(openWeb).toHaveBeenCalledTimes(1);
    expect(stopServer).not.toHaveBeenCalled();
    expect(printed.join('\n')).toContain('1  Web UI (Open in Browser)');
    expect(printed.join('\n')).toContain('server keeps running in the background');
    expect(startupMenuText(status)).toContain('Choose an interface:');
  });

  test('choice 2 hides to tray', async () => {
    const hideToTray = vi.fn(async () => undefined);
    const stopServer = vi.fn(async () => ({ stopped: true, pid: 123, reason: 'daemon stopped' }));
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
      hideToTray,
      openWeb: async () => undefined,
      stopServer,
    });
    expect(result).toBe('tray');
    expect(hideToTray).toHaveBeenCalledTimes(1);
    expect(stopServer).not.toHaveBeenCalled();
  });

  test('choice 3 exits and shuts the server down', async () => {
    const printed: string[] = [];
    const stopServer = vi.fn(async () => ({ stopped: true, pid: 123, reason: 'daemon stopped' }));
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
      readChoice: async () => '3',
      print: (text) => printed.push(text),
      openWeb: async () => undefined,
      stopServer,
    });
    expect(result).toBe('exit');
    expect(stopServer).toHaveBeenCalledTimes(1);
    expect(printed.join('\n')).toContain('Daedalus server stopped (pid 123). Bye.');
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

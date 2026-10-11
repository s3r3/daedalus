import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { detectTray, TRAY_ICON_PNG_PATH, trayMenuItems, type TrayAction } from '../src/tray.ts';
import {
  createTrayBackend,
  LINUX_TRAY_BACKEND_NAME,
  LinuxAppIndicatorBackend,
  linuxTrayAvailable,
  trayDependencyHint,
  type LinuxTraySpawn,
} from '../src/tray-linux.ts';

// Test double for ChildProcess: only the surface LinuxAppIndicatorBackend uses.
const asSpawn = (fn: (command: string, args: string[]) => FakeChild): LinuxTraySpawn =>
  fn as unknown as LinuxTraySpawn;
import { createTrayHandlers, pickTerminal } from '../src/tray-actions.ts';

const DISPLAY = { DISPLAY: ':0' };

describe('linuxTrayAvailable', () => {
  test('false on non-linux platforms', () => {
    expect(linuxTrayAvailable(DISPLAY, 'darwin', () => true)).toBe(false);
    expect(linuxTrayAvailable(DISPLAY, 'win32', () => true)).toBe(false);
  });

  test('false without a desktop session', () => {
    expect(linuxTrayAvailable({}, 'linux', () => true)).toBe(false);
  });

  test('true on linux with display and working bindings', () => {
    expect(linuxTrayAvailable(DISPLAY, 'linux', () => true)).toBe(true);
    expect(linuxTrayAvailable({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux', () => true)).toBe(true);
  });

  test('false when the probe fails or throws', () => {
    expect(linuxTrayAvailable(DISPLAY, 'linux', () => false)).toBe(false);
    expect(linuxTrayAvailable(DISPLAY, 'linux', () => { throw new Error('no python'); })).toBe(false);
  });
});

describe('detectTray with the linux backend', () => {
  test('available when the backend can run', () => {
    const status = detectTray(DISPLAY, 'linux', () => true);
    expect(status.available).toBe(true);
    expect(status.desktopSession).toBe(true);
    expect(status.backend).toBe(LINUX_TRAY_BACKEND_NAME);
    expect(status.backend).toBe('appindicator3');
  });

  test('honest about missing AppIndicator bindings', () => {
    const status = detectTray(DISPLAY, 'linux', () => false);
    expect(status.available).toBe(false);
    expect(status.desktopSession).toBe(true);
    expect(status.reason).toContain('AppIndicator3');
    expect(status.reason).toContain('pacman');
    expect(status.backend).toBe('none');
  });

  test('dependency hint names both distro families', () => {
    expect(trayDependencyHint()).toContain('libappindicator-gtk3');
    expect(trayDependencyHint()).toContain('gir1.2-appindicator3-1');
  });

  test('png icon asset exists next to the svg', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync(TRAY_ICON_PNG_PATH)).toBe(true);
  });
});

describe('createTrayBackend', () => {
  test('returns a backend when available, undefined otherwise', () => {
    expect(createTrayBackend(DISPLAY, 'linux', () => true)).toBeInstanceOf(LinuxAppIndicatorBackend);
    expect(createTrayBackend(DISPLAY, 'linux', () => false)).toBeUndefined();
    expect(createTrayBackend({}, 'linux', () => true)).toBeUndefined();
  });
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}

describe('LinuxAppIndicatorBackend', () => {
  test('spawns the helper with icon and menu JSON, resolves on READY', async () => {
    let seenArgs: string[] = [];
    let seenCommand = '';
    const children: FakeChild[] = [];
    const spawnImpl = ((command: string, args: string[]) => {
      seenCommand = command;
      seenArgs = args;
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const backend = new LinuxAppIndicatorBackend({ spawnImpl: asSpawn(spawnImpl), readyTimeoutMs: 500 });
    const actions: TrayAction[] = [];
    const shown = backend.show(trayMenuItems(), async (action) => { actions.push(action); });
    const child = children[0]!;
    expect(seenCommand).toBe('python3');
    expect(seenArgs[0]).toMatch(/daedalus-tray\.py$/);
    const iconArg = seenArgs[seenArgs.indexOf('--icon') + 1];
    expect(iconArg).toMatch(/tray-icon\.png$/);
    const menuArg = seenArgs[seenArgs.indexOf('--menu') + 1];
    const menu = JSON.parse(menuArg!) as Array<{ id: string; label: string }>;
    expect(menu.map((item) => item.id)).toEqual(['open-cli', 'open-web', 'status', 'quit']);
    child.stdout.emit('data', 'READY\n');
    await shown;
    child.stdout.emit('data', 'ACTION:open-web\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions).toEqual(['open-web']);
    await backend.hide();
    expect(child.kill).toHaveBeenCalled();
    expect(backend.childForTests()).toBeUndefined();
  });

  test('rejects when the helper reports ERROR', async () => {
    const children: FakeChild[] = [];
    const spawnImpl = ((() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as () => FakeChild);
    const backend = new LinuxAppIndicatorBackend({ spawnImpl: asSpawn(spawnImpl), readyTimeoutMs: 500 });
    const shown = backend.show(trayMenuItems(), async () => undefined);
    children[0]!.stderr.emit('data', 'ERROR: AppIndicator3 unavailable: No module named \'gi\'\n');
    await expect(shown).rejects.toThrow(/AppIndicator3 unavailable/);
  });

  test('rejects on READY timeout', async () => {
    const spawnImpl = asSpawn(() => new FakeChild());
    const backend = new LinuxAppIndicatorBackend({ spawnImpl, readyTimeoutMs: 20 });
    await expect(backend.show(trayMenuItems(), async () => undefined)).rejects.toThrow(/did not print READY/);
  });

  test('hide without show is a no-op', async () => {
    const backend = new LinuxAppIndicatorBackend({ spawnImpl: asSpawn(() => new FakeChild()) });
    await expect(backend.hide()).resolves.toBeUndefined();
  });

  test('second show while shown is a no-op', async () => {
    const children: FakeChild[] = [];
    const spawnImpl = ((() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as () => FakeChild);
    const backend = new LinuxAppIndicatorBackend({ spawnImpl: asSpawn(spawnImpl), readyTimeoutMs: 500 });
    const first = backend.show(trayMenuItems(), async () => undefined);
    children[0]!.stdout.emit('data', 'READY\n');
    await first;
    await backend.show(trayMenuItems(), async () => undefined);
    expect(children.length).toBe(1);
    await backend.hide();
  });
});

describe('pickTerminal', () => {
  test('picks the first available emulator in order', () => {
    expect(pickTerminal(() => false)).toBeUndefined();
    expect(pickTerminal((command) => command === 'konsole')?.command).toBe('konsole');
    expect(pickTerminal((command) => command === 'xterm')?.command).toBe('xterm');
    // x-terminal-emulator outranks gnome-terminal
    expect(pickTerminal(() => true)?.command).toBe('x-terminal-emulator');
  });
});

describe('createTrayHandlers', () => {
  function baseDeps(overrides: Record<string, unknown> = {}) {
    return {
      serverUrl: 'http://127.0.0.1:3080',
      cwd: '/tmp/ws',
      openBrowser: vi.fn(() => ({ command: 'xdg-open', args: ['http://127.0.0.1:3080'] })),
      print: vi.fn(),
      stopDaemon: vi.fn(async () => ({ stopped: true, pid: 123, reason: 'daemon stopped' })),
      onQuit: vi.fn(),
      commandExists: () => true,
      spawnTerminal: vi.fn(),
      ...overrides,
    };
  }

  test('Open Web opens the server URL in a browser', async () => {
    const deps = baseDeps();
    const handlers = createTrayHandlers(deps);
    await handlers.onOpenWeb?.();
    expect(deps.openBrowser).toHaveBeenCalledWith('http://127.0.0.1:3080');
  });

  test('Open CLI opens a terminal running the launcher', async () => {
    const deps = baseDeps();
    const handlers = createTrayHandlers(deps);
    await handlers.onOpenCli?.();
    expect(deps.spawnTerminal).toHaveBeenCalledTimes(1);
    const [command, args, cwd] = (deps.spawnTerminal as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], string];
    expect(command).toBe('x-terminal-emulator');
    expect(cwd).toBe('/tmp/ws');
    expect(args.join(' ')).toContain('daedalus');
  });

  test('Status opens a terminal running `daedalus status`', async () => {
    const deps = baseDeps();
    const handlers = createTrayHandlers(deps);
    await handlers.onStatus?.();
    const [, args] = (deps.spawnTerminal as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], string];
    expect(args.join(' ')).toContain('status');
  });

  test('no terminal emulator -> honest message, no crash', async () => {
    const deps = baseDeps({ commandExists: () => false });
    const handlers = createTrayHandlers(deps);
    await handlers.onOpenCli?.();
    expect(deps.spawnTerminal).not.toHaveBeenCalled();
    expect((deps.print as ReturnType<typeof vi.fn>).mock.calls.join(' ')).toContain('no known terminal emulator');
  });

  test('Quit stops the daemon then releases the tray', async () => {
    const deps = baseDeps();
    const handlers = createTrayHandlers(deps);
    await handlers.onQuit?.();
    expect(deps.stopDaemon).toHaveBeenCalled();
    expect(deps.onQuit).toHaveBeenCalled();
    expect((deps.print as ReturnType<typeof vi.fn>).mock.calls.join(' ')).toContain('daemon stopped');
  });
});

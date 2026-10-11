import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAY_ICON_PNG_PATH, type TrayAction, type TrayBackend, type TrayMenuItem } from './tray.ts';

/** Backend name reported in TrayStatus. */
export const LINUX_TRAY_BACKEND_NAME = 'appindicator3';

const HELPER_RELATIVE = join('..', 'tray', 'daedalus-tray.py');

function helperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), HELPER_RELATIVE);
}

export type AppIndicatorProbe = () => boolean;

/** Real probe: python3 must import the AppIndicator3 gir bindings. */
export function probeAppIndicator(): boolean {
  try {
    const result = spawnSync(
      'python3',
      ['-c', "import gi; gi.require_version('AppIndicator3', '0.1'); from gi.repository import AppIndicator3"],
      { stdio: 'ignore', timeout: 8_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

let cachedAvailability: boolean | undefined;

/** Test hook: forget the cached probe result. */
export function resetLinuxTrayAvailabilityCache(): void {
  cachedAvailability = undefined;
}

/**
 * Whether the Linux tray backend can actually run here: Linux, a desktop
 * session, and working AppIndicator3 Python bindings. Cached per process;
 * pass an explicit `probe` in tests.
 */
export function linuxTrayAvailable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: AppIndicatorProbe = probeAppIndicator,
): boolean {
  if (platform !== 'linux') return false;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  // Cache only the real probe; injected test probes always run fresh.
  if (probe === probeAppIndicator) {
    if (cachedAvailability === undefined) {
      try {
        cachedAvailability = probe();
      } catch {
        cachedAvailability = false;
      }
    }
    return cachedAvailability;
  }
  try {
    return probe();
  } catch {
    return false;
  }
}

/** Exact install line for the missing tray dependency, per distro family. */
export function trayDependencyHint(): string {
  return 'AppIndicator3 Python bindings are missing — install libappindicator-gtk3 + python-gobject '
    + '(Arch: sudo pacman -S libappindicator-gtk3 python-gobject; Debian/Ubuntu: sudo apt install gir1.2-appindicator3-1)';
}

export type LinuxTraySpawn = (command: string, args: string[]) => ChildProcess;

export type LinuxTrayBackendOptions = {
  helper?: string;
  icon?: string;
  spawnImpl?: LinuxTraySpawn;
  /** How long to wait for the helper's READY line before giving up. */
  readyTimeoutMs?: number;
};

/**
 * `TrayBackend` over the `daedalus-tray.py` AppIndicator helper. The helper
 * prints `READY` when the icon is live and `ACTION:<id>` per menu click;
 * anything else on stdout is ignored. `hide()` kills the helper.
 */
export class LinuxAppIndicatorBackend implements TrayBackend {
  readonly name = LINUX_TRAY_BACKEND_NAME;
  #child?: ChildProcess;
  #onAction?: (action: TrayAction) => Promise<void>;
  readonly #options: Required<Pick<LinuxTrayBackendOptions, 'helper' | 'icon' | 'readyTimeoutMs'>> &
    Pick<LinuxTrayBackendOptions, 'spawnImpl'>;

  constructor(options: LinuxTrayBackendOptions = {}) {
    this.#options = {
      helper: options.helper ?? helperPath(),
      icon: options.icon ?? TRAY_ICON_PNG_PATH,
      readyTimeoutMs: options.readyTimeoutMs ?? 10_000,
      ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
    };
  }

  /** For tests: the child process while the tray is shown. */
  childForTests(): ChildProcess | undefined {
    return this.#child;
  }

  show(items: TrayMenuItem[], onAction: (action: TrayAction) => Promise<void>): Promise<void> {
    if (this.#child) return Promise.resolve();
    this.#onAction = onAction;
    const menu = JSON.stringify(items.map((item) => ({ id: item.action, label: item.label })));
    const spawnImpl = this.#options.spawnImpl ?? ((command: string, args: string[]) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
    const child = spawnImpl('python3', [this.#options.helper, '--icon', this.#options.icon, '--menu', menu]);
    this.#child = child;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        this.#child = undefined;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail(`tray helper did not print READY within ${this.#options.readyTimeoutMs}ms`), this.#options.readyTimeoutMs);
      let buffer = '';
      child.stdout?.on('data', (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line === 'READY') {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve();
            }
          } else if (line.startsWith('ACTION:')) {
            const id = line.slice('ACTION:'.length);
            void this.#onAction?.(id as TrayAction);
          }
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (/^ERROR:/m.test(text)) fail(`tray helper failed: ${text.trim().split('\n')[0]}`);
      });
      child.on('error', (error) => fail(`could not start tray helper: ${error instanceof Error ? error.message : String(error)}`));
      child.on('exit', (code) => {
        if (!settled) fail(`tray helper exited before READY (code ${code ?? 'unknown'})`);
        if (this.#child === child) this.#child = undefined;
      });
    });
  }

  hide(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#onAction = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return Promise.resolve();
  }
}

/** A backend when the Linux tray can run here, otherwise undefined. */
export function createTrayBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: AppIndicatorProbe = probeAppIndicator,
): TrayBackend | undefined {
  return linuxTrayAvailable(env, platform, probe) ? new LinuxAppIndicatorBackend() : undefined;
}

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TrayAction = 'open-cli' | 'open-web' | 'status' | 'quit';

/**
 * Path of the bundled tray icon asset. The icon is a placeholder — a bold
 * "D" in the Daedalus accent style (`cli/assets/tray-icon.svg`) — until
 * Farid supplies the final design; backends should load this path so
 * swapping the file later is all a real tray backend needs.
 */
export const TRAY_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'tray-icon.svg');

export type TrayMenuItem = {
  id: TrayAction;
  label: string;
  action: TrayAction;
};

export type TrayStatus = {
  available: boolean;
  desktopSession: boolean;
  reason: string;
  backend: string;
  /** Bundled icon a native backend would display; a placeholder "D" for now. */
  icon: string;
};

export type TrayHandlers = {
  onOpenCli?: () => Promise<void> | void;
  onOpenWeb?: () => Promise<void> | void;
  onStatus?: () => Promise<void> | void;
  onQuit?: () => Promise<void> | void;
};

export type TrayBackend = {
  name: string;
  show: (items: TrayMenuItem[], onAction: (action: TrayAction) => Promise<void>) => Promise<void> | void;
  hide: () => Promise<void> | void;
};

export function trayMenuItems(): TrayMenuItem[] {
  return [
    { id: 'open-cli', label: 'Open CLI', action: 'open-cli' },
    { id: 'open-web', label: 'Open Web', action: 'open-web' },
    { id: 'status', label: 'Status', action: 'status' },
    { id: 'quit', label: 'Quit', action: 'quit' },
  ];
}

export function detectTray(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): TrayStatus {
  const desktopSession = platform === 'darwin' || platform === 'win32' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (!desktopSession) {
    return {
      available: false,
      desktopSession: false,
      reason: 'no tray in this environment (no desktop session); use `daedalus status` / `daedalus stop`',
      backend: 'none',
      icon: TRAY_ICON_PATH,
    };
  }
  return {
    available: false,
    desktopSession: true,
    reason: 'desktop session detected, but no native tray backend is bundled in this build; use `daedalus status` / `daedalus stop`',
    backend: 'none',
    icon: TRAY_ICON_PATH,
  };
}

/**
 * Tray lifecycle logic without a native GUI dependency. A desktop host can
 * inject a backend; in headless or backend-less environments the manager
 * reports the limitation honestly instead of pretending an icon exists.
 */
export class TrayManager {
  readonly #handlers: TrayHandlers;
  readonly #backend?: TrayBackend;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;
  #active = false;

  constructor(handlers: TrayHandlers = {}, backend?: TrayBackend, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
    this.#handlers = handlers;
    this.#backend = backend;
    this.#env = env;
    this.#platform = platform;
  }

  items(): TrayMenuItem[] {
    return trayMenuItems();
  }

  status(): TrayStatus {
    const detected = detectTray(this.#env, this.#platform);
    if (this.#active && this.#backend) {
      return { available: true, desktopSession: true, reason: 'tray active', backend: this.#backend.name, icon: TRAY_ICON_PATH };
    }
    if (detected.desktopSession && this.#backend) {
      return { ...detected, reason: 'tray backend present but not started', backend: this.#backend.name };
    }
    return detected;
  }

  async start(): Promise<TrayStatus> {
    const detected = detectTray(this.#env, this.#platform);
    if (!detected.desktopSession || !this.#backend) return this.status();
    await this.#backend.show(this.items(), (action) => this.handleAction(action));
    this.#active = true;
    return this.status();
  }

  async handleAction(action: TrayAction): Promise<void> {
    switch (action) {
      case 'open-cli':
        await this.#handlers.onOpenCli?.();
        return;
      case 'open-web':
        await this.#handlers.onOpenWeb?.();
        return;
      case 'status':
        await this.#handlers.onStatus?.();
        return;
      case 'quit':
        await this.#handlers.onQuit?.();
        await this.stop();
        return;
    }
  }

  async stop(): Promise<void> {
    if (this.#backend && this.#active) await this.#backend.hide();
    this.#active = false;
  }
}

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TrayHandlers } from './tray.ts';

/** Terminal emulators tried in order to open a visible terminal on Linux. */
export const TERMINAL_CANDIDATES: Array<{ command: string; args: string[] }> = [
  { command: 'x-terminal-emulator', args: ['-e'] },
  { command: 'gnome-terminal', args: ['--'] },
  { command: 'konsole', args: ['-e'] },
  { command: 'alacritty', args: ['-e'] },
  { command: 'kitty', args: ['-e'] },
  { command: 'xterm', args: ['-e'] },
];

export type CommandExists = (command: string) => boolean;

function defaultCommandExists(command: string): boolean {
  try {
    return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

/** First terminal emulator found on PATH, or undefined. */
export function pickTerminal(commandExists: CommandExists = defaultCommandExists): { command: string; args: string[] } | undefined {
  return TERMINAL_CANDIDATES.find((candidate) => commandExists(candidate.command));
}

function cliEntryPoint(): { command: string; args: string[] } {
  // Prefer the installed `daedalus` on PATH; fall back to this exact entry.
  if (defaultCommandExists('daedalus')) return { command: 'daedalus', args: [] };
  return { command: process.execPath, args: ['--experimental-strip-types', fileURLToPath(new URL('./index.ts', import.meta.url))] };
}

export type TrayActionDeps = {
  serverUrl: string;
  cwd: string;
  openBrowser: (url: string) => { command: string; args: string[] };
  print: (text: string) => void;
  stopDaemon: () => Promise<{ stopped: boolean; pid?: number; reason: string }>;
  /** Called after Quit so the launcher can release the tray and exit. */
  onQuit: () => void;
  commandExists?: CommandExists;
  spawnTerminal?: (command: string, args: string[], cwd: string) => void;
};

function openCliTerminal(deps: TrayActionDeps, cliArgs: string[]): void {
  const terminal = pickTerminal(deps.commandExists);
  if (!terminal) {
    deps.print('Could not open a terminal: no known terminal emulator found on PATH (tried x-terminal-emulator, gnome-terminal, konsole, alacritty, kitty, xterm).\n');
    return;
  }
  const entry = cliEntryPoint();
  const shellCommand = [entry.command, ...entry.args, ...cliArgs].join(' ');
  try {
    (deps.spawnTerminal ?? defaultSpawnTerminal)(terminal.command, [...terminal.args, 'sh', '-c', `${shellCommand}; exec sh`], deps.cwd);
  } catch (error) {
    deps.print(`Could not open a terminal: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function defaultSpawnTerminal(command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * The four tray menu actions, wired honestly: Open CLI / Status open a real
 * terminal running daedalus, Open Web opens the local Web UI, Quit stops
 * the daemon and releases the tray. Every dependency is injectable for tests.
 */
export function createTrayHandlers(deps: TrayActionDeps): TrayHandlers {
  return {
    onOpenCli: async () => {
      openCliTerminal(deps, []);
    },
    onOpenWeb: async () => {
      deps.openBrowser(deps.serverUrl);
    },
    onStatus: async () => {
      openCliTerminal(deps, ['status']);
    },
    onQuit: async () => {
      try {
        const result = await deps.stopDaemon();
        deps.print(`Daemon stop: ${result.reason}${result.pid ? ` (pid ${result.pid})` : ''}\n`);
      } catch (error) {
        deps.print(`Daemon stop failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      deps.onQuit();
    },
  };
}

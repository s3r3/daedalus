import { defineCommand } from 'citty';
import consola from 'consola';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export default defineCommand({
  meta: { name: 'dev', description: 'Start the local preview server' },
  args: {
    port: { type: 'string', description: 'Port number', default: '4200' },
  },
  run({ args }) {
    // Look for apps/studio from current working directory
    const studioDir = resolve(process.cwd(), 'apps/studio');
    if (!existsSync(studioDir)) {
      consola.error('apps/studio not found. Are you in the Slidemason project root?');
      process.exit(1);
    }

    consola.start(`Starting Slidemason Studio on port ${args.port}...`);
    const child = spawn('npx', ['vite', '--port', args.port], {
      cwd: studioDir,
      stdio: 'inherit',
      shell: true,
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  },
});

import { defineCommand } from 'citty';
import consola from 'consola';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export default defineCommand({
  meta: { name: 'build', description: 'Build the presentation' },
  run() {
    const studioDir = resolve(process.cwd(), 'apps/studio');
    consola.start('Building presentation...');
    execSync('npx vite build', { cwd: studioDir, stdio: 'inherit' });
    consola.success('Build complete! Output in dist/');
  },
});

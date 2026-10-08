import { defineCommand } from 'citty';
import consola from 'consola';
import { execSync } from 'node:child_process';

export default defineCommand({
  meta: { name: 'publish-github', description: 'Publish to GitHub Pages' },
  run() {
    consola.start('Publishing to GitHub Pages...');
    try {
      execSync('npx gh-pages -d dist', { stdio: 'inherit' });
      consola.success('Published to GitHub Pages!');
    } catch (error) {
      consola.error('Failed to publish. Make sure you have built the static site first (slidemason export-static)');
      process.exit(1);
    }
  },
});

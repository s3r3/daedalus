import { defineCommand } from 'citty';
import consola from 'consola';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineCommand({
  meta: { name: 'init', description: 'Initialize a new Slidemason project' },
  args: {
    dir: { type: 'positional', description: 'Project directory', default: '.' },
  },
  run({ args }) {
    const root = resolve(args.dir);
    const dirs = ['data', 'generated', 'prompts'];
    for (const dir of dirs) {
      const path = resolve(root, dir);
      if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
        consola.success(`Created ${dir}/`);
      }
    }

    // Create .gitkeep files
    for (const dir of ['data', 'generated']) {
      const gitkeep = resolve(root, dir, '.gitkeep');
      if (!existsSync(gitkeep)) writeFileSync(gitkeep, '');
    }

    consola.success('Slidemason project initialized!');
    consola.info('Next steps:');
    consola.info('  1. Drop files into data/');
    consola.info('  2. Run: slidemason ingest');
    consola.info('  3. Use your coding agent with the prompts in prompts/');
  },
});

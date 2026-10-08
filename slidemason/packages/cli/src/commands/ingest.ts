import { defineCommand } from 'citty';
import consola from 'consola';
import { ingest } from '@slidemason/core';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineCommand({
  meta: { name: 'ingest', description: 'Scan /data and generate manifest.json' },
  args: {
    dataDir: { type: 'string', description: 'Data directory path', default: 'data' },
  },
  async run({ args }) {
    const dataDir = resolve(args.dataDir);
    consola.start('Scanning data directory...');

    const manifest = await ingest(dataDir);

    const outDir = resolve('generated');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    consola.success(`Found ${manifest.files.length} files`);
    consola.success('Manifest written to generated/manifest.json');
  },
});

import { defineCommand } from 'citty';
import consola from 'consola';

export default defineCommand({
  meta: { name: 'export-static', description: 'Export as static site' },
  args: {
    output: { type: 'string', description: 'Output directory', default: 'dist' },
  },
  async run({ args }) {
    const { exportStatic } = await import('@slidemason/export');
    consola.start('Exporting static site...');
    await exportStatic({
      projectRoot: process.cwd(),
      outputDir: args.output,
    });
    consola.success(`Static site exported to ${args.output}/`);
  },
});

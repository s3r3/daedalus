import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

interface ExportStaticOptions {
  projectRoot: string;
  outputDir?: string;
}

export async function exportStatic({ projectRoot, outputDir = 'dist' }: ExportStaticOptions): Promise<void> {
  const studioDir = resolve(projectRoot, 'apps/studio');
  execSync(`pnpm vite build --outDir ${resolve(projectRoot, outputDir)}`, {
    cwd: studioDir,
    stdio: 'inherit',
  });
}

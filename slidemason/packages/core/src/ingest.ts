import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import type { Manifest } from './schemas/manifest.js';

const EXT_TYPE_MAP: Record<string, string> = {
  '.md': 'markdown',
  '.txt': 'text',
  '.json': 'json',
  '.csv': 'csv',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
};

async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await walkDir(fullPath)));
    } else {
      paths.push(fullPath);
    }
  }
  return paths;
}

export async function ingest(dataDir: string): Promise<Manifest> {
  const allFiles = await walkDir(dataDir);
  const files = [];

  for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    const type = EXT_TYPE_MAP[ext];
    if (!type) continue;

    const fileStat = await stat(filePath);
    files.push({
      path: relative(process.cwd(), filePath),
      name: filePath.split('/').pop()!,
      type: type as 'markdown' | 'text' | 'json' | 'csv' | 'image',
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    files,
  };
}

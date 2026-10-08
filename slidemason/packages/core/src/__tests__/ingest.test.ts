import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ingest } from '../ingest';

const TEST_DATA_DIR = join(import.meta.dirname, '__fixtures__/data');

describe('ingest', () => {
  beforeEach(() => {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('discovers markdown files', async () => {
    writeFileSync(join(TEST_DATA_DIR, 'notes.md'), '# Notes\nSome content');
    const manifest = await ingest(TEST_DATA_DIR);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].type).toBe('markdown');
    expect(manifest.files[0].name).toBe('notes.md');
  });

  it('discovers files recursively', async () => {
    mkdirSync(join(TEST_DATA_DIR, 'sub'), { recursive: true });
    writeFileSync(join(TEST_DATA_DIR, 'top.md'), '# Top');
    writeFileSync(join(TEST_DATA_DIR, 'sub/nested.txt'), 'nested');
    const manifest = await ingest(TEST_DATA_DIR);
    expect(manifest.files).toHaveLength(2);
  });

  it('categorizes file types correctly', async () => {
    writeFileSync(join(TEST_DATA_DIR, 'doc.md'), '# Doc');
    writeFileSync(join(TEST_DATA_DIR, 'data.csv'), 'a,b\n1,2');
    writeFileSync(join(TEST_DATA_DIR, 'config.json'), '{}');
    writeFileSync(join(TEST_DATA_DIR, 'note.txt'), 'note');
    const manifest = await ingest(TEST_DATA_DIR);
    const types = manifest.files.map(f => f.type).sort();
    expect(types).toEqual(['csv', 'json', 'markdown', 'text']);
  });

  it('ignores unsupported file types', async () => {
    writeFileSync(join(TEST_DATA_DIR, 'notes.md'), '# Notes');
    writeFileSync(join(TEST_DATA_DIR, 'binary.exe'), 'binary');
    const manifest = await ingest(TEST_DATA_DIR);
    expect(manifest.files).toHaveLength(1);
  });

  it('returns empty files array for empty directory', async () => {
    const manifest = await ingest(TEST_DATA_DIR);
    expect(manifest.files).toEqual([]);
  });
});

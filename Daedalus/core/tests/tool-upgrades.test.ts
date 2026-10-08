import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createGrepTool, editFileTool, editSearchReplaceTool, parseRipgrepJson, readFileTool, ripgrepArgs } from '../src/index.ts';

/**
 * Tool-upgrade batch (2026-10-08 audit recommendations): batch read/edit
 * shapes, whitespace-tolerant edit application, and the post-edit hunk
 * shown back to the model.
 */

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function workspace(): string { dir = mkdtempSync(join(tmpdir(), 'daedalus-toolup-')); return dir; }
const ctx = (root: string) => ({ workspaceRoot: root });

describe('read_file paths[] batch', () => {
  test('serves several files in one call, each with its own header', async () => {
    const root = workspace();
    writeFileSync(join(root, 'app.tsx'), 'export const App = () => null\n');
    writeFileSync(join(root, 'app.css'), '.parallax { color: red }\n');
    const result = await readFileTool.execute({ paths: ['app.tsx', 'app.css'] }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('[read_file app.tsx');
    expect(result.output).toContain('[read_file app.css');
    expect(result.output).toContain('.parallax');
    expect(result.meta.files).toBe(2);
  });

  test('a missing file reports inline while the others still serve', async () => {
    const root = workspace();
    writeFileSync(join(root, 'here.ts'), 'export const here = 1\n');
    const result = await readFileTool.execute({ paths: ['here.ts', 'gone.ts'] }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('here = 1');
    expect(result.output).toContain('[read_file gone.ts — error:');
  });

  test('rejects a batch past the cap', async () => {
    const root = workspace();
    const result = await readFileTool.execute({ paths: Array.from({ length: 9 }, (_, i) => `f${i}.ts`) }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.output).toContain('at most 8');
  });
});

describe('edit_file batch + replace_all + tolerance + hunk', () => {
  test('edits[] applies several edits in one call and reports the hunk', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n');
    const result = await editFileTool.execute({
      path: 'a.ts',
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 10' },
        { old_string: 'const c = 3', new_string: 'const c = 30' },
      ],
    }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.meta.edits).toBe(2);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toContain('const a = 10');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toContain('const c = 30');
    expect(result.output).toContain('-const a = 1');
    expect(result.output).toContain('+const a = 10');
  });

  test('edits[] is atomic: a failing second edit writes nothing', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'const a = 1\n');
    const result = await editFileTool.execute({
      path: 'a.ts',
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 99' },
        { old_string: 'missing anchor', new_string: 'x' },
      ],
    }, ctx(root));
    expect(result.status).toBe('error');
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\n');
  });

  test('replace_all replaces every exact occurrence', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'foo();\nfoo();\nfoo();\n');
    const result = await editFileTool.execute({ path: 'a.ts', old_string: 'foo()', new_string: 'bar()', replace_all: true }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.meta.replacements).toBe(3);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('bar();\nbar();\nbar();\n');
  });

  test('an indentation-only mismatch still applies and is flagged', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'function f() {\n    const x = 1\n    return x\n}\n');
    const result = await editFileTool.execute({ path: 'a.ts', old_string: '  const x = 1\n  return x', new_string: '  const x = 2\n  return x' }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.meta.whitespace_tolerant).toBe(true);
    expect(result.output).toContain('whitespace tolerance');
    const after = readFileSync(join(root, 'a.ts'), 'utf8');
    expect(after).toContain('    const x = 2');
    expect(after).toContain('    return x');
  });

  test('a genuinely different anchor still fails loudly', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'const a = 1\n');
    const result = await editFileTool.execute({ path: 'a.ts', old_string: 'const banana = 9', new_string: 'x' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.output).toContain('not found');
  });
});

describe('grep output modes (JS engine, deterministic)', () => {
  const jsGrep = createGrepTool({ useRipgrep: false });
  const seedTree = (root: string): void => {
    writeFileSync(join(root, 'a.ts'), 'const needle = 1\nconst other = 2\nneedle again\n');
    writeFileSync(join(root, 'b.md'), 'needle in docs\n');
  };

  test('files_with_matches lists just the paths', async () => {
    const root = workspace();
    seedTree(root);
    const result = await jsGrep.execute({ pattern: 'needle', output_mode: 'files_with_matches' }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.output.split('\n')).toEqual(['a.ts', 'b.md']);
    expect(result.meta.mode).toBe('files_with_matches');
  });

  test('count totals matches per file', async () => {
    const root = workspace();
    seedTree(root);
    const result = await jsGrep.execute({ pattern: 'needle', output_mode: 'count' }, ctx(root));
    expect(result.output).toContain('a.ts: 2');
    expect(result.output).toContain('b.md: 1');
    expect(result.meta.count).toBe(3);
  });

  test('context lines surround matches with the grep - separator', async () => {
    const root = workspace();
    seedTree(root);
    const result = await jsGrep.execute({ pattern: 'other', context: 1 }, ctx(root));
    expect(result.output).toContain('a.ts:2: const other = 2');
    expect(result.output).toContain('a.ts-1- const needle = 1');
  });

  test('glob filters which files are searched', async () => {
    const root = workspace();
    seedTree(root);
    const result = await jsGrep.execute({ pattern: 'needle', glob: '*.ts' }, ctx(root));
    expect(result.output).toContain('a.ts');
    expect(result.output).not.toContain('b.md');
  });

  test('ripgrep args carry the ignore set and json mode', () => {
    const args = ripgrepArgs({ pattern: 'x', ignoreCase: true, context: 2 });
    expect(args).toContain('--json');
    expect(args).toContain('-i');
    expect(args).toContain('-C');
    expect(args.join(' ')).toContain('!node_modules');
  });

  test('ripgrep JSON parses into the same line shape', () => {
    const root = workspace();
    const stdout = [
      JSON.stringify({ type: 'match', data: { path: { text: 'src/a.ts' }, lines: { text: 'hit\n' }, line_number: 3 } }),
      JSON.stringify({ type: 'summary', data: {} }),
    ].join('\n');
    const lines = parseRipgrepJson(stdout, root, root);
    expect(lines).toEqual([{ path: 'src/a.ts', line: 3, text: 'hit', context: false }]);
  });
});

describe('edit_search_replace whitespace tolerance', () => {
  test('a block whose indentation drifted applies via the tolerant fallback', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.ts'), 'if (ok) {\n      doThing()\n      doMore()\n}\n');
    const result = await editSearchReplaceTool.execute({
      path: 'a.ts',
      replacements: '<<<<<<< SEARCH\n  doThing()\n  doMore()\n=======\n  doOther()\n  doMore()\n>>>>>>> REPLACE',
    }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.meta.whitespace_tolerant).toBe(true);
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toContain('      doOther()\n      doMore()');
    expect(result.output).toContain('-      doThing()');
  });
});

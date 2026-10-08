import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitStatus, parseGitPorcelain, revertFileToHead } from '../src/git-status.ts';

/**
 * The Web git surface: porcelain parsing plus a real-repo check that
 * status reports the worktree and revert restores HEAD content —
 * refusing untracked files instead of deleting them.
 */

describe('parseGitPorcelain', () => {
  test('maps the two-letter codes and follows renames to the live path', () => {
    const files = parseGitPorcelain([
      ' M src/App.tsx',
      '?? new-file.ts',
      'A  staged.ts',
      ' D gone.ts',
      'R  old.ts -> renamed.ts',
      'AM both.ts',
      '',
    ].join('\n'));
    expect(files).toEqual([
      { path: 'src/App.tsx', status: 'modified' },
      { path: 'new-file.ts', status: 'untracked' },
      { path: 'staged.ts', status: 'added' },
      { path: 'gone.ts', status: 'deleted' },
      { path: 'renamed.ts', status: 'renamed' },
      { path: 'both.ts', status: 'added' },
    ]);
  });
});

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'daedalus-git-'));
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'tracked.txt'), 'original\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-qm', 'init']);
  return root;
}

describe('gitStatus / revertFileToHead against a real repo', () => {
  test('reports branch and changes; revert restores HEAD and refuses untracked', async () => {
    const root = gitRepo();
    writeFileSync(join(root, 'tracked.txt'), 'agent edit\n');
    writeFileSync(join(root, 'fresh.txt'), 'brand new\n');

    const status = await gitStatus(root);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(status.files).toContainEqual({ path: 'tracked.txt', status: 'modified' });
    expect(status.files).toContainEqual({ path: 'fresh.txt', status: 'untracked' });

    expect(await revertFileToHead(root, 'tracked.txt')).toEqual({ ok: true });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('original\n');

    // Untracked files are refused, never deleted; untouched files too.
    expect(await revertFileToHead(root, 'fresh.txt')).toEqual({ ok: false, reason: 'untracked' });
    expect(existsSync(join(root, 'fresh.txt'))).toBe(true);
    expect(await revertFileToHead(root, 'tracked.txt')).toEqual({ ok: false, reason: 'not_changed' });
  });

  test('a plain folder is not a repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'daedalus-nogit-'));
    expect(await gitStatus(plain)).toEqual({ isRepo: false, branch: null, files: [] });
    expect(await revertFileToHead(plain, 'x.txt')).toEqual({ ok: false, reason: 'not_a_repo' });
  });
});

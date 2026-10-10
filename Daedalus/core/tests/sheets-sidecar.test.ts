import { afterEach, describe, expect, test } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  probeSheetSidecar,
  resolveSheetSidecar,
  runSheetSidecar,
  sheetSidecarCacheDir,
  sidecarCandidates,
  newWorkbook,
  type WorkbookSpec,
} from '../src/index.ts';

/**
 * Sidecar discovery + build-on-first-use (Part A). The probe never
 * builds; resolution at export time may build ONCE from a source
 * checkout into ~/.daedalus/bin. All binaries here are bash stubs —
 * the contract under test is discovery order, memoization, honest
 * reasons, and the applied-note wording, not the Go payload itself.
 */

const tmps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
});

const STUB_SIDECAR = [
  '#!/usr/bin/env bash',
  'if [ "$1" = "--version" ]; then echo "daedalus-sheet-sidecar 9.9.9-test"; exit 0; fi',
  'if [ "$1" = "inject" ]; then',
  '  payload=$(cat)',
  '  out=$(printf \'%s\' "$payload" | sed -n \'s/.*"output":"\\([^"]*\\)".*/\\1/p\')',
  '  inp=$(printf \'%s\' "$payload" | sed -n \'s/.*"input":"\\([^"]*\\)".*/\\1/p\')',
  '  cp "$inp" "$out"',
  '  echo \'{"charts":1,"pivots":1,"slicers":0}\'',
  '  exit 0',
  'fi',
  'exit 1',
  '',
].join('\n');

function writeStubSidecar(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, STUB_SIDECAR, 'utf8');
  chmodSync(path, 0o755);
}

function fakeSourceDir(): string {
  const dir = tempDir('daedalus-sidecar-src-');
  writeFileSync(join(dir, 'go.mod'), 'module daedalus-sheet-sidecar\n\ngo 1.23\n', 'utf8');
  writeFileSync(join(dir, 'main.go'), 'package main\n', 'utf8');
  return dir;
}

function specWorkbook(): WorkbookSpec {
  return newWorkbook('Uji Sidecar', { createdBy: 'test' });
}

describe('sidecar discovery', () => {
  test('candidates resolve in order: env → PATH → source bin → per-user cache', () => {
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    const withEnv = sidecarCandidates({ DAEDALUS_SHEET_SIDECAR: '/opt/custom/sidecar' }, { homeDir: home, sourceDir: source });
    expect(withEnv[0]).toBe('/opt/custom/sidecar');
    expect(withEnv[1]).toBe('daedalus-sheet-sidecar');
    expect(withEnv[2]).toBe(join(source, 'bin', 'daedalus-sheet-sidecar'));
    expect(withEnv[3]).toBe(join(home, '.daedalus', 'bin', 'daedalus-sheet-sidecar'));
    const noEnv = sidecarCandidates({}, { homeDir: home, sourceDir: source });
    expect(noEnv[0]).toBe('daedalus-sheet-sidecar');
    expect(sheetSidecarCacheDir('/home/someone')).toBe('/home/someone/.daedalus/bin');
  });

  test('cheap probe finds the per-user cache copy and never builds', async () => {
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    const cacheBin = join(sheetSidecarCacheDir(home), 'daedalus-sheet-sidecar');
    writeStubSidecar(cacheBin);
    const env: NodeJS.ProcessEnv = { PATH: '/nonexistent' };
    const seams = { env, homeDir: home, sourceDir: source, build: async () => { throw new Error('probe must not build'); } };
    const probe = await probeSheetSidecar(env, seams);
    expect(probe.available).toBe(true);
    expect(probe.path).toBe(cacheBin);
    expect(probe.version).toContain('9.9.9-test');

    // Remove the cache copy: probe reports absent and does NOT create it.
    rmSync(cacheBin);
    const absent = await probeSheetSidecar(env, seams);
    expect(absent.available).toBe(false);
    expect(existsSync(cacheBin)).toBe(false);
  });
});

describe('resolveSheetSidecar build-on-first-use', () => {
  test('builds once into ~/.daedalus/bin, memoizes, reports builtFromSource', async () => {
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    let builds = 0;
    const build = async (input: { outPath: string }): Promise<{ ok: true }> => {
      builds += 1;
      writeStubSidecar(input.outPath);
      return { ok: true };
    };
    const seams = { env: { PATH: '/nonexistent' }, homeDir: home, sourceDir: source, goPath: '/fake/go', build };
    const first = await resolveSheetSidecar(seams);
    expect(first.available).toBe(true);
    if (first.available) {
      expect(first.builtFromSource).toBe(true);
      expect(first.path).toBe(join(sheetSidecarCacheDir(home), 'daedalus-sheet-sidecar'));
      expect(first.version).toContain('9.9.9-test');
    }
    const second = await resolveSheetSidecar(seams);
    expect(second.available).toBe(true);
    expect(builds).toBe(1);
  });

  test('a deleted cache binary after a memoized build is rebuilt, not trusted', async () => {
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    let builds = 0;
    const build = async (input: { outPath: string }): Promise<{ ok: true }> => {
      builds += 1;
      writeStubSidecar(input.outPath);
      return { ok: true };
    };
    const seams = { env: { PATH: '/nonexistent' }, homeDir: home, sourceDir: source, goPath: '/fake/go', build };
    const first = await resolveSheetSidecar(seams);
    expect(first.available).toBe(true);
    expect(builds).toBe(1);
    // The cache entry disappears after the build (user cleanup, another
    // process): the stale in-process memo must not win.
    if (first.available) rmSync(first.path);
    const again = await resolveSheetSidecar(seams);
    expect(again.available).toBe(true);
    if (again.available) expect(again.builtFromSource).toBe(true);
    expect(builds).toBe(2);
  });

  test('Go absent: honest reason with the remedy, export-grade wording', async () => {
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    const resolved = await resolveSheetSidecar({ env: { PATH: '/nonexistent' }, homeDir: home, sourceDir: source, goPath: null });
    expect(resolved.available).toBe(false);
    if (!resolved.available) {
      expect(resolved.reason).toContain('Go tidak ditemukan');
      expect(resolved.reason).toContain('DAEDALUS_SHEET_SIDECAR');
    }
  });

  test('explicit env path short-circuits: broken config never silently builds', async () => {
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    let builds = 0;
    const resolved = await resolveSheetSidecar({
      env: { DAEDALUS_SHEET_SIDECAR: join(home, 'no-such-binary'), PATH: '/nonexistent' },
      homeDir: home,
      sourceDir: source,
      goPath: '/fake/go',
      build: async () => { builds += 1; return { ok: true }; },
    });
    expect(resolved.available).toBe(false);
    if (!resolved.available) expect(resolved.reason).toBe('sidecar-tidak-terdeteksi');
    expect(builds).toBe(0);
  });

  test('no source checkout at all: plain not-detected, no build attempted', async () => {
    const home = tempDir('daedalus-sidecar-home-');
    const resolved = await resolveSheetSidecar({ env: { PATH: '/nonexistent' }, homeDir: home, sourceDir: join(home, 'nothing-here'), goPath: '/fake/go' });
    expect(resolved.available).toBe(false);
    if (!resolved.available) expect(resolved.reason).toBe('sidecar-tidak-terdeteksi');
  });
});

describe('runSheetSidecar with a from-source build', () => {
  test('applied note says the sidecar was built from source (go build)', async () => {
    const dir = tempDir('daedalus-sidecar-run-');
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    const xlsxPath = join(dir, 'out.xlsx');
    writeFileSync(xlsxPath, Buffer.from('fake-xlsx-bytes'));
    const result = await runSheetSidecar(xlsxPath, specWorkbook(), {
      charts: [{ id: 'c1', type: 'column', range: 'Data!A1:B4', sheet: 'Dashboard', anchor: 'D2' }],
      pivots: [{ id: 'p1', source: 'Data!A1:B4', target: 'Pivot', rows: ['Kanal'], values: [{ field: 'Laba', agg: 'sum' }] }],
      slicers: [],
    }, {
      seams: {
        env: { PATH: '/nonexistent' },
        homeDir: home,
        sourceDir: source,
        goPath: '/fake/go',
        build: async (input) => {
          writeStubSidecar(input.outPath);
          return { ok: true };
        },
      },
    });
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.note).toContain('1 chart native + 1 pivot native');
      expect(result.note).toContain('sidecar dibangun dari sumber (go build)');
    }
    expect(existsSync(xlsxPath)).toBe(true);
  });

  test('default builder path: a stub `go` on PATH produces the cache binary', async () => {
    const dir = tempDir('daedalus-sidecar-go-');
    const home = tempDir('daedalus-sidecar-home-');
    const source = fakeSourceDir();
    // Stub `go`: `go build -trimpath -o <out> .` copies the stub sidecar into place.
    const stubSidecar = join(dir, 'stub-sidecar.sh');
    writeStubSidecar(stubSidecar);
    const goDir = join(dir, 'goroot-bin');
    mkdirSync(goDir, { recursive: true });
    const fakeGo = join(goDir, 'go');
    writeFileSync(fakeGo, [
      '#!/usr/bin/env bash',
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
      'cp "$STUB_SIDECAR_SRC" "$out" && chmod +x "$out"',
      '',
    ].join('\n'), 'utf8');
    chmodSync(fakeGo, 0o755);
    const resolved = await resolveSheetSidecar({
      env: { PATH: `${goDir}:/usr/bin:/bin`, STUB_SIDECAR_SRC: stubSidecar },
      homeDir: home,
      sourceDir: source,
    });
    expect(resolved.available).toBe(true);
    if (resolved.available) {
      expect(resolved.builtFromSource).toBe(true);
      expect(resolved.version).toContain('9.9.9-test');
      expect(existsSync(join(sheetSidecarCacheDir(home), 'daedalus-sheet-sidecar'))).toBe(true);
    }
    expect(copyFileSync).toBeDefined();
  });
});

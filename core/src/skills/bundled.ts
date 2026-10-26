import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daedalusGlobalSkillsDir, type SkillDirOptions } from './loader.ts';

/**
 * Bundled starter skills (Daedalus/skills/ in the repo). They ship as data,
 * not code. `ensureBundledSkillsInstalled()` copies any bundled skill that
 * is missing from the Daedalus-global skills directory
 * (`~/.daedalus/skills`, origin `global`), so the permanent set is present
 * and enabled by default in every workspace with zero user action and zero
 * downloads. A same-name skill already present is never overwritten — the
 * existing copy (and the per-workspace disable toggles) always win.
 *
 * This runs for the Coding domain only: `TaskRunner` prepares extensions
 * after the slide/dokumen/spreadsheet engines have returned early, so
 * bundled coding skills can never leak into the domain engines (total
 * separation — the engines never see a skill registry at all).
 */

/** Directory holding the starter skills bundled with this build. */
export function bundledSkillsDir(): string {
  // core/src/skills/bundled.ts (source) and core/dist/skills/bundled.js
  // (built) are both three levels below the Daedalus/ tree root.
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');
}

export type BundledInstallResult = {
  installed: string[];
  /** Bundled names already present in the target dir (left untouched). */
  skipped: string[];
  /** The global skills directory they were installed into. */
  targetDir: string;
};

export type BundledInstallOptions = SkillDirOptions & {
  /**
   * Set to false to skip the install (hermetic tests, read-only
   * environments). The runtime passes no option, so real runs install.
   */
  autoInstall?: boolean;
};

/**
 * Idempotent: after the first successful run every bundled skill exists in
 * the global dir and later runs only readdir. Never overwrites.
 */
export async function ensureBundledSkillsInstalled(
  options?: BundledInstallOptions,
): Promise<BundledInstallResult> {
  const targetDir = daedalusGlobalSkillsDir(options);
  if (options?.autoInstall === false) return { installed: [], skipped: [], targetDir };
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(bundledSkillsDir(), { withFileTypes: true });
  } catch {
    return { installed: [], skipped: [], targetDir };
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (names.length === 0) return { installed: [], skipped: [], targetDir };
  await mkdir(targetDir, { recursive: true });
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    try {
      await stat(join(bundledSkillsDir(), name, 'SKILL.md'));
    } catch {
      continue; // not a skill folder; ignore
    }
    try {
      await stat(join(targetDir, name));
      skipped.push(name);
      continue;
    } catch {
      // missing — install below
    }
    try {
      await cp(join(bundledSkillsDir(), name), join(targetDir, name), { recursive: true });
    } catch (error) {
      // Race: another process/worker installed this skill between the
      // stat above and the copy (parallel test files, concurrent CLI
      // runs). The target now exists with identical content, so treat
      // it as skipped instead of failing the whole run.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(name);
        continue;
      }
      throw error;
    }
    installed.push(name);
  }
  return { installed, skipped, targetDir };
}

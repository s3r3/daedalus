import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Workspace pins (tailor suite): paths the user marked as important in the
 * Web workspace panel. Pins persist in `<daedalus-home>/pins.json` (the same
 * store the CLI and Web share for a workspace) and the pinned paths ride
 * along in every task's workspace overview, so even a weak model starts
 * oriented instead of re-discovering the layout. The CLI reads the same
 * file through the runtime — there is deliberately no CLI pin UI.
 */

export const PINS_FILE_NAME = "pins.json";
/** Hard cap on stored pins; the prompt-side cap is stricter (see context.ts). */
export const MAX_PINS = 50;

export function pinsFilePath(daedalusHome: string): string {
  return join(daedalusHome, PINS_FILE_NAME);
}

/**
 * Accept only workspace-relative paths: no absolute paths, no `..` escapes,
 * no duplicates. Returns the cleaned list capped at MAX_PINS.
 */
export function sanitizePins(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const pins: string[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const path = entry.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path === "." || isAbsolute(path)) continue;
    if (path.split("/").some((segment) => segment === "..")) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    pins.push(path);
    if (pins.length >= MAX_PINS) break;
  }
  return pins;
}

/** Load pins from a daedalus home; a missing or malformed file means "no pins". */
export async function loadPins(daedalusHome: string): Promise<string[]> {
  try {
    const raw = await readFile(pinsFilePath(daedalusHome), "utf8");
    const parsed = JSON.parse(raw) as { pins?: unknown };
    return sanitizePins(parsed?.pins);
  } catch {
    return [];
  }
}

/** Persist pins atomically (same tmp+rename discipline as the provider store). */
export async function savePins(daedalusHome: string, pins: unknown): Promise<string[]> {
  const cleaned = sanitizePins(pins);
  const filePath = pinsFilePath(daedalusHome);
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, pins: cleaned }, null, 2), "utf8");
  await rename(tmp, filePath);
  return cleaned;
}

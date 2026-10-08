// Server-side loader for the visual reference attached to a selected community
// style. The textual style block remains the fallback; a missing or unavailable
// preview must never prevent a deck from rendering.

import fs from "node:fs";
import path from "node:path";
import { getCommunityTemplate } from "./community";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const referenceCache = new Map<string, Buffer>();

function looksLikeImage(bytes: Buffer): boolean {
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return true;
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return true;
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return true;
  return bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function cacheReference(key: string, bytes: Buffer): Buffer | null {
  if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES || !looksLikeImage(bytes)) return null;
  referenceCache.set(key, bytes);
  return bytes;
}

/** Best-effort image bytes for the selected visual direction. */
export async function loadCommunityStyleReference(
  templateId?: string | null,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const template = getCommunityTemplate(templateId);
  if (!template) return null;
  const cached = referenceCache.get(template.id);
  if (cached) return cached;

  if (template.cover.startsWith("/")) {
    const publicRoot = path.resolve(process.cwd(), "public");
    const source = path.resolve(publicRoot, template.cover.replace(/^\/+/, ""));
    if (!source.startsWith(`${publicRoot}${path.sep}`) || !fs.existsSync(source)) return null;
    try {
      return cacheReference(template.id, fs.readFileSync(source));
    } catch {
      return null;
    }
  }

  if (!/^https:\/\//i.test(template.cover)) return null;
  try {
    const timeout = AbortSignal.timeout(8_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(template.cover, { signal: requestSignal, cache: "force-cache" });
    if (!response.ok) return null;
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_REFERENCE_BYTES) return null;
    return cacheReference(template.id, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}


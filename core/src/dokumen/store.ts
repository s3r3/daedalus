import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  activePointerPath,
  documentPaths,
  documentsRoot,
  dokumenArchiveDir,
  savedSchemasDir,
  type DokumenKind,
  type DokumenSchema,
  type DocumentState,
  type ParsedSource,
  type SourceInfo,
} from './document.ts';

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  try {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
  } catch {
    return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
  }
}

export function newDocumentId(): string {
  return uniqueId('doc');
}
export function newSourceId(): string {
  return uniqueId('src');
}
export function newRecordId(): string {
  return uniqueId('rec');
}
export function newSectionId(): string {
  return uniqueId('sec');
}
export function newStyleOpId(): string {
  return uniqueId('op');
}

export function newDocument(kind: DokumenKind, title: string): DocumentState {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: newDocumentId(),
    kind,
    title,
    createdAt: now,
    updatedAt: now,
    sources: [],
    records: [],
    sections: [],
    styleOps: [],
    exports: [],
    citations: {},
  };
}

export async function writeDocument(root: string, doc: DocumentState): Promise<void> {
  const paths = documentPaths(root, doc.id);
  await mkdir(paths.dir, { recursive: true });
  doc.updatedAt = new Date().toISOString();
  const tmp = `${paths.file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.file);
}

export async function readDocument(root: string, id: string): Promise<DocumentState | null> {
  const paths = documentPaths(root, id);
  let raw: string;
  try {
    raw = await readFile(paths.file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`document.json is not valid JSON (${paths.file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isDocumentShape(parsed)) {
    throw new Error(`document.json has an invalid shape (${paths.file})`);
  }
  return parsed;
}

function isDocumentShape(v: unknown): v is DocumentState {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  if (d.version !== 1 || typeof d.id !== 'string' || typeof d.title !== 'string') return false;
  if (d.kind !== 'extract' && d.kind !== 'compose') return false;
  if (!Array.isArray(d.sources) || !Array.isArray(d.records) || !Array.isArray(d.sections)) return false;
  if (!Array.isArray(d.styleOps) || !Array.isArray(d.exports)) return false;
  if (typeof d.citations !== 'object' || d.citations === null || Array.isArray(d.citations)) return false;
  return true;
}

/** The workspace's active document (the one panels show), or null. */
export async function readActiveDocument(root: string): Promise<DocumentState | null> {
  let id: string | null = null;
  try {
    const raw = await readFile(activePointerPath(root), 'utf8');
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (typeof parsed.id === 'string') id = parsed.id;
  } catch {
    return null;
  }
  if (!id) return null;
  return readDocument(root, id);
}

export async function setActiveDocument(root: string, id: string): Promise<void> {
  await mkdir(documentsRoot(root), { recursive: true });
  await writeFile(activePointerPath(root), `${JSON.stringify({ id }, null, 2)}\n`, 'utf8');
}

/** Create a fresh active document, replacing the pointer (old one stays on disk until archived). */
export async function createActiveDocument(root: string, kind: DokumenKind, title: string): Promise<DocumentState> {
  const doc = newDocument(kind, title);
  await writeDocument(root, doc);
  await setActiveDocument(root, doc.id);
  return doc;
}

export async function appendAudit(root: string, docId: string, entry: Record<string, unknown>): Promise<void> {
  const paths = documentPaths(root, docId);
  await mkdir(paths.dir, { recursive: true });
  await appendFile(paths.auditLog, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

export async function readAudit(root: string, docId: string): Promise<Array<Record<string, unknown>>> {
  const paths = documentPaths(root, docId);
  try {
    const raw = await readFile(paths.auditLog, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Ingest one workspace file into the document: copy its bytes into the
 * document's files/ and register it. Idempotent per content hash — the
 * same file ingested twice (or the same bytes under two names) yields
 * the existing source, never a duplicate.
 */
export async function ingestSourceFile(
  root: string,
  doc: DocumentState,
  absPath: string,
  originPath?: string,
): Promise<{ source: SourceInfo; added: boolean }> {
  const bytes = await readFile(absPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = doc.sources.find((s) => s.sha256 === sha256);
  if (existing) return { source: existing, added: false };
  const paths = documentPaths(root, doc.id);
  await mkdir(paths.filesDir, { recursive: true });
  const filename = basename(absPath);
  await copyFile(absPath, join(paths.filesDir, filename));
  const source: SourceInfo = {
    id: newSourceId(),
    filename,
    ...(originPath ? { originPath } : {}),
    sha256,
    bytes: bytes.length,
    pages: 0,
    parseMode: 'native',
    status: 'registered',
  };
  doc.sources.push(source);
  await appendAudit(root, doc.id, { actor: 'engine', action: 'source_ingested', sourceId: source.id, filename, sha256 });
  return { source, added: true };
}

export function sourceFilePath(root: string, docId: string, filename: string): string {
  return join(documentPaths(root, docId).filesDir, basename(filename));
}

/* ------------------------------------------------------- parsed cache */

export async function writeParsedBlocks(root: string, docId: string, sourceId: string, parsed: ParsedSource): Promise<void> {
  const paths = documentPaths(root, docId);
  await mkdir(paths.blocksDir, { recursive: true });
  await writeFile(join(paths.blocksDir, `${sourceId}.json`), `${JSON.stringify(parsed)}\n`, 'utf8');
}

export async function readParsedBlocks(root: string, docId: string, sourceId: string): Promise<ParsedSource | null> {
  const paths = documentPaths(root, docId);
  try {
    const raw = await readFile(join(paths.blocksDir, `${sourceId}.json`), 'utf8');
    return JSON.parse(raw) as ParsedSource;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ saved schemas */

export type SavedSchema = { docType: string; schema: DokumenSchema; savedAt: string };

function schemaFileName(docType: string): string {
  return `${docType.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.json`;
}

export async function readSavedSchema(root: string, docType: string): Promise<SavedSchema | null> {
  try {
    const raw = await readFile(join(savedSchemasDir(root), schemaFileName(docType)), 'utf8');
    return JSON.parse(raw) as SavedSchema;
  } catch {
    return null;
  }
}

export async function saveSchema(root: string, docType: string, schema: DokumenSchema): Promise<void> {
  await mkdir(savedSchemasDir(root), { recursive: true });
  await writeFile(join(savedSchemasDir(root), schemaFileName(docType)), `${JSON.stringify({ docType, schema, savedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
}

export async function listSavedSchemas(root: string): Promise<SavedSchema[]> {
  let names: string[];
  try {
    names = await readdir(savedSchemasDir(root));
  } catch {
    return [];
  }
  const out: SavedSchema[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(await readFile(join(savedSchemasDir(root), name), 'utf8')) as SavedSchema);
    } catch {
      /* a corrupt saved schema is skipped, never fatal */
    }
  }
  return out;
}

/* ------------------------------------------------------------ archive */

/**
 * New chat in Dokumen = full reset: the active document folder moves to
 * `.daedalus/dokumen-archive/<timestamp>-<slug>/` (never deleted), and
 * the active pointer is cleared. Slide's deck-archive precedent.
 */
export async function archiveActiveDocument(root: string): Promise<{ archivedTo: string; id: string } | null> {
  const doc = await readActiveDocument(root);
  if (!doc) return null;
  const paths = documentPaths(root, doc.id);
  if (!existsSync(paths.dir)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = doc.title.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dokumen';
  const target = join(dokumenArchiveDir(root), `${stamp}-${slug}`);
  await mkdir(dokumenArchiveDir(root), { recursive: true });
  await rename(paths.dir, target);
  try {
    await writeFile(activePointerPath(root), `${JSON.stringify({ id: null }, null, 2)}\n`, 'utf8');
  } catch {
    /* pointer cleanup is best-effort; the archive itself already happened */
  }
  return { archivedTo: target, id: doc.id };
}

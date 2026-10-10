import { join } from 'node:path';

/**
 * document.json — the Dokumen domain's source of truth (the deck.json
 * analog). Native files (PDF/DOCX/XLSX exports) are renders of this
 * state, never the truth itself: every human edit (field correction,
 * prose edit, style-op approval) lands here, and any export can be
 * re-rendered from it. See Desain-Agentic-Dokumen-v1.md.
 */

export type DokumenKind = 'extract' | 'compose';

/** Composer sub-mode named by the Web: Ekstrak | Susun. */
export type DokumenSubMode = 'ekstrak' | 'susun';

export type FieldType = 'string' | 'number' | 'money' | 'date' | 'email' | 'boolean';

export type FieldDef = {
  name: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  /** Deterministic rule ids (validate.ts): 'arithmetic-total', 'not-future', … */
  rules?: string[];
  examples?: string[];
};

export type ExtractionTarget = 'per_doc' | 'per_page' | 'per_row';

export type DokumenSchema = {
  version: number;
  fields: FieldDef[];
  extractionTarget: ExtractionTarget;
  /** Decision thresholds (0..1); defaults live in validate.ts. */
  autoClearMin?: number;
  escalateBelow?: number;
  /** True once a human approved this schema in the panel (or it came from a saved schema). */
  approved?: boolean;
};

export type FieldStatus = 'auto' | 'flagged' | 'escalated' | 'corrected';

export type Provenance = {
  page: number;
  quote?: string;
  /** [x, y, w, h] in PDF points (origin top-left), when the parser knows it. */
  bbox?: [number, number, number, number];
};

export type FieldValue = {
  value: string | number | boolean | null;
  /** Verbatim text the value was read from, before normalization. */
  raw?: string;
  confidence: number;
  provenance?: Provenance;
  status: FieldStatus;
  /** Set when code derived the value (never the model) or a human corrected it. */
  note?: string;
  originalValue?: string | number | boolean | null;
};

export type RecordCheck = { rule: string; passed: boolean; detail: string };

export type RecordDecision = 'auto-clear' | 'flag' | 'escalate';

export type ExtractRecord = {
  id: string;
  sourceId: string;
  /** Page the record came from for per_page/per_row targets (1-based); absent = whole doc. */
  page?: number;
  fields: Record<string, FieldValue>;
  checks: RecordCheck[];
  decision: RecordDecision;
};

export type SourceStatus = 'registered' | 'parsed' | 'extracted' | 'flagged' | 'failed';

export type SourceInfo = {
  id: string;
  filename: string;
  /** Workspace-relative path the file was ingested from (provenance of the copy). */
  originPath?: string;
  sha256: string;
  bytes: number;
  pages: number;
  parseMode: 'native';
  status: SourceStatus;
  docType?: string;
  error?: string;
};

export type SectionStatus = 'staged' | 'drafted' | 'critic-flagged';

export type DokumenSection = {
  id: string;
  title: string;
  thesisPoints: string[];
  /** Citation ids ([SRC-1] …) threaded into this section's prose. */
  citations: string[];
  prose: string;
  status: SectionStatus;
};

export type StyleOp = {
  id: string;
  /** Machine target: 'margin' | 'font' | 'fontSize' | 'lineSpacing' | 'headingNumbering' | 'headingFont'. */
  target: string;
  /** Human-readable state before, e.g. "margin 2.54/2.54/2.54/2.54 cm". */
  before: string;
  after: string;
  applied: boolean;
};

export type ExportRecord = {
  format: 'json' | 'csv' | 'xlsx' | 'docx' | 'pdf';
  /** Workspace-relative path of the rendered file. */
  path: string;
  recordCount: number;
  heldBack: number;
  at: string;
};

export type Citation = { id: string; title: string; url?: string; quote?: string };

export type DocumentState = {
  version: 1;
  id: string;
  kind: DokumenKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  sources: SourceInfo[];
  schema?: DokumenSchema;
  records: ExtractRecord[];
  sections: DokumenSection[];
  styleOps: StyleOp[];
  /** DOCX opened for re-layout (workspace-relative), when styleOps exist. */
  styleTarget?: string;
  exports: ExportRecord[];
  citations: Record<string, Citation>;
};

export type ParsedBlock = {
  page: number;
  text: string;
  bbox?: [number, number, number, number];
};

export type ParsedSource = {
  pages: number;
  /** Page sizes in points (PDF) for bbox overlay rendering; index = page-1. */
  pageSizes: Array<{ width: number; height: number }>;
  blocks: ParsedBlock[];
  /** Whole text (blocks joined) — chunking happens per page, never one giant context. */
  text: string;
};

export function documentDir(root: string, id: string): string {
  return join(root, '.daedalus', 'documents', id);
}

export function documentPaths(root: string, id: string): {
  dir: string;
  file: string;
  filesDir: string;
  blocksDir: string;
  exportsDir: string;
  auditLog: string;
} {
  const dir = documentDir(root, id);
  return {
    dir,
    file: join(dir, 'document.json'),
    filesDir: join(dir, 'files'),
    blocksDir: join(dir, 'blocks'),
    exportsDir: join(dir, 'exports'),
    auditLog: join(dir, 'audit.jsonl'),
  };
}

export function documentsRoot(root: string): string {
  return join(root, '.daedalus', 'documents');
}

export function activePointerPath(root: string): string {
  return join(documentsRoot(root), 'active.json');
}

export function savedSchemasDir(root: string): string {
  return join(documentsRoot(root), 'schemas');
}

export function dokumenArchiveDir(root: string): string {
  return join(root, '.daedalus', 'dokumen-archive');
}

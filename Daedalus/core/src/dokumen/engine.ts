import { resolve } from 'node:path';
import type { LLMProvider } from '../providers/llm/types.ts';
import type { DocumentState, DokumenSubMode, ParsedSource, SourceInfo } from './document.ts';
import {
  appendAudit,
  listSavedSchemas,
  archiveActiveDocument,
  createActiveDocument,
  ingestSourceFile,
  newSectionId,
  readActiveDocument,
  readParsedBlocks,
  sourceFilePath,
  writeDocument,
  writeParsedBlocks,
} from './store.ts';
import { pageChunks, parseSourceFile } from './parse.ts';
import {
  classifyStage,
  criticStage,
  draftSectionStage,
  extractSourceStage,
  proposeOutlineStage,
  proposeSchemaStage,
  type CitationMaterial,
} from './pipeline.ts';
import { decisionCounts } from './validate.ts';
import { inspectDocxStyles, parseStyleInstruction, proposeStyleOps, applyStyleOps } from './style-ops.ts';
import { DokumenWebTools } from './web.ts';

export type { DokumenSubMode } from './document.ts';

/** The one helper inherited from the house: ask the user a question with options, answer as text. */
export type DokumenAskUser = (question: string, options: string[]) => Promise<string>;

export type DokumenRunEvent =
  | { type: 'stage'; docId: string; stage: string }
  | { type: 'model-request-started'; model: string }
  | { type: 'model-request-finished'; model: string; inputTokens?: number; outputTokens?: number }
  | { type: 'file-changed'; docId: string; path: string }
  | { type: 'report'; docId: string; summary: string };

export type DokumenEngineOptions = {
  signal?: AbortSignal;
  onEvent?: (event: DokumenRunEvent) => void;
  /** Mirrors the plan-step heartbeat (SlideEngine's setStage). */
  setStage?: (label: string) => void;
  /**
   * Inherited ask_user seam — the ONLY helper Dokumen shares with the
   * coding domain (constitution). Used when a saved schema matches the
   * document kind: the user picks reuse-vs-fresh in the chat card.
   */
  askUser?: DokumenAskUser;
  webTools?: DokumenWebTools;
};

export type DokumenRunOptions = {
  subMode: DokumenSubMode;
  /** Absolute (or workspace-relative) source paths to ingest for this run. */
  sources?: string[];
  /** DOCX to re-layout (compose sub-mode); the instruction is the prompt. */
  docxPath?: string;
};

type StagedGate = {
  kind: 'schema' | 'outline' | 'style';
  docId: string;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * DokumenEngine — the third fully separate Daedalus domain engine
 * (design decision 1). It never touches Coding's AgentLoop, tool
 * registry, permission gate, or autonomy modes, and never Slide's
 * engine; Slide is only a design-level template. The single shared
 * helper is `ask_user`, inherited exactly as Slide inherits it, and the
 * single shared concept is staged review: schema (Ekstrak), outline
 * (Susun), and style changes are staged in the panel and released by a
 * button — never by a chat question card.
 *
 * `document.json` is the source of truth; the model is called only in
 * narrow schema-bound stages (classify, propose schema, extract,
 * draft, critic) whose output is validated by code. Validation,
 * arithmetic reconciliation, and style rewriting are deterministic.
 */
export class DokumenEngine {
  readonly #provider: LLMProvider;
  readonly #options: DokumenEngineOptions;
  readonly #abort = new AbortController();
  readonly #web: DokumenWebTools;
  #staged: StagedGate | undefined;
  #stagedRelease: 'release' | 'abandon' | undefined;
  #workspaceRoot = '';

  /** Workspace this engine is running in (the runtime's seam key). */
  get workspaceRoot(): string {
    return this.#workspaceRoot;
  }

  constructor(provider: LLMProvider, options: DokumenEngineOptions = {}) {
    this.#provider = this.#observingProvider(provider);
    this.#options = options;
    this.#web = options.webTools ?? new DokumenWebTools();
    options.signal?.addEventListener('abort', () => this.#abort.abort(), { once: true });
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /** Called by the runtime when the process must stop: abort in-flight work and free the gate. */
  stop(detail = 'dokumen task stopped'): void {
    this.#abort.abort();
    const staged = this.#staged;
    this.#staged = undefined;
    this.#stagedRelease = undefined;
    staged?.reject(new Error(detail));
  }

  /** Settle the staged schema/outline/style gate as APPROVED (the panel's release button). */
  releaseStaged(): boolean {
    const staged = this.#staged;
    if (!staged) {
      this.#stagedRelease = 'release';
      return false;
    }
    this.#staged = undefined;
    staged.resolve();
    return true;
  }

  /** Settle the staged gate as ABANDONED (new chat / superseding task). */
  abandonStaged(): boolean {
    const staged = this.#staged;
    if (!staged) {
      this.#stagedRelease = 'abandon';
      return false;
    }
    this.#staged = undefined;
    staged.reject(new Error('staged review abandoned'));
    return true;
  }

  async run(root: string, prompt: string, run: DokumenRunOptions): Promise<string> {
    this.#workspaceRoot = root;
    const doc = await this.#ensureDocument(root, run.subMode === 'ekstrak' ? 'extract' : 'compose', prompt);
    if (run.subMode === 'ekstrak') return this.#runExtract(root, doc, prompt, run);
    if (run.docxPath) return this.#runRelayout(root, doc, prompt, run.docxPath);
    return this.#runCompose(root, doc, prompt);
  }

  /* ------------------------------------------------------------ extract */

  async #runExtract(root: string, doc: DocumentState, prompt: string, run: DokumenRunOptions): Promise<string> {
    this.#stage(doc, 'Menyiapkan dokumen');

    // Ingest: copy bytes in, hash for dedupe (an already-present file
    // is pointed at the existing source, never duplicated).
    for (const sourcePath of run.sources ?? []) {
      const abs = resolve(root, sourcePath);
      const { source, added } = await ingestSourceFile(root, doc, abs, sourcePath);
      await appendAudit(root, doc.id, { action: 'ingest', detail: added ? `sumber masuk: ${source.filename}` : `duplikat terdeteksi (sha256 sama): ${source.filename}` });
      await writeDocument(root, doc);
      this.#emitFileChanged(doc);
    }

    // Parse every source that has no blocks yet (native, always).
    for (const source of doc.sources) {
      const cached = await readParsedBlocks(root, doc.id, source.id);
      if (cached || source.status === 'parsed') continue;
      try {
        const parsed = await parseSourceFile(sourceFilePath(root, doc.id, source.filename));
        await writeParsedBlocks(root, doc.id, source.id, parsed);
        source.pages = parsed.pages;
        source.parseMode = 'native';
        source.status = 'parsed';
        await writeDocument(root, doc);
        await appendAudit(root, doc.id, { action: 'parse', sourceId: source.id, detail: `${source.filename}: ${parsed.pages} halaman, ${parsed.blocks.length} blok teks (native)` });
      } catch (error) {
        source.status = 'failed';
        source.error = error instanceof Error ? error.message : String(error);
        await writeDocument(root, doc);
        await appendAudit(root, doc.id, { action: 'parse-failed', sourceId: source.id, detail: source.error });
      }
      this.#emitFileChanged(doc);
    }

    const parsedSources = doc.sources.filter((s) => s.status === 'parsed');
    if (parsedSources.length === 0) {
      return this.#report(doc, 'Tidak ada sumber yang bisa dibaca. Tambahkan berkas PDF, DOCX, EML, TXT, atau MD lalu jalankan lagi.');
    }

    // Classify the first source (cheap seat), then the schema gate.
    const first = parsedSources[0]!;
    const firstParsed = await this.#parsedOf(root, doc, first);

    if (!doc.schema) {
      this.#stage(doc, 'Mengklasifikasi dokumen');
      first.docType = first.docType ?? (await classifyStage(this.#provider, firstParsed, this.signal).catch(() => 'dokumen'));
      await writeDocument(root, doc);

      // A saved schema for this kind? ask_user decides reuse vs fresh
      // (the one inherited helper). Without ask_user: reuse silently.
      const saved = (await listSavedSchemas(root)).find((s) => s.docType === first.docType && s.schema.fields.length > 0);
      let reuse = false;
      if (saved) {
        if (this.#options.askUser) {
          const answer = await this.#options.askUser(
            `Sudah ada skema tersimpan untuk dokumen "${first.docType}" (${saved.schema.fields.map((f) => f.name).join(', ')}). Pakai skema itu atau buat usulan skema baru dari contoh ini?`,
            ['Pakai skema tersimpan', 'Buat usulan baru'],
            ).catch(() => '');
          reuse = /tersimpan/i.test(answer);
        } else {
          reuse = true;
        }
      }
      if (saved && reuse) {
        doc.schema = { ...saved.schema, approved: true };
        await appendAudit(root, doc.id, { action: 'schema-reused', detail: `skema tersimpan "${first.docType}" dipakai` });
        await writeDocument(root, doc);
      } else {
        this.#stage(doc, 'Mengusulkan skema');
        const fields = await proposeSchemaStage(this.#provider, firstParsed, first.docType ?? 'dokumen', prompt, this.signal);
        doc.schema = { version: 1, fields, extractionTarget: 'per_doc', approved: false };
        await writeDocument(root, doc);
        await appendAudit(root, doc.id, { action: 'schema-proposed', detail: `${fields.length} field diusulkan: ${fields.map((f) => f.name).join(', ')}` });
        this.#emitFileChanged(doc);
      }
    }

    if (doc.schema && !doc.schema.approved) {
      this.#stage(doc, 'Menunggu persetujuan skema');
      try {
        await this.#stageGate(doc, 'schema');
      } catch {
        return this.#report(doc, 'Usulan skema dibatalkan sebelum disetujui. Tidak ada data yang diekstrak.');
      }
      doc = (await readActiveDocument(root)) ?? doc;
      doc.schema = { ...doc.schema!, approved: true };
      await appendAudit(root, doc.id, { action: 'schema-approved', detail: 'skema disetujui dari Panel Skema (tombol Ekstrak)' });
      await writeDocument(root, doc);
      this.#emitFileChanged(doc);
    }

    // Extract + validate per source (records replaced per source).
    this.#stage(doc, 'Mengekstrak data');
    const schema = doc.schema!;
    let extracted = 0;
    for (const source of parsedSources) {
      const parsed = await this.#parsedOf(root, doc, source);
      const records = await extractSourceStage(this.#provider, parsed, schema, source.id, this.signal);
      doc.records = doc.records.filter((r) => r.sourceId !== source.id).concat(records);
      extracted += records.length;
      await appendAudit(root, doc.id, { action: 'extract', sourceId: source.id, detail: `${records.length} record diekstrak dari ${source.filename}` });
      await writeDocument(root, doc);
      this.#emitFileChanged(doc);
    }

    const counts = decisionCounts(doc.records);
    return this.#report(
      doc,
      [
        `Ekstraksi selesai terhadap ${parsedSources.length} sumber: ${extracted} record.`,
        `Keputusan deterministik: ${counts.autoClear} otomatis lolos (auto-clear), ${counts.flag} ditandai (flag), ${counts.escalate} dinaikkan (escalate).`,
        counts.heldBack > 0
          ? `${counts.heldBack} record tertahan dari ekspor sampai diperiksa/dikoreksi di kanvas. Buka catatan di Panel Laporan.`
          : 'Semua record terverifikasi dan siap diekspor (JSON/CSV/XLSX dari Panel Laporan).',
      ].join(' '),
    );
  }

  /* ------------------------------------------------------------ compose */

  async #runCompose(root: string, doc: DocumentState, prompt: string): Promise<string> {
    this.#stage(doc, 'Menyusun kerangka');
    const outlineReady = doc.sections.length > 0 && doc.sections.every((s) => s.status === 'staged');
    if (!outlineReady) {
      doc = (await readActiveDocument(root)) ?? doc;
      doc.sections = doc.sections.filter((s) => s.status === 'drafted' || s.status === 'critic-flagged');
      const summaries: string[] = [];
      for (const source of doc.sources.filter((s) => s.status === 'parsed')) {
        const parsed = await this.#parsedOf(root, doc, source);
        summaries.push(`Sumber "${source.filename}" (${source.docType ?? 'dokumen'}): ${parsed.text.slice(0, 400)}`);
      }
      const outline = await proposeOutlineStage(this.#provider, prompt, summaries, this.signal);
      doc.sections = outline.map((item) => ({
        id: newSectionId(),
        title: item.title,
        thesisPoints: item.thesisPoints,
        prose: '',
        citations: [],
        status: 'staged' as const,
      }));
      doc.title = doc.title || prompt.slice(0, 80) || doc.title;
      await writeDocument(root, doc);
      await appendAudit(root, doc.id, { action: 'outline-proposed', detail: `${outline.length} bab diusulkan: ${outline.map((o) => o.title).join(' | ')}` });
      this.#emitFileChanged(doc);
    }

    this.#stage(doc, 'Menunggu persetujuan kerangka');
    try {
      await this.#stageGate(doc, 'outline');
    } catch {
      return this.#report(doc, 'Kerangka dibatalkan sebelum disetujui. Belum ada bab yang ditulis.');
    }
    doc = (await readActiveDocument(root)) ?? doc;

    // Write each section: web-gathered, cited, critic-gated (cap 3).
    let citationSeq = Object.keys(doc.citations).length;
    const flagged: string[] = [];
    let wordTotal = 0;
    for (const section of doc.sections) {
      if (this.signal.aborted) throw new Error('dokumen task stopped');
      this.#stage(doc, `Menulis bab "${section.title}"`);
      const materials: CitationMaterial[] = [];

      // Workspace sources are citable material too.
      for (const source of doc.sources.filter((s) => s.status === 'parsed').slice(0, 2)) {
        const parsed = await this.#parsedOf(root, doc, source);
        citationSeq += 1;
        const id = `SRC-${citationSeq}`;
        doc.citations[id] = { id, title: source.filename };
        materials.push({ id, title: source.filename, text: pageChunks(parsed).map((c) => c.text).join('\n').slice(0, 6000) });
      }

      // The engine's own web tools (never the shell): search, then fetch.
      const hits = await this.#web.webSearch(`${section.title} ${doc.title}`.slice(0, 120), 3, this.signal).catch(() => []);
      await appendAudit(root, doc.id, { action: 'web-search', detail: `"${section.title}" → ${hits.length} hasil` });
      for (const hit of hits.slice(0, 2)) {
        const page = await this.#web.fetchUrl(hit.url, this.signal).catch(() => null);
        if (!page) continue;
        citationSeq += 1;
        const id = `SRC-${citationSeq}`;
        doc.citations[id] = { id, title: page.title || hit.title, url: page.url };
        materials.push({ id, title: page.title || hit.title, text: page.text });
        await appendAudit(root, doc.id, { action: 'web-fetch', detail: `${page.url} dibaca sebagai ${id}` });
      }
      await writeDocument(root, doc);

      let accepted: { prose: string; citations: string[] } | null = null;
      let lastIssues: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const draft = await draftSectionStage(this.#provider, {
          title: section.title,
          thesisPoints: section.thesisPoints,
          goal: doc.title,
          materials,
          ...(attempt > 1 ? { repairIssues: lastIssues } : {}),
        }, this.signal);
        const verdict = await criticStage(this.#provider, { title: section.title, prose: draft.prose, citations: draft.citations, materials }, this.signal);
        if (verdict.ok) {
          accepted = draft;
          break;
        }
        lastIssues = verdict.issues;
        await appendAudit(root, doc.id, { action: 'critic-reject', detail: `bab "${section.title}" upaya ${attempt}: ${verdict.issues.join('; ')}` });
      }
      section.prose = accepted?.prose ?? section.prose;
      section.citations = accepted ? accepted.citations.filter((id) => doc.citations[id] !== undefined) : [];
      section.status = accepted ? 'drafted' : 'critic-flagged';
      if (!accepted) flagged.push(section.title);
      wordTotal += section.prose.split(/\s+/).filter(Boolean).length;
      await writeDocument(root, doc);
      this.#emitFileChanged(doc);
    }

    return this.#report(
      doc,
      [
        `Penyusunan selesai: ${doc.sections.length} bab, ±${wordTotal} kata, ${Object.keys(doc.citations).length} sitasi tercatat.`,
        flagged.length > 0 ? `Bab yang DITANDAI kritikus (butuh pemeriksaan): ${flagged.join(', ')}.` : 'Semua bab lolos gerbang kritikus.',
        'Ekspor DOCX tersedia dari Panel Laporan.',
      ].join(' '),
    );
  }

  /* ------------------------------------------------------------ re-layout */

  async #runRelayout(root: string, doc: DocumentState, prompt: string, docxPath: string): Promise<string> {
    this.#stage(doc, 'Membaca gaya dokumen');
    const abs = resolve(root, docxPath);
    const current = await inspectDocxStyles(abs).catch((error: unknown) => {
      throw new Error(`tidak dapat membaca DOCX ${docxPath}: ${error instanceof Error ? error.message : String(error)}`);
    });
    doc.styleTarget = abs;
    await writeDocument(root, doc);

    const target = parseStyleInstruction(prompt);
    if (!target) {
      return this.#report(
        doc,
        `Dokumen dibaca (margin saat ini ${current.marginsCm.join('/')} cm, ${current.font} ${current.fontSizePt}pt, spasi ${current.lineSpacing}). Instruksi tata ulang tidak dikenali — sebutkan misalnya: "margin 4-3-3-3, font Times New Roman 12pt, spasi 1.5, heading bernomor".`,
      );
    }
    doc.styleOps = proposeStyleOps(current, target);
    await writeDocument(root, doc);
    await appendAudit(root, doc.id, { action: 'style-staged', detail: `${doc.styleOps.length} perubahan gaya diusulkan untuk ${docxPath}` });
    this.#emitFileChanged(doc);
    if (doc.styleOps.length === 0) {
      return this.#report(doc, 'Dokumen sudah sesuai instruksi — tidak ada perubahan gaya yang perlu diterapkan.');
    }

    this.#stage(doc, 'Menunggu penerapan tata ulang');
    try {
      await this.#stageGate(doc, 'style');
    } catch {
      return this.#report(doc, 'Daftar perubahan tata ulang dibatalkan. Berkas asli tidak diubah.');
    }
    doc = (await readActiveDocument(root)) ?? doc;
    const result = await applyStyleOps(root, doc, abs, doc.styleOps);
    await appendAudit(root, doc.id, { action: 'style-applied', detail: `${result.path} (${result.bytes} byte); asli tidak ditimpa` });
    await writeDocument(root, doc);
    this.#emitFileChanged(doc);
    return this.#report(doc, `Tata ulang diterapkan: ${result.path} dibuat dari ${docxPath} (${result.bytes} byte). Berkas asli tidak pernah ditimpa.`);
  }

  /* ------------------------------------------------------------ helpers */

  async #ensureDocument(root: string, kind: 'extract' | 'compose', prompt: string): Promise<DocumentState> {
    const existing = await readActiveDocument(root);
    if (existing && existing.kind === kind) return existing;
    if (existing) await archiveActiveDocument(root);
    return createActiveDocument(root, kind, prompt.slice(0, 80) || (kind === 'extract' ? 'Ekstraksi dokumen' : 'Dokumen baru'));
  }

  async #parsedOf(root: string, doc: DocumentState, source: SourceInfo): Promise<ParsedSource> {
    const cached = await readParsedBlocks(root, doc.id, source.id);
    if (cached) return cached;
    return parseSourceFile(sourceFilePath(root, doc.id, source.filename));
  }

  /**
   * The staged gate (Slide doctrine): the panel shows the proposal,
   * the run waits here; the panel's release button settles it. A late
   * release (button hit before staging) settles immediately on arrival.
   */
  #stageGate(doc: DocumentState, kind: StagedGate['kind']): Promise<void> {
    if (this.#stagedRelease === 'release') {
      this.#stagedRelease = undefined;
      return Promise.resolve();
    }
    if (this.#stagedRelease === 'abandon') {
      this.#stagedRelease = undefined;
      return Promise.reject(new Error('staged review abandoned'));
    }
    if (this.#staged) return Promise.reject(new Error('another staged review is already waiting'));
    return new Promise<void>((resolvePromise, reject) => {
      this.#staged = { kind, docId: doc.id, resolve: resolvePromise, reject };
      this.#stage(doc, kind === 'schema' ? 'Menunggu persetujuan skema' : kind === 'outline' ? 'Menunggu persetujuan kerangka' : 'Menunggu penerapan tata ulang');
    });
  }

  #observingProvider(provider: LLMProvider): LLMProvider {
    return {
      name: provider.name,
      chat: async (messages, tools, options) => {
        const model = provider.name;
        this.#options.onEvent?.({ type: 'model-request-started', model });
        try {
          const response = await provider.chat(messages, tools, options);
          this.#options.onEvent?.({
            type: 'model-request-finished',
            model,
            ...(typeof response.usage?.prompt_tokens === 'number' ? { inputTokens: response.usage.prompt_tokens } : {}),
            ...(typeof response.usage?.completion_tokens === 'number' ? { outputTokens: response.usage.completion_tokens } : {}),
          });
          return response;
        } catch (error) {
          this.#options.onEvent?.({ type: 'model-request-finished', model });
          throw error;
        }
      },
      stream: (messages, tools, options) => provider.stream(messages, tools, options),
    };
  }

  #stage(doc: DocumentState, label: string): void {
    this.#options.setStage?.(label);
    this.#options.onEvent?.({ type: 'stage', docId: doc.id, stage: label });
  }

  #emitFileChanged(doc: DocumentState): void {
    this.#options.onEvent?.({ type: 'file-changed', docId: doc.id, path: `.daedalus/documents/${doc.id}/document.json` });
  }

  async #report(doc: DocumentState, summary: string): Promise<string> {
    this.#options.onEvent?.({ type: 'report', docId: doc.id, summary });
    return [
      `Dokumen "${doc.title}" (${doc.kind === 'extract' ? 'Ekstrak' : 'Susun'})`,
      summary,
      'Seluruh perubahan tercatat di audit log dokumen (.daedalus/documents/<id>/audit.jsonl).',
    ].join('\n');
  }
}

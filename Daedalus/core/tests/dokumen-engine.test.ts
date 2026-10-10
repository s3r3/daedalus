import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DokumenEngine,
  DokumenWebTools,
  TaskRunner,
  buildDocumentDocxBytes,
  decisionCounts,
  exportData,
  exportDocumentDocx,
  inspectDocxStyles,
  parseStyleInstruction,
  proposeStyleOps,
  applyStyleOps,
  readActiveDocument,
  readAudit,
  archiveActiveDocument,
  createActiveDocument,
  writeDocument,
  type LLMProvider,
  type Message,
} from '../src/index.ts';

/**
 * DokumenEngine suite: the third separate domain. A scripted provider
 * answers each pipeline seat by looking at the stage's system prompt;
 * the engine must stage the schema for approval (never extract before
 * release), validate deterministically, gate exports on verification,
 * archive on reset, and re-layout DOCX without touching the original.
 */

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-dokumen-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INVOICE = `CV Sinar Abadi — Invoice INV-2026-001
Tanggal: 12 Maret 2026
Subtotal: Rp 1.000.000
PPN: Rp 110.000
Total: Rp 1.110.000
Jatuh tempo 30 hari. Terima kasih.`;

type Scenario = { wrongTotal?: boolean; unreadableTotal?: boolean; criticMode?: 'ok' | 'always-reject' | 'reject-first' };

function scriptedProvider(scenario: Scenario = {}): LLMProvider {
  let draftCalls = 0;
  let criticCalls = 0;
  const respond = (messages: Message[]): { content: string } => {
    const system = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    if (system.includes('classify a document')) return { content: '{"docType":"invoice"}' };
    if (system.includes('propose an extraction schema')) {
      return { content: '{"fields":[{"name":"vendor","type":"string","required":true},{"name":"invoice_number","type":"string","required":true},{"name":"date","type":"date","required":true},{"name":"subtotal","type":"money"},{"name":"tax","type":"money"},{"name":"total","type":"money","required":true}]}' };
    }
    if (system.includes('extract structured fields')) {
      const total = scenario.unreadableTotal
        ? { value: 'samar', confidence: 0.9, quote: 'Total' }
        : { value: scenario.wrongTotal ? 999999 : 'Rp 1.110.000', confidence: 0.95, quote: 'Total: Rp 1.110.000' };
      return {
        content: JSON.stringify({
          fields: {
            vendor: { value: 'CV Sinar Abadi', confidence: 0.97, quote: 'CV Sinar Abadi' },
            invoice_number: { value: 'INV-2026-001', confidence: 0.95, quote: 'Invoice INV-2026-001' },
            date: { value: '12 Maret 2026', confidence: 0.93, quote: 'Tanggal: 12 Maret 2026' },
            subtotal: { value: 'Rp 1.000.000', confidence: 0.95, quote: 'Subtotal: Rp 1.000.000' },
            tax: { value: 'Rp 110.000', confidence: 0.95, quote: 'PPN: Rp 110.000' },
            total,
          },
        }),
      };
    }
    if (system.includes('outline a formal')) {
      return { content: '{"sections":[{"title":"Pendahuluan","thesisPoints":["Latar belakang"]},{"title":"Penutup","thesisPoints":["Kesimpulan"]}]}' };
    }
    if (system.includes('write ONE section')) {
      draftCalls += 1;
      const user = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const ids = [...user.matchAll(/\[(SRC-\d+)\]/g)].map((m) => m[1]!);
      const id = ids[ids.length - 1] ?? 'SRC-1';
      return { content: JSON.stringify({ prose: `Dokumen ini membahas latar belakang penelitian secara umum dan sistematis. Berdasarkan sumber yang dibaca [${id}], kerangka kerja disusun bertahap. Upaya tulis ke-${draftCalls}.`, citations: [id] }) };
    }
    if (system.includes('critic gate')) {
      criticCalls += 1;
      if (scenario.criticMode === 'always-reject') return { content: JSON.stringify({ ok: false, issues: [`sitasi belum menunjang klaim utama (kritik ke-${criticCalls})`] }) };
      if (scenario.criticMode === 'reject-first' && criticCalls % 2 === 1) return { content: JSON.stringify({ ok: false, issues: [`perlu revisi sebelum lolos (kritik ke-${criticCalls})`] }) };
      return { content: '{"ok":true,"issues":[]}' };
    }
    return { content: '{}' };
  };
  return {
    name: 'fake-dokumen',
    async chat(messages: Message[]) {
      return { message: { role: 'assistant' as const, content: respond(messages).content }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
  } as unknown as LLMProvider;
}

const offlineWeb = new DokumenWebTools({
  fetchImpl: async (url) => {
    if (url.includes('duckduckgo')) return { status: 200, text: async () => '<a class="result__a" href="https://example.org/sumber">Sumber</a><a class="result__snippet">ringkasan</a>' };
    return { status: 200, text: async () => '<html><head><title>Sumber Contoh</title></head><body><p>Isi sumber yang dapat disitasi untuk bab ini.</p></body></html>' };
  },
  env: {},
});

async function until(fn: () => Promise<boolean>, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not met in time');
}

async function runExtract(root: string, scenario: Scenario = {}): Promise<DokumenEngine> {
  writeFileSync(join(root, 'invoice.txt'), INVOICE);
  const engine = new DokumenEngine(scriptedProvider(scenario), { webTools: offlineWeb });
  const pending = engine.run(root, 'ekstrak invoice ini', { subMode: 'ekstrak', sources: ['invoice.txt'] });
  await until(async () => {
    const doc = await readActiveDocument(root);
    return Boolean(doc?.schema && !doc.schema.approved);
  });
  expect(engine.releaseStaged()).toBe(true);
  await pending;
  return engine;
}

describe('Ekstrak pipeline (golden invoice, per-field ground truth)', () => {
  test('extracts, normalizes, reconciles and auto-clears a clean invoice', async () => {
    const root = tmpRoot();
    await runExtract(root);
    const doc = (await readActiveDocument(root))!;
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0]!.status).toBe('parsed');
    expect(doc.records).toHaveLength(1);
    const record = doc.records[0]!;
    expect(record.fields.vendor!.value).toBe('CV Sinar Abadi');
    expect(record.fields.date!.value).toBe('2026-03-12');
    expect(record.fields.subtotal!.value).toBe(1000000);
    expect(record.fields.tax!.value).toBe(110000);
    expect(record.fields.total!.value).toBe(1110000);
    expect(record.fields.total!.provenance?.page).toBe(1);
    expect(record.decision).toBe('auto-clear');
    const audit = await readAudit(root, doc.id);
    expect(audit.some((a) => a.action === 'extract')).toBe(true);
  });

  test('HONESTY: wrong total is flagged end-to-end and HELD BACK from export', async () => {
    const root = tmpRoot();
    await runExtract(root, { wrongTotal: true });
    const doc = (await readActiveDocument(root))!;
    expect(doc.records[0]!.decision).toBe('flag');
    const result = await exportData(root, doc, 'json');
    expect(result.recordCount).toBe(0);
    expect(result.heldBack).toBe(1);
    const rows = JSON.parse(readFileSync(join(root, result.path), 'utf8')) as unknown[];
    expect(rows).toHaveLength(0);
  });

  test('HONESTY: unreadable total escalates; after human correction the export gate opens', async () => {
    const root = tmpRoot();
    await runExtract(root, { unreadableTotal: true });
    const doc = (await readActiveDocument(root))!;
    expect(doc.records[0]!.decision).toBe('escalate');
    // Human correction in the grid (the server route does exactly this).
    const total = doc.records[0]!.fields.total!;
    doc.records[0]!.fields.total = { ...total, value: 1110000, status: 'corrected', originalValue: total.value, note: 'dikoreksi pengguna' };
    await writeDocument(root, doc);
    const result = await exportData(root, doc, 'csv');
    expect(result.recordCount).toBe(1);
    expect(result.heldBack).toBe(0);
    const csv = readFileSync(join(root, result.path), 'utf8');
    expect(csv).toContain('1110000');
    expect(csv).toContain('total:corrected');
  });

  test('hash dedupe: ingesting the same file twice yields one source', async () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'invoice.txt'), INVOICE);
    writeFileSync(join(root, 'invoice-copy.txt'), INVOICE);
    const engine = new DokumenEngine(scriptedProvider(), { webTools: offlineWeb });
    const pending = engine.run(root, 'ekstrak', { subMode: 'ekstrak', sources: ['invoice.txt', 'invoice-copy.txt'] });
    await until(async () => Boolean((await readActiveDocument(root))?.schema));
    engine.releaseStaged();
    await pending;
    const doc = (await readActiveDocument(root))!;
    expect(doc.sources).toHaveLength(1);
  });
});

describe('Susun pipeline (outline staged, cited drafting, critic gate)', () => {
  test('stages an outline, then writes cited sections on release', async () => {
    const root = tmpRoot();
    const engine = new DokumenEngine(scriptedProvider(), { webTools: offlineWeb });
    const pending = engine.run(root, 'susun makalah tentang agentic framework', { subMode: 'susun' });
    await until(async () => {
      const doc = await readActiveDocument(root);
      return Boolean(doc && doc.sections.length === 2);
    });
    const staged = (await readActiveDocument(root))!;
    expect(staged.sections.every((s) => s.status === 'staged')).toBe(true);
    expect(staged.sections.every((s) => s.prose === '')).toBe(true);
    expect(engine.releaseStaged()).toBe(true);
    const summary = await pending;
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'drafted')).toBe(true);
    expect(doc.sections[0]!.prose).toMatch(/\[SRC-\d+\]/);
    expect(Object.keys(doc.citations).length).toBeGreaterThan(0);
    expect(summary).toContain('lolos gerbang kritikus');
    // DOCX export renders from document.json.
    const exported = await exportDocumentDocx(root, doc);
    expect(existsSync(join(root, exported.path))).toBe(true);
    expect(exported.bytes).toBeGreaterThan(1000);
  });
});

describe('Susun critic rejects (flagged section keeps its draft + verdict)', () => {
  test('critic rejects all 3 attempts: last draft stays, final issues recorded on the section', async () => {
    const root = tmpRoot();
    const engine = new DokumenEngine(scriptedProvider({ criticMode: 'always-reject' }), { webTools: offlineWeb });
    const pending = engine.run(root, 'susun makalah tentang agentic framework', { subMode: 'susun' });
    await until(async () => {
      const doc = await readActiveDocument(root);
      return Boolean(doc && doc.sections.length === 2 && doc.sections.every((s) => s.status === 'staged'));
    });
    expect(engine.releaseStaged()).toBe(true);
    const summary = await pending;
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'critic-flagged')).toBe(true);
    // Not the empty-prose bug: bab pertama memakai draf upaya ke-3, bab kedua ke-6.
    expect(doc.sections[0]!.prose).toContain('Upaya tulis ke-3.');
    expect(doc.sections[0]!.prose).toMatch(/\[SRC-\d+\]/);
    expect(doc.sections[1]!.prose).toContain('Upaya tulis ke-6.');
    expect(doc.sections[0]!.criticIssues).toEqual(['sitasi belum menunjang klaim utama (kritik ke-3)']);
    expect(doc.sections[1]!.criticIssues).toEqual(['sitasi belum menunjang klaim utama (kritik ke-6)']);
    expect(summary).toContain('DITANDAI kritikus');
  });

  test('reject then accept: section drafted with the accepted prose and issues cleared', async () => {
    const root = tmpRoot();
    const engine = new DokumenEngine(scriptedProvider({ criticMode: 'reject-first' }), { webTools: offlineWeb });
    const pending = engine.run(root, 'susun makalah tentang agentic framework', { subMode: 'susun' });
    await until(async () => {
      const doc = await readActiveDocument(root);
      return Boolean(doc && doc.sections.length === 2 && doc.sections.every((s) => s.status === 'staged'));
    });
    expect(engine.releaseStaged()).toBe(true);
    const summary = await pending;
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'drafted')).toBe(true);
    expect(doc.sections[0]!.prose).toContain('Upaya tulis ke-2.');
    expect(doc.sections[1]!.prose).toContain('Upaya tulis ke-4.');
    expect(doc.sections.every((s) => (s.criticIssues ?? []).length === 0)).toBe(true);
    expect(summary).toContain('lolos gerbang kritikus');
  });
});

/**
 * A fake that imitates a COMPETENT real model (not the minimal scripted
 * one): cites the sources it was given, writes uncited general-knowledge
 * prose when given none, and critiques by the gate's rules.
 */
function susunanProvider(behavior: { contradiction?: boolean } = {}): LLMProvider {
  const respond = (messages: Message[]): { content: string } => {
    const system = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    const user = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    if (system.includes('outline a formal')) {
      return { content: '{"sections":[{"title":"Pendahuluan","thesisPoints":["Latar belakang"]},{"title":"Penutup","thesisPoints":["Kesimpulan"]}]}' };
    }
    if (system.includes('write ONE section')) {
      const ids = [...user.matchAll(/\[(SRC-\d+)\]/g)].map((m) => m[1]!);
      const id = ids[ids.length - 1];
      if (!id) {
        return { content: JSON.stringify({ prose: 'Bahasan umum ini disusun dari pengetahuan umum: vertebrata adalah hewan bertulang belakang yang terbagi ke dalam beberapa kelas besar dengan ciri khas masing-masing yang dikenal luas.', citations: [] }) };
      }
      if (behavior.contradiction) {
        return { content: JSON.stringify({ prose: `Berdasarkan sumber yang dibaca [${id}], dinyatakan bahwa semua vertebrata berdarah dingin, tidak menyusui, dan bertelur tanpa kecuali. KLAIM-BERTENTANGAN sengaja ditulis untuk menguji gerbang kritikus.`, citations: [id] }) };
      }
      return { content: JSON.stringify({ prose: `Berdasarkan sumber yang dibaca [${id}], kerangka vertebrata tersusun atas tulang belakang yang melindungi sumsum tulang belakang. Ciri inilah yang membedakan vertebrata dari hewan tak bertulang belakang.`, citations: [id] }) };
    }
    if (system.includes('critic gate')) {
      if (user.includes('KLAIM-BERTENTANGAN')) return { content: JSON.stringify({ ok: false, issues: ['klaim dalam prosa bertentangan dengan sumber yang disitasi'] }) };
      return { content: '{"ok":true,"issues":[]}' };
    }
    return { content: '{}' };
  };
  return {
    name: 'fake-dokumen-kompeten',
    async chat(messages: Message[]) {
      return { message: { role: 'assistant' as const, content: respond(messages).content }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    async *stream() {
      yield { type: 'done' as const };
    },
  } as unknown as LLMProvider;
}

const emptySearchWeb = new DokumenWebTools({
  fetchImpl: async () => ({ status: 200, text: async () => '<html><body>tidak ada hasil</body></html>' }),
  env: {},
});

const failingWeb = new DokumenWebTools({
  fetchImpl: async () => {
    throw new Error('jaringan tidak terjangkau (simulasi)');
  },
  env: {},
});

async function runSusunToEnd(root: string, provider: LLMProvider, webTools: DokumenWebTools): Promise<string> {
  const engine = new DokumenEngine(provider, { webTools });
  const pending = engine.run(root, 'susun makalah tentang morfologi hewan vertebrata', { subMode: 'susun' });
  await until(async () => {
    const doc = await readActiveDocument(root);
    return Boolean(doc && doc.sections.length === 2 && doc.sections.every((s) => s.status === 'staged'));
  });
  expect(engine.releaseStaged()).toBe(true);
  return pending;
}

describe('Susun critic semantics (honestly passable; research never silent)', () => {
  test('(i) sources read + properly cited draft → accepted, report counts the research', async () => {
    const root = tmpRoot();
    const summary = await runSusunToEnd(root, susunanProvider(), offlineWeb);
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'drafted')).toBe(true);
    expect(doc.sections[0]!.citations.length).toBeGreaterThan(0);
    expect(doc.sections[0]!.prose).toMatch(/\[SRC-\d+\]/);
    expect(summary).toContain('2 dari 2 bab tertulis, 0 ditandai kritikus');
    expect(summary).toContain('Riset web: 1 sumber eksternal dibaca');
  });

  test('(ii) draft contradicts its cited source → critic still rejects; prose retained (flagged path)', async () => {
    const root = tmpRoot();
    const summary = await runSusunToEnd(root, susunanProvider({ contradiction: true }), offlineWeb);
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'critic-flagged')).toBe(true);
    expect(doc.sections[0]!.prose).toContain('KLAIM-BERTENTANGAN');
    expect(doc.sections[0]!.criticIssues!.join(' ')).toMatch(/bertentangan/);
    expect(summary).toContain('0 dari 2 bab tertulis, 2 ditandai kritikus');
  });

  test('(iii) zero web hits + no workspace sources → uncited draft accepted as citation-free, report says so', async () => {
    const root = tmpRoot();
    const summary = await runSusunToEnd(root, susunanProvider(), emptySearchWeb);
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'drafted')).toBe(true);
    expect(doc.sections[0]!.citations).toEqual([]);
    expect(summary).toContain('Riset web: 0 sumber eksternal dibaca');
    expect(summary).toContain('pengetahuan umum model');
    const audit = await readAudit(root, doc.id);
    expect(audit.some((a) => a.action === 'research')).toBe(true);
  });

  test('(iv) webSearch throws → run completes, failure surfaced in audit + report', async () => {
    const root = tmpRoot();
    const summary = await runSusunToEnd(root, susunanProvider(), failingWeb);
    const doc = (await readActiveDocument(root))!;
    expect(doc.sections.every((s) => s.status === 'drafted')).toBe(true);
    expect(summary).toContain('Riset web gagal');
    const audit = await readAudit(root, doc.id);
    expect(audit.some((a) => a.action === 'web-search-failed')).toBe(true);
  });
});

describe('Pratinjau compose bytes (no export side effects)', () => {
  test('buildDocumentDocxBytes renders a real DOCX without writing files or recording an export', async () => {
    const root = tmpRoot();
    const doc = await createActiveDocument(root, 'compose', 'Makalah Uji');
    doc.sections = [{ id: 's1', title: 'Pendahuluan', thesisPoints: [], citations: [], prose: 'Paragraf pembuka yang cukup panjang untuk menjadi isi dokumen.', status: 'drafted' }];
    const exportsBefore = doc.exports.length;
    const bytes = await buildDocumentDocxBytes(doc);
    // A DOCX is a zip: PK\x03\x04 magic, multi-KB with styles inside.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(1000);
    expect(doc.exports.length).toBe(exportsBefore);
    expect(existsSync(join(root, '.daedalus', 'documents', doc.id, 'exports'))).toBe(false);
  });
});

describe('DOCX re-layout (deterministic style ops)', () => {
  test('staged ops apply to a NEW docx; the original stays byte-identical', async () => {
    const root = tmpRoot();
    // Build a source DOCX via the engine's own DOCX writer.
    const doc = await createActiveDocument(root, 'compose', 'Sumber tata ulang');
    await exportDocumentDocx(root, { ...doc, sections: [{ id: 's1', title: 'Bab 1', thesisPoints: [], citations: [], prose: 'Isi bab pertama yang cukup panjang untuk dirender sebagai paragraf.', status: 'drafted' }] });
    const docAfter = (await readActiveDocument(root))!;
    // Locate the rendered DOCX in the document's exports folder.
    const { readdirSync } = await import('node:fs');
    const exportFile = readdirSync(join(root, '.daedalus', 'documents', doc.id, 'exports')).find((f) => f.endsWith('.docx'))!;
    const sourceAbs = join(root, '.daedalus', 'documents', doc.id, 'exports', exportFile);
    const before = readFileSync(sourceAbs);

    const current = await inspectDocxStyles(sourceAbs);
    const target = parseStyleInstruction('margin 4-3-3-3, font Times New Roman 12pt, spasi 1.5, heading bernomor');
    expect(target).not.toBeNull();
    const ops = proposeStyleOps(current, target!);
    expect(ops.length).toBeGreaterThanOrEqual(3);
    const result = await applyStyleOps(root, docAfter, sourceAbs, ops);
    expect(result.path).toContain('-tata-ulang.docx');
    expect(readFileSync(sourceAbs).equals(before)).toBe(true); // original untouched
    const after = await inspectDocxStyles(join(root, result.path));
    expect(after.marginsCm).toEqual([4, 3, 3, 3]);
    expect(after.font).toBe('Times New Roman');
    expect(after.fontSizePt).toBe(12);
    expect(after.lineSpacing).toBe(1.5);
    expect(after.headingNumbered).toBe(true);
  });
});

describe('new-chat reset (archive)', () => {
  test('archives the active document folder and clears the pointer', async () => {
    const root = tmpRoot();
    const doc = await createActiveDocument(root, 'extract', 'Arsipkan saya');
    const archived = await archiveActiveDocument(root);
    expect(archived?.id).toBe(doc.id);
    expect(existsSync(archived!.archivedTo)).toBe(true);
    expect(existsSync(join(archived!.archivedTo, 'document.json'))).toBe(true);
    expect(await readActiveDocument(root)).toBeNull();
  });
});

describe('TaskRunner dokumen dispatch (separation guard)', () => {
  test('a dokumen task runs on the DokumenEngine and completes through the runner', async () => {
    const root = tmpRoot();
    writeFileSync(join(root, 'invoice.txt'), INVOICE);
    const runner = new TaskRunner({ workspaceRoot: root, provider: scriptedProvider() });
    const pending = runner.run({ goal: 'ekstrak invoice ini', domain: 'dokumen', dokumen: { subMode: 'ekstrak', sources: ['invoice.txt'] } });
    // Release the staged schema gate through the runner seam.
    await until(async () => Boolean((await readActiveDocument(root))?.schema));
    await until(async () => runner.releaseDokumenGate(root));
    const result = await pending;
    expect(result.outcome).toBe('success');
    expect(result.report.evidence.join(' ')).toContain('Ekstraksi selesai');
  });
});

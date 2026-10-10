import type { LLMProvider, Message } from '../providers/llm/types.ts';
import type { DokumenSchema, FieldDef, ParsedSource } from './document.ts';
import { findProvenance, pageChunks } from './parse.ts';
import { validateRecord } from './validate.ts';
import type { ExtractRecord, FieldValue } from './document.ts';
import { newRecordId } from './store.ts';

/**
 * The Dokumen pipeline: code-sequenced stages with the LLM in narrow,
 * schema-bound seats (classify, propose schema, extract, draft,
 * critique) — the Slide doctrine carried over. Every stage call is
 * validated locally; invalid output is retried with the issues quoted
 * verbatim (≤3 attempts), never silently replaced by invented data.
 */

export const MAX_STAGE_ATTEMPTS = 3;

export class DokumenPipelineError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'DokumenPipelineError';
    this.issues = issues;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function messageText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function extractJsonValue(raw: string): unknown {
  const trimmed = raw.trim();
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const starts = [trimmed.indexOf('['), trimmed.indexOf('{')].filter((i) => i >= 0).sort((a, b) => a - b);
  if (starts.length > 0) {
    const start = starts[0]!;
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}

type Verdict<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export async function structuredCall<T>(
  provider: LLMProvider,
  system: string,
  user: string,
  validate: (value: unknown) => Verdict<T>,
  signal?: AbortSignal,
): Promise<T> {
  const messages: Message[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let issues: string[] = ['model produced no parseable JSON'];
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await provider.chat(messages, undefined, signal ? { signal } : undefined);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      issues = [`the model request failed: ${message}`];
      if (attempt < MAX_STAGE_ATTEMPTS) {
        messages.push({ role: 'user', content: `The previous request failed (${message}). Return the corrected JSON only — no prose, no explanation, no markdown fences.` });
        continue;
      }
      throw new DokumenPipelineError(`model output stayed invalid after ${MAX_STAGE_ATTEMPTS} attempts: ${issues.join('; ')}`, issues);
    }
    const raw = messageText(response.message.content);
    const verdict = validate(extractJsonValue(raw));
    if (verdict.ok) return verdict.value;
    issues = verdict.issues;
    if (attempt < MAX_STAGE_ATTEMPTS) {
      messages.push({ role: 'assistant', content: raw.slice(0, 2000) });
      messages.push({
        role: 'user',
        content: `That output is invalid:\n${verdict.issues.map((i) => `- ${i}`).join('\n')}\n\nReturn corrected JSON only — no prose, no explanation, no markdown fences.`,
      });
    }
  }
  throw new DokumenPipelineError(`model output stayed invalid after ${MAX_STAGE_ATTEMPTS} attempts: ${issues.join('; ')}`, issues);
}

/* ------------------------------------------------------------ stages */

const FIELD_TYPES = ['string', 'number', 'money', 'date', 'email', 'boolean'];

function validateFieldDefs(value: unknown): Verdict<FieldDef[]> {
  if (!isObj(value) || !Array.isArray(value.fields)) return { ok: false, issues: ['output must be {"fields":[...]}'] };
  if (value.fields.length === 0) return { ok: false, issues: ['fields is empty — propose at least one field'] };
  const issues: string[] = [];
  const fields: FieldDef[] = [];
  const seen = new Set<string>();
  value.fields.forEach((raw, i) => {
    if (!isObj(raw) || typeof raw.name !== 'string' || raw.name.trim() === '') {
      issues.push(`field ${i + 1}: needs a non-empty "name"`);
      return;
    }
    const name = raw.name.trim();
    if (seen.has(name)) {
      issues.push(`field "${name}" appears twice`);
      return;
    }
    seen.add(name);
    const type = typeof raw.type === 'string' && FIELD_TYPES.includes(raw.type) ? raw.type : 'string';
    fields.push({
      name,
      type: type as FieldDef['type'],
      ...(raw.required === true ? { required: true } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    });
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: fields };
}

/** Seat 1 (cheap): classify the document kind from its first page. */
export async function classifyStage(provider: LLMProvider, parsed: ParsedSource, signal?: AbortSignal): Promise<string> {
  const firstPage = pageChunks(parsed)[0]?.text ?? parsed.text.slice(0, 2000);
  const result = await structuredCall<{ docType: string }>(
    provider,
    'You classify a document for a structured-extraction engine. Answer with ONLY JSON: {"docType":"<short kind, e.g. invoice, kwitansi, kontrak, laporan, email, surat, formulir, lain-lain>"}. Use the document language where natural.',
    `First page text:\n${firstPage.slice(0, 3000)}\n\nReturn {"docType": "..."} now.`,
    (value) => {
      if (isObj(value) && typeof value.docType === 'string' && value.docType.trim()) return { ok: true, value: { docType: value.docType.trim().slice(0, 40) } };
      return { ok: false, issues: ['output must be {"docType": "<kind>"}'] };
    },
    signal,
  );
  return result.docType;
}

/** Schema proposal from a sample — a human approves/edits it in the panel before extraction. */
export async function proposeSchemaStage(provider: LLMProvider, parsed: ParsedSource, docType: string, goal: string, signal?: AbortSignal): Promise<FieldDef[]> {
  const sample = pageChunks(parsed)
    .slice(0, 2)
    .map((c) => `--- page ${c.page} ---\n${c.text}`)
    .join('\n')
    .slice(0, 6000);
  return structuredCall<FieldDef[]>(
    provider,
    [
      'You propose an extraction schema for documents of one kind. Answer with ONLY JSON: {"fields":[{"name":"snake_case","type":"string|number|money|date|email|boolean","required":true|false,"description":"..."}]}.',
      'Field names in snake_case. Choose types so values can be validated deterministically (money for currency amounts, date for dates, number for plain quantities).',
      'For invoices/receipts include, when present: vendor, invoice_number, date, subtotal, tax (ppn), discount, total, due_date.',
      'Never propose a field the sample does not support. 4–14 fields.',
    ].join('\n'),
    `Document kind: ${docType}\nUser goal: ${goal}\n\nSample text:\n${sample}\n\nReturn {"fields":[...]} now.`,
    validateFieldDefs,
    signal,
  );
}

type RawFieldRead = { value: string | number | boolean | null; confidence: number; quote?: string };

/**
 * Seat 2: extract one source against the approved schema. Calls are
 * per page-chunk when the document is long (per_page/per_row targets)
 * or one call per document for per_doc — never the whole corpus at once.
 */
export async function extractSourceStage(
  provider: LLMProvider,
  parsed: ParsedSource,
  schema: DokumenSchema,
  sourceId: string,
  signal?: AbortSignal,
): Promise<ExtractRecord[]> {
  const system = [
    'You extract structured fields from a document. Answer with ONLY JSON: {"fields":{"<field>":{"value":<string|number|boolean|null>,"confidence":<0..1>,"quote":"<verbatim snippet the value was read from>"}}}.',
    'Rules: read ONLY what the text says — never compute, never guess, never fill a value from another field. A missing field is {"value":null,"confidence":0}. "quote" must be copied verbatim from the text.',
    `Fields: ${schema.fields.map((f) => `${f.name} (${f.type}${f.required ? ', required' : ''}${f.description ? ` — ${f.description}` : ''})`).join('; ')}`,
  ].join('\n');

  const readFields = (value: unknown): Verdict<Record<string, RawFieldRead>> => {
    if (!isObj(value) || !isObj(value.fields)) return { ok: false, issues: ['output must be {"fields":{...}}'] };
    const out: Record<string, RawFieldRead> = {};
    for (const field of schema.fields) {
      const raw = value.fields[field.name];
      if (raw === undefined) {
        out[field.name] = { value: null, confidence: 0 };
        continue;
      }
      if (!isObj(raw)) return { ok: false, issues: [`field "${field.name}" must be an object {value, confidence, quote}`] };
      const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0.7;
      out[field.name] = {
        value: (raw.value ?? null) as string | number | boolean | null,
        confidence,
        ...(typeof raw.quote === 'string' ? { quote: raw.quote } : {}),
      };
    }
    return { ok: true, value: out };
  };

  const toRecord = (reads: Record<string, RawFieldRead>, page?: number): ExtractRecord => {
    const fields: Record<string, FieldValue> = {};
    for (const field of schema.fields) {
      const read = reads[field.name] ?? { value: null, confidence: 0 };
      const provenance = findProvenance(parsed, read.quote);
      fields[field.name] = {
        value: read.value,
        ...(read.quote ? { raw: String(read.value ?? '') } : {}),
        confidence: read.confidence,
        ...(provenance ? { provenance } : {}),
        status: read.value === null ? 'escalated' : 'auto',
        ...(read.value === null ? { note: 'tidak ditemukan di dokumen' } : {}),
      };
    }
    const record: ExtractRecord = { id: newRecordId(), sourceId, ...(page ? { page } : {}), fields, checks: [], decision: 'flag' };
    return validateRecord(record, schema);
  };

  if (schema.extractionTarget === 'per_doc') {
    const text = pageChunks(parsed)
      .map((c) => `--- page ${c.page} ---\n${c.text}`)
      .join('\n')
      .slice(0, 14_000);
    const reads = await structuredCall(provider, system, `Document text:\n${text}\n\nReturn {"fields":{...}} now.`, readFields, signal);
    return [toRecord(reads)];
  }

  // per_page / per_row: one record per page chunk.
  const records: ExtractRecord[] = [];
  for (const chunk of pageChunks(parsed)) {
    if (chunk.text.trim().length === 0) continue;
    const reads = await structuredCall(provider, system, `Page ${chunk.page} text:\n${chunk.text.slice(0, 8000)}\n\nReturn {"fields":{...}} now.`, readFields, signal);
    records.push(toRecord(reads, chunk.page));
  }
  return records;
}

/* --------------------------------------------------------- Susun seats */

export type OutlineItem = { title: string; thesisPoints: string[] };

export async function proposeOutlineStage(provider: LLMProvider, goal: string, sourceSummaries: string[], signal?: AbortSignal): Promise<OutlineItem[]> {
  return structuredCall<OutlineItem[]>(
    provider,
    'You outline a formal Indonesian document (laporan/makalah/skripsi). Answer with ONLY JSON: {"sections":[{"title":"...","thesisPoints":["...","..."]}]}. 4–10 sections, ordered; the first is the introduction, the last the conclusion.',
    [`Goal: ${goal}`, ...(sourceSummaries.length > 0 ? [`Available sources:\n${sourceSummaries.join('\n')}`] : []), 'Return {"sections":[...]} now.'].join('\n\n'),
    (value) => {
      if (!isObj(value) || !Array.isArray(value.sections) || value.sections.length === 0) {
        return { ok: false, issues: ['output must be {"sections":[{title, thesisPoints[]}]} with at least one section'] };
      }
      const issues: string[] = [];
      const sections: OutlineItem[] = [];
      value.sections.forEach((raw, i) => {
        if (!isObj(raw) || typeof raw.title !== 'string' || !raw.title.trim()) {
          issues.push(`section ${i + 1}: needs a non-empty title`);
          return;
        }
        sections.push({
          title: raw.title.trim(),
          thesisPoints: Array.isArray(raw.thesisPoints) ? raw.thesisPoints.filter((p): p is string => typeof p === 'string').slice(0, 6) : [],
        });
      });
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: sections };
    },
    signal,
  );
}

export type CitationMaterial = { id: string; title: string; text: string };

export async function draftSectionStage(
  provider: LLMProvider,
  input: { title: string; thesisPoints: string[]; goal: string; materials: CitationMaterial[]; repairIssues?: string[] },
  signal?: AbortSignal,
): Promise<{ prose: string; citations: string[] }> {
  const materialText = input.materials.map((m) => `[${m.id}] ${m.title}\n${m.text.slice(0, 4000)}`).join('\n\n');
  return structuredCall<{ prose: string; citations: string[] }>(
    provider,
    [
      'You write ONE section of a formal Indonesian document. Answer with ONLY JSON: {"prose":"<the section text>","citations":["SRC-1",...]}.',
      'Every factual claim must rest on the provided sources; mark the supporting source inline like [SRC-1] right after the claim, and list every used id in "citations". Invent no facts, numbers, or names beyond the sources. Formal academic Indonesian, 2–5 paragraphs.',
      ...(input.repairIssues && input.repairIssues.length > 0 ? [`Your previous draft was rejected by the critic for:\n${input.repairIssues.map((i) => `- ${i}`).join('\n')}\nFix exactly those problems.`] : []),
    ].join('\n'),
    [`Document goal: ${input.goal}`, `Section: ${input.title}`, `Key points:\n${input.thesisPoints.map((p) => `- ${p}`).join('\n')}`, `Sources:\n${materialText || '(no sources provided — write only general framing, no factual claims)'}`, 'Return {"prose": "...", "citations": [...]} now.'].join('\n\n'),
    (value) => {
      if (!isObj(value) || typeof value.prose !== 'string' || value.prose.trim().length < 40) {
        return { ok: false, issues: ['output must be {"prose": "<substantial section text>", "citations": [...]}'] };
      }
      const citations = Array.isArray(value.citations) ? value.citations.filter((c): c is string => typeof c === 'string') : [];
      return { ok: true, value: { prose: value.prose.trim(), citations } };
    },
    signal,
  );
}

export async function criticStage(
  provider: LLMProvider,
  input: { title: string; prose: string; citations: string[]; materials: CitationMaterial[] },
  signal?: AbortSignal,
): Promise<{ ok: boolean; issues: string[] }> {
  // Deterministic pre-check first: every used citation must name a
  // real material, and a prose with factual density but no citation
  // markers fails without spending a model call.
  const known = new Set(input.materials.map((m) => m.id));
  const issues: string[] = [];
  for (const id of input.citations) {
    if (!known.has(id)) issues.push(`citation ${id} does not name a provided source`);
  }
  const markers = (input.prose.match(/\[SRC-\d+\]/g) ?? []).length;
  if (input.materials.length > 0 && markers === 0) issues.push('prose carries no inline [SRC-n] citation markers although sources were provided');
  if (issues.length > 0) return { ok: false, issues };

  return structuredCall<{ ok: boolean; issues: string[] }>(
    provider,
    'You are the critic gate of a document engine. Answer with ONLY JSON: {"ok":true|false,"issues":["..."]}. Reject (ok:false) when: a factual claim or number has no supporting source inline, a claim contradicts the sources, or the section drifts off its title. Accept only grounded prose.',
    [`Section: ${input.title}`, `Prose:\n${input.prose}`, `Sources:\n${input.materials.map((m) => `[${m.id}] ${m.title}\n${m.text.slice(0, 2500)}`).join('\n\n')}`, 'Return {"ok": ..., "issues": [...]} now.'].join('\n\n'),
    (value) => {
      if (!isObj(value) || typeof value.ok !== 'boolean') return { ok: false, issues: ['output must be {"ok":boolean,"issues":[...]}'] };
      return { ok: true, value: { ok: value.ok, issues: Array.isArray(value.issues) ? value.issues.filter((i): i is string => typeof i === 'string') : [] } };
    },
    signal,
  );
}

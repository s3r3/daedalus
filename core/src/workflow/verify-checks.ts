import { createRequire } from "node:module";
import { statSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  CodingVerifyData,
  DokumenVerifyData,
  ResearchVerifyData,
  SlideVerifyData,
  VerifyCheck,
  VerifyCheckResult,
  VerifyContext,
} from "./verify.ts";
import { VerifyGate } from "./verify.ts";

/**
 * Built-in verify checklists for the five engines (v2, Fase 2).
 *
 * Every check is deterministic code — no model calls, no network, no engine
 * imports. Checks read only the filesystem and the `VerifyContext` payload
 * the caller (Fase 3 wiring) fills in. Each failure carries a concrete
 * reason naming the file/field/claim at fault.
 *
 * `createDefaultVerifyGate()` registers all five checklists at once.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** Resolve a workspace-relative path, refusing escapes outside the root. */
function wsPath(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const rel2 = relative(root, abs);
  if (rel2 === "" || rel2.startsWith("..") || isAbsolute(rel2)) {
    throw new Error(`path "${rel}" keluar dari workspace`);
  }
  return abs;
}

function fileState(root: string, rel: string): "missing" | "empty" | "ok" {
  let st;
  try {
    st = statSync(wsPath(root, rel));
  } catch {
    return "missing";
  }
  if (!st.isFile() || st.size === 0) return "empty";
  return "ok";
}

function readText(root: string, rel: string): string {
  return readFileSync(wsPath(root, rel), "utf8");
}

const ok: VerifyCheckResult = { ok: true };
const fail = (reason: string, details?: unknown): VerifyCheckResult => ({
  ok: false,
  reason,
  ...(details !== undefined ? { details } : {}),
});

// ---------------------------------------------------------------------------
// Coding
// ---------------------------------------------------------------------------

const SCRIPT_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i).toLowerCase() : "";
}

/** Light syntax parse via the TypeScript compiler (transpile = parse only, no type-check). */
function syntaxErrors(source: string, fileName: string): string[] | null {
  let ts: typeof import("typescript");
  try {
    ts = require("typescript");
  } catch {
    return null; // no compiler context — caller skips the check
  }
  const out = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const errors = (out.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  return errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ").trim());
}

export const codingChecks: VerifyCheck[] = [
  {
    name: "coding-deliverables-exist",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const data: CodingVerifyData | undefined = ctx.coding;
      const files = data?.files ?? [];
      if (files.length === 0) {
        return fail(
          "tidak ada file deliverable yang didaftarkan untuk dicek (coding.files kosong) — isi dulu daftar file yang harus dihasilkan",
        );
      }
      const missing: string[] = [];
      const empty: string[] = [];
      for (const rel of files) {
        const state = fileState(ctx.workspaceRoot, rel);
        if (state === "missing") missing.push(rel);
        else if (state === "empty") empty.push(rel);
      }
      if (missing.length > 0) {
        return fail(`${missing.join(", ")} tidak ditemukan di workspace`, { missing });
      }
      if (empty.length > 0) {
        return fail(`${empty.join(", ")} kosong (0 byte)`, { empty });
      }
      return ok;
    },
  },
  {
    name: "coding-syntax-valid",
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const files = ctx.coding?.files ?? [];
      const scripts = files.filter((f) => SCRIPT_EXTS.has(extOf(f)));
      const jsons = files.filter((f) => extOf(f) === ".json");
      if (scripts.length === 0 && jsons.length === 0) {
        return {
          ok: true,
          skipped: true,
          reason: "tidak ada file .ts/.js/.json di deliverables — cek syntax dilewati",
        };
      }
      const problems: string[] = [];
      for (const rel of scripts) {
        let source: string;
        try {
          source = readText(ctx.workspaceRoot, rel);
        } catch {
          problems.push(`${rel}: tidak bisa dibaca`);
          continue;
        }
        const errors = syntaxErrors(source, rel);
        if (errors === null) {
          return {
            ok: true,
            skipped: true,
            reason: "paket typescript tidak tersedia — cek syntax dilewati",
          };
        }
        for (const e of errors) problems.push(`${rel}: ${e}`);
      }
      for (const rel of jsons) {
        try {
          JSON.parse(readText(ctx.workspaceRoot, rel));
        } catch (e) {
          problems.push(`${rel}: JSON tidak valid (${e instanceof Error ? e.message : e})`);
        }
      }
      if (problems.length > 0) {
        return fail(`syntax tidak valid: ${problems.slice(0, 3).join("; ")}`, {
          problems,
        });
      }
      return ok;
    },
  },
];

// ---------------------------------------------------------------------------
// Slide
// ---------------------------------------------------------------------------

const DEFAULT_DECK_PATH = "deck.json";
const DEFAULT_PPTX_PATH = "deck.pptx";
const DEFAULT_MAX_CHARS_PER_SLIDE = 1500;

type DeckSlideLike = {
  id?: string;
  content?: unknown;
  notes?: string;
};

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, into);
  }
}

export const slideChecks: VerifyCheck[] = [
  {
    name: "slide-pptx-exists",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const data: SlideVerifyData | undefined = ctx.slide;
      const rel = data?.pptxPath ?? DEFAULT_PPTX_PATH;
      const state = fileState(ctx.workspaceRoot, rel);
      if (state === "missing") return fail(`${rel} tidak ditemukan di workspace`);
      if (state === "empty") return fail(`${rel} kosong (0 byte) — export pptx gagal`);
      return ok;
    },
  },
  {
    name: "slide-count-matches",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const data: SlideVerifyData | undefined = ctx.slide;
      const deckRel = data?.deckPath ?? DEFAULT_DECK_PATH;
      if (fileState(ctx.workspaceRoot, deckRel) === "missing") {
        return fail(`${deckRel} tidak ditemukan di workspace — tidak bisa cek jumlah slide`);
      }
      let deck: { slides?: unknown };
      try {
        deck = JSON.parse(readText(ctx.workspaceRoot, deckRel));
      } catch (e) {
        return fail(`${deckRel} bukan JSON valid (${e instanceof Error ? e.message : e})`);
      }
      const count = Array.isArray(deck.slides) ? deck.slides.length : 0;
      if (count === 0) return fail(`deck di ${deckRel} tidak punya slide`);
      if (data?.expectedSlides !== undefined && count !== data.expectedSlides) {
        return fail(
          `jumlah slide ${count} tidak sesuai ekspektasi ${data.expectedSlides}`,
          { count, expected: data.expectedSlides },
        );
      }
      return ok;
    },
  },
  {
    name: "slide-no-overflow",
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const data: SlideVerifyData | undefined = ctx.slide;
      const deckRel = data?.deckPath ?? DEFAULT_DECK_PATH;
      if (fileState(ctx.workspaceRoot, deckRel) === "missing") {
        return {
          ok: true,
          skipped: true,
          reason: `${deckRel} tidak ada — cek overflow dilewati (slide-count-matches sudah gagal)`,
        };
      }
      let deck: { slides?: DeckSlideLike[] };
      try {
        deck = JSON.parse(readText(ctx.workspaceRoot, deckRel));
      } catch {
        return {
          ok: true,
          skipped: true,
          reason: `${deckRel} bukan JSON valid — cek overflow dilewati`,
        };
      }
      const max = data?.maxCharsPerSlide ?? DEFAULT_MAX_CHARS_PER_SLIDE;
      const overflowing: string[] = [];
      for (const [i, slide] of (deck.slides ?? []).entries()) {
        const parts: string[] = [];
        collectStrings(slide?.content, parts);
        if (slide?.notes) parts.push(slide.notes);
        const total = parts.join("").length;
        if (total > max) {
          overflowing.push(`slide ${i + 1}${slide?.id ? ` ("${slide.id}")` : ""}: ${total} karakter > batas ${max}`);
        }
      }
      if (overflowing.length > 0) {
        return fail(`teks overflow: ${overflowing.slice(0, 3).join("; ")}`, { overflowing });
      }
      return ok;
    },
  },
];

// ---------------------------------------------------------------------------
// Dokumen
// ---------------------------------------------------------------------------

const MIN_CONFIDENCE_DEFAULT = 0.7;

export const dokumenChecks: VerifyCheck[] = [
  {
    name: "dokumen-fields-confident",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const data: DokumenVerifyData | undefined = ctx.dokumen;
      const fields = data?.fields ?? [];
      if (fields.length === 0) {
        return fail("tidak ada field yang diekstrak untuk dicek (dokumen.fields kosong)");
      }
      const min = data?.minConfidence ?? MIN_CONFIDENCE_DEFAULT;
      const low = fields.filter(
        (f) => !(typeof f.confidence === "number" && f.confidence >= min),
      );
      if (low.length > 0) {
        const named = low
          .slice(0, 3)
          .map((f) => `"${f.name}" confidence ${f.confidence} di bawah ${min}`)
          .join("; ");
        return fail(`field kurang yakin: ${named}`, { low: low.map((f) => f.name) });
      }
      return ok;
    },
  },
  {
    name: "dokumen-output-exists",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const rel = ctx.dokumen?.outputPath;
      if (!rel) {
        return fail("dokumen.outputPath tidak diisi — tidak tahu file output apa yang harus dicek");
      }
      const state = fileState(ctx.workspaceRoot, rel);
      if (state === "missing") return fail(`${rel} tidak ditemukan di workspace`);
      if (state === "empty") return fail(`${rel} kosong (0 byte)`);
      return ok;
    },
  },
];

// ---------------------------------------------------------------------------
// Spreadsheet
// ---------------------------------------------------------------------------

export const spreadsheetChecks: VerifyCheck[] = [
  {
    name: "spreadsheet-xlsx-exists",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const rel = ctx.spreadsheet?.xlsxPath;
      if (!rel) {
        return fail("spreadsheet.xlsxPath tidak diisi — tidak tahu file .xlsx apa yang harus dicek");
      }
      const state = fileState(ctx.workspaceRoot, rel);
      if (state === "missing") return fail(`${rel} tidak ditemukan di workspace`);
      if (state === "empty") return fail(`${rel} kosong (0 byte) — export xlsx gagal`);
      return ok;
    },
  },
  {
    name: "spreadsheet-numbers-verified",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      // Fase 2 PERCAYA pada verify gate deterministik milik engine Analis —
      // angka tidak dihitung ulang di sini, hanya flag-nya yang dicek.
      if (ctx.spreadsheet?.numbersVerified === true) return ok;
      return fail(
        "angka belum terverifikasi (numbersVerified=false) — jalankan dulu verify gate deterministik engine analis spreadsheet",
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export const researchChecks: VerifyCheck[] = [
  {
    name: "research-claims-have-sources",
    quick: true,
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      const data: ResearchVerifyData | undefined = ctx.research;
      const claims = data?.claims ?? [];
      if (claims.length === 0) {
        return fail("laporan tidak punya klaim untuk dicek (research.claims kosong)");
      }
      const unsourced = claims.filter(
        (c) => !Array.isArray(c.sourceIds) || c.sourceIds.length === 0,
      );
      if (unsourced.length > 0) {
        const ids = unsourced.slice(0, 3).map((c) => `"${c.id}"`).join(", ");
        return fail(`klaim tanpa sumber: ${ids}`, { unsourced: unsourced.map((c) => c.id) });
      }
      return ok;
    },
  },
  {
    name: "research-sources-passed",
    run: async (ctx: VerifyContext): Promise<VerifyCheckResult> => {
      // 7 aturan verifikasi sumber tinggal di dalam engine riset — di sini
      // hanya flag gatePassed-nya yang dicek.
      if (ctx.research?.sourcesVerified === true) return ok;
      return fail(
        "sumber belum lolos verify gate 7 aturan engine riset (sourcesVerified=false)",
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * One gate with every engine's built-in checklist registered.
 * Fase 3 calls this once and passes the gate to engine execution.
 */
export function createDefaultVerifyGate(): VerifyGate {
  return new VerifyGate()
    .register("coding", codingChecks)
    .register("slide", slideChecks)
    .register("dokumen", dokumenChecks)
    .register("spreadsheet", spreadsheetChecks)
    .register("research", researchChecks);
}

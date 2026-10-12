import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDocumentDocxBytes, documentPaths, type DocumentState } from "@daedalus/core";
import { findExecutableOnPath, executableCandidates } from "./slide-preview.ts";

/**
 * Pratinjau for the Dokumen domain: renders the DOCX the user would
 * get — for Susun, a temp .docx composed from the CURRENT
 * document.json prose (the exact bytes Export would write, composed
 * in memory, never recorded as an export); for Tata ulang, the result
 * .docx Terapkan already produced — through a locally installed word
 * processor, so the user sees inside Daedalus exactly what that
 * engine draws (margins, fonts, spacing) instead of downloading
 * blindly. The editable canvas stays text; these page images are the
 * exported file itself, rasterised. Same architecture as Slide's
 * Pratinjau Asli (slide-preview.ts): cached page images, serial
 * renders, honest states.
 *
 * Two engines sit behind one small interface, chosen at runtime:
 *   1. Word (Windows only): the .docx opened by Microsoft Word
 *      itself via COM from a PowerShell script, exported to PDF
 *      (ExportAsFixedFormat), then rasterised with pdftoppm. The
 *      most faithful render there is — Microsoft's own layout.
 *   2. LibreOffice (any platform): `soffice --headless
 *      --convert-to pdf` (dedicated user profile) → `pdftoppm -png`.
 * Selection order is Word first (Windows' native engine), LibreOffice
 * second. When neither is present the service reports a distinct
 * `unavailable` state — never a crash.
 *
 * Word cleanup mirrors the PowerPoint discipline exactly: Word is a
 * single-instance COM server, so activation may hand back the USER's
 * already-running instance. The script snapshots WINWORD pids before
 * activation, writes any pid it started to a pid file, and only calls
 * `Application.Quit()` when no WINWORD process existed before the
 * render; a pre-existing instance only loses our document (closed
 * without saving), never the app. On Node-side timeout we taskkill
 * exactly the pids recorded in that pid file — never a process we did
 * not start. The document is opened read-only; the original file is
 * never modified.
 *
 * Results are cached under
 * `<workspace>/.daedalus/dokumen-preview/<key>/page-N.png`, where the
 * key hashes everything the render depends on (document title,
 * section prose/status, citations, style ops, and the style result
 * file's bytes). An edit therefore yields a new key and the old
 * render reports as stale instead of silently showing pages of an
 * older document.
 */

export type DocPreviewStatusName = "unavailable" | "idle" | "rendering" | "ready" | "stale" | "error";

/** A render engine that can rasterise a .docx on this machine. */
export type DocPreviewEngineId = "libreoffice" | "word";

/** What is being previewed: the composed Susun document, or the Tata ulang result file. */
export type DocPreviewKind = "compose" | "style";

export type DocPreviewStatus = {
  available: boolean;
  status: DocPreviewStatusName;
  /** Engine that would render (or rendered) this preview; null when unavailable. */
  engine: DocPreviewEngineId | null;
  /** Which artifact this status refers to. */
  kind: DocPreviewKind;
  /** Hash of the document state the status refers to (null when there is nothing to render). */
  key: string | null;
  /** Pages ready for `key` (0 unless status is ready). */
  pages: number;
  /** Page image URLs for `key`, present when ready. */
  pageUrls?: string[];
  error?: string;
  renderedAt?: string;
};

/** Converts one .docx into per-page PNGs inside `workDir`; returns the PNG paths in page order. */
export type DocPreviewConverter = (input: { docxPath: string; workDir: string; profileDir: string }) => Promise<string[]>;

/** Which engines are usable on this machine. Detection is cached per service instance. */
export type DocPreviewEngineAvailability = {
  /** LibreOffice pipeline usable: soffice + pdftoppm found on PATH. */
  libreOffice: boolean;
  /** Word usable: win32 + a PowerShell host + pdftoppm + the Word COM progid registered. */
  word: boolean;
};

/** Filesystem/platform seams for engine detection, injected by tests to stay deterministic. */
export type DocPreviewEngineSeams = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** "Does this absolute path exist?" — defaults to slide-preview's PATH-scan semantics. */
  fileExists?: (path: string) => boolean;
  /** COM probe seam (win32 only in production): true when Word.Application is registered. */
  probeWordCom?: (shell: string) => Promise<boolean>;
};

export type DokumenPreviewDeps = {
  /** Engine detection. Tests inject a fixed verdict; production detects + caches. */
  availability?: () => DocPreviewEngineAvailability | Promise<DocPreviewEngineAvailability>;
  /** The docx → PNGs step for whichever engine is selected. Tests inject a fake. */
  converter?: DocPreviewConverter;
  /** Per-engine converters; wins over `converter` for that engine. Tests use these to see which engine ran. */
  converters?: Partial<Record<DocPreviewEngineId, DocPreviewConverter>>;
  /** The compose-state → temp .docx step. Tests inject a fake; production composes export bytes in memory. */
  composeDocx?: (root: string, doc: DocumentState) => Promise<{ path: string; cleanup?: () => Promise<void> }>;
  /** Detection seams (platform/env/probes). Production defaults; tests simulate win32. */
  engineSeams?: DocPreviewEngineSeams;
};

const PREVIEW_DIR = join(".daedalus", "dokumen-preview");
const KEY_SALT = "dokumen-preview:v1";
const PAGE_DPI = 100;
const SOFFICE_TIMEOUT_MS = 90_000;
const PDFTOPPM_TIMEOUT_MS = 30_000;
/** Whole Word render (app start + PDF export) gets one budget; on expiry we kill only the instance we started. */
const WORD_TIMEOUT_MS = 120_000;
const POWERSHELL_PROBE_TIMEOUT_MS = 8_000;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

type RenderJob = {
  state: "rendering" | "error";
  error?: string;
};

type Manifest = { key: string; pages: number; renderedAt: string };

function cacheRoot(root: string): string {
  return join(root, PREVIEW_DIR);
}

// ---------------------------------------------------------------------------
// Engine detection
// ---------------------------------------------------------------------------

function toolOnPath(tool: "soffice" | "pdftoppm" | "powershell", seams: DocPreviewEngineSeams): boolean {
  const platform = seams.platform ?? process.platform;
  return findExecutableOnPath(executableCandidates(tool, platform), seams) !== null;
}

/** PowerShell host usable for the Word engine, or null. Only ever consulted on win32. */
export function findDocPowerShell(seams: DocPreviewEngineSeams = {}): string | null {
  const platform = seams.platform ?? process.platform;
  return findExecutableOnPath(executableCandidates("powershell", platform), seams);
}

/** Default COM probe: a registry-only lookup (GetTypeFromProgID never launches Word). */
function defaultProbeWordCom(shell: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", "if ([Type]::GetTypeFromProgID('Word.Application')) { exit 0 } else { exit 2 }"],
      { timeout: POWERSHELL_PROBE_TIMEOUT_MS, windowsHide: true },
      (error) => resolvePromise(!error),
    );
  });
}

/**
 * Detect usable engines. LibreOffice needs soffice + pdftoppm on PATH
 * (any platform). Word is Windows-only: a PowerShell host, pdftoppm
 * (the PDF Word exports still needs rasterising), plus the Word COM
 * progid — probed, never assumed from the shell alone. Never throws:
 * any failure reads as "not available".
 */
export async function detectDocPreviewEngines(seams: DocPreviewEngineSeams = {}): Promise<DocPreviewEngineAvailability> {
  const platform = seams.platform ?? process.platform;
  const pdftoppm = toolOnPath("pdftoppm", seams);
  const libreOffice = toolOnPath("soffice", seams) && pdftoppm;
  let word = false;
  if (platform === "win32" && pdftoppm) {
    const shell = findDocPowerShell(seams);
    if (shell) {
      try {
        word = await (seams.probeWordCom ?? defaultProbeWordCom)(shell);
      } catch {
        word = false;
      }
    }
  }
  return { libreOffice, word };
}

/** Selection order: Word (Windows' native engine) before LibreOffice (headless fallback). */
export function resolveDocPreviewEngine(availability: DocPreviewEngineAvailability): DocPreviewEngineId | null {
  if (availability.word) return "word";
  if (availability.libreOffice) return "libreoffice";
  return null;
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? "").trim();
        reject(new Error(`${command} gagal${detail ? `: ${detail.split("\n").slice(-2).join(" ")}` : `: ${error.message}`}`));
        return;
      }
      resolvePromise();
    });
  });
}

/** Per-page PNGs a converter left in `workDir`, in page order; throws when empty. */
async function collectPages(workDir: string, emptyMessage: string): Promise<string[]> {
  const entries = await readdir(workDir);
  const pages = entries
    .map((name) => /^page-(\d+)\.png$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => join(workDir, match[0]));
  if (pages.length === 0) throw new Error(emptyMessage);
  return pages;
}

/** Rasterise a PDF sitting in `workDir` into page-N.png files. */
async function pdfToPages(pdfPath: string, workDir: string, emptyMessage: string): Promise<string[]> {
  await runCommand("pdftoppm", ["-png", "-r", String(PAGE_DPI), pdfPath, join(workDir, "page")], PDFTOPPM_TIMEOUT_MS);
  return collectPages(workDir, emptyMessage);
}

/** Production converter, LibreOffice engine: headless → PDF → per-page PNGs. */
export const libreOfficeDocxConverter: DocPreviewConverter = async ({ docxPath, workDir, profileDir }) => {
  await runCommand(
    "soffice",
    ["-env:UserInstallation=" + pathToFileURL(profileDir).href, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", workDir, docxPath],
    SOFFICE_TIMEOUT_MS,
  );
  const pdfPath = join(workDir, `${basename(docxPath).replace(/\.docx$/i, "")}.pdf`);
  if (!existsSync(pdfPath)) throw new Error("LibreOffice tidak menghasilkan PDF dari berkas .docx ini.");
  return pdfToPages(pdfPath, workDir, "pdftoppm tidak menghasilkan gambar halaman dari PDF ini.");
};

/**
 * The PowerShell script driving Word via COM (Windows only). Pure
 * string generation so tests can assert its exact semantics:
 *  - snapshots WINWORD pids before activation and records any pid it
 *    started into `pidFile` (the Node runner taskkills exactly those
 *    on timeout — a pre-existing user Word is never force-killed);
 *  - opens the .docx read-only + invisible and exports it to PDF
 *    (ExportAsFixedFormat, wdExportFormatPDF = 17);
 *  - always closes our document WITHOUT saving, and only Quit()s
 *    Word when no WINWORD process existed before the render;
 *  - failures go to stderr with exit 1 (ErrorActionPreference Stop).
 * ASCII-only on purpose: PowerShell 5.1 misreads UTF-8-no-BOM scripts
 * containing non-ASCII characters.
 */
export function buildWordExportScript(input: { docxPath: string; pdfPath: string; pidFile: string }): string {
  const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$docxPath = ${psString(input.docxPath)}`,
    `$pdfPath = ${psString(input.pdfPath)}`,
    `$pidFile = ${psString(input.pidFile)}`,
    "function Get-WordPids {",
    "  try { return @((Get-Process -Name WINWORD -ErrorAction Stop).Id) } catch { return @() }",
    "}",
    "$preExisting = @(Get-WordPids)",
    "$word = $null",
    "$document = $null",
    "try {",
    "  $word = New-Object -ComObject Word.Application",
    "  $startedByUs = @(Get-WordPids | Where-Object { $preExisting -notcontains $_ })",
    "  if ($startedByUs.Count -gt 0) { [IO.File]::WriteAllLines($pidFile, [string[]]$startedByUs) }",
    "  try { $word.Visible = $false } catch { }",
    "  try { $word.DisplayAlerts = 0 } catch { }",
    "  $document = $word.Documents.Open($docxPath, $false, $true, $false)",
    "  $document.ExportAsFixedFormat($pdfPath, 17)",
    "} catch {",
    "  [Console]::Error.WriteLine('Render Word gagal: ' + $_.Exception.Message)",
    "  exit 1",
    "} finally {",
    "  if ($null -ne $document) {",
    "    try { $document.Close($false) } catch { }",
    "    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) } catch { }",
    "  }",
    "  if ($null -ne $word) {",
    "    if ($preExisting.Count -eq 0) { try { $word.Quit() } catch { } }",
    "    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch { }",
    "  }",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "}",
    "",
  ].join("\r\n");
}

/** Runs the generated PowerShell script; injected by tests. */
export type WordScriptRunner = (input: { shell: string; scriptPath: string; pidFile: string; timeoutMs: number }) => Promise<void>;

/**
 * Production runner: spawns the shell hidden, enforces the timeout,
 * and on timeout kills — in order — the Word pids the script
 * recorded (instances THIS render started) and then the shell itself.
 * A user's pre-existing Word process is never in that pid file.
 */
export const defaultWordScriptRunner: WordScriptRunner = ({ shell, scriptPath, pidFile, timeoutMs }) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true });
    let stderr = "";
    let timedOut = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        const pids = readFileSync(pidFile, "utf8").split(/\s+/).map((part) => part.trim()).filter((part) => /^\d+$/.test(part));
        for (const pid of pids) {
          execFile("taskkill", ["/F", "/PID", pid], () => undefined);
        }
      } catch {
        // no pid file yet: Word may not even have started
      }
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`PowerShell tidak bisa dijalankan: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Render Word melewati batas ${Math.round(timeoutMs / 1000)} detik; instance Word yang dimulai render ini sudah dihentikan.`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-2).join(" ");
        reject(new Error(detail || `Render Word gagal (kode keluar ${code ?? "?"}).`));
        return;
      }
      resolvePromise();
    });
  });

/** Production converter, Word engine (Windows): temp script → PDF export → pdftoppm pages. The shell resolver is injectable for tests. */
export function createWordConverter(
  runner: WordScriptRunner = defaultWordScriptRunner,
  resolveShell: () => string | null = () => findDocPowerShell(),
): DocPreviewConverter {
  return async ({ docxPath, workDir }) => {
    const shell = resolveShell();
    if (!shell) throw new Error("PowerShell tidak ditemukan di mesin ini — engine Word tidak tersedia.");
    const scriptPath = join(workDir, "render-word.ps1");
    const pidFile = join(workDir, "word-pids.txt");
    const pdfPath = join(workDir, "preview.pdf");
    await writeFile(scriptPath, buildWordExportScript({ docxPath, pdfPath, pidFile }), "utf8");
    await runner({ shell, scriptPath, pidFile, timeoutMs: WORD_TIMEOUT_MS });
    if (!existsSync(pdfPath)) throw new Error("Word tidak menghasilkan PDF dari berkas .docx ini.");
    return pdfToPages(pdfPath, workDir, "pdftoppm tidak menghasilkan gambar halaman dari PDF Word ini.");
  };
}

export const wordConverter: DocPreviewConverter = createWordConverter();

/**
 * Absolute path of the Tata ulang result DOCX for this document, or
 * null when Terapkan has not produced one. Mirrors core applyStyleOps'
 * naming: `<base>-tata-ulang.docx` beside the other document exports.
 */
export function styleResultPath(root: string, doc: DocumentState): string | null {
  if (!doc.styleTarget) return null;
  const base = basename(doc.styleTarget).replace(/\.docx$/i, "");
  const candidate = join(documentPaths(root, doc.id).exportsDir, `${base}-tata-ulang.docx`);
  return existsSync(candidate) ? candidate : null;
}

async function defaultComposeDocx(root: string, doc: DocumentState): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const bytes = await buildDocumentDocxBytes(doc);
  const dir = join(cacheRoot(root), ".compose");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `preview-${process.pid}.docx`);
  await writeFile(path, bytes);
  return { path, cleanup: async () => { await rm(path, { force: true }); } };
}

export class DokumenPreviewService {
  readonly #deps: Required<Omit<DokumenPreviewDeps, "availability" | "converter" | "converters" | "engineSeams">> & {
    availability?: DokumenPreviewDeps["availability"];
    converter?: DocPreviewConverter;
    converters: Partial<Record<DocPreviewEngineId, DocPreviewConverter>>;
    engineSeams: DocPreviewEngineSeams;
  };
  #enginesCache: Promise<{ availability: DocPreviewEngineAvailability; engine: DocPreviewEngineId | null }> | undefined;
  #jobs = new Map<string, RenderJob>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: DokumenPreviewDeps = {}) {
    this.#deps = {
      availability: deps.availability,
      converter: deps.converter,
      converters: deps.converters ?? {},
      engineSeams: deps.engineSeams ?? {},
      composeDocx: deps.composeDocx ?? defaultComposeDocx,
    };
  }

  /** Engine verdict for this machine, detected once and cached (detection includes a PATH scan + at most one COM probe). */
  #engines(): Promise<{ availability: DocPreviewEngineAvailability; engine: DocPreviewEngineId | null }> {
    if (!this.#enginesCache) {
      this.#enginesCache = (async () => {
        const availability = this.#deps.availability
          ? await this.#deps.availability()
          : await detectDocPreviewEngines(this.#deps.engineSeams);
        return { availability, engine: resolveDocPreviewEngine(availability) };
      })();
    }
    return this.#enginesCache;
  }

  /** The converter that runs for the selected engine: per-engine dep, else the shared dep, else production. */
  #converterFor(engine: DocPreviewEngineId): DocPreviewConverter {
    return (
      this.#deps.converters[engine] ??
      this.#deps.converter ??
      (engine === "libreoffice" ? libreOfficeDocxConverter : wordConverter)
    );
  }

  /**
   * Cache key for everything the render of this artifact depends on.
   * Compose: title + every section's prose/status/citations + the
   * citation table. Style: the ops list + the target + the result
   * file's bytes. Any change flips the key, which is what makes an
   * old render detectably stale. Null when there is nothing to render
   * (style kind before Terapkan produced a result file).
   */
  async computeKey(root: string, doc: DocumentState, kind: DocPreviewKind): Promise<string | null> {
    const hash = createHash("sha256");
    hash.update(KEY_SALT);
    hash.update(`kind:${kind}`);
    if (kind === "compose") {
      hash.update(
        JSON.stringify({
          title: doc.title,
          sections: doc.sections.map((s) => ({ id: s.id, title: s.title, prose: s.prose, status: s.status, citations: s.citations })),
          citations: doc.citations,
        }),
      );
      return hash.digest("hex");
    }
    const resultPath = styleResultPath(root, doc);
    if (!resultPath) return null;
    hash.update(JSON.stringify({ styleTarget: doc.styleTarget, styleOps: doc.styleOps }));
    hash.update(await readFile(resultPath));
    return hash.digest("hex");
  }

  async status(root: string, doc: DocumentState, kind: DocPreviewKind, pageUrlFor: (key: string, page: number) => string): Promise<DocPreviewStatus> {
    const key = await this.computeKey(root, doc, kind);
    const { engine } = await this.#engines();
    if (!engine) return { available: false, status: "unavailable", engine: null, kind, key, pages: 0 };
    if (!key) {
      // Style kind with a target but no Terapkan result yet: say so
      // plainly instead of an idle that would look like "nothing to
      // preview" — Export-grade honesty, same as the render refusal.
      if (kind === "style" && doc.styleTarget) {
        return {
          available: true,
          status: "error",
          engine,
          kind,
          key: null,
          pages: 0,
          error: "belum ada DOCX hasil tata ulang — tekan Terapkan dulu sebelum pratinjau.",
        };
      }
      return { available: true, status: "idle", engine, kind, key: null, pages: 0 };
    }
    const manifest = await this.#readManifest(root, key);
    if (manifest) {
      return {
        available: true,
        status: "ready",
        engine,
        kind,
        key,
        pages: manifest.pages,
        pageUrls: Array.from({ length: manifest.pages }, (_, i) => pageUrlFor(key, i + 1)),
        renderedAt: manifest.renderedAt,
      };
    }
    const job = this.#jobs.get(`${root}::${key}`);
    if (job?.state === "rendering") return { available: true, status: "rendering", engine, kind, key, pages: 0 };
    if (job?.state === "error") return { available: true, status: "error", engine, kind, key, pages: 0, error: job.error };
    // A render of an older document state on disk means this exact
    // state has no faithful pages yet: stale, not ready.
    if (await this.#hasAnyManifest(root)) return { available: true, status: "stale", engine, kind, key, pages: 0 };
    return { available: true, status: "idle", engine, kind, key, pages: 0 };
  }

  /** Queue a render of the artifact's current state (deduped per key, fully serialised). */
  async render(root: string, doc: DocumentState, kind: DocPreviewKind, pageUrlFor: (key: string, page: number) => string): Promise<DocPreviewStatus> {
    const key = await this.computeKey(root, doc, kind);
    const { engine } = await this.#engines();
    if (!engine) return { available: false, status: "unavailable", engine: null, kind, key, pages: 0 };
    if (!key) return this.status(root, doc, kind, pageUrlFor);
    if (await this.#readManifest(root, key)) return this.status(root, doc, kind, pageUrlFor);
    const jobKey = `${root}::${key}`;
    if (this.#jobs.get(jobKey)?.state !== "rendering") {
      const job: RenderJob = { state: "rendering" };
      this.#jobs.set(jobKey, job);
      const run = async (): Promise<void> => {
        try {
          await this.#renderNow(root, doc, kind, key, this.#converterFor(engine));
          this.#jobs.delete(jobKey);
        } catch (error) {
          job.state = "error";
          job.error = error instanceof Error ? error.message : String(error);
        }
      };
      this.#queue = this.#queue.then(run, run);
    }
    return { available: true, status: "rendering", engine, kind, key, pages: 0 };
  }

  async #renderNow(root: string, doc: DocumentState, kind: DocPreviewKind, key: string, converter: DocPreviewConverter): Promise<void> {
    // Refuse what Export would refuse, in the open: no sections with
    // prose yet (Susun), or no Terapkan result yet (Tata ulang).
    if (kind === "compose" && !doc.sections.some((s) => s.prose.trim().length > 0)) {
      throw new Error("belum ada bab tertulis — tulis dulu (tombol Susun) sebelum pratinjau.");
    }
    const dir = cacheRoot(root);
    const workDir = join(dir, `.work-${key.slice(0, 12)}-${process.pid}`);
    const finalDir = join(dir, key);
    let docxPath: string;
    let cleanup: (() => Promise<void>) | undefined;
    if (kind === "compose") {
      const composed = await this.#deps.composeDocx(root, doc);
      docxPath = composed.path;
      cleanup = composed.cleanup;
    } else {
      const resultPath = styleResultPath(root, doc);
      if (!resultPath) throw new Error("belum ada DOCX hasil tata ulang — tekan Terapkan dulu sebelum pratinjau.");
      docxPath = resultPath;
    }
    try {
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const pages = await converter({ docxPath, workDir, profileDir: join(dir, ".lo-profile") });
      if (pages.length === 0) throw new Error("render tidak menghasilkan halaman apa pun.");
      await rm(finalDir, { recursive: true, force: true });
      await mkdir(finalDir, { recursive: true });
      for (let i = 0; i < pages.length; i += 1) {
        await rename(pages[i]!, join(finalDir, `page-${i + 1}.png`));
      }
      const manifest: Manifest = { key, pages: pages.length, renderedAt: new Date().toISOString() };
      await writeFile(join(finalDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    } finally {
      await rm(workDir, { recursive: true, force: true });
      if (cleanup) await cleanup().catch(() => undefined);
    }
  }

  /** Absolute path of a cached page image, or null — never outside the key's cache dir. */
  pageFile(root: string, key: string, page: number): string | null {
    if (!KEY_PATTERN.test(key) || !Number.isInteger(page) || page < 1 || page > 999) return null;
    const dir = resolve(cacheRoot(root), key);
    const file = resolve(dir, `page-${page}.png`);
    if (!file.startsWith(dir + sep)) return null;
    return existsSync(file) ? file : null;
  }

  readPageBytes(root: string, key: string, page: number): Buffer | null {
    const file = this.pageFile(root, key, page);
    return file ? readFileSync(file) : null;
  }

  async #readManifest(root: string, key: string): Promise<Manifest | null> {
    try {
      const raw = await readFile(join(cacheRoot(root), key, "manifest.json"), "utf8");
      const parsed = JSON.parse(raw) as Partial<Manifest>;
      if (parsed.key === key && typeof parsed.pages === "number" && parsed.pages > 0 && typeof parsed.renderedAt === "string") {
        // Trust the manifest only as far as the first and last page files.
        if (existsSync(join(cacheRoot(root), key, "page-1.png")) && existsSync(join(cacheRoot(root), key, `page-${parsed.pages}.png`))) {
          return parsed as Manifest;
        }
      }
    } catch {
      // no cache for this key
    }
    return null;
  }

  async #hasAnyManifest(root: string): Promise<boolean> {
    try {
      const entries = await readdir(cacheRoot(root), { withFileTypes: true });
      return entries.some((entry) => entry.isDirectory() && KEY_PATTERN.test(entry.name) && existsSync(join(cacheRoot(root), entry.name, "manifest.json")));
    } catch {
      return false;
    }
  }
}

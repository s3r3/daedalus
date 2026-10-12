import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { exportWorkbookToXlsx, workbookPaths, type WorkbookSpec } from "@daedalus/core";
import { executableCandidates, findExecutableOnPath } from "./slide-preview.ts";

/**
 * Pratinjau (workbook preview): renders the .xlsx that Export would
 * produce from the CURRENT workbook state through a real spreadsheet
 * engine, so the user sees inside Daedalus exactly what that engine
 * draws — the native chart and pivot included — without opening
 * another app. The grid canvas is a live editing surface; these page
 * images are the exported file itself, rasterised.
 *
 * Two engines sit behind one small interface (the same shape as
 * Slide's Pratinjau Asli, so a third engine — a Word renderer for
 * Agentic Dokumen — can clone the pattern):
 *   1. Excel (Windows only): the would-be export opened read-only by
 *      Microsoft Excel itself via COM from a PowerShell script,
 *      printed to PDF (ExportAsFixedFormat), then PDF → PNG. The most
 *      faithful raster there is, but COM exists only on Windows, and
 *      in this VM this path is code + reviewed script text only —
 *      it has never executed here.
 *   2. LibreOffice (any platform): the same export → `soffice
 *      --headless --convert-to pdf` (dedicated user profile) →
 *      `pdftoppm -png`.
 * Selection order is Excel first (win32), LibreOffice second — the UI
 * names the engine that rendered. When neither is present the service
 * reports a distinct `unavailable` state, never a crash.
 *
 * What the raster NEVER proves: slicer interactivity. LibreOffice
 * draws slicers as an unsupported-shape placeholder and Excel's PDF
 * is a static print; clicking a slicer and watching the pivot/charts
 * react can only be proven in Excel itself. The preview proves
 * charts, pivots, values and layout.
 *
 * Excel cleanup semantics mirror the PowerPoint engine: a pid
 * snapshot before activation, any pid the render started is recorded
 * to a pid file, and `Quit()` is only called when no EXCEL process
 * existed before; on timeout we kill exactly the recorded pids.
 *
 * Results are cached under
 * `<workspace>/.daedalus/sheet-preview/<key>/page-N.png`, where the key
 * hashes workbook.json (the only input the export reads). A workbook
 * change therefore yields a new key and the old render reports as
 * stale. Renders are serialised and hard-timed-out.
 */

export type SheetPreviewStatusName = "unavailable" | "idle" | "rendering" | "ready" | "stale" | "error";

/** A render engine that can rasterise the exported .xlsx on this machine. */
export type SheetPreviewEngineId = "excel" | "libreoffice";

export function sheetPreviewEngineLabel(engine: SheetPreviewEngineId | null): string | null {
  if (engine === "excel") return "Excel";
  if (engine === "libreoffice") return "LibreOffice";
  return null;
}

export type SheetPreviewStatus = {
  available: boolean;
  status: SheetPreviewStatusName;
  /** Engine that would render (or rendered) this workbook; null when unavailable. */
  engine: SheetPreviewEngineId | null;
  /** Display name of that engine ("Excel" | "LibreOffice"). */
  engineLabel: string | null;
  /** Hash of the current workbook state the status refers to (null without a workbook). */
  key: string | null;
  /** Pages ready for `key` (0 unless status is ready). */
  pages: number;
  /** Page image URLs for `key`, present when ready. */
  pageUrls?: string[];
  error?: string;
  renderedAt?: string;
};

/** Converts one exported .xlsx into per-page PNGs inside `workDir`; returns the PNG paths in page order. */
export type SheetPreviewConverter = (input: { xlsxPath: string; workDir: string; profileDir: string }) => Promise<string[]>;

/** Which engines are usable on this machine. Detection is cached per service instance. */
export type SheetPreviewEngineAvailability = {
  /** Excel pipeline usable: win32 + a PowerShell host + the Excel COM progid registered. */
  excel: boolean;
  /** LibreOffice pipeline usable: soffice + pdftoppm found on PATH. */
  libreOffice: boolean;
};

/** Filesystem/platform seams for engine detection, injected by tests to stay deterministic. */
export type SheetPreviewEngineSeams = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** "Does this absolute path exist?" — defaults to an executable check on posix, plain existence on win32. */
  fileExists?: (path: string) => boolean;
  /** COM probe seam (win32 only in production): true when Excel.Application is registered. */
  probeExcelCom?: (shell: string) => Promise<boolean>;
  /** PowerShell script runner seam (win32 only in production). Tests inject a fake. */
  runExcelScript?: ExcelScriptRunner;
};

export type SheetPreviewDeps = {
  /** Engine detection. Tests inject a fixed verdict; production detects + caches. */
  availability?: () => SheetPreviewEngineAvailability | Promise<SheetPreviewEngineAvailability>;
  /** Per-engine converters. Tests use these to see which engine ran. */
  converters?: Partial<Record<SheetPreviewEngineId, SheetPreviewConverter>>;
  /** The workbook → temp .xlsx step. Tests inject a fake; production reuses core's exporter into a temp root. */
  exportXlsx?: (root: string, workbook: WorkbookSpec) => Promise<{ path: string; cleanup?: () => Promise<void> }>;
  /** Detection seams (platform/env/probes). Production defaults; tests simulate win32. */
  engineSeams?: SheetPreviewEngineSeams;
};

const PREVIEW_DIR = join(".daedalus", "sheet-preview");
const KEY_SALT = "sheet-preview:v1";
const PAGE_DPI = 100;
const SOFFICE_TIMEOUT_MS = 90_000;
const PDFTOPPM_TIMEOUT_MS = 30_000;
/** Whole Excel render (app start + PDF export) gets one budget; on expiry we kill only the instance we started. */
const EXCEL_TIMEOUT_MS = 120_000;
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

function toolOnPath(tool: "soffice" | "pdftoppm" | "powershell", seams: SheetPreviewEngineSeams): boolean {
  const platform = seams.platform ?? process.platform;
  return findExecutableOnPath(executableCandidates(tool, platform), seams) !== null;
}

/** PowerShell host usable for the Excel engine, or null. Only ever consulted on win32. */
export function findPowerShell(seams: SheetPreviewEngineSeams = {}): string | null {
  const platform = seams.platform ?? process.platform;
  return findExecutableOnPath(executableCandidates("powershell", platform), seams);
}

/** Default COM probe: a registry-only lookup (GetTypeFromProgID never launches Excel). */
function defaultProbeExcelCom(shell: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", "if ([Type]::GetTypeFromProgID('Excel.Application')) { exit 0 } else { exit 2 }"],
      { timeout: POWERSHELL_PROBE_TIMEOUT_MS, windowsHide: true },
      (error) => resolvePromise(!error),
    );
  });
}

/**
 * Detect usable engines. Excel is Windows-only: a PowerShell host plus
 * the Excel COM progid — probed in the registry, never launched.
 * LibreOffice needs soffice + pdftoppm on PATH (any platform). Never
 * throws: any failure reads as "not available".
 */
export async function detectSheetPreviewEngines(seams: SheetPreviewEngineSeams = {}): Promise<SheetPreviewEngineAvailability> {
  const platform = seams.platform ?? process.platform;
  const libreOffice = toolOnPath("soffice", seams) && toolOnPath("pdftoppm", seams);
  let excel = false;
  if (platform === "win32") {
    const shell = findPowerShell(seams);
    if (shell) {
      try {
        excel = await (seams.probeExcelCom ?? defaultProbeExcelCom)(shell);
      } catch {
        excel = false;
      }
    }
  }
  return { excel, libreOffice };
}

/** Selection order: Excel (Microsoft's own renderer, Windows) before LibreOffice (cross-platform fallback). */
export function resolveSheetPreviewEngine(availability: SheetPreviewEngineAvailability): SheetPreviewEngineId | null {
  if (availability.excel) return "excel";
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

async function pdfToPages(pdfPath: string, workDir: string): Promise<string[]> {
  await runCommand("pdftoppm", ["-png", "-r", String(PAGE_DPI), pdfPath, join(workDir, "page")], PDFTOPPM_TIMEOUT_MS);
  return collectPages(workDir, "pdftoppm tidak menghasilkan gambar halaman dari PDF ini.");
}

function pdfSibling(xlsxPath: string, workDir: string): string {
  return join(workDir, `${basename(xlsxPath).replace(/\.[^.]+$/, "")}.pdf`);
}

/** Production converter, LibreOffice engine: headless → PDF → per-page PNGs. */
export const libreOfficeSheetConverter: SheetPreviewConverter = async ({ xlsxPath, workDir, profileDir }) => {
  await runCommand(
    "soffice",
    ["-env:UserInstallation=" + pathToFileURL(profileDir).href, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", workDir, xlsxPath],
    SOFFICE_TIMEOUT_MS,
  );
  const pdfPath = pdfSibling(xlsxPath, workDir);
  if (!existsSync(pdfPath)) throw new Error("LibreOffice tidak menghasilkan PDF dari berkas .xlsx ini.");
  return pdfToPages(pdfPath, workDir);
};

/**
 * The PowerShell script driving Excel via COM (Windows only). Pure
 * string generation so tests can assert its exact semantics:
 *  - snapshots EXCEL pids before activation and records any pid it
 *    started into `pidFile` (the Node runner taskkills exactly those
 *    on timeout — a pre-existing user Excel is never force-killed);
 *  - opens the .xlsx read-only and prints it to PDF via
 *    ExportAsFixedFormat (type 0 = xlTypePDF), closes without saving;
 *  - only Quit()s Excel when no EXCEL process existed before the
 *    render; a pre-existing instance only loses our workbook.
 * ASCII-only on purpose: PowerShell 5.1 misreads UTF-8-no-BOM scripts
 * containing non-ASCII characters.
 */
export function buildExcelExportScript(input: { xlsxPath: string; pdfPath: string; pidFile: string }): string {
  const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$xlsxPath = ${psString(input.xlsxPath)}`,
    `$pdfPath = ${psString(input.pdfPath)}`,
    `$pidFile = ${psString(input.pidFile)}`,
    "function Get-ExcelPids {",
    "  try { return @((Get-Process -Name EXCEL -ErrorAction Stop).Id) } catch { return @() }",
    "}",
    "$preExisting = @(Get-ExcelPids)",
    "$excel = $null",
    "$workbook = $null",
    "try {",
    "  $excel = New-Object -ComObject Excel.Application",
    "  $startedByUs = @(Get-ExcelPids | Where-Object { $preExisting -notcontains $_ })",
    "  if ($startedByUs.Count -gt 0) { [IO.File]::WriteAllLines($pidFile, [string[]]$startedByUs) }",
    "  try { $excel.Visible = $false } catch { }",
    "  try { $excel.DisplayAlerts = $false } catch { }",
    "  $workbook = $excel.Workbooks.Open($xlsxPath, 0, $true)",
    "  $workbook.ExportAsFixedFormat(0, $pdfPath)",
    "} catch {",
    "  [Console]::Error.WriteLine('Render Excel gagal: ' + $_.Exception.Message)",
    "  exit 1",
    "} finally {",
    "  if ($null -ne $workbook) {",
    "    try { $workbook.Close($false) } catch { }",
    "    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) } catch { }",
    "  }",
    "  if ($null -ne $excel) {",
    "    if ($preExisting.Count -eq 0) { try { $excel.Quit() } catch { } }",
    "    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel) } catch { }",
    "  }",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "}",
    "",
  ].join("\r\n");
}

/** Runs the generated PowerShell script; injected by tests. */
export type ExcelScriptRunner = (input: { shell: string; scriptPath: string; pidFile: string; timeoutMs: number }) => Promise<void>;

/**
 * Production runner: spawns the shell hidden, enforces the timeout,
 * and on timeout kills — in order — the Excel pids the script recorded
 * (instances THIS render started) and then the shell itself. A user's
 * pre-existing Excel process is never in that pid file.
 */
export const defaultExcelScriptRunner: ExcelScriptRunner = ({ shell, scriptPath, pidFile, timeoutMs }) =>
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
        // no pid file yet: Excel may not even have started
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
        reject(new Error(`Render Excel melewati batas ${Math.round(timeoutMs / 1000)} detik; instance Excel yang dimulai render ini sudah dihentikan.`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-2).join(" ");
        reject(new Error(detail || `Render Excel gagal (kode keluar ${code ?? "?"}).`));
        return;
      }
      resolvePromise();
    });
  });

/** Production converter, Excel engine (Windows): temp script → COM print-to-PDF → the shared PDF→PNG step. */
export function createExcelConverter(
  runner: ExcelScriptRunner = defaultExcelScriptRunner,
  resolveShell: () => string | null = () => findPowerShell(),
): SheetPreviewConverter {
  return async ({ xlsxPath, workDir }) => {
    const shell = resolveShell();
    if (!shell) throw new Error("PowerShell tidak ditemukan di mesin ini — engine Excel tidak tersedia.");
    const scriptPath = join(workDir, "render-excel.ps1");
    const pidFile = join(workDir, "excel-pids.txt");
    const pdfPath = pdfSibling(xlsxPath, workDir);
    await writeFile(scriptPath, buildExcelExportScript({ xlsxPath, pdfPath, pidFile }), "utf8");
    await runner({ shell, scriptPath, pidFile, timeoutMs: EXCEL_TIMEOUT_MS });
    if (!existsSync(pdfPath)) throw new Error("Excel tidak menghasilkan PDF dari berkas .xlsx ini.");
    return pdfToPages(pdfPath, workDir);
  };
}

async function defaultExportXlsx(root: string, workbook: WorkbookSpec): Promise<{ path: string; cleanup: () => Promise<void> }> {
  // Export into a throwaway root so the preview never clobbers the
  // user's workbook/ exports; core's exporter asks workbookPaths()
  // where to write, so a temp root confines every byte it produces.
  const tmpRoot = join(cacheRoot(root), `.xlsx-${process.pid}-${Date.now()}`);
  const record = await exportWorkbookToXlsx(workbook, tmpRoot);
  return { path: record.path, cleanup: async () => { await rm(tmpRoot, { recursive: true, force: true }); } };
}

export class SheetPreviewService {
  readonly #deps: Required<Omit<SheetPreviewDeps, "availability" | "converters" | "engineSeams">> & {
    availability?: SheetPreviewDeps["availability"];
    converters: Partial<Record<SheetPreviewEngineId, SheetPreviewConverter>>;
    engineSeams: SheetPreviewEngineSeams;
  };
  #enginesCache: Promise<{ availability: SheetPreviewEngineAvailability; engine: SheetPreviewEngineId | null }> | undefined;
  #jobs = new Map<string, RenderJob>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SheetPreviewDeps = {}) {
    this.#deps = {
      availability: deps.availability,
      converters: deps.converters ?? {},
      engineSeams: deps.engineSeams ?? {},
      exportXlsx: deps.exportXlsx ?? defaultExportXlsx,
    };
  }

  /** Engine verdict for this machine, detected once and cached (a PATH scan + at most one COM probe). */
  #engines(): Promise<{ availability: SheetPreviewEngineAvailability; engine: SheetPreviewEngineId | null }> {
    if (!this.#enginesCache) {
      this.#enginesCache = (async () => {
        const availability = this.#deps.availability
          ? await this.#deps.availability()
          : await detectSheetPreviewEngines(this.#deps.engineSeams);
        return { availability, engine: resolveSheetPreviewEngine(availability) };
      })();
    }
    return this.#enginesCache;
  }

  /** The converter for the selected engine: per-engine dep, else production (Excel via the runner seam when one is injected). */
  #converterFor(engine: SheetPreviewEngineId): SheetPreviewConverter {
    const injected = this.#deps.converters[engine];
    if (injected) return injected;
    if (engine === "libreoffice") return libreOfficeSheetConverter;
    const seams = this.#deps.engineSeams;
    return createExcelConverter(seams.runExcelScript ?? defaultExcelScriptRunner, () => findPowerShell(seams));
  }

  /**
   * Cache key for everything the export of this workbook depends on:
   * workbook.json is the export's only input, so its bytes are the
   * key. Any edit flips the key, which is what makes an old render
   * detectably stale instead of silently showing older numbers.
   */
  async computeKey(root: string, workbook: WorkbookSpec): Promise<string> {
    const hash = createHash("sha256");
    hash.update(KEY_SALT);
    try {
      hash.update(await readFile(workbookPaths(root).file));
    } catch {
      hash.update(JSON.stringify(workbook));
    }
    return hash.digest("hex");
  }

  async status(root: string, workbook: WorkbookSpec, pageUrlFor: (key: string, page: number) => string): Promise<SheetPreviewStatus> {
    const key = await this.computeKey(root, workbook);
    const { engine } = await this.#engines();
    const engineLabel = sheetPreviewEngineLabel(engine);
    if (!engine) return { available: false, status: "unavailable", engine: null, engineLabel: null, key, pages: 0 };
    const manifest = await this.#readManifest(root, key);
    if (manifest) {
      return {
        available: true,
        status: "ready",
        engine,
        engineLabel,
        key,
        pages: manifest.pages,
        pageUrls: Array.from({ length: manifest.pages }, (_, i) => pageUrlFor(key, i + 1)),
        renderedAt: manifest.renderedAt,
      };
    }
    const job = this.#jobs.get(`${root}::${key}`);
    if (job?.state === "rendering") return { available: true, status: "rendering", engine, engineLabel, key, pages: 0 };
    if (job?.state === "error") return { available: true, status: "error", engine, engineLabel, key, pages: 0, error: job.error };
    // A render of an older workbook state on disk means this exact
    // state has no faithful pages yet: stale, not ready.
    if (await this.#hasAnyManifest(root)) return { available: true, status: "stale", engine, engineLabel, key, pages: 0 };
    return { available: true, status: "idle", engine, engineLabel, key, pages: 0 };
  }

  /** Queue a render of the workbook's current state (deduped per key, fully serialised). */
  async render(root: string, workbook: WorkbookSpec, pageUrlFor: (key: string, page: number) => string): Promise<SheetPreviewStatus> {
    const key = await this.computeKey(root, workbook);
    const { engine } = await this.#engines();
    const engineLabel = sheetPreviewEngineLabel(engine);
    if (!engine) return { available: false, status: "unavailable", engine: null, engineLabel: null, key, pages: 0 };
    if (await this.#readManifest(root, key)) return this.status(root, workbook, pageUrlFor);
    const jobKey = `${root}::${key}`;
    if (this.#jobs.get(jobKey)?.state !== "rendering") {
      const job: RenderJob = { state: "rendering" };
      this.#jobs.set(jobKey, job);
      const run = async (): Promise<void> => {
        try {
          await this.#renderNow(root, workbook, key, this.#converterFor(engine));
          this.#jobs.delete(jobKey);
        } catch (error) {
          job.state = "error";
          job.error = error instanceof Error ? error.message : String(error);
        }
      };
      this.#queue = this.#queue.then(run, run);
    }
    return { available: true, status: "rendering", engine, engineLabel, key, pages: 0 };
  }

  async #renderNow(root: string, workbook: WorkbookSpec, key: string, converter: SheetPreviewConverter): Promise<void> {
    if (workbook.sheets.length === 0) {
      throw new Error("workbook belum punya sheet — tambahkan data sebelum pratinjau.");
    }
    const dir = cacheRoot(root);
    const workDir = join(dir, `.work-${key.slice(0, 12)}-${process.pid}`);
    const finalDir = join(dir, key);
    const exported = await this.#deps.exportXlsx(root, workbook);
    try {
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const pages = await converter({ xlsxPath: exported.path, workDir, profileDir: join(dir, ".lo-profile") });
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
      if (exported.cleanup) await exported.cleanup().catch(() => undefined);
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

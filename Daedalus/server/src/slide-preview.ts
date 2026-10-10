import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deckPaths, exportDeckToPptx, pptxTemplatesDir, validateDeck, type DeckSpec } from "@daedalus/core";

/**
 * Pratinjau Asli (True Preview): renders the .pptx that Export would
 * produce from the CURRENT deck state through a locally installed
 * presentation engine, so the user sees inside Daedalus exactly what
 * that engine draws — gradients, shadows, and all — without opening
 * another app. The editable canvas stays an approximation; these page
 * images are the exported file itself, rasterised.
 *
 * Two engines sit behind one small interface, chosen at runtime:
 *   1. LibreOffice (any platform): core export → temp .pptx →
 *      `soffice --headless --convert-to pdf` (dedicated user profile)
 *      → `pdftoppm -png`.
 *   2. PowerPoint (Windows only): the same exported .pptx opened by
 *      Microsoft PowerPoint itself via COM from a PowerShell script,
 *      each slide exported to PNG. This is the most faithful raster
 *      there is — Microsoft's own renderer — but COM only exists on
 *      Windows, so detection gates on `win32`.
 * Selection order is LibreOffice first (headless, singleton-safe),
 * PowerPoint second. When neither is present the service reports a
 * distinct `unavailable` state — never a crash.
 *
 * PowerPoint cleanup semantics (see buildPowerPointExportScript):
 * PowerPoint is a single-instance COM server, so `New-Object
 * -ComObject` may hand back the USER's already-running instance. The
 * script snapshots POWERPNT pids before activation, writes any pid it
 * started to a pid file, and only calls `Application.Quit()` when no
 * PowerPoint process existed before the render; a pre-existing
 * instance only loses our presentation (closed normally), never the
 * app. On Node-side timeout we taskkill exactly the pids recorded in
 * that pid file — never a process we did not start.
 *
 * Results are cached under
 * `<workspace>/.daedalus/slide-preview/<key>/page-N.png`, where the key
 * hashes everything the export depends on (deck.json bytes, deck
 * assets, referenced template records + source .pptx). A deck change
 * therefore yields a new key and the old render reports as stale
 * instead of silently showing pages of an older deck. Renders are
 * serialised (one render at a time across both engines) and
 * hard-timed-out.
 */

export type TruePreviewStatusName = "unavailable" | "idle" | "rendering" | "ready" | "stale" | "error";

/** A render engine that can rasterise the exported .pptx on this machine. */
export type PreviewEngineId = "libreoffice" | "powerpoint";

export type TruePreviewStatus = {
  available: boolean;
  status: TruePreviewStatusName;
  /** Engine that would render (or rendered) this deck; null when unavailable. */
  engine: PreviewEngineId | null;
  /** Hash of the current deck state the status refers to (null without a deck). */
  key: string | null;
  /** Pages ready for `key` (0 unless status is ready). */
  pages: number;
  /** Page image URLs for `key`, present when ready. */
  pageUrls?: string[];
  error?: string;
  renderedAt?: string;
};

/** Converts one exported .pptx into per-page PNGs inside `workDir`; returns the PNG paths in page order. */
export type PreviewConverter = (input: { pptxPath: string; workDir: string; profileDir: string }) => Promise<string[]>;

/** Which engines are usable on this machine. Detection is cached per service instance. */
export type PreviewEngineAvailability = {
  /** LibreOffice pipeline usable: soffice + pdftoppm found on PATH. */
  libreOffice: boolean;
  /** PowerPoint usable: win32 + a PowerShell host + the PowerPoint COM progid registered. */
  powerPoint: boolean;
};

/** Filesystem/platform seams for engine detection, injected by tests to stay deterministic. */
export type PreviewEngineSeams = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** "Does this absolute path exist?" — defaults to an executable check on posix, plain existence on win32. */
  fileExists?: (path: string) => boolean;
  /** COM probe seam (win32 only in production): true when PowerPoint.Application is registered. */
  probePowerPointCom?: (shell: string) => Promise<boolean>;
};

export type SlidePreviewDeps = {
  /** Engine detection. Tests inject a fixed verdict; production detects + caches. */
  availability?: () => PreviewEngineAvailability | Promise<PreviewEngineAvailability>;
  /** The pptx → PNGs step for whichever engine is selected. Tests inject a fake. */
  converter?: PreviewConverter;
  /** Per-engine converters; wins over `converter` for that engine. Tests use these to see which engine ran. */
  converters?: Partial<Record<PreviewEngineId, PreviewConverter>>;
  /** The deck → temp .pptx step. Tests inject a fake; production reuses core's exporter. */
  exportPptx?: (root: string, deck: DeckSpec) => Promise<{ path: string; cleanup?: () => Promise<void> }>;
  /** Detection seams (platform/env/probes). Production defaults; tests simulate win32. */
  engineSeams?: PreviewEngineSeams;
};

const PREVIEW_DIR = join(".daedalus", "slide-preview");
const KEY_SALT = "true-preview:v1:r100";
const PAGE_DPI = 100;
const SOFFICE_TIMEOUT_MS = 90_000;
const PDFTOPPM_TIMEOUT_MS = 30_000;
/** Whole PowerPoint render (app start + per-slide export) gets one budget; on expiry we kill only the instance we started. */
const POWERPOINT_TIMEOUT_MS = 120_000;
const POWERSHELL_PROBE_TIMEOUT_MS = 8_000;
/** Page width (px) for PowerPoint slide exports; height follows the deck's own aspect. Matches ~100 DPI at 16:9. */
export const POWERPOINT_PAGE_WIDTH_PX = 1280;
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

/** Executable file names to try for a tool, per platform (Windows carries .exe/.com variants). */
export function executableCandidates(tool: "soffice" | "pdftoppm" | "powershell", platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    switch (tool) {
      case "soffice":
        return ["soffice.exe", "soffice.com", "soffice"];
      case "pdftoppm":
        return ["pdftoppm.exe", "pdftoppm"];
      case "powershell":
        return ["powershell.exe", "pwsh.exe"];
    }
  }
  switch (tool) {
    case "soffice":
      return ["soffice"];
    case "pdftoppm":
      return ["pdftoppm"];
    case "powershell":
      return ["pwsh", "powershell"];
  }
}

function defaultFileExists(platform: NodeJS.Platform): (path: string) => boolean {
  return (path: string): boolean => {
    try {
      // Windows filesystems do not model X_OK; plain existence is the honest check there.
      accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/** First PATH hit (full path) among `names`, or null. Splits PATH with the platform separator. */
export function findExecutableOnPath(names: string[], seams: PreviewEngineSeams = {}): string | null {
  const platform = seams.platform ?? process.platform;
  const env = seams.env ?? process.env;
  const fileExists = seams.fileExists ?? defaultFileExists(platform);
  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const dir of pathEnv.split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function toolOnPath(tool: "soffice" | "pdftoppm" | "powershell", seams: PreviewEngineSeams): boolean {
  const platform = seams.platform ?? process.platform;
  return findExecutableOnPath(executableCandidates(tool, platform), seams) !== null;
}

/** PowerShell host usable for the PowerPoint engine, or null. Only ever consulted on win32. */
export function findPowerShell(seams: PreviewEngineSeams = {}): string | null {
  const platform = seams.platform ?? process.platform;
  return findExecutableOnPath(executableCandidates("powershell", platform), seams);
}

/** Default COM probe: a registry-only lookup (GetTypeFromProgID never launches PowerPoint). */
function defaultProbePowerPointCom(shell: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", "if ([Type]::GetTypeFromProgID('PowerPoint.Application')) { exit 0 } else { exit 2 }"],
      { timeout: POWERSHELL_PROBE_TIMEOUT_MS, windowsHide: true },
      (error) => resolvePromise(!error),
    );
  });
}

/**
 * Detect usable engines. LibreOffice needs soffice + pdftoppm on PATH
 * (any platform). PowerPoint is Windows-only: a PowerShell host plus
 * the PowerPoint COM progid — probed, never assumed from the shell
 * alone. Never throws: any failure reads as "not available".
 */
export async function detectPreviewEngines(seams: PreviewEngineSeams = {}): Promise<PreviewEngineAvailability> {
  const platform = seams.platform ?? process.platform;
  const libreOffice = toolOnPath("soffice", seams) && toolOnPath("pdftoppm", seams);
  let powerPoint = false;
  if (platform === "win32") {
    const shell = findPowerShell(seams);
    if (shell) {
      try {
        powerPoint = await (seams.probePowerPointCom ?? defaultProbePowerPointCom)(shell);
      } catch {
        powerPoint = false;
      }
    }
  }
  return { libreOffice, powerPoint };
}

/** Selection order: LibreOffice (headless, singleton-safe) before PowerPoint (Windows COM). */
export function resolvePreviewEngine(availability: PreviewEngineAvailability): PreviewEngineId | null {
  if (availability.libreOffice) return "libreoffice";
  if (availability.powerPoint) return "powerpoint";
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

/** Production converter, LibreOffice engine: headless → PDF → per-page PNGs. */
export const libreOfficeConverter: PreviewConverter = async ({ pptxPath, workDir, profileDir }) => {
  await runCommand(
    "soffice",
    ["-env:UserInstallation=" + pathToFileURL(profileDir).href, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", workDir, pptxPath],
    SOFFICE_TIMEOUT_MS,
  );
  const pdfPath = join(workDir, `${basename(pptxPath).replace(/\.pptx$/i, "")}.pdf`);
  if (!existsSync(pdfPath)) throw new Error("LibreOffice tidak menghasilkan PDF dari berkas .pptx ini.");
  await runCommand("pdftoppm", ["-png", "-r", String(PAGE_DPI), pdfPath, join(workDir, "page")], PDFTOPPM_TIMEOUT_MS);
  return collectPages(workDir, "pdftoppm tidak menghasilkan gambar halaman dari PDF ini.");
};

/**
 * The PowerShell script driving PowerPoint via COM (Windows only).
 * Pure string generation so tests can assert its exact semantics:
 *  - snapshots POWERPNT pids before activation and records any pid it
 *    started into `pidFile` (the Node runner taskkills exactly those
 *    on timeout — a pre-existing user PowerPoint is never force-killed);
 *  - opens the .pptx read-only, windowless, and exports every slide
 *    to page-N.png at `widthPx` wide, height from the deck's aspect;
 *  - always closes the presentation, and only Quit()s PowerPoint when
 *    no POWERPNT process existed before the render;
 *  - failures go to stderr with exit 1 (ErrorActionPreference Stop).
 * ASCII-only on purpose: PowerShell 5.1 misreads UTF-8-no-BOM scripts
 * containing non-ASCII characters.
 */
export function buildPowerPointExportScript(input: { pptxPath: string; outDir: string; pidFile: string; widthPx?: number }): string {
  const psString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const widthPx = input.widthPx ?? POWERPOINT_PAGE_WIDTH_PX;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$pptxPath = ${psString(input.pptxPath)}`,
    `$outDir = ${psString(input.outDir)}`,
    `$pidFile = ${psString(input.pidFile)}`,
    `$widthPx = ${widthPx}`,
    "function Get-PowerPointPids {",
    "  try { return @((Get-Process -Name POWERPNT -ErrorAction Stop).Id) } catch { return @() }",
    "}",
    "$preExisting = @(Get-PowerPointPids)",
    "$app = $null",
    "$presentation = $null",
    "try {",
    "  $app = New-Object -ComObject PowerPoint.Application",
    "  $startedByUs = @(Get-PowerPointPids | Where-Object { $preExisting -notcontains $_ })",
    "  if ($startedByUs.Count -gt 0) { [IO.File]::WriteAllLines($pidFile, [string[]]$startedByUs) }",
    "  try { $app.DisplayAlerts = 1 } catch { }",
    "  $presentation = $app.Presentations.Open($pptxPath, $true, $false, $false)",
    "  $heightPx = [int][Math]::Round($widthPx * [double]$presentation.PageSetup.SlideHeight / [double]$presentation.PageSetup.SlideWidth)",
    "  $index = 0",
    "  foreach ($slide in $presentation.Slides) {",
    "    $index += 1",
    "    $slide.Export((Join-Path $outDir ('page-{0}.png' -f $index)), 'PNG', $widthPx, $heightPx)",
    "  }",
    "  if ($index -eq 0) { throw 'PowerPoint membuka berkas .pptx ini tanpa slide.' }",
    "} catch {",
    "  [Console]::Error.WriteLine('Render PowerPoint gagal: ' + $_.Exception.Message)",
    "  exit 1",
    "} finally {",
    "  if ($null -ne $presentation) {",
    "    try { $presentation.Close() } catch { }",
    "    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) } catch { }",
    "  }",
    "  if ($null -ne $app) {",
    "    if ($preExisting.Count -eq 0) { try { $app.Quit() } catch { } }",
    "    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }",
    "  }",
    "  [GC]::Collect()",
    "  [GC]::WaitForPendingFinalizers()",
    "}",
    "",
  ].join("\r\n");
}

/** Runs the generated PowerShell script; injected by tests. */
export type PowerPointScriptRunner = (input: { shell: string; scriptPath: string; pidFile: string; timeoutMs: number }) => Promise<void>;

/**
 * Production runner: spawns the shell hidden, enforces the timeout,
 * and on timeout kills — in order — the PowerPoint pids the script
 * recorded (instances THIS render started) and then the shell itself.
 * A user's pre-existing PowerPoint process is never in that pid file.
 */
export const defaultPowerPointScriptRunner: PowerPointScriptRunner = ({ shell, scriptPath, pidFile, timeoutMs }) =>
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
        // no pid file yet: PowerPoint may not even have started
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
        reject(new Error(`Render PowerPoint melewati batas ${Math.round(timeoutMs / 1000)} detik; instance PowerPoint yang dimulai render ini sudah dihentikan.`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-2).join(" ");
        reject(new Error(detail || `Render PowerPoint gagal (kode keluar ${code ?? "?"}).`));
        return;
      }
      resolvePromise();
    });
  });

/** Production converter, PowerPoint engine (Windows): temp script → COM export of each slide. The shell resolver is injectable for tests. */
export function createPowerPointConverter(
  runner: PowerPointScriptRunner = defaultPowerPointScriptRunner,
  resolveShell: () => string | null = () => findPowerShell(),
): PreviewConverter {
  return async ({ pptxPath, workDir }) => {
    const shell = resolveShell();
    if (!shell) throw new Error("PowerShell tidak ditemukan di mesin ini — engine PowerPoint tidak tersedia.");
    const scriptPath = join(workDir, "render-powerpoint.ps1");
    const pidFile = join(workDir, "powerpoint-pids.txt");
    await writeFile(scriptPath, buildPowerPointExportScript({ pptxPath, outDir: workDir, pidFile }), "utf8");
    await runner({ shell, scriptPath, pidFile, timeoutMs: POWERPOINT_TIMEOUT_MS });
    return collectPages(workDir, "PowerPoint tidak menghasilkan gambar halaman dari berkas .pptx ini.");
  };
}

export const powerPointConverter: PreviewConverter = createPowerPointConverter();

async function defaultExportPptx(root: string, deck: DeckSpec): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const result = await exportDeckToPptx(deck, root, { fileSuffix: "pratinjau-asli" });
  const absolute = join(root, result.relativePath);
  return { path: absolute, cleanup: async () => { await rm(absolute, { force: true }); } };
}

export class SlidePreviewService {
  readonly #deps: Required<Omit<SlidePreviewDeps, "availability" | "converter" | "converters" | "engineSeams">> & {
    availability?: SlidePreviewDeps["availability"];
    converter?: PreviewConverter;
    converters: Partial<Record<PreviewEngineId, PreviewConverter>>;
    engineSeams: PreviewEngineSeams;
  };
  #enginesCache: Promise<{ availability: PreviewEngineAvailability; engine: PreviewEngineId | null }> | undefined;
  #jobs = new Map<string, RenderJob>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SlidePreviewDeps = {}) {
    this.#deps = {
      availability: deps.availability,
      converter: deps.converter,
      converters: deps.converters ?? {},
      engineSeams: deps.engineSeams ?? {},
      exportPptx: deps.exportPptx ?? defaultExportPptx,
    };
  }

  /** Engine verdict for this machine, detected once and cached (detection includes a PATH scan + at most one COM probe). */
  #engines(): Promise<{ availability: PreviewEngineAvailability; engine: PreviewEngineId | null }> {
    if (!this.#enginesCache) {
      this.#enginesCache = (async () => {
        const availability = this.#deps.availability
          ? await this.#deps.availability()
          : await detectPreviewEngines(this.#deps.engineSeams);
        return { availability, engine: resolvePreviewEngine(availability) };
      })();
    }
    return this.#enginesCache;
  }

  /** The converter that runs for the selected engine: per-engine dep, else the shared dep, else production. */
  #converterFor(engine: PreviewEngineId): PreviewConverter {
    return (
      this.#deps.converters[engine] ??
      this.#deps.converter ??
      (engine === "libreoffice" ? libreOfficeConverter : powerPointConverter)
    );
  }

  /**
   * Cache key for everything the export of this deck depends on:
   * deck.json bytes, deck asset bytes, and the stored record + source
   * .pptx of every imported template the deck references. Any change
   * flips the key, which is what makes an old render detectably stale.
   */
  async computeKey(root: string, deck: DeckSpec): Promise<string> {
    const hash = createHash("sha256");
    hash.update(KEY_SALT);
    const paths = deckPaths(root);
    try {
      hash.update(await readFile(paths.file));
    } catch {
      hash.update(JSON.stringify(deck));
    }
    try {
      const assets = (await readdir(paths.assetsDir)).sort();
      for (const name of assets) {
        hash.update(`asset:${name}:`);
        hash.update(await readFile(join(paths.assetsDir, name)));
      }
    } catch {
      // no assets directory yet — export sees the same emptiness
    }
    const templateIds = new Set<string>();
    if (deck.theme.customTemplateId) templateIds.add(deck.theme.customTemplateId);
    for (const slide of deck.slides) {
      if (slide.templateRef?.templateId) templateIds.add(slide.templateRef.templateId);
    }
    const dir = pptxTemplatesDir(root);
    for (const id of [...templateIds].sort()) {
      hash.update(`template:${id}:`);
      try {
        const recordRaw = await readFile(join(dir, `${id}.json`));
        hash.update(recordRaw);
        const record = JSON.parse(recordRaw.toString("utf8")) as { sourceFileName?: unknown };
        if (typeof record.sourceFileName === "string") {
          hash.update(await readFile(join(dir, basename(record.sourceFileName))));
        }
      } catch {
        // missing template record — the export reports that itself
      }
    }
    return hash.digest("hex");
  }

  async status(root: string, deck: DeckSpec, pageUrlFor: (key: string, page: number) => string): Promise<TruePreviewStatus> {
    const key = await this.computeKey(root, deck);
    const { engine } = await this.#engines();
    if (!engine) return { available: false, status: "unavailable", engine: null, key, pages: 0 };
    const manifest = await this.#readManifest(root, key);
    if (manifest) {
      return {
        available: true,
        status: "ready",
        engine,
        key,
        pages: manifest.pages,
        pageUrls: Array.from({ length: manifest.pages }, (_, i) => pageUrlFor(key, i + 1)),
        renderedAt: manifest.renderedAt,
      };
    }
    const job = this.#jobs.get(`${root}::${key}`);
    if (job?.state === "rendering") return { available: true, status: "rendering", engine, key, pages: 0 };
    if (job?.state === "error") return { available: true, status: "error", engine, key, pages: 0, error: job.error };
    // A render of an older deck state on disk means this exact state
    // has no faithful pages yet: stale, not ready.
    if (await this.#hasAnyManifest(root)) return { available: true, status: "stale", engine, key, pages: 0 };
    return { available: true, status: "idle", engine, key, pages: 0 };
  }

  /** Queue a render of the deck's current state (deduped per key, fully serialised). */
  async render(root: string, deck: DeckSpec, pageUrlFor: (key: string, page: number) => string): Promise<TruePreviewStatus> {
    const key = await this.computeKey(root, deck);
    const { engine } = await this.#engines();
    if (!engine) return { available: false, status: "unavailable", engine: null, key, pages: 0 };
    if (await this.#readManifest(root, key)) return this.status(root, deck, pageUrlFor);
    const jobKey = `${root}::${key}`;
    if (this.#jobs.get(jobKey)?.state !== "rendering") {
      const job: RenderJob = { state: "rendering" };
      this.#jobs.set(jobKey, job);
      const run = async (): Promise<void> => {
        try {
          await this.#renderNow(root, deck, key, this.#converterFor(engine));
          this.#jobs.delete(jobKey);
        } catch (error) {
          job.state = "error";
          job.error = error instanceof Error ? error.message : String(error);
        }
      };
      this.#queue = this.#queue.then(run, run);
    }
    return { available: true, status: "rendering", engine, key, pages: 0 };
  }

  async #renderNow(root: string, deck: DeckSpec, key: string, converter: PreviewConverter): Promise<void> {
    // Mirror the Export route's contract: an invalid or empty deck is
    // refused here exactly as it is there, with the issue in the open.
    const issues = validateDeck(deck, { root }).filter((issue) => issue.severity === "error");
    if (deck.slides.length === 0 || issues.length > 0) {
      throw new Error(issues[0]?.message ?? "deck belum punya slide — tambahkan slide sebelum pratinjau.");
    }
    const dir = cacheRoot(root);
    const workDir = join(dir, `.work-${key.slice(0, 12)}-${process.pid}`);
    const finalDir = join(dir, key);
    const exported = await this.#deps.exportPptx(root, deck);
    try {
      await rm(workDir, { recursive: true, force: true });
      await mkdir(workDir, { recursive: true });
      const pages = await converter({ pptxPath: exported.path, workDir, profileDir: join(dir, ".lo-profile") });
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

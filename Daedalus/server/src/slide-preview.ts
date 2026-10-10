import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { deckPaths, exportDeckToPptx, pptxTemplatesDir, validateDeck, type DeckSpec } from "@daedalus/core";

/**
 * Pratinjau Asli (True Preview): renders the .pptx that Export would
 * produce from the CURRENT deck state through a locally installed
 * LibreOffice, so the user sees inside Daedalus exactly what
 * LibreOffice/PowerPoint draws — gradients, shadows, and all — without
 * opening another app. The editable canvas stays an approximation;
 * these page images are the exported file itself, rasterised.
 *
 * Pipeline (on demand, never per edit): core export → temp .pptx →
 * `soffice --headless --convert-to pdf` (dedicated user profile) →
 * `pdftoppm -png`. Results are cached under
 * `<workspace>/.daedalus/slide-preview/<key>/page-N.png`, where the key
 * hashes everything the export depends on (deck.json bytes, deck
 * assets, referenced template records + source .pptx). A deck change
 * therefore yields a new key and the old render reports as stale
 * instead of silently showing pages of an older deck.
 *
 * Renders are serialised (LibreOffice is a per-profile singleton) and
 * hard-timed-out. When `soffice`/`pdftoppm` are absent the service
 * reports a distinct `unavailable` state — never a crash.
 */

export type TruePreviewStatusName = "unavailable" | "idle" | "rendering" | "ready" | "stale" | "error";

export type TruePreviewStatus = {
  available: boolean;
  status: TruePreviewStatusName;
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

export type ConverterAvailability = { soffice: boolean; pdftoppm: boolean };

export type SlidePreviewDeps = {
  /** Converter detection (PATH scan, cached per service instance). */
  availability?: () => ConverterAvailability;
  /** The pptx → PNGs step. Tests inject a fake; production uses LibreOffice. */
  converter?: PreviewConverter;
  /** The deck → temp .pptx step. Tests inject a fake; production reuses core's exporter. */
  exportPptx?: (root: string, deck: DeckSpec) => Promise<{ path: string; cleanup?: () => Promise<void> }>;
};

const PREVIEW_DIR = join(".daedalus", "slide-preview");
const KEY_SALT = "true-preview:v1:r100";
const PAGE_DPI = 100;
const SOFFICE_TIMEOUT_MS = 90_000;
const PDFTOPPM_TIMEOUT_MS = 30_000;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

type RenderJob = {
  state: "rendering" | "error";
  error?: string;
};

type Manifest = { key: string; pages: number; renderedAt: string };

function cacheRoot(root: string): string {
  return join(root, PREVIEW_DIR);
}

function executableOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

function defaultAvailability(): ConverterAvailability {
  return { soffice: executableOnPath("soffice"), pdftoppm: executableOnPath("pdftoppm") };
}

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

/** Production converter: LibreOffice headless → PDF → per-page PNGs. */
export const libreOfficeConverter: PreviewConverter = async ({ pptxPath, workDir, profileDir }) => {
  await runCommand(
    "soffice",
    ["--headless", "--norestore", `--env:UserInstallation=${pathToFileURL(profileDir).href}`, "--convert-to", "pdf", "--outdir", workDir, pptxPath],
    SOFFICE_TIMEOUT_MS,
  );
  const pdfPath = join(workDir, `${basename(pptxPath).replace(/\.pptx$/i, "")}.pdf`);
  if (!existsSync(pdfPath)) throw new Error("LibreOffice tidak menghasilkan PDF dari berkas .pptx ini.");
  await runCommand("pdftoppm", ["-png", "-r", String(PAGE_DPI), pdfPath, join(workDir, "page")], PDFTOPPM_TIMEOUT_MS);
  const entries = await readdir(workDir);
  const pages = entries
    .map((name) => /^page-(\d+)\.png$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((match) => join(workDir, match[0]));
  if (pages.length === 0) throw new Error("pdftoppm tidak menghasilkan gambar halaman dari PDF ini.");
  return pages;
};

async function defaultExportPptx(root: string, deck: DeckSpec): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const result = await exportDeckToPptx(deck, root, { fileSuffix: "pratinjau-asli" });
  const absolute = join(root, result.relativePath);
  return { path: absolute, cleanup: async () => { await rm(absolute, { force: true }); } };
}

export class SlidePreviewService {
  readonly #deps: Required<SlidePreviewDeps>;
  #availabilityCache: ConverterAvailability | undefined;
  #jobs = new Map<string, RenderJob>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: SlidePreviewDeps = {}) {
    this.#deps = {
      availability: deps.availability ?? (() => (this.#availabilityCache ??= defaultAvailability())),
      converter: deps.converter ?? libreOfficeConverter,
      exportPptx: deps.exportPptx ?? defaultExportPptx,
    };
  }

  get available(): boolean {
    const found = this.#deps.availability();
    return found.soffice && found.pdftoppm;
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
    if (!this.available) return { available: false, status: "unavailable", key, pages: 0 };
    const manifest = await this.#readManifest(root, key);
    if (manifest) {
      return {
        available: true,
        status: "ready",
        key,
        pages: manifest.pages,
        pageUrls: Array.from({ length: manifest.pages }, (_, i) => pageUrlFor(key, i + 1)),
        renderedAt: manifest.renderedAt,
      };
    }
    const job = this.#jobs.get(`${root}::${key}`);
    if (job?.state === "rendering") return { available: true, status: "rendering", key, pages: 0 };
    if (job?.state === "error") return { available: true, status: "error", key, pages: 0, error: job.error };
    // A render of an older deck state on disk means this exact state
    // has no faithful pages yet: stale, not ready.
    if (await this.#hasAnyManifest(root)) return { available: true, status: "stale", key, pages: 0 };
    return { available: true, status: "idle", key, pages: 0 };
  }

  /** Queue a render of the deck's current state (deduped per key, fully serialised). */
  async render(root: string, deck: DeckSpec, pageUrlFor: (key: string, page: number) => string): Promise<TruePreviewStatus> {
    const key = await this.computeKey(root, deck);
    if (!this.available) return { available: false, status: "unavailable", key, pages: 0 };
    if (await this.#readManifest(root, key)) return this.status(root, deck, pageUrlFor);
    const jobKey = `${root}::${key}`;
    if (this.#jobs.get(jobKey)?.state !== "rendering") {
      const job: RenderJob = { state: "rendering" };
      this.#jobs.set(jobKey, job);
      const run = async (): Promise<void> => {
        try {
          await this.#renderNow(root, deck, key);
          this.#jobs.delete(jobKey);
        } catch (error) {
          job.state = "error";
          job.error = error instanceof Error ? error.message : String(error);
        }
      };
      this.#queue = this.#queue.then(run, run);
    }
    return { available: true, status: "rendering", key, pages: 0 };
  }

  async #renderNow(root: string, deck: DeckSpec, key: string): Promise<void> {
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
      const pages = await this.#deps.converter({ pptxPath: exported.path, workDir, profileDir: join(dir, ".lo-profile") });
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

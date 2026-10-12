import { execFile } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';
import { pathInWorkspace } from '../filesystem/index.ts';

/**
 * view_image: let the model actually LOOK at an image in the workspace
 * (Claude Code's image-capable Read / Codex's view_image). The tool result
 * text is a one-line placeholder; the image bytes ride in
 * `meta.image_data_url`, which the agent loop lifts onto the next model
 * request as an `image_url` content block (the same carriage user
 * uploads take) and strips before the result is emitted or persisted —
 * so transcripts and the event log never carry base64.
 *
 * Vision gate: the tool refuses when the execution context says the
 * selected model cannot see images (`visionEnabled === false`, resolved
 * by the runtime from the provider registry's supportsVision flags).
 * Silently dropping the picture would teach the model it "saw" something
 * it never received — the refusal names the fix instead.
 */

/** Mirrors the context manager's attachment cap (5 MB per image). */
export const VIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Magic-byte sniff: the real format decides, never the file name. */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export const viewImageTool: ToolDefinition = {
  name: 'view_image',
  description: [
    'Look at an image file in the workspace (png, jpg/jpeg, gif, webp; up to 5 MB): the picture is attached to the conversation and you see it on your next turn.',
    'Use it to inspect screenshots, mockups, or generated images instead of guessing from file names. The selected model must support vision — with a text-only model this call refuses and says so (never pretends you saw it).',
  ].join(' '),
  mutating: false,
  inputSchema: {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string', description: 'Workspace-relative path of the image, e.g. screenshots/home.png' } },
    additionalProperties: false,
  },
  async execute(args, context): Promise<ToolResult> {
    const path = (args as { path?: unknown })?.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      return { call_id: '', status: 'error', output: 'view_image requires a string "path".', truncated: false, meta: { reason: 'invalid_arguments' } };
    }
    if (context.visionEnabled === false) {
      return {
        call_id: '',
        status: 'denied',
        output: 'current model cannot view images — view_image needs a vision-capable model. Switch the task to a model with vision support (the model picker marks them), or inspect the image another way.',
        truncated: false,
        meta: { reason: 'vision_unsupported', path },
      };
    }
    let absolute: string;
    try {
      absolute = await pathInWorkspace(context.workspaceRoot, path);
    } catch (error) {
      return { call_id: '', status: 'error', output: String(error), truncated: false, meta: { reason: 'path_escape', path } };
    }
    let bytes: Buffer;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) return { call_id: '', status: 'error', output: `view_image: ${path} is not a file`, truncated: false, meta: { reason: 'not_a_file', path } };
      if (info.size === 0) return { call_id: '', status: 'error', output: `view_image: ${path} is empty`, truncated: false, meta: { reason: 'empty', path } };
      if (info.size > VIEW_IMAGE_MAX_BYTES) {
        return {
          call_id: '',
          status: 'error',
          output: `view_image: ${path} is ${info.size} bytes, over the ${VIEW_IMAGE_MAX_BYTES}-byte limit — downscale or crop the image first.`,
          truncated: false,
          meta: { reason: 'too_large', path, bytes: info.size },
        };
      }
      bytes = await readFile(absolute);
    } catch (error) {
      return { call_id: '', status: 'error', output: String(error), truncated: false, meta: { reason: 'read_failed', path } };
    }
    const mime = sniffImageMime(bytes);
    if (!mime) {
      return {
        call_id: '',
        status: 'error',
        output: `view_image: ${path} is not a supported image (png, jpg/jpeg, gif, webp) — the file's bytes do not match any of those formats.`,
        truncated: false,
        meta: { reason: 'unsupported_image', path },
      };
    }
    return {
      call_id: '',
      status: 'ok',
      output: `viewed image ${path} (${mime}, ${bytes.length} bytes) — the image itself is attached to this conversation; you see it with this result.`,
      truncated: false,
      meta: {
        image_path: path,
        image_mime: mime,
        image_bytes: bytes.length,
        // Lifted by the agent loop onto the next request as an image_url
        // block, then stripped from the result before it is emitted or
        // persisted (transcripts render the placeholder line above).
        image_data_url: `data:${mime};base64,${bytes.toString('base64')}`,
      },
    };
  },
};

/**
 * screenshot: render a page (usually the workspace's dev server) with a
 * headless Chrome/Chromium and hand the PNG to the model through the
 * same carriage as view_image. This is the verify half of "build the
 * page": without it the agent can only CLAIM the page looks right —
 * the exact failure where an unstyled page was reported as done with
 * parallax. The screenshot lands under `.daedalus/screenshots/` (state,
 * never source) and the text result tells the model to actually check
 * the render before calling anything finished.
 */

export const SCREENSHOT_DEFAULT_WIDTH = 1280;
export const SCREENSHOT_DEFAULT_HEIGHT = 800;
export const SCREENSHOT_TIMEOUT_MS = 60_000;

const CHROME_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge'] as const;
const CHROME_ABSOLUTE_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
] as const;

async function fileIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a headless browser: DAEDALUS_CHROME_BIN wins, then PATH
 * candidates, then the standard macOS app paths. Undefined = none.
 */
export async function resolveScreenshotBrowser(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const override = env.DAEDALUS_CHROME_BIN;
  if (override) return override;
  const pathValue = env.PATH ?? '';
  for (const candidate of CHROME_CANDIDATES) {
    for (const dir of pathValue.split(':')) {
      if (dir && (await fileIsExecutable(join(dir, candidate)))) return candidate;
    }
  }
  for (const absolute of CHROME_ABSOLUTE_PATHS) {
    if (await fileIsExecutable(absolute)) return absolute;
  }
  return undefined;
}

/** Chrome flags for one capture; `--headless=new` first, old mode as retry. Exported for tests. */
export function screenshotChromeArgs(url: string, outputPath: string, width: number, height: number, legacyHeadless = false): string[] {
  return [
    legacyHeadless ? '--headless' : '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=10000',
    `--screenshot=${outputPath}`,
    url,
  ];
}

export type ScreenshotRunner = (binary: string, args: string[]) => Promise<{ code: number; stderr: string }>;

const defaultRunner: ScreenshotRunner = (binary, args) =>
  new Promise((resolvePromise) => {
    execFile(binary, args, { timeout: SCREENSHOT_TIMEOUT_MS, maxBuffer: 4_000_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) resolvePromise({ code: 0, stderr: '' });
      else resolvePromise({ code: typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1, stderr: String(stderr ?? error.message ?? '') });
    });
  });

function screenshotSlug(url: URL): string {
  const raw = `${url.hostname}${url.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
  return raw.toLowerCase();
}

export function createScreenshotTool(options: { resolveBrowser?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>; runner?: ScreenshotRunner; env?: NodeJS.ProcessEnv; now?: () => number } = {}): ToolDefinition {
  const resolveBrowser = options.resolveBrowser ?? ((env) => resolveScreenshotBrowser(env));
  const runner = options.runner ?? defaultRunner;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());
  return {
    name: 'screenshot',
    description: [
      'Take a screenshot of a web page (http/https URL — typically your dev server, e.g. http://localhost:5173) with a headless browser and LOOK at it: the picture is attached to this conversation like view_image.',
      'Use it to verify pages you build actually render (layout, styling, content, no error overlay) before reporting them done — never claim a page looks right from the code alone. Saved under .daedalus/screenshots/ so you can view_image it again later.',
    ].join(' '),
    mutating: false,
    timeoutMs: SCREENSHOT_TIMEOUT_MS + 15_000,
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Full http/https URL to render, e.g. http://localhost:5173/' },
        width: { type: 'integer', minimum: 320, maximum: 3840 },
        height: { type: 'integer', minimum: 240, maximum: 2160 },
        path: { type: 'string', description: 'Optional workspace-relative output path (default .daedalus/screenshots/<page>-<timestamp>.png)' },
      },
      additionalProperties: false,
    },
    async execute(args, context): Promise<ToolResult> {
      const a = args as { url?: unknown; width?: unknown; height?: unknown; path?: unknown };
      if (typeof a.url !== 'string' || a.url.trim().length === 0) {
        return { call_id: '', status: 'error', output: 'screenshot requires a string "url".', truncated: false, meta: { reason: 'invalid_arguments' } };
      }
      let url: URL;
      try {
        url = new URL(a.url.trim());
      } catch {
        return { call_id: '', status: 'error', output: `screenshot: "${a.url}" is not a valid URL.`, truncated: false, meta: { reason: 'invalid_url' } };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { call_id: '', status: 'error', output: `screenshot: only http/https URLs can be rendered (got ${url.protocol}).`, truncated: false, meta: { reason: 'unsupported_protocol' } };
      }
      if (context.visionEnabled === false) {
        return {
          call_id: '',
          status: 'denied',
          output: 'current model cannot view images — screenshot needs a vision-capable model to be useful. Switch the task to a model with vision support (the model picker marks them) before verifying pages visually.',
          truncated: false,
          meta: { reason: 'vision_unsupported', url: url.href },
        };
      }
      const width = typeof a.width === 'number' && Number.isFinite(a.width) ? Math.min(3840, Math.max(320, Math.floor(a.width))) : SCREENSHOT_DEFAULT_WIDTH;
      const height = typeof a.height === 'number' && Number.isFinite(a.height) ? Math.min(2160, Math.max(240, Math.floor(a.height))) : SCREENSHOT_DEFAULT_HEIGHT;
      const relPath = typeof a.path === 'string' && a.path.trim() ? a.path.trim() : `.daedalus/screenshots/${screenshotSlug(url)}-${now()}.png`;
      let absolute: string;
      try {
        absolute = await pathInWorkspace(context.workspaceRoot, relPath);
      } catch (error) {
        return { call_id: '', status: 'error', output: String(error), truncated: false, meta: { reason: 'path_escape', path: relPath } };
      }
      const browser = await resolveBrowser(env);
      if (!browser) {
        return {
          call_id: '',
          status: 'error',
          output: 'screenshot: no headless Chrome/Chromium found on this machine. Install chromium (or google-chrome), or set DAEDALUS_CHROME_BIN to the browser binary, then retry. Until then, verify the page another way and say you could not look at it — do not claim it renders correctly.',
          truncated: false,
          meta: { reason: 'no_browser', url: url.href },
        };
      }
      try {
        await mkdir(dirname(absolute), { recursive: true });
      } catch (error) {
        return { call_id: '', status: 'error', output: `screenshot: could not prepare ${relPath}: ${(error as Error).message}`, truncated: false, meta: { reason: 'mkdir_failed', path: relPath } };
      }
      let run = await runner(browser, screenshotChromeArgs(url.href, absolute, width, height));
      if (run.code !== 0) {
        // Older Chromes reject --headless=new; retry once in legacy mode.
        run = await runner(browser, screenshotChromeArgs(url.href, absolute, width, height, true));
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch {
        return {
          call_id: '',
          status: 'error',
          output: `screenshot: the browser exited ${run.code} and produced no image for ${url.href}${run.stderr ? ` — ${run.stderr.split('\n').filter(Boolean).slice(-2).join(' ')}` : ''}. Is the dev server running at that URL? Start it (run_command, background: true), wait for it to answer, then screenshot again.`,
          truncated: false,
          meta: { reason: 'capture_failed', url: url.href, exit_code: run.code },
        };
      }
      const mime = sniffImageMime(bytes);
      if (!mime || bytes.length === 0 || bytes.length > VIEW_IMAGE_MAX_BYTES) {
        return { call_id: '', status: 'error', output: `screenshot: captured output at ${relPath} is not a usable image (${bytes.length} bytes).`, truncated: false, meta: { reason: 'bad_capture', path: relPath, bytes: bytes.length } };
      }
      return {
        call_id: '',
        status: 'ok',
        output: `screenshot of ${url.href} saved to ${relPath} (${width}×${height}, ${mime}, ${bytes.length} bytes) — the image itself is attached; look at it: does the page actually render (layout, styling, content, no error overlay or blank screen) before you call it done?`,
        truncated: false,
        meta: {
          image_path: relPath,
          image_mime: mime,
          image_bytes: bytes.length,
          image_data_url: `data:${mime};base64,${bytes.toString('base64')}`,
          url: url.href,
          width,
          height,
        },
      };
    },
  };
}

export const screenshotTool: ToolDefinition = createScreenshotTool();

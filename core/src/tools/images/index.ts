import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';
import { pathInWorkspace } from '../filesystem/index.ts';
import { decodeHtmlEntities, htmlToText, validateFetchTarget, type FetchUrlResponse } from '../web/index.ts';
import { sniffImageMime } from '../media/index.ts';

/**
 * search_images + download_file: find openly-licensed photos and bring one
 * into the workspace. No mainstream coding agent ships this natively (the
 * field's web tools are text-only; images land via shell curl, stock/CC
 * skills/MCPs, screenshots, or generation) — so Daedalus follows the
 * proven stock/CC pattern directly:
 *
 * - search_images queries Openverse (https://api.openverse.org/v1/images/,
 *   anonymous, NO API key) and the Wikimedia Commons API (generator=search
 *   in the File: namespace + imageinfo with extmetadata; a descriptive
 *   User-Agent is REQUIRED by Commons policy). Results come back as
 *   structured text — title, source page, image/thumbnail URLs, dimensions,
 *   license name + URL, author, commercial-use flag — never base64.
 *   Unknown-license results are excluded unless the caller opts in, and
 *   CC/public-domain results rank first.
 * - download_file fetches ONE image URL into a workspace-relative path with
 *   fetch_url's SSRF posture (every literal and redirect target validated,
 *   5 redirects max and reported), magic-byte/Content-Type/extension
 *   agreement, a 10 MB cap enforced WHILE STREAMING, an atomic temp+rename
 *   write, and a `<file>.attribution.txt` sidecar when the model passes
 *   the licensing metadata from search_images.
 *
 * Deliberate non-goals: no API keys anywhere; Google Images is never
 * scraped as a backend (its results carry no reuse rights); fetch_url
 * stays text-only and binary never flows through it.
 */

/** Wikimedia's robot policy requires a descriptive UA — say who we are. */
export const IMAGE_TOOLS_USER_AGENT = 'Daedalus/1.0 (agent image search; openly-licensed image lookup for coding tasks)';

export const SEARCH_IMAGES_DEFAULT_COUNT = 6;
export const SEARCH_IMAGES_MAX_COUNT = 12;
export const SEARCH_IMAGES_TIMEOUT_MS = 15_000;

export const DOWNLOAD_FILE_DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // mirrors SWE-agent's 10 MB image cap
export const DOWNLOAD_FILE_MAX_REDIRECTS = 5;
export const DOWNLOAD_FILE_TIMEOUT_MS = 60_000;

export type ImageSearchSource = 'openverse' | 'wikimedia' | 'all';
type ImageSearchOrigin = 'openverse' | 'wikimedia';

export type ImageSearchResult = {
  title: string;
  pageUrl: string;
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  license: string | null;
  licenseUrl?: string;
  author?: string;
  attribution: string;
  commercialUse: boolean | null;
  source: ImageSearchOrigin;
};

/** Injectable fetch seam for the JSON APIs (tests drive fixtures — never the network). */
export type ImageSearchFetchImpl = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<FetchUrlResponse>;

/** Injectable byte-stream fetch seam for download_file. */
export type DownloadFetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
};
export type DownloadFetchImpl = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<DownloadFetchResponse>;

const defaultSearchFetch: ImageSearchFetchImpl = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, text: () => response.text() };
};

const defaultDownloadFetch: DownloadFetchImpl = async (url, init) => {
  const response = await fetch(url, init);
  const body = response.body
    ? (Readable.fromWeb(response.body as never) as unknown as AsyncIterable<Uint8Array>)
    : null;
  return { status: response.status, headers: response.headers, body };
};

// ── license helpers ─────────────────────────────────────────────────────────

/** Slugs Openverse/Commons use that make derivative use unrestricted-ish. */
const FREE_LICENSE = /^(cc0|pdm|public domain|cc by\b|cc-by\b)/i;

/** Commercial use is OK unless the license forbids it (NC) or is unknown. */
function commercialUseForLicense(license: string | null): boolean | null {
  if (!license) return null;
  if (/\bnc\b|-nc\b|noncommercial|non-commercial/i.test(license)) return false;
  if (FREE_LICENSE.test(license.trim()) || /^cc\b/i.test(license.trim()) || /^gfdl/i.test(license.trim())) return true;
  return null; // a license we cannot classify beats guessing
}

/** Ranking: CC0/public domain first, then free CC, other CC, NC-restricted, unknown. Lower wins. */
function licenseRank(license: string | null): number {
  if (!license) return 4;
  if (/^(cc0|pdm|public domain)/i.test(license.trim())) return 0;
  if (/\bnc\b|-nc\b|noncommercial|non-commercial/i.test(license)) return 3;
  if (FREE_LICENSE.test(license.trim())) return 1;
  if (/cc|gfdl/i.test(license)) return 2;
  return 4;
}

function cleanInlineText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = htmlToText(decodeHtmlEntities(value)).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

// ── Openverse ───────────────────────────────────────────────────────────────

type OpenverseImage = {
  title?: string;
  foreign_landing_url?: string;
  url?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  license?: string;
  license_version?: string;
  license_url?: string;
  creator?: string;
  attribution?: string;
};

export function parseOpenverseResults(body: unknown): ImageSearchResult[] {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const parsed: ImageSearchResult[] = [];
  for (const raw of results) {
    const item = raw as OpenverseImage;
    if (typeof item?.url !== 'string' || item.url.length === 0) continue;
    const version = typeof item.license_version === 'string' && item.license_version ? ` ${item.license_version}` : '';
    const slug = typeof item.license === 'string' ? item.license.toLowerCase() : '';
    const slugName = slug.split('-').filter(Boolean).map((part) => part.toUpperCase()).join('-');
    const license = slug === 'cc0'
      ? 'CC0'
      : slug === 'pdm'
        ? 'Public Domain'
        : slug
          ? `CC ${slugName}${version}`
          : null;
    const author = typeof item.creator === 'string' && item.creator.trim() ? item.creator.trim() : undefined;
    parsed.push({
      title: (typeof item.title === 'string' && item.title.trim()) || '(untitled image)',
      pageUrl: typeof item.foreign_landing_url === 'string' && item.foreign_landing_url ? item.foreign_landing_url : item.url,
      imageUrl: item.url,
      ...(typeof item.thumbnail === 'string' && item.thumbnail ? { thumbnailUrl: item.thumbnail } : {}),
      ...(typeof item.width === 'number' && item.width > 0 ? { width: item.width } : {}),
      ...(typeof item.height === 'number' && item.height > 0 ? { height: item.height } : {}),
      license,
      ...(typeof item.license_url === 'string' && item.license_url ? { licenseUrl: item.license_url } : {}),
      ...(author ? { author } : {}),
      attribution: typeof item.attribution === 'string' && item.attribution.trim()
        ? item.attribution.trim()
        : buildAttribution((typeof item.title === 'string' && item.title.trim()) || 'image', author, license, item.url),
      commercialUse: commercialUseForLicense(license),
      source: 'openverse',
    });
  }
  return parsed;
}

export function buildOpenverseQueryUrl(query: string, count: number, commercialOnly: boolean): string {
  const params = new URLSearchParams({ q: query, page_size: String(count), filter_dead: 'true' });
  if (commercialOnly) params.set('license_type', 'commercial');
  return `https://api.openverse.org/v1/images/?${params.toString()}`;
}

// ── Wikimedia Commons ───────────────────────────────────────────────────────

type CommonsPage = {
  title?: string;
  index?: number;
  imageinfo?: Array<{
    url?: string;
    descriptionurl?: string;
    thumburl?: string;
    width?: number;
    height?: number;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }>;
};

export function parseWikimediaResults(body: unknown): ImageSearchResult[] {
  const pages = (body as { query?: { pages?: Record<string, CommonsPage> } })?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  const ordered = Object.values(pages)
    .filter((page) => page && Array.isArray(page.imageinfo) && page.imageinfo.length > 0)
    .sort((a, b) => (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER));
  const parsed: ImageSearchResult[] = [];
  for (const page of ordered) {
    const info = page.imageinfo![0]!;
    if (typeof info.url !== 'string' || info.url.length === 0) continue;
    const meta = info.extmetadata ?? {};
    const license = cleanInlineText(meta.LicenseShortName?.value) ?? null;
    const licenseUrl = typeof meta.LicenseUrl?.value === 'string' && meta.LicenseUrl.value.startsWith('http')
      ? meta.LicenseUrl.value
      : undefined;
    const author = cleanInlineText(meta.Artist?.value);
    const credit = cleanInlineText(meta.Credit?.value);
    const title = (page.title ?? '').replace(/^File:/, '').replace(/_/g, ' ').trim() || '(untitled image)';
    parsed.push({
      title,
      pageUrl: typeof info.descriptionurl === 'string' && info.descriptionurl ? info.descriptionurl : info.url,
      imageUrl: info.url,
      ...(typeof info.thumburl === 'string' && info.thumburl ? { thumbnailUrl: info.thumburl } : {}),
      ...(typeof info.width === 'number' && info.width > 0 ? { width: info.width } : {}),
      ...(typeof info.height === 'number' && info.height > 0 ? { height: info.height } : {}),
      license,
      ...(licenseUrl ? { licenseUrl } : {}),
      ...(author ? { author } : {}),
      attribution: buildAttribution(title, author ?? credit, license, info.url),
      commercialUse: commercialUseForLicense(license),
      source: 'wikimedia',
    });
  }
  return parsed;
}

export function buildWikimediaQueryUrl(query: string, count: number): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(count),
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '480',
  });
  return `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
}

function buildAttribution(title: string, author: string | undefined, license: string | null, imageUrl: string): string {
  const parts = [`"${title}"`];
  if (author) parts.push(`by ${author}`);
  parts.push(license ? `licensed under ${license}` : `license unknown — verify at the source page before use`);
  parts.push(`(${imageUrl})`);
  return parts.join(' ');
}

/** Merge both sources: dedupe by image URL, drop unknown licenses unless opted in, CC/PD first. */
export function mergeImageResults(
  lists: ImageSearchResult[][],
  options: { count: number; commercialOnly: boolean; includeUnknownLicense: boolean },
): ImageSearchResult[] {
  const seen = new Set<string>();
  const merged: ImageSearchResult[] = [];
  for (const list of lists) {
    for (const result of list) {
      const key = result.imageUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!result.license && !options.includeUnknownLicense) continue;
      if (options.commercialOnly && result.commercialUse !== true) continue;
      merged.push(result);
    }
  }
  merged.sort((a, b) => licenseRank(a.license) - licenseRank(b.license));
  return merged.slice(0, options.count);
}

/** Lowercase URL-safe slug from a free-text image title. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** Destination extension matching a download URL's own format (download_file refuses mismatches). */
function imageDestExtension(url: string): string {
  const match = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(url);
  return match ? `.${match[1]!.toLowerCase()}` : '.jpg';
}

function renderSearchResults(
  query: string,
  results: ImageSearchResult[],
  notes: string[],
  options: { visionEnabled?: boolean } = {},
): string {
  // Matches view_image's own contract: only an explicit false means the
  // serving model cannot see images (undefined = host did not say).
  const canSeeImages = options.visionEnabled !== false;
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push(`No openly-licensed images found for "${query}".`);
    for (const note of notes) lines.push(note);
    lines.push('Try broader terms, or source: "wikimedia" for a specific person/place (Wikimedia Commons covers named subjects best). An empty result is an outcome, not an error — say plainly that nothing was found.');
    return lines.join('\n');
  }
  lines.push(`Found ${results.length} openly-licensed image(s) for "${query}":`);
  results.forEach((result, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${result.title} [${result.source === 'openverse' ? 'Openverse' : 'Wikimedia Commons'}]`);
    lines.push(`   page: ${result.pageUrl}`);
    lines.push(`   image: ${result.imageUrl}`);
    if (result.thumbnailUrl && result.thumbnailUrl !== result.imageUrl) lines.push(`   thumb: ${result.thumbnailUrl}`);
    if (result.width && result.height) lines.push(`   size: ${result.width}×${result.height}`);
    if (result.license) {
      lines.push(`   license: ${result.license}${result.licenseUrl ? ` (${result.licenseUrl})` : ''} — commercial use: ${result.commercialUse === true ? 'yes' : result.commercialUse === false ? 'NO' : 'unverified'}`);
    } else {
      lines.push('   license: UNKNOWN — included only because include_unknown_license was set; verify reuse rights at the page above before using it.');
    }
    if (result.author) lines.push(`   by: ${result.author}`);
    lines.push(`   attribution: ${result.attribution}`);
  });
  for (const note of notes) lines.push('', note);
  lines.push('');
  lines.push(canSeeImages
    ? 'Next: download the chosen image with download_file (pass license, author, and source_url from the result above so the attribution sidecar is written), then view_image the downloaded file to CONFIRM it shows what the user asked for before wiring it into a page. NEVER hotlink these URLs into a page — download first.'
    : 'Next: download the chosen image with download_file (pass license, author, and source_url from the result above so the attribution sidecar is written). The current model cannot view images, so do NOT call view_image on it — the saved file is verified by its bytes (format and dimensions). NEVER hotlink these URLs into a page — download first.');
  // Concrete first-result template: models stall after search when the
  // next call has to be invented; spelling it out with the actual first
  // result's data turns "found images" into an executable next step.
  // Default to the thumbnail (≈500px): a "give me an image" request is
  // served just as well by it and downloads in a fraction of the time of
  // a multi-MB original (the live cat run fetched 9.9 MB for a 144 KB
  // need); the full-size URL stays in the result above when the user
  // actually asked for full resolution.
  const first = results[0]!;
  const slug = slugify(first.title) || 'image';
  const downloadUrl = first.thumbnailUrl && first.thumbnailUrl !== first.imageUrl ? first.thumbnailUrl : first.imageUrl;
  const usedThumbnail = downloadUrl !== first.imageUrl;
  const dest = `public/${slug}${imageDestExtension(downloadUrl)}`;
  lines.push('');
  lines.push('Suggested sequence (using result 1 above; pick another result by copying its values instead):');
  lines.push(`1. download_file { url: "${downloadUrl}", dest: "${dest}"${first.pageUrl ? `, source_url: "${first.pageUrl}"` : ''}${first.author ? `, author: "${first.author}"` : ''}${first.license ? `, license: "${first.license}"` : ''} }${usedThumbnail ? ` — the ~500px thumbnail on purpose (fast, plenty for a page); download the full-size image: URL from result 1 instead only when full resolution was asked for.` : ''}`);
  if (canSeeImages) {
    lines.push(`2. view_image { path: "${dest}" } — confirm it actually shows the subject.`);
    lines.push(`3. Reference ${dest} from the page (e.g. an <img> or import). Download first, never hotlink.`);
  } else {
    lines.push(`2. Reference ${dest} from the page (e.g. an <img> or import). Download first, never hotlink. (No view_image step: this model cannot see images.)`);
  }
  return lines.join('\n');
}

export function createSearchImagesTool(options: { fetchImpl?: ImageSearchFetchImpl; timeoutMs?: number } = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? SEARCH_IMAGES_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? defaultSearchFetch;
  return {
    name: 'search_images',
    description: [
      'Search for openly-licensed photos/images on Openverse and Wikimedia Commons (both free, no API key) and get structured results: title, source page, direct image URL, thumbnail, dimensions, license name + URL, author, attribution text, and whether commercial use is allowed. No image bytes come back — only metadata.',
      'Use it when the user wants a real picture (a person, place, product) in the project: search here, then download_file the chosen image into the workspace (passing its license/author/source_url so attribution is recorded). For the download, prefer the thumb URL (≈500px — much faster, plenty for a page) unless the user asked for full resolution, which uses the image URL. If the model in use cannot see images (view_image would refuse), skip view_image — never call it just because the flow mentions confirming. Results with unknown licenses are excluded unless include_unknown_license is set.',
      'NEVER hotlink a result URL into a generated page (download first), and NEVER substitute an AI-generated image for a real named person\'s photo — offer generation only as a labelled alternative.',
    ].join(' '),
    mutating: false,
    timeoutMs: timeoutMs + 5_000,
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "vladimir putin portrait" or "coffee shop interior"' },
        count: { type: 'number', description: `Results to return (default ${SEARCH_IMAGES_DEFAULT_COUNT}, max ${SEARCH_IMAGES_MAX_COUNT})` },
        source: { type: 'string', enum: ['all', 'openverse', 'wikimedia'], description: 'Which catalogue(s) to query (default all)' },
        commercial_only: { type: 'boolean', description: 'Only licences that allow commercial use (excludes CC-NC and unknown licences)' },
        include_unknown_license: { type: 'boolean', description: 'Also return results whose licence could not be read (flagged UNKNOWN — verify rights at the source page)' },
      },
      additionalProperties: false,
    },
    async execute(args, context): Promise<ToolResult> {
      const input = (args ?? {}) as { query?: unknown; count?: unknown; source?: unknown; commercial_only?: unknown; include_unknown_license?: unknown };
      if (typeof input.query !== 'string' || input.query.trim().length === 0) {
        return { call_id: '', status: 'error', output: 'search_images requires a non-empty string "query".', truncated: false, meta: { reason: 'invalid_arguments' } };
      }
      const query = input.query.trim();
      const count = typeof input.count === 'number' && Number.isFinite(input.count)
        ? Math.min(SEARCH_IMAGES_MAX_COUNT, Math.max(1, Math.floor(input.count)))
        : SEARCH_IMAGES_DEFAULT_COUNT;
      const source: ImageSearchSource = input.source === 'openverse' || input.source === 'wikimedia' ? input.source : 'all';
      const commercialOnly = input.commercial_only === true;
      const includeUnknownLicense = input.include_unknown_license === true;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const onHostAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onHostAbort, { once: true });

      type Outcome = { origin: ImageSearchOrigin; results?: ImageSearchResult[]; failure?: { reason: string; detail: string } };
      const runSource = async (origin: ImageSearchOrigin): Promise<Outcome> => {
        const url = origin === 'openverse'
          ? buildOpenverseQueryUrl(query, count, commercialOnly)
          : buildWikimediaQueryUrl(query, count);
        let response: FetchUrlResponse;
        try {
          response = await fetchImpl(url, {
            headers: { 'User-Agent': IMAGE_TOOLS_USER_AGENT, Accept: 'application/json' },
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted || (error as Error)?.name === 'AbortError' || (error as Error)?.name === 'TimeoutError') {
            return { origin, failure: { reason: 'timeout', detail: `${origin} did not answer within ${timeoutMs}ms` } };
          }
          return { origin, failure: { reason: 'fetch_failed', detail: `${origin} could not be reached: ${(error as Error)?.message ?? String(error)}` } };
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            origin,
            failure: {
              reason: response.status === 429 ? 'rate_limited' : 'http_status',
              detail: response.status === 429
                ? `${origin} rate-limited this anonymous client (HTTP 429) — wait, narrow the query, or query the other source`
                : `${origin} answered HTTP ${response.status}`,
            },
          };
        }
        try {
          const body: unknown = JSON.parse(await response.text());
          return { origin, results: origin === 'openverse' ? parseOpenverseResults(body) : parseWikimediaResults(body) };
        } catch {
          return { origin, failure: { reason: 'bad_response', detail: `${origin} returned a body that is not the expected JSON` } };
        }
      };

      try {
        const origins: ImageSearchOrigin[] = source === 'all' ? ['openverse', 'wikimedia'] : [source];
        const outcomes = await Promise.all(origins.map(runSource));
        const failures = outcomes.filter((outcome) => outcome.failure);
        const lists = outcomes.filter((outcome) => outcome.results).map((outcome) => outcome.results!);
        if (lists.length === 0) {
          const first = failures[0]!;
          return {
            call_id: '',
            status: 'error',
            output: `search_images: ${failures.map((failure) => failure.failure!.detail).join('; ')}.`,
            truncated: false,
            meta: { reason: first.failure!.reason, query },
          };
        }
        const merged = mergeImageResults(lists, { count, commercialOnly, includeUnknownLicense });
        const notes = failures.map((failure) => `Note: ${failure.failure!.detail}; results above come from the other source only.`);
        return {
          call_id: '',
          status: 'ok',
          output: renderSearchResults(query, merged, notes, { visionEnabled: context.visionEnabled }),
          truncated: false,
          meta: {
            query,
            count: merged.length,
            results: merged,
            ...(failures.length > 0 ? { partial_failures: failures.map((failure) => failure.origin) } : {}),
          },
        };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onHostAbort);
      }
    },
  };
}

export const searchImagesTool: ToolDefinition = createSearchImagesTool();

// ── image dimensions ────────────────────────────────────────────────────────

/** Read pixel dimensions from image headers (PNG IHDR, GIF descriptor, JPEG SOF, WebP chunks). */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 4) === 'GIF8') {
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && bytes.length >= 30) {
      return { width: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1, height: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1 };
    }
    return undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1]!;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (offset + 9 > bytes.length) return undefined;
        const height = bytes.readUInt16BE(offset + 5);
        const width = bytes.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : undefined;
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (segmentLength < 2) return undefined;
      offset += 2 + segmentLength;
    }
  }
  return undefined;
}

// ── download_file ───────────────────────────────────────────────────────────

const EXTENSIONS_BY_MIME: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
};

function contentTypeMismatch(contentType: string | null, mime: string): string | undefined {
  if (!contentType) return undefined;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type === mime || (type === 'image/jpg' && mime === 'image/jpeg')) return undefined;
  if (type.startsWith('image/') || type === 'text/html' || type === 'application/json' || type === 'text/plain') {
    return `the server said ${type} but the bytes are ${mime}`;
  }
  return undefined; // octet-stream and friends: the magic bytes decide
}

export function createDownloadFileTool(options: { fetchImpl?: DownloadFetchImpl; timeoutMs?: number; maxBytes?: number } = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_FILE_TIMEOUT_MS;
  const defaultMaxBytes = options.maxBytes ?? DOWNLOAD_FILE_DEFAULT_MAX_BYTES;
  const fetchImpl = options.fetchImpl ?? defaultDownloadFetch;
  return {
    name: 'download_file',
    description: [
      'Download ONE image (png/jpg/gif/webp, up to 10 MB) from a public http/https URL into a workspace-relative path, creating parent folders. This is how a photo found with search_images gets INTO the project — download it (the ≈500px thumb URL is the fast default; the full-size image URL only when full resolution was asked for), then, on a vision-capable model, view_image the saved file to confirm it matches before using it in a page; NEVER hotlink the remote URL into a page instead.',
      'Guards: private/loopback/link-local targets and redirects are refused; an existing destination is refused (pick another name); the bytes, the server Content-Type, and the destination extension must agree, so a wrong extension or an HTML error page is refused instead of saved.',
      'Pass license, author, and source_url from the search_images result and a <file>.attribution.txt sidecar is written next to the image; omit them and the result says attribution was not recorded. NEVER substitute an AI-generated image for a real named person\'s photo.',
    ].join(' '),
    mutating: true,
    timeoutMs: timeoutMs + 5_000,
    inputSchema: {
      type: 'object',
      required: ['url', 'path'],
      properties: {
        url: { type: 'string', description: 'Public http/https URL of the image file (typically a search_images result image URL)' },
        path: { type: 'string', description: 'Workspace-relative destination, extension matching the image, e.g. public/images/putin.jpg' },
        license: { type: 'string', description: 'Licence name from the search_images result (written to the attribution sidecar)' },
        author: { type: 'string', description: 'Author/creator from the search_images result (attribution sidecar)' },
        source_url: { type: 'string', description: 'Source page URL from the search_images result (attribution sidecar)' },
        max_bytes: { type: 'number', description: 'Byte cap override (default 10 MB; cannot exceed 10 MB)' },
      },
      additionalProperties: false,
    },
    async execute(args, context): Promise<ToolResult> {
      const input = (args ?? {}) as {
        url?: unknown; path?: unknown; license?: unknown; author?: unknown; source_url?: unknown; max_bytes?: unknown;
      };
      if (typeof input.url !== 'string' || input.url.trim().length === 0) {
        return { call_id: '', status: 'error', output: 'download_file requires a string "url".', truncated: false, meta: { reason: 'invalid_arguments' } };
      }
      if (typeof input.path !== 'string' || input.path.trim().length === 0) {
        return { call_id: '', status: 'error', output: 'download_file requires a workspace-relative string "path".', truncated: false, meta: { reason: 'invalid_arguments' } };
      }
      const requestedPath = input.path.trim();
      const target = validateFetchTarget(input.url.trim());
      if ('reason' in target) {
        return { call_id: '', status: 'denied', output: target.detail.replaceAll('fetch_url', 'download_file'), truncated: false, meta: { reason: target.reason } };
      }
      let absolute: string;
      try {
        absolute = await pathInWorkspace(context.workspaceRoot, requestedPath);
      } catch (error) {
        return { call_id: '', status: 'error', output: `download_file: ${String(error)} — the destination must stay inside the workspace.`, truncated: false, meta: { reason: 'path_escape', path: requestedPath } };
      }
      const existing = await stat(absolute).catch(() => undefined);
      if (existing) {
        return {
          call_id: '',
          status: 'error',
          output: `download_file: ${requestedPath} already exists — refusing to overwrite it. Pick a different destination name.`,
          truncated: false,
          meta: { reason: 'already_exists', path: requestedPath },
        };
      }
      const maxBytes = typeof input.max_bytes === 'number' && Number.isFinite(input.max_bytes) && input.max_bytes > 0
        ? Math.min(DOWNLOAD_FILE_DEFAULT_MAX_BYTES, Math.floor(input.max_bytes))
        : defaultMaxBytes;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const onHostAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onHostAbort, { once: true });

      const redirects: string[] = [];
      let tempPath: string | undefined;
      try {
        // Follow redirects manually, re-validating every hop (fetch_url posture).
        let current = target.url;
        let response: DownloadFetchResponse | undefined;
        for (let hop = 0; hop <= DOWNLOAD_FILE_MAX_REDIRECTS; hop++) {
          try {
            response = await fetchImpl(current.href, { redirect: 'manual', signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted || (error as Error)?.name === 'AbortError' || (error as Error)?.name === 'TimeoutError') {
              return { call_id: '', status: 'timeout', output: `download_file timed out after ${timeoutMs}ms fetching ${current.href}`, truncated: false, meta: { reason: 'timeout', url: input.url } };
            }
            return { call_id: '', status: 'error', output: `download_file could not fetch ${current.href}: ${(error as Error)?.message ?? String(error)}`, truncated: false, meta: { reason: 'fetch_failed', url: input.url } };
          }
          const location = response.headers.get('location');
          if ([301, 302, 303, 307, 308].includes(response.status) && location) {
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              return { call_id: '', status: 'error', output: `download_file: ${current.href} redirected to an invalid URL (${location})`, truncated: false, meta: { reason: 'invalid_redirect', url: input.url } };
            }
            const revalidated = validateFetchTarget(next.href);
            if ('reason' in revalidated) {
              return { call_id: '', status: 'denied', output: `download_file: ${current.href} redirected to a refused target — ${revalidated.detail.replaceAll('fetch_url', 'download_file')}`, truncated: false, meta: { reason: revalidated.reason, url: input.url, redirect_to: next.href } };
            }
            if (hop === DOWNLOAD_FILE_MAX_REDIRECTS) {
              return { call_id: '', status: 'error', output: `download_file: too many redirects (>${DOWNLOAD_FILE_MAX_REDIRECTS}) starting at ${input.url as string}`, truncated: false, meta: { reason: 'too_many_redirects', url: input.url, redirects } };
            }
            redirects.push(current.href);
            current = revalidated.url;
            continue;
          }
          break;
        }
        if (!response) {
          return { call_id: '', status: 'error', output: 'download_file: no response received', truncated: false, meta: { reason: 'fetch_failed', url: input.url } };
        }
        if (response.status < 200 || response.status >= 300) {
          return { call_id: '', status: 'error', output: `download_file: HTTP ${response.status} from ${current.href}`, truncated: false, meta: { reason: 'http_status', url: input.url, final_url: current.href, status: response.status } };
        }
        if (!response.body) {
          return { call_id: '', status: 'error', output: `download_file: ${current.href} returned no body`, truncated: false, meta: { reason: 'fetch_failed', url: input.url, final_url: current.href } };
        }

        // Stream to a temp file next to the destination, counting bytes as
        // they arrive: the cap aborts mid-stream instead of after the fact.
        await mkdir(dirname(absolute), { recursive: true });
        tempPath = join(dirname(absolute), `.download-${process.pid}-${Date.now()}.part`);
        const tempFile: string = tempPath;
        const hash = createHash('sha256');
        let received = 0;
        const headChunks: Buffer[] = [];
        let headBytes = 0;
        const sink = createWriteStream(tempFile);
        try {
          for await (const chunk of response.body) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += buffer.length;
            if (received > maxBytes) {
              controller.abort();
              sink.destroy();
              await rm(tempFile, { force: true });
              tempPath = undefined;
              return {
                call_id: '',
                status: 'error',
                output: `download_file: ${current.href} exceeds the ${maxBytes}-byte cap (aborted mid-download at ${received} bytes). Pick a smaller image or thumbnail from search_images.`,
                truncated: false,
                meta: { reason: 'too_large', url: input.url, final_url: current.href, bytes: received, max_bytes: maxBytes },
              };
            }
            hash.update(buffer);
            if (headBytes < 64 * 1024) {
              headChunks.push(buffer);
              headBytes += buffer.length;
            }
            await new Promise<void>((resolvePromise, rejectPromise) => {
              sink.write(buffer, (error) => (error ? rejectPromise(error) : resolvePromise()));
            });
          }
          await new Promise<void>((resolvePromise, rejectPromise) => {
            sink.end((error?: Error | null) => (error ? rejectPromise(error) : resolvePromise()));
          });
        } catch (error) {
          sink.destroy();
          await rm(tempFile, { force: true });
          tempPath = undefined;
          if (controller.signal.aborted) {
            return { call_id: '', status: 'timeout', output: `download_file timed out after ${timeoutMs}ms downloading ${current.href}`, truncated: false, meta: { reason: 'timeout', url: input.url, final_url: current.href } };
          }
          throw error;
        }
        if (received === 0) {
          await rm(tempFile, { force: true });
          tempPath = undefined;
          return { call_id: '', status: 'error', output: `download_file: ${current.href} returned an empty body`, truncated: false, meta: { reason: 'empty_body', url: input.url, final_url: current.href } };
        }

        // The bytes decide what this is; the server header and the file
        // extension must agree with them (an HTML error page is refused).
        const head = Buffer.concat(headChunks);
        const mime = sniffImageMime(head);
        if (!mime) {
          await rm(tempFile, { force: true });
          tempPath = undefined;
          return {
            call_id: '',
            status: 'error',
            output: `download_file: ${current.href} is not a supported image (png, jpg/jpeg, gif, webp) — its bytes do not match those formats, so nothing was saved. download_file carries images; use fetch_url for text/documentation.`,
            truncated: false,
            meta: { reason: 'unsupported_content', url: input.url, final_url: current.href, content_type: response.headers.get('content-type') ?? undefined },
          };
        }
        const mismatch = contentTypeMismatch(response.headers.get('content-type'), mime);
        if (mismatch) {
          await rm(tempFile, { force: true });
          tempPath = undefined;
          return {
            call_id: '',
            status: 'error',
            output: `download_file: ${mismatch} — refusing to save a mislabelled download.`,
            truncated: false,
            meta: { reason: 'content_mismatch', url: input.url, final_url: current.href, mime, content_type: response.headers.get('content-type') ?? undefined },
          };
        }
        const ext = extname(requestedPath).toLowerCase();
        const allowedExt = EXTENSIONS_BY_MIME[mime]!;
        if (!allowedExt.includes(ext)) {
          await rm(tempFile, { force: true });
          tempPath = undefined;
          return {
            call_id: '',
            status: 'error',
            output: `download_file: the image at ${current.href} is ${mime} but the destination "${requestedPath}" ends in "${ext || '(no extension)'}". Rename the destination to end in ${allowedExt.join(' or ')} and retry.`,
            truncated: false,
            meta: { reason: 'content_mismatch', url: input.url, final_url: current.href, mime, path: requestedPath },
          };
        }

        if (!tempPath) throw new Error('download_file: internal error — the temporary download file is missing');
        await rename(tempFile, absolute);
        tempPath = undefined;
        const dims = imageDimensions(head);
        const sha256 = hash.digest('hex');

        const attributionInput = {
          license: typeof input.license === 'string' && input.license.trim() ? input.license.trim() : undefined,
          author: typeof input.author === 'string' && input.author.trim() ? input.author.trim() : undefined,
          sourceUrl: typeof input.source_url === 'string' && input.source_url.trim() ? input.source_url.trim() : undefined,
        };
        let attributionPath: string | undefined;
        if (attributionInput.license || attributionInput.author || attributionInput.sourceUrl) {
          attributionPath = `${requestedPath}.attribution.txt`;
          const sidecarLines = [
            `Downloaded image: ${requestedPath} (${mime}, ${received} bytes${dims ? `, ${dims.width}x${dims.height}` : ''})`,
            `Downloaded from: ${current.href}`,
            ...(attributionInput.sourceUrl ? [`Source page: ${attributionInput.sourceUrl}`] : []),
            ...(attributionInput.author ? [`Author: ${attributionInput.author}`] : []),
            ...(attributionInput.license ? [`License: ${attributionInput.license} — attribution is required where the licence demands it; keep this file with the image`] : ['License: not recorded — verify reuse rights at the source before publishing']),
            `sha256: ${sha256}`,
          ];
          await writeFile(`${absolute}.attribution.txt`, sidecarLines.join('\n') + '\n', 'utf8');
        }

        const sizeNote = dims ? `${dims.width}x${dims.height}, ` : '';
        const attributionNote = attributionPath
          ? ` attribution recorded in ${attributionPath}.`
          : ' attribution not recorded (no licence/author/source passed) — if this image came from search_images, re-download with them to record attribution.';
        // Follow-up guidance is capability-aware: ordering view_image on
        // a text-only model buys a vision_unsupported rejection and a
        // wasted model round-trip (live cat run, call 4) — say plainly
        // how the file was verified instead.
        const confirmNote = context.visionEnabled === false
          ? ' The current model cannot view images, so no visual confirmation is possible — the file is verified by its bytes (format, dimensions, sha256). Do not call view_image on it.'
          : ` If it is meant for the user's page, view_image ${requestedPath} now to confirm it shows the right thing before wiring it in.`;
        return {
          call_id: '',
          status: 'ok',
          output: `downloaded ${requestedPath} (${mime}, ${sizeNote}${received} bytes) from ${current.href}.${attributionNote}${confirmNote}`,
          truncated: false,
          meta: {
            path: requestedPath,
            bytes: received,
            mime,
            sha256,
            final_url: current.href,
            ...(redirects.length > 0 ? { redirects } : {}),
            ...(dims ? { width: dims.width, height: dims.height } : {}),
            ...(attributionPath ? { attribution_file: attributionPath } : { attribution_recorded: false }),
          },
        };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onHostAbort);
        if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

export const downloadFileTool: ToolDefinition = createDownloadFileTool();

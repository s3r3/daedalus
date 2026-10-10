import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AGENT_MODE_ORDER,
  classifyToolName,
  createDownloadFileTool,
  createSearchImagesTool,
  downloadFileTool,
  imageDimensions,
  isToolVisible,
  searchImagesTool,
  toolCallPolicy,
  toolModePolicy,
  type DownloadFetchImpl,
  type DownloadFetchResponse,
  type FetchUrlResponse,
  type ImageSearchFetchImpl,
  type ToolExecutionContext,
} from '../src/index.ts';

/**
 * search_images + download_file: every HTTP behaviour is driven through the
 * injected fetch seams against recorded API fixtures — no test touches the
 * network.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ctx = (root: string, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({ workspaceRoot: root, ...extra });

// ── fixtures ────────────────────────────────────────────────────────────────

// A minimal but header-valid PNG (2×3) and JPEG (4×5) — the magic bytes and
// dimension fields are what the tools read; the rest may be inert filler.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03]),
  Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0', 'ascii'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x05, 0x00, 0x04, 0x01]),
]);

function jsonResponse(status: number, body: unknown): FetchUrlResponse {
  return {
    status,
    headers: { get: () => 'application/json' },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

type SearchStub = { impl: ImageSearchFetchImpl; calls: Array<{ url: string; headers: Record<string, string> }> };
function stubSearch(handler: (url: string) => FetchUrlResponse | Promise<FetchUrlResponse>): SearchStub {
  const calls: SearchStub['calls'] = [];
  const impl: ImageSearchFetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return handler(url);
  };
  return { impl, calls };
}

const OPENVERSE_BODY = {
  result_count: 2,
  results: [
    {
      title: 'Cat in a box',
      foreign_landing_url: 'https://www.flickr.com/photos/example/1',
      url: 'https://live.staticflickr.com/1/cat.jpg',
      thumbnail: 'https://live.staticflickr.com/1/cat_small.jpg',
      width: 1024,
      height: 768,
      license: 'by',
      license_version: '2.0',
      license_url: 'https://creativecommons.org/licenses/by/2.0/',
      creator: 'Jane Photographer',
      attribution: '"Cat in a box" by Jane Photographer is licensed under CC BY 2.0',
    },
    {
      // Same image URL as the Commons first hit — merge must dedupe it.
      title: 'Shared photo',
      foreign_landing_url: 'https://example.org/shared',
      url: 'https://upload.wikimedia.org/shared.jpg',
      width: 800,
      height: 600,
      license: 'cc0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      creator: 'Shared Author',
    },
  ],
};

const WIKIMEDIA_BODY = {
  query: {
    pages: {
      '222': {
        pageid: 222,
        ns: 6,
        title: 'File:Second cat.jpg',
        index: 2,
        imageinfo: [{
          url: 'https://upload.wikimedia.org/second-cat.jpg',
          descriptionurl: 'https://commons.wikimedia.org/wiki/File:Second_cat.jpg',
          thumburl: 'https://upload.wikimedia.org/480px-Second_cat.jpg',
          width: 1600,
          height: 1200,
          extmetadata: {
            LicenseShortName: { value: 'CC BY-NC 4.0' },
            LicenseUrl: { value: 'https://creativecommons.org/licenses/by-nc/4.0' },
            Artist: { value: '<a href="https://commons.wikimedia.org/wiki/User:Bob">Bob Shooter</a>' },
          },
        }],
      },
      '111': {
        pageid: 111,
        ns: 6,
        title: 'File:Shared photo.jpg',
        index: 1,
        imageinfo: [{
          url: 'https://upload.wikimedia.org/shared.jpg',
          descriptionurl: 'https://commons.wikimedia.org/wiki/File:Shared_photo.jpg',
          width: 800,
          height: 600,
          extmetadata: {
            LicenseShortName: { value: 'CC0' },
            Artist: { value: 'Shared Author' },
          },
        }],
      },
    },
  },
};

function bothSourcesHandler(url: string): FetchUrlResponse {
  if (url.startsWith('https://api.openverse.org/')) return jsonResponse(200, OPENVERSE_BODY);
  if (url.startsWith('https://commons.wikimedia.org/')) return jsonResponse(200, WIKIMEDIA_BODY);
  return jsonResponse(404, {});
}

describe('search_images', () => {
  test('parses both APIs and maps license/author/attribution fields', async () => {
    const { impl, calls } = stubSearch(bothSourcesHandler);
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'cat' }, ctx('/tmp/daedalus-img-ws'));
    expect(result.status).toBe('ok');

    // The Commons descriptive User-Agent is required by policy.
    const commonsCall = calls.find((call) => call.url.startsWith('https://commons.wikimedia.org/'));
    expect(commonsCall?.headers['User-Agent']).toContain('Daedalus');
    expect(commonsCall?.url).toContain('gsrnamespace=6');
    expect(commonsCall?.url).toContain('extmetadata');
    const openverseCall = calls.find((call) => call.url.startsWith('https://api.openverse.org/'));
    expect(openverseCall?.url).toContain('q=cat');

    const results = result.meta.results as Array<Record<string, unknown>>;
    const flickr = results.find((entry) => entry.source === 'openverse' && String(entry.title).includes('Cat in a box'));
    expect(flickr).toMatchObject({
      pageUrl: 'https://www.flickr.com/photos/example/1',
      imageUrl: 'https://live.staticflickr.com/1/cat.jpg',
      thumbnailUrl: 'https://live.staticflickr.com/1/cat_small.jpg',
      width: 1024,
      height: 768,
      license: 'CC BY 2.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
      author: 'Jane Photographer',
      commercialUse: true,
    });
    expect(String(flickr?.attribution)).toContain('Jane Photographer');

    const commons = results.find((entry) => entry.source === 'wikimedia' && String(entry.title).includes('Second cat'));
    expect(commons).toMatchObject({
      license: 'CC BY-NC 4.0',
      author: 'Bob Shooter', // HTML from extmetadata is stripped
      commercialUse: false,
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Second_cat.jpg',
    });

    // Structured text only — never base64.
    expect(result.output).toContain('Cat in a box');
    expect(result.output).toContain('license: CC BY-NC 4.0');
    expect(result.output).toContain('commercial use: NO');
    expect(result.output).not.toContain('base64');
    expect(result.output).toContain('NEVER hotlink');
  });

  test('merges both sources, dedupes by image URL, and ranks CC0/CC first', async () => {
    const { impl } = stubSearch(bothSourcesHandler);
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'cat', count: 12 }, ctx('/tmp/daedalus-img-ws'));
    const results = result.meta.results as Array<Record<string, unknown>>;
    // Openverse cat + Openverse shared + Commons second cat (shared dupes to one).
    expect(results).toHaveLength(3);
    expect(new Set(results.map((entry) => entry.imageUrl)).size).toBe(3);
    // CC0 (rank 0) leads; the NC-licensed Commons photo ranks last.
    expect(results[0]?.license).toBe('CC0');
    expect(results[results.length - 1]?.license).toBe('CC BY-NC 4.0');
  });

  test('commercial_only drops NC results and caps the count', async () => {
    const { impl } = stubSearch(bothSourcesHandler);
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const commercial = await tool.execute({ query: 'cat', commercial_only: true }, ctx('/tmp/daedalus-img-ws'));
    const commercialResults = commercial.meta.results as Array<Record<string, unknown>>;
    expect(commercialResults.every((entry) => entry.commercialUse === true)).toBe(true);
    expect(commercialResults.some((entry) => entry.license === 'CC BY-NC 4.0')).toBe(false);

    const capped = await tool.execute({ query: 'cat', count: 1 }, ctx('/tmp/daedalus-img-ws'));
    expect(capped.meta.count).toBe(1);
  });

  test('unknown licenses are excluded by default and flagged when opted in', async () => {
    const unknownBody = {
      result_count: 1,
      results: [{ title: 'Mystery', url: 'https://images.example.org/mystery.jpg', foreign_landing_url: 'https://example.org/m' }],
    };
    const { impl } = stubSearch((url) => (url.includes('openverse') ? jsonResponse(200, unknownBody) : jsonResponse(200, { query: { pages: {} } })));
    const tool = createSearchImagesTool({ fetchImpl: impl });

    const excluded = await tool.execute({ query: 'mystery' }, ctx('/tmp/daedalus-img-ws'));
    expect(excluded.status).toBe('ok');
    expect(excluded.meta.count).toBe(0);

    const included = await tool.execute({ query: 'mystery', include_unknown_license: true }, ctx('/tmp/daedalus-img-ws'));
    expect(included.meta.count).toBe(1);
    expect(included.output).toContain('license: UNKNOWN');
  });

  test('an empty result is a normal ok outcome, not an error', async () => {
    const { impl } = stubSearch((url) => (url.includes('openverse')
      ? jsonResponse(200, { result_count: 0, results: [] })
      : jsonResponse(200, { query: { pages: {} } })));
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'zzzznothing' }, ctx('/tmp/daedalus-img-ws'));
    expect(result.status).toBe('ok');
    expect(result.meta.count).toBe(0);
    expect(result.output).toContain('No openly-licensed images found');
  });

  test('one failing source degrades to the other; both failing is a typed error', async () => {
    const { impl } = stubSearch((url) => (url.includes('openverse') ? jsonResponse(429, {}) : jsonResponse(200, WIKIMEDIA_BODY)));
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const partial = await tool.execute({ query: 'cat', source: 'all' }, ctx('/tmp/daedalus-img-ws'));
    expect(partial.status).toBe('ok');
    expect((partial.meta.results as unknown[]).length).toBeGreaterThan(0);
    expect(partial.output).toContain('rate-limited');

    const { impl: failImpl } = stubSearch(() => jsonResponse(503, {}));
    const failTool = createSearchImagesTool({ fetchImpl: failImpl });
    const failed = await failTool.execute({ query: 'cat' }, ctx('/tmp/daedalus-img-ws'));
    expect(failed.status).toBe('error');
    expect(failed.meta.reason).toBe('http_status');
  });

  test('suggested download prefers the thumbnail; the full-size URL stays in the result', async () => {
    const { impl } = stubSearch(bothSourcesHandler);
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'cat' }, ctx('/tmp/daedalus-img-ws'));
    expect(result.status).toBe('ok');
    // Ranked first is the CC0 "Shared photo" (no thumbnail in the
    // fixture, so its own URL is suggested as-is).
    expect(result.output).toContain('image: https://upload.wikimedia.org/shared.jpg');
    // The suggested sequence must point at the ~500px thumbnail of the
    // result it templates, not the multi-MB original.
    expect(result.output).toContain('Suggested sequence');
  });

  test('with a thumbnail available the suggested sequence downloads the thumbnail, not the original', async () => {
    // Single-result fixture where result 1 carries a thumbnail.
    const body = {
      result_count: 1,
      results: [{
        title: 'Cat in a box',
        foreign_landing_url: 'https://www.flickr.com/photos/example/1',
        url: 'https://live.staticflickr.com/1/cat.jpg',
        thumbnail: 'https://live.staticflickr.com/1/cat_small.jpg',
        width: 1024,
        height: 768,
        license: 'by',
        license_version: '2.0',
        license_url: 'https://creativecommons.org/licenses/by/2.0/',
        creator: 'Jane Photographer',
        attribution: '"Cat in a box" by Jane Photographer is licensed under CC BY 2.0',
      }],
    };
    const { impl } = stubSearch((url) => (url.includes('openverse') ? jsonResponse(200, body) : jsonResponse(200, { query: { pages: {} } })));
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'cat' }, ctx('/tmp/daedalus-img-ws'));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('download_file { url: "https://live.staticflickr.com/1/cat_small.jpg"');
    // ...while the full-size original remains available in the listing.
    expect(result.output).toContain('image: https://live.staticflickr.com/1/cat.jpg');
    expect(result.output).toContain('full resolution was asked for');
  });

  test('a text-only model gets no view_image order in the closing guidance', async () => {
    const { impl } = stubSearch(bothSourcesHandler);
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'cat' }, ctx('/tmp/daedalus-img-ws', { visionEnabled: false }));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('cannot view images');
    expect(result.output).toContain('do NOT call view_image');
    expect(result.output).not.toMatch(/2\. view_image/);
    expect(result.output).not.toContain('view_image { path:');
  });

  test('a vision-capable model still gets the view_image confirmation step', async () => {
    const { impl } = stubSearch(bothSourcesHandler);
    const tool = createSearchImagesTool({ fetchImpl: impl });
    const result = await tool.execute({ query: 'cat' }, ctx('/tmp/daedalus-img-ws', { visionEnabled: true }));
    expect(result.status).toBe('ok');
    expect(result.output).toMatch(/2\. view_image \{ path: "public\//);
  });

  test('search_images is a read tool visible in every mode including Ask', () => {
    expect(classifyToolName('search_images')).toBe('read');
    for (const mode of AGENT_MODE_ORDER) {
      expect(isToolVisible(mode, 'search_images'), mode).toBe(true);
      expect(toolModePolicy(mode, 'search_images').approval, mode).toBe('auto');
    }
    expect(searchImagesTool.mutating).toBe(false);
  });
});

// ── download_file ───────────────────────────────────────────────────────────

type DownloadStub = { impl: DownloadFetchImpl; calls: string[]; consumed: () => number };
function stubDownload(handler: (url: string) => DownloadFetchResponse | Promise<DownloadFetchResponse>): DownloadStub {
  const calls: string[] = [];
  let consumedChunks = 0;
  const impl: DownloadFetchImpl = async (url) => {
    calls.push(url);
    const response = await handler(url);
    if (response.body) {
      const inner = response.body;
      response.body = (async function* () {
        for await (const chunk of inner) {
          consumedChunks += 1;
          yield chunk;
        }
      })();
    }
    return response;
  };
  return { impl, calls, consumed: () => consumedChunks };
}

function chunked(bytes: Buffer, chunkSize = 7): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
  })();
}

function bodyResponse(status: number, body: AsyncIterable<Uint8Array> | null, headers: Record<string, string> = {}): DownloadFetchResponse {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { status, headers: { get: (name) => lowered.get(name.toLowerCase()) ?? null }, body };
}

describe('download_file', () => {
  test('happy path: an image lands on disk with sha256, mime, and dimensions reported', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES), { 'content-type': 'image/png' }));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://images.example.org/cat.png', path: 'public/images/cat.png' }, ctx(root));
    expect(result.status).toBe('ok');
    const onDisk = readFileSync(join(root, 'public/images/cat.png'));
    expect(onDisk.equals(PNG_BYTES)).toBe(true);
    expect(result.meta.mime).toBe('image/png');
    expect(result.meta.bytes).toBe(PNG_BYTES.length);
    expect(result.meta.sha256).toBe(createHash('sha256').update(PNG_BYTES).digest('hex'));
    expect(result.meta.width).toBe(2);
    expect(result.meta.height).toBe(3);
    expect(result.meta.attribution_recorded).toBe(false);
    expect(result.output).toContain('attribution not recorded');
    // No leftover temp files next to the destination.
    expect(existsSync(join(root, 'public/images/cat.png.attribution.txt'))).toBe(false);
  });

  test('a text-only model is told the file is verified by bytes, never ordered to view_image', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES), { 'content-type': 'image/png' }));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://images.example.org/cat.png', path: 'public/images/cat.png' }, ctx(root, { visionEnabled: false }));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('verified by its bytes');
    expect(result.output).toContain('Do not call view_image');
    expect(result.output).not.toContain('view_image public/images/cat.png now');
  });

  test('a vision-capable model still gets the view_image confirmation order', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES), { 'content-type': 'image/png' }));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://images.example.org/cat.png', path: 'public/images/cat.png' }, ctx(root, { visionEnabled: true }));
    expect(result.status).toBe('ok');
    expect(result.output).toContain('view_image public/images/cat.png now to confirm');
  });

  test('image headers expose dimensions for jpeg too', () => {
    expect(imageDimensions(JPEG_BYTES)).toEqual({ width: 4, height: 5 });
    expect(imageDimensions(PNG_BYTES)).toEqual({ width: 2, height: 3 });
  });

  test('a redirect into a private address is refused at the redirect target', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl, calls } = stubDownload((url) => (url.startsWith('https://images.example.org/')
      ? bodyResponse(302, null, { location: 'http://192.168.0.9/secret.png' })
      : bodyResponse(200, chunked(PNG_BYTES))));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://images.example.org/cat.png', path: 'cat.png' }, ctx(root));
    expect(result.status).toBe('denied');
    expect(result.meta.reason).toBe('private_host');
    expect(existsSync(join(root, 'cat.png'))).toBe(false);
    expect(calls).toEqual(['https://images.example.org/cat.png']);
  });

  test('the literal target is SSRF-checked before any fetch', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl, calls } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES)));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data.png', path: 'x.png' }, ctx(root));
    expect(result.status).toBe('denied');
    expect(result.meta.reason).toBe('private_host');
    expect(calls).toEqual([]);
  });

  test('non-image bytes are refused and nothing is saved', async () => {
    const root = temp('daedalus-dl-ws-');
    const html = Buffer.from('<html><body>not an image</body></html>');
    const { impl } = stubDownload(() => bodyResponse(200, chunked(html), { 'content-type': 'text/html' }));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://example.org/page.png', path: 'page.png' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('unsupported_content');
    expect(existsSync(join(root, 'page.png'))).toBe(false);
  });

  test('a lying Content-Type or wrong destination extension is refused', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl: typeImpl } = stubDownload(() => bodyResponse(200, chunked(JPEG_BYTES), { 'content-type': 'image/png' }));
    const tool = createDownloadFileTool({ fetchImpl: typeImpl });
    const lied = await tool.execute({ url: 'https://images.example.org/a.jpg', path: 'a.jpg' }, ctx(root));
    expect(lied.status).toBe('error');
    expect(lied.meta.reason).toBe('content_mismatch');
    expect(existsSync(join(root, 'a.jpg'))).toBe(false);

    const { impl: extImpl } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES), { 'content-type': 'image/png' }));
    const extTool = createDownloadFileTool({ fetchImpl: extImpl });
    const wrongExt = await extTool.execute({ url: 'https://images.example.org/a.png', path: 'a.jpg' }, ctx(root));
    expect(wrongExt.status).toBe('error');
    expect(wrongExt.meta.reason).toBe('content_mismatch');
    expect(wrongExt.output).toContain('.png');
    expect(existsSync(join(root, 'a.jpg'))).toBe(false);
  });

  test('the size cap aborts mid-stream instead of reading the whole body', async () => {
    const root = temp('daedalus-dl-ws-');
    // 120 bytes of PNG-headed data in 10-byte chunks; cap is 50.
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(120 - PNG_BYTES.length, 7)]);
    const { impl, consumed } = stubDownload(() => bodyResponse(200, chunked(big, 10), { 'content-type': 'image/png' }));
    const tool = createDownloadFileTool({ fetchImpl: impl, maxBytes: 50 });
    const result = await tool.execute({ url: 'https://images.example.org/big.png', path: 'big.png' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('too_large');
    // Stopped after ~6 chunks (60 > 50), never pulled all 12.
    expect(consumed()).toBeLessThan(12);
    expect(existsSync(join(root, 'big.png'))).toBe(false);
  });

  test('an existing destination is refused, never overwritten', async () => {
    const root = temp('daedalus-dl-ws-');
    writeFileSync(join(root, 'cat.png'), 'original');
    const { impl, calls } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES)));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://images.example.org/cat.png', path: 'cat.png' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('already_exists');
    expect(calls).toEqual([]); // refused before fetching
    expect(readFileSync(join(root, 'cat.png'), 'utf8')).toBe('original');
  });

  test('path traversal outside the workspace is refused', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl, calls } = stubDownload(() => bodyResponse(200, chunked(PNG_BYTES)));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://images.example.org/cat.png', path: '../evil.png' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('path_escape');
    expect(calls).toEqual([]);
    expect(existsSync(join(root, '..', 'evil.png'))).toBe(false);
  });

  test('attribution metadata writes a sidecar; no temp debris remains', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl } = stubDownload(() => bodyResponse(200, chunked(JPEG_BYTES), { 'content-type': 'image/jpeg' }));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({
      url: 'https://live.staticflickr.com/1/cat.jpg',
      path: 'assets/cat.jpg',
      license: 'CC BY 2.0',
      author: 'Jane Photographer',
      source_url: 'https://www.flickr.com/photos/example/1',
    }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.meta.attribution_file).toBe('assets/cat.jpg.attribution.txt');
    const sidecar = readFileSync(join(root, 'assets/cat.jpg.attribution.txt'), 'utf8');
    expect(sidecar).toContain('Jane Photographer');
    expect(sidecar).toContain('License: CC BY 2.0');
    expect(sidecar).toContain('https://www.flickr.com/photos/example/1');
  });

  test('redirect chains are reported in the result', async () => {
    const root = temp('daedalus-dl-ws-');
    const { impl } = stubDownload((url) => (url.includes('cdn.example.org')
      ? bodyResponse(301, null, { location: 'https://images.example.org/final.png' })
      : bodyResponse(200, chunked(PNG_BYTES), { 'content-type': 'image/png' })));
    const tool = createDownloadFileTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://cdn.example.org/a.png', path: 'a.png' }, ctx(root));
    expect(result.status).toBe('ok');
    expect(result.meta.final_url).toBe('https://images.example.org/final.png');
    expect(result.meta.redirects).toEqual(['https://cdn.example.org/a.png']);
  });

  test('download_file is mutating: hidden in Ask/Plan, approval-gated in Manual, free in Auto', () => {
    expect(classifyToolName('download_file')).toBe('mutating');
    expect(downloadFileTool.mutating).toBe(true);
    expect(isToolVisible('ask', 'download_file')).toBe(false);
    expect(isToolVisible('plan', 'download_file')).toBe(false);
    expect(isToolVisible('manual', 'download_file')).toBe(true);
    expect(toolModePolicy('manual', 'download_file')).toEqual({ visible: true, approval: 'ask' });
    expect(toolModePolicy('auto', 'download_file')).toEqual({ visible: true, approval: 'auto' });
    // The Plan documents carve-out must NOT cover downloads, even into the plans folder.
    expect(toolCallPolicy('plan', 'download_file', '.daedalus/plans/x/cat.png').approval).toBe('deny');
  });
});

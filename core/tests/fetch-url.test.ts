import { describe, expect, test } from 'vitest';
import {
  AGENT_MODE_ORDER,
  FETCH_URL_MAX_CHARS,
  classifyToolName,
  createDefaultRegistry,
  createFetchUrlTool,
  htmlToText,
  isBlockedFetchHost,
  isToolVisible,
  validateFetchTarget,
  type FetchUrlImpl,
  type FetchUrlResponse,
  type ToolExecutionContext,
} from '../src/index.ts';

/**
 * fetch_url tests: every HTTP behaviour is driven through the injected
 * fetchImpl seam — no test touches the network.
 */

const CTX: ToolExecutionContext = { workspaceRoot: '/tmp/daedalus-fetch-ws' };

function stubResponse(status: number, body = '', headers: Record<string, string> = {}): FetchUrlResponse {
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

function stubFetch(handler: (url: string) => FetchUrlResponse | Promise<FetchUrlResponse>): { impl: FetchUrlImpl; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchUrlImpl = async (url) => {
    calls.push(url);
    return handler(url);
  };
  return { impl, calls };
}

describe('htmlToText extraction', () => {
  test('strips scripts/styles/tags, breaks blocks into lines, decodes entities', () => {
    const html = [
      '<html><head><style>body { color: red; }</style><script>const x = "</p>"; steal()</script></head>',
      '<body><h1>Install &amp; Go</h1><p>Run <code>npm&nbsp;install</code> first.</p>',
      '<ul><li>Node &#8805; 20</li><li>It&#39;s &quot;fast&quot;</li></ul>',
      '<p>Second&nbsp;paragraph</p></body></html>',
    ].join('\n');
    const text = htmlToText(html);
    expect(text).toContain('Install & Go');
    expect(text).toContain('Run npm install first.');
    expect(text).toContain('- Node ≥ 20');
    expect(text).toContain('It\'s "fast"');
    expect(text).toContain('Second paragraph');
    expect(text).not.toContain('steal()');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('<');
  });

  test('collapses runs of blank lines to one paragraph break', () => {
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });
});

describe('fetch_url SSRF guard', () => {
  test('blocks literal private/loopback/link-local hosts', () => {
    for (const host of [
      '127.0.0.1', '127.0.1', '127.1', '10.0.0.5', '172.16.0.9', '172.31.255.1',
      '192.168.1.10', '169.254.169.254', 'localhost', 'api.localhost', '[::1]',
      '0x7f.1', '2130706433', '0.0.0',
    ]) {
      expect(isBlockedFetchHost(host), host).toBe(true);
    }
  });

  test('allows public hosts (including 172.15.x, just outside the private range)', () => {
    for (const host of ['example.com', 'nextjs.org', '172.15.0.1', '172.32.0.1', '8.8.8.8', 'docs.python.org']) {
      expect(isBlockedFetchHost(host), host).toBe(false);
    }
  });

  test('the tool refuses private targets and bad schemes without fetching', async () => {
    const { impl, calls } = stubFetch(() => stubResponse(200, 'secret'));
    const tool = createFetchUrlTool({ fetchImpl: impl });

    const loopback = await tool.execute({ url: 'http://127.0.0.1:8080/admin' }, CTX);
    expect(loopback.status).toBe('denied');
    expect(loopback.meta.reason).toBe('private_host');

    const metadata = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, CTX);
    expect(metadata.status).toBe('denied');

    const fileScheme = await tool.execute({ url: 'file:///etc/passwd' }, CTX);
    expect(fileScheme.status).toBe('denied');
    expect(fileScheme.meta.reason).toBe('unsupported_scheme');

    const garbage = await tool.execute({ url: 'not a url' }, CTX);
    expect(garbage.status).toBe('denied');
    expect(garbage.meta.reason).toBe('invalid_url');

    expect(calls).toEqual([]);
  });

  test('a redirect into a private address is refused at the redirect target', async () => {
    const { impl, calls } = stubFetch((url) => (
      url.startsWith('https://docs.example.com/')
        ? stubResponse(302, '', { location: 'http://169.254.169.254/latest/meta-data/' })
        : stubResponse(200, 'secret')
    ));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/start' }, CTX);
    expect(result.status).toBe('denied');
    expect(result.meta.reason).toBe('private_host');
    expect(result.output).toContain('redirected to a refused target');
    expect(calls).toEqual(['https://docs.example.com/start']);
  });
});

describe('fetch_url fetching', () => {
  test('returns extracted text for an HTML docs page', async () => {
    const { impl } = stubFetch(() => stubResponse(
      200,
      '<html><body><h1>Getting started</h1><script>track()</script><p>Install with <b>pip install django</b>.</p></body></html>',
      { 'content-type': 'text/html; charset=utf-8' },
    ));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/start' }, CTX);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('Fetched https://docs.example.com/start (HTTP 200');
    expect(result.output).toContain('Getting started');
    expect(result.output).toContain('Install with pip install django.');
    expect(result.output).not.toContain('track()');
    expect(result.meta.final_url).toBe('https://docs.example.com/start');
  });

  test('passes plain text and markdown through verbatim', async () => {
    const { impl } = stubFetch(() => stubResponse(200, '# Install\n\nRun `make docs` & read <carefully>.\n', { 'content-type': 'text/markdown' }));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/guide.md' }, CTX);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('# Install\n\nRun `make docs` & read <carefully>.');
  });

  test('caps long pages at 12,000 chars with an explicit truncation note', async () => {
    const { impl } = stubFetch(() => stubResponse(200, 'a'.repeat(13_500), { 'content-type': 'text/plain' }));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/huge' }, CTX);
    expect(result.status).toBe('ok');
    expect(result.truncated).toBe(true);
    expect(result.output).toContain(`…[truncated at ${FETCH_URL_MAX_CHARS} of 13500 chars`);
    expect(result.meta.output_truncated).toBe(true);
    expect(result.meta.chars).toBe(13_500);
  });

  test('follows up to 3 redirects and reports the final URL', async () => {
    const pages: Record<string, FetchUrlResponse> = {
      'https://docs.example.com/a': stubResponse(301, '', { location: '/b' }),
      'https://docs.example.com/b': stubResponse(302, '', { location: 'https://docs.example.com/c' }),
      'https://docs.example.com/c': stubResponse(200, 'final docs', { 'content-type': 'text/plain' }),
    };
    const { impl, calls } = stubFetch((url) => {
      const page = pages[url];
      if (!page) throw new Error(`unexpected fetch ${url}`);
      return page;
    });
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/a' }, CTX);
    expect(result.status).toBe('ok');
    expect(result.output).toContain('final docs');
    expect(result.output).toContain('redirected from https://docs.example.com/a');
    expect(result.meta.final_url).toBe('https://docs.example.com/c');
    expect(calls).toHaveLength(3);
  });

  test('a 4th redirect is refused as too many redirects', async () => {
    const { impl, calls } = stubFetch(() => stubResponse(301, '', { location: 'https://docs.example.com/next' }));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/next' }, CTX);
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('too_many_redirects');
    expect(calls.length).toBe(4); // initial + 3 followed hops
  });

  test('HTTP errors are typed errors naming the status', async () => {
    const { impl } = stubFetch(() => stubResponse(404, 'nope', { 'content-type': 'text/html' }));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/missing' }, CTX);
    expect(result.status).toBe('error');
    expect(result.output).toContain('HTTP 404');
    expect(result.meta.reason).toBe('http_status');
    expect(result.meta.status).toBe(404);
  });

  test('binary content types are refused as unreadable', async () => {
    const { impl } = stubFetch(() => stubResponse(200, 'binary', { 'content-type': 'application/octet-stream' }));
    const tool = createFetchUrlTool({ fetchImpl: impl });
    const result = await tool.execute({ url: 'https://docs.example.com/manual.pdf' }, CTX);
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('unreadable_content_type');
  });

  test('a hung fetch surfaces as a typed timeout, quickly', async () => {
    const hanging: FetchUrlImpl = (_url, init) => new Promise<FetchUrlResponse>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const tool = createFetchUrlTool({ fetchImpl: hanging, timeoutMs: 25 });
    const result = await tool.execute({ url: 'https://docs.example.com/slow' }, CTX);
    expect(result.status).toBe('timeout');
    expect(result.meta.reason).toBe('timeout');
    expect(result.output).toContain('--help');
  });

  test('a network failure is an error result, not a throw', async () => {
    const failing: FetchUrlImpl = async () => { throw new Error('getaddrinfo ENOTFOUND docs.example.com'); };
    const tool = createFetchUrlTool({ fetchImpl: failing });
    const result = await tool.execute({ url: 'https://docs.example.com/' }, CTX);
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('fetch_failed');
    expect(result.output).toContain('ENOTFOUND');
  });

  test('validateFetchTarget round-trips a public URL', () => {
    const ok = validateFetchTarget('https://nextjs.org/docs/getting-started');
    expect('url' in ok && ok.url.hostname).toBe('nextjs.org');
  });
});

describe('fetch_url availability', () => {
  test('registered by default, classified read, visible in every mode (Ask included)', () => {
    const names = createDefaultRegistry().list().map((tool) => tool.name);
    expect(names).toContain('fetch_url');
    expect(classifyToolName('fetch_url')).toBe('read');
    for (const mode of [...AGENT_MODE_ORDER, 'orchestrator' as const]) {
      expect(isToolVisible(mode, 'fetch_url'), mode).toBe(true);
    }
  });

  test('the default instance has the read-only static shape', () => {
    const tool = createDefaultRegistry().get('fetch_url');
    expect(tool.mutating).toBe(false);
    expect(tool.inputSchema).toMatchObject({ required: ['url'] });
  });
});

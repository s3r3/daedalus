/**
 * DokumenEngine's own web tools (design decision 7): `web_search` and
 * `fetch_url` as deliberate domain tools — every fetch is recorded by
 * the caller (audit log + citation), so Susun's claims can be traced
 * back to what was actually read. Shell/curl/run_command are NEVER
 * available in this domain; the structural ban lives here, not in a
 * prompt. Backend mirrors the house pattern: Brave/Tavily when their
 * key env var is set, else keyless DuckDuckGo HTML.
 */

export type WebFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

export type SearchHit = { title: string; url: string; snippet: string };

const TIMEOUT_MS = 15_000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let m = snippetPattern.exec(html); m; m = snippetPattern.exec(html)) snippets.push(stripHtml(m[1] ?? ''));
  let i = 0;
  for (let m = linkPattern.exec(html); m; m = linkPattern.exec(html)) {
    let href = m[1] ?? '';
    try {
      const parsed = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
      href = parsed.searchParams.get('uddg') ?? parsed.href;
    } catch {
      /* keep raw href */
    }
    hits.push({ title: stripHtml(m[2] ?? ''), url: href, snippet: snippets[i] ?? '' });
    i++;
  }
  return hits;
}

export class DokumenWebTools {
  readonly #fetch: WebFetch;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: { fetchImpl?: WebFetch; env?: NodeJS.ProcessEnv } = {}) {
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#env = options.env ?? process.env;
  }

  async webSearch(query: string, count = 5, signal?: AbortSignal): Promise<SearchHit[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.#env.DAEDALUS_TAVILY_API_KEY) {
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: this.#env.DAEDALUS_TAVILY_API_KEY, query, max_results: count }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Tavily search HTTP ${response.status}`);
        const body = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (body.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
      }
      const response = await this.#fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Daedalus-Dokumen/1.0' },
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`DuckDuckGo search HTTP ${response.status}`);
      return parseDuckDuckGo(await response.text()).slice(0, count);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Read a page's readable text (capped); the caller records the fetch as a citation source. */
  async fetchUrl(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.#fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Daedalus-Dokumen/1.0' },
        signal: controller.signal,
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`fetch ${url} → HTTP ${response.status}`);
      const html = await response.text();
      const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || url;
      return { url, title, text: stripHtml(html).slice(0, 24_000) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

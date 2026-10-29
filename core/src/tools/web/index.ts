import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ToolDefinition } from '../registry.ts';
import type { ToolResult } from '../../contracts.ts';

/**
 * fetch_url: read a public web page (install docs, API references) and
 * return its readable text — the "look it up instead of guessing" tool the
 * scaffold playbook points at for frameworks without a verified recipe.
 * Modelled on Claude Code's WebFetch / Cline's fetch_web_content: a local
 * fetch with HTML stripped to text. There is deliberately NO search
 * engine behind it (no API key in Daedalus): the model supplies the exact
 * docs URL from its own knowledge, and a failed fetch falls back to
 * probing `<generator> --help`, never to invented install steps.
 *
 * Safety: http/https only; private/loopback/link-local/CGNAT hosts are
 * refused — including IPv6 disguises (mapped/compatible/NAT64/6to4) and
 * internal names — and every redirect target is re-validated before it
 * is followed (max 3 hops). Hostnames are also resolved (DNS) and
 * refused when they point at a private address, so DNS rebinding is
 * covered too (the lookup is injectable for tests; the default uses the
 * system resolver with a 3s cap). Operator-approved hosts can be
 * allow-listed via DAEDALUS_SSRF_ALLOW_HOSTS for the DNS check only —
 * literal private addresses are never allow-listed.
 */

/** Hard cap on returned text; the rest is dropped with an explicit note. */
export const FETCH_URL_MAX_CHARS = 12_000;
/** Per-request fetch budget: docs pages are small; a hang is a failure. */
export const FETCH_URL_TIMEOUT_MS = 15_000;
export const FETCH_URL_MAX_REDIRECTS = 3;
/** Bodies beyond this are refused before extraction (memory guard). */
export const FETCH_URL_MAX_BODY_CHARS = 2_000_000;
/** Cap on a single DNS resolution inside the guard (mirrors server ssrf.ts). */
export const FETCH_URL_DNS_TIMEOUT_MS = 3_000;
/** Injectable DNS seam (tests resolve fake hosts — no test touches the network). */
export type FetchUrlLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchUrlResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

/** Injectable fetch seam (tests drive redirects, timeouts, bodies — never the network). */
export type FetchUrlImpl = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<FetchUrlResponse>;

/** IPv4 ranges blocked by the SSRF guard (ported from server ssrf.ts). */
function isBlockedIPv4(o: number[]): boolean {
  const [a, b, c] = [o[0]!, o[1]!, o[2]!];
  if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local (+ cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Parse an IPv6 literal into 8 groups (handles embedded dotted IPv4 and zone ids). */
function parseIPv6(ip: string): number[] | undefined {
  let s = ip.split('%')[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const o = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (o.some((n) => n > 255)) return undefined;
    s = s.slice(0, s.length - v4[0].length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 0) return undefined;
  const groups = [...head, ...(halves.length === 2 ? Array(fill).fill('0') : []), ...tail].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : undefined;
}

/** IPv6 ranges blocked by the SSRF guard (ported from server ssrf.ts). */
function isBlockedIPv6(groups: number[]): boolean {
  const g = groups;
  const v4of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isBlockedIPv4(v4of(g[6]!, g[7]!)); // ::ffff:a.b.c.d (mapped)
  if (g.slice(0, 6).every((n) => n === 0)) return isBlockedIPv4(v4of(g[6]!, g[7]!)); // ::a.b.c.d (compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return isBlockedIPv4(v4of(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(v4of(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // ULA
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Is this literal IP address blocked? Unparseable IPv6 fails closed. */
export function isBlockedIp(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  if (isIP(bare) === 4) return isBlockedIPv4(bare.split('.').map(Number));
  if (isIP(bare) === 6) {
    const groups = parseIPv6(bare);
    return groups ? isBlockedIPv6(groups) : true;
  }
  return false;
}

const BLOCKED_INTERNAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp)$/;

/** Expand an all-numeric/hex hostname (dotted, short, hex, integer form) to 4 octets, inet_aton-style. */
function numericHostToOctets(parts: string[]): number[] | undefined {
  const values = parts.map((part) => (part.toLowerCase().startsWith('0x') ? parseInt(part, 16) : Number(part)));
  if (values.some((n) => !Number.isInteger(n) || n < 0)) return undefined;
  if (values.length === 1) {
    const v = values[0]!;
    if (v > 0xffffffff) return undefined;
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  if (values.length === 2) {
    const [a, b] = values as [number, number];
    if (a > 255 || b > 0xffffff) return undefined;
    return [a, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff];
  }
  if (values.length === 3) {
    const [a, b, c] = values as [number, number, number];
    if (a > 255 || b > 255 || c > 0xffff) return undefined;
    return [a, b, (c >>> 8) & 0xff, c & 0xff];
  }
  if (values.length === 4) {
    if (values.some((n) => n! > 255)) return undefined;
    return values as number[];
  }
  return undefined;
}

/**
 * Is this hostname a literal private/loopback/link-local/CGNAT address,
 * an internal name, or an IPv6 disguise of one (mapped/compatible/NAT64/
 * 6to4)? Keeps core's short/obfuscated IPv4 handling (127.1, 0x7f.1,
 * integer form) and adds the server guard's ranges and disguises.
 * Public hostnames are allowed here — DNS resolution is a separate,
 * async step in the tool itself.
 */
export function isBlockedFetchHost(rawHostname: string): boolean {
  const host = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host.length === 0) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (BLOCKED_INTERNAL_NAME.test(host) || host === 'metadata.google.internal') return true;
  if (host.includes(':')) return isBlockedIp(host);
  const parts = host.split('.');
  if (parts.every((part) => /^(0x[0-9a-f]+|\d+)$/i.test(part))) {
    const octets = numericHostToOctets(parts);
    // Malformed numeric host: fail closed (not a legitimate public host).
    return octets ? isBlockedIPv4(octets) : true;
  }
  return false;
}

/** Validate scheme + host for `fetch_url`; returns the URL or a typed refusal reason. */
export function validateFetchTarget(raw: string): { url: URL } | { reason: string; detail: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'invalid_url', detail: `fetch_url: "${raw}" is not a valid URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { reason: 'unsupported_scheme', detail: `fetch_url only fetches http/https URLs, not ${url.protocol}` };
  }
  if (isBlockedFetchHost(url.hostname)) {
    return {
      reason: 'private_host',
      detail: `fetch_url refuses private/loopback/link-local address ${url.hostname} (SSRF guard) — fetch_url is for public documentation only`,
    };
  }
  return { url };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const numeric = body.slice(1);
      const code = numeric.toLowerCase().startsWith('x') ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Strip an HTML page to readable text: script/style/svg bodies removed,
 * block tags become line breaks, remaining tags dropped, entities decoded,
 * whitespace collapsed. Plain-text and markdown bodies skip this entirely
 * (passed through verbatim by the caller).
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = withoutBlocks
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|section|article|header|footer|main|li|tr|h[1-6]|pre|blockquote|table)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ');
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ' '));
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+([.,;:!?%)\]])/g, '$1').replace(/([(\[])\s+/g, '$1').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isReadableContentType(contentType: string | null): boolean {
  if (!contentType) return true; // no header: sniff by content below
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('text/')
    || type === 'application/json'
    || type === 'application/xml'
    || type === 'application/xhtml+xml'
    || type.endsWith('+xml')
    || type.endsWith('+json');
}

/** Cap long pages with an explicit note (the model can fetch a more specific page next). */
export function capFetchedText(text: string, cap = FETCH_URL_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return {
    text: `${text.slice(0, cap)}\n…[truncated at ${cap} of ${text.length} chars — fetch a more specific docs page/anchor for the rest]`,
    truncated: true,
  };
}

function envAllowHosts(): string[] {
  return (process.env.DAEDALUS_SSRF_ALLOW_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host: string, list: string[]): boolean {
  return list.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry));
}

class DnsAbortError extends Error {
  constructor() { super('dns aborted'); this.name = 'DnsAbortError'; }
}

async function withTimeoutAndAbort<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DnsAbortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('dns timeout')), ms);
        timer.unref?.();
        onAbort = () => reject(new DnsAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * DNS half of the SSRF guard: resolve a non-literal hostname and refuse
 * it when any address is private (DNS rebinding). Literal IPs skip
 * resolution (already covered by validateFetchTarget) and allow-listed
 * hosts skip it too — the allow-list never excuses a literal private
 * address, only a hostname whose resolution the operator trusts.
 */
async function checkFetchTargetDns(url: URL, lookup: FetchUrlLookup, allowHosts: string[], signal: AbortSignal): Promise<{ ok: true } | { reason: string; detail: string }> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host) !== 0) return { ok: true };
  if (hostAllowed(host, allowHosts)) return { ok: true };
  let addresses: string[];
  try {
    const resolved = await withTimeoutAndAbort(lookup(host), FETCH_URL_DNS_TIMEOUT_MS, signal);
    addresses = resolved.map((r) => r.address);
  } catch (error) {
    if (error instanceof DnsAbortError) throw error;
    return { reason: 'dns_failed', detail: `fetch_url: host ${host} could not be resolved` };
  }
  if (addresses.length === 0) return { reason: 'dns_failed', detail: `fetch_url: host ${host} has no addresses` };
  const bad = addresses.find((a) => isBlockedIp(a));
  if (bad) {
    return { reason: 'private_host', detail: `fetch_url refuses ${host} (resolves to private address ${bad}) — fetch_url is for public documentation only` };
  }
  return { ok: true };
}

export type FetchUrlOptions = {
  fetchImpl?: FetchUrlImpl;
  timeoutMs?: number;
  /** DNS seam for the SSRF guard (tests inject fake resolvers). Default: the system resolver. */
  lookup?: FetchUrlLookup;
  /** Hosts exempt from the DNS check only. Default: DAEDALUS_SSRF_ALLOW_HOSTS. */
  allowHosts?: string[];
};

export function createFetchUrlTool(options: FetchUrlOptions = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? FETCH_URL_TIMEOUT_MS;
  const fetchImpl: FetchUrlImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const lookup: FetchUrlLookup = options.lookup ?? ((h) => dnsLookup(h, { all: true }));
  const allowHosts = options.allowHosts ?? envAllowHosts();
  return {
    name: 'fetch_url',
    description: [
      'Fetch a public web page (official documentation, install guides, API references) and return its readable text, so you can look up how to install or use a tool/framework instead of guessing from memory.',
      'HTTP/HTTPS only; private/loopback addresses are refused, including hostnames that resolve to one. There is no search engine behind it — you supply the exact docs URL. Long pages are truncated with a note; fetch a more specific page/anchor then.',
      'If the fetch fails, fall back to probing `<generator> --help` with run_command — never invent install steps and present them as verified.',
    ].join(' '),
    mutating: false,
    timeoutMs: timeoutMs + 5_000,
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', description: 'Full http/https URL of the docs page to read' } },
      additionalProperties: false,
    },
    async execute(args, context): Promise<ToolResult> {
      const raw = (args as { url?: unknown })?.url;
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { call_id: '', status: 'error', output: 'fetch_url requires a string "url".', truncated: false, meta: { reason: 'invalid_arguments' } };
      }
      let target = validateFetchTarget(raw.trim());
      if ('reason' in target) {
        return { call_id: '', status: 'denied', output: target.detail, truncated: false, meta: { reason: target.reason } };
      }
      let current = target.url;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      const onHostAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onHostAbort, { once: true });
      try {
        for (let hop = 0; hop <= FETCH_URL_MAX_REDIRECTS; hop++) {
          // DNS half of the guard, re-run per hop like the sync check.
          try {
            const dns = await checkFetchTargetDns(current, lookup, allowHosts, controller.signal);
            if ('reason' in dns) {
              return { call_id: '', status: 'denied', output: dns.detail, truncated: false, meta: { reason: dns.reason, url: raw } };
            }
          } catch (error) {
            if (error instanceof DnsAbortError || controller.signal.aborted) {
              return {
                call_id: '',
                status: 'timeout',
                output: `fetch_url timed out after ${timeoutMs}ms fetching ${current.href} — try again, or fall back to probing the tool with \`--help\` via run_command.`,
                truncated: false,
                meta: { reason: 'timeout', url: raw },
              };
            }
            throw error;
          }
          let response: FetchUrlResponse;
          try {
            response = await fetchImpl(current.href, { redirect: 'manual', signal: controller.signal });
          } catch (error) {
            if (controller.signal.aborted || (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError') {
              return {
                call_id: '',
                status: 'timeout',
                output: `fetch_url timed out after ${timeoutMs}ms fetching ${current.href} — try again, or fall back to probing the tool with \`--help\` via run_command.`,
                truncated: false,
                meta: { reason: 'timeout', url: raw },
              };
            }
            return {
              call_id: '',
              status: 'error',
              output: `fetch_url could not fetch ${current.href}: ${(error as Error)?.message ?? String(error)}`,
              truncated: false,
              meta: { reason: 'fetch_failed', url: raw },
            };
          }
          const location = response.headers.get('location');
          if (REDIRECT_STATUSES.has(response.status) && location) {
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              return { call_id: '', status: 'error', output: `fetch_url: ${current.href} redirected to an invalid URL (${location})`, truncated: false, meta: { reason: 'invalid_redirect', url: raw } };
            }
            const revalidated = validateFetchTarget(next.href);
            if ('reason' in revalidated) {
              return {
                call_id: '',
                status: 'denied',
                output: `fetch_url: ${current.href} redirected to a refused target — ${revalidated.detail}`,
                truncated: false,
                meta: { reason: revalidated.reason, url: raw, redirect_to: next.href },
              };
            }
            if (hop === FETCH_URL_MAX_REDIRECTS) {
              return { call_id: '', status: 'error', output: `fetch_url: too many redirects (>${FETCH_URL_MAX_REDIRECTS}) starting at ${raw}`, truncated: false, meta: { reason: 'too_many_redirects', url: raw } };
            }
            current = revalidated.url;
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            return {
              call_id: '',
              status: 'error',
              output: `fetch_url: HTTP ${response.status} from ${current.href}. Check the URL, or fall back to the tool's own \`--help\` via run_command.`,
              truncated: false,
              meta: { reason: 'http_status', url: raw, final_url: current.href, status: response.status },
            };
          }
          const contentType = response.headers.get('content-type');
          if (!isReadableContentType(contentType)) {
            return {
              call_id: '',
              status: 'error',
              output: `fetch_url: ${current.href} returned ${contentType ?? 'an unknown type'}, which is not readable text (fetch_url reads HTML/text/markdown/JSON docs).`,
              truncated: false,
              meta: { reason: 'unreadable_content_type', url: raw, final_url: current.href, content_type: contentType ?? undefined },
            };
          }
          const body = await response.text();
          if (body.length > FETCH_URL_MAX_BODY_CHARS) {
            return {
              call_id: '',
              status: 'error',
              output: `fetch_url: ${current.href} returned ${body.length} chars, over the ${FETCH_URL_MAX_BODY_CHARS}-char fetch limit — fetch a more specific page instead.`,
              truncated: false,
              meta: { reason: 'body_too_large', url: raw, final_url: current.href, chars: body.length },
            };
          }
          const type = (contentType ?? '').toLowerCase();
          const plain = type.includes('text/plain') || type.includes('markdown') || type.includes('application/json') || !type.includes('html');
          const extracted = plain ? body.trim() : htmlToText(body);
          const capped = capFetchedText(extracted);
          const header = `Fetched ${current.href} (HTTP ${response.status}${contentType ? `, ${contentType.split(';')[0]}` : ''}${current.href !== raw.trim() ? ` — redirected from ${raw.trim()}` : ''}):`;
          return {
            call_id: '',
            status: 'ok',
            output: `${header}\n\n${capped.text}`,
            truncated: capped.truncated,
            meta: {
              url: raw,
              final_url: current.href,
              status: response.status,
              ...(contentType ? { content_type: contentType.split(';')[0] } : {}),
              chars: extracted.length,
              ...(capped.truncated ? { output_truncated: true } : {}),
            },
          };
        }
        // Unreachable (the redirect branch returns at the cap), keeps the
        // type checker honest about the loop's exit.
        return { call_id: '', status: 'error', output: 'fetch_url: too many redirects', truncated: false, meta: { reason: 'too_many_redirects', url: raw } };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onHostAbort);
      }
    },
  };
}

export const fetchUrlTool: ToolDefinition = createFetchUrlTool();

/**
 * web_search: the discovery half fetch_url deliberately lacked. The
 * model often knows WHAT it needs (an install command, an error's
 * meaning) but not the exact URL; without search it guesses URLs from
 * memory or gives up to `--help` probing. Backend order: Brave
 * (DAEDALUS_BRAVE_SEARCH_API_KEY), Tavily (DAEDALUS_TAVILY_API_KEY),
 * then keyless DuckDuckGo HTML. Results are title/URL/snippet only —
 * fetch_url reads the chosen page in full.
 */

export const WEB_SEARCH_TIMEOUT_MS = 15_000;
export const WEB_SEARCH_MAX_QUERIES = 3;
export const WEB_SEARCH_DEFAULT_COUNT = 5;
export const WEB_SEARCH_MAX_COUNT = 10;

export type WebSearchResult = { title: string; url: string; snippet: string };

export type WebSearchFetchImpl = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<FetchUrlResponse>;

export type WebSearchBackend = 'brave' | 'tavily' | 'duckduckgo';

export function webSearchBackend(env: NodeJS.ProcessEnv = process.env): WebSearchBackend {
  if (env.DAEDALUS_BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.DAEDALUS_TAVILY_API_KEY) return 'tavily';
  return 'duckduckgo';
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Parse DuckDuckGo's keyless HTML results page into title/url/snippet rows. Exported for tests. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  for (let match = snippetPattern.exec(html); match; match = snippetPattern.exec(html)) snippets.push(stripTags(match[1] ?? ''));
  let index = 0;
  for (let match = linkPattern.exec(html); match; match = linkPattern.exec(html)) {
    let href = decodeHtmlEntities(match[1] ?? '');
    try {
      const parsed = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) href = uddg;
      else href = parsed.href;
    } catch { /* keep the raw href */ }
    results.push({ title: stripTags(match[2] ?? ''), url: href, snippet: snippets[index] ?? '' });
    index++;
  }
  return results;
}

export function createWebSearchTool(options: { fetchImpl?: WebSearchFetchImpl; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const fetchImpl: WebSearchFetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  const runOne = async (backend: WebSearchBackend, query: string, count: number, signal: AbortSignal): Promise<WebSearchResult[]> => {
    if (backend === 'brave') {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
      const response = await fetchImpl(url, { headers: { accept: 'application/json', 'x-subscription-token': env.DAEDALUS_BRAVE_SEARCH_API_KEY as string }, signal });
      if (response.status < 200 || response.status >= 300) throw new Error(`Brave search returned HTTP ${response.status}`);
      const body = JSON.parse(await response.text()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return (body.web?.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }));
    }
    if (backend === 'tavily') {
      const response = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: env.DAEDALUS_TAVILY_API_KEY, query, max_results: count }),
        signal,
      });
      if (response.status < 200 || response.status >= 300) throw new Error(`Tavily search returned HTTP ${response.status}`);
      const body = JSON.parse(await response.text()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      return (body.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
    }
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Daedalus/1.0' }, signal });
    if (response.status < 200 || response.status >= 300) throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
    return parseDuckDuckGoHtml(await response.text()).slice(0, count);
  };

  return {
    name: 'web_search',
    description: [
      'Search the public web for something you do not know (an install command, an error message, current docs): returns titles, URLs, and snippets. Follow up with fetch_url on the result you choose to read it in full.',
      'Pass one `query` or up to 3 `queries` merged in one call. Uses Brave/Tavily when their API key env var is set, otherwise a keyless DuckDuckGo backend (which may refuse when rate-limited — then fetch a known docs URL directly instead of retrying in a loop).',
    ].join(' '),
    mutating: false,
    timeoutMs: timeoutMs * WEB_SEARCH_MAX_QUERIES + 5_000,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One search query' },
        queries: { type: 'array', items: { type: 'string' }, maxItems: WEB_SEARCH_MAX_QUERIES, description: 'Up to 3 queries in one call' },
        count: { type: 'integer', minimum: 1, maximum: WEB_SEARCH_MAX_COUNT, description: 'Results per query (default 5)' },
      },
      additionalProperties: false,
    },
    async execute(args, context): Promise<ToolResult> {
      const a = args as { query?: unknown; queries?: unknown; count?: unknown };
      const queries = [...(typeof a.query === 'string' && a.query.trim() ? [a.query.trim()] : []), ...(Array.isArray(a.queries) ? a.queries.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).map((q) => q.trim()) : [])].slice(0, WEB_SEARCH_MAX_QUERIES);
      if (queries.length === 0) return { call_id: '', status: 'error', output: 'web_search requires a "query" string or "queries" array (up to 3).', truncated: false, meta: { reason: 'invalid_arguments' } };
      const count = typeof a.count === 'number' && Number.isFinite(a.count) ? Math.min(WEB_SEARCH_MAX_COUNT, Math.max(1, Math.floor(a.count))) : WEB_SEARCH_DEFAULT_COUNT;
      const backend = webSearchBackend(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs * queries.length);
      timer.unref?.();
      const onHostAbort = (): void => controller.abort();
      context.signal?.addEventListener('abort', onHostAbort, { once: true });
      try {
        const sections: string[] = [];
        let total = 0;
        for (const query of queries) {
          const results = await runOne(backend, query, count, controller.signal);
          total += results.length;
          sections.push([
            `## ${query}`,
            ...(results.length === 0 ? ['(no results)'] : results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)),
          ].join('\n'));
        }
        return {
          call_id: '',
          status: 'ok',
          output: `Web search via ${backend} (${total} result${total === 1 ? '' : 's'}):\n\n${sections.join('\n\n')}`,
          truncated: false,
          meta: { backend, queries: queries.length, count: total },
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { call_id: '', status: 'timeout', output: `web_search timed out via the ${backend} backend — fetch a known docs URL with fetch_url instead of retrying search in a loop.`, truncated: false, meta: { reason: 'timeout', backend } };
        }
        return { call_id: '', status: 'error', output: `web_search failed via the ${backend} backend: ${(error as Error)?.message ?? String(error)}. If it refuses (rate limit / no key), fetch a known docs URL with fetch_url instead.`, truncated: false, meta: { reason: 'search_failed', backend } };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onHostAbort);
      }
    },
  };
}

export const webSearchTool: ToolDefinition = createWebSearchTool();

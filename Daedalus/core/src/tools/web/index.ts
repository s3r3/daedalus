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
 * Safety: http/https only; literal private/loopback/link-local hosts are
 * refused, and every redirect target is re-validated before it is
 * followed (max 3 hops). DNS is NOT inspected — the codebase has no DNS
 * seam, so a public hostname that resolves to a private address (DNS
 * rebinding) is outside the implemented layer; the block list covers
 * literal hosts plus redirect targets, which is the layer these tools
 * conventionally enforce.
 */

/** Hard cap on returned text; the rest is dropped with an explicit note. */
export const FETCH_URL_MAX_CHARS = 12_000;
/** Per-request fetch budget: docs pages are small; a hang is a failure. */
export const FETCH_URL_TIMEOUT_MS = 15_000;
export const FETCH_URL_MAX_REDIRECTS = 3;
/** Bodies beyond this are refused before extraction (memory guard). */
export const FETCH_URL_MAX_BODY_CHARS = 2_000_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchUrlResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

/** Injectable fetch seam (tests drive redirects, timeouts, bodies — never the network). */
export type FetchUrlImpl = (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<FetchUrlResponse>;

/**
 * Is this hostname a literal private/loopback/link-local address (or
 * `localhost`)? Handles dotted IPv4, short/obfuscated IPv4 forms the URL
 * parser passes through (127.1, 0x7f.1, integer form), and IPv6 literals.
 * Public hostnames are allowed — DNS resolution is not inspected.
 */
export function isBlockedFetchHost(rawHostname: string): boolean {
  const host = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host.length === 0) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) {
    // IPv6 literal: loopback, unspecified, link-local (fe80::/10), ULA (fc00::/7).
    return host === '::1'
      || host === '::'
      || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')
      || host.startsWith('fc') || host.startsWith('fd');
  }
  const parts = host.split('.');
  if (parts.every((part) => /^(0x[0-9a-f]+|\d+)$/i.test(part))) {
    const values = parts.map((part) => (part.toLowerCase().startsWith('0x') ? parseInt(part, 16) : Number(part)));
    // Single integer form (2130706433): the first octet is the top byte.
    const first = values.length === 1 && values[0]! > 255 ? values[0]! >>> 24 : values[0]!;
    const second = values.length === 1 ? (values[0]! >>> 16) & 0xff : values[1]!;
    if (first === 127 || first === 10 || first === 0) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;
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

export function createFetchUrlTool(options: { fetchImpl?: FetchUrlImpl; timeoutMs?: number } = {}): ToolDefinition {
  const timeoutMs = options.timeoutMs ?? FETCH_URL_TIMEOUT_MS;
  const fetchImpl: FetchUrlImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    name: 'fetch_url',
    description: [
      'Fetch a public web page (official documentation, install guides, API references) and return its readable text, so you can look up how to install or use a tool/framework instead of guessing from memory.',
      'HTTP/HTTPS only; private/loopback addresses are refused. There is no search engine behind it — you supply the exact docs URL. Long pages are truncated with a note; fetch a more specific page/anchor then.',
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

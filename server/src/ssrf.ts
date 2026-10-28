/**
 * Guard SSRF untuk pengambilan dokumen riset di server (S10).
 *
 * URL sumber riset berasal dari hasil pencarian / isi laporan, yaitu dikendalikan pihak luar. Tanpa guard, sumber yang
 * menunjuk ke `http://127.0.0.1:3080/...` (server ini sendiri), `169.254.169.254` (metadata cloud), atau jaringan
 * lokal akan di-fetch dari mesin pengguna dan isinya masuk ke laporan/preview.
 *
 * Aturan yang sama dengan guard `fetch_url` di core (host privat/loopback/link-local ditolak, SETIAP redirect divalidasi
 * ulang), ditambah yang tidak ditangani core: bentuk IPv6 "mapped"/NAT64/6to4 yang membawa IPv4, rentang CGNAT, dan
 * resolusi DNS (nama publik yang menunjuk ke IP privat). Host API yang di-hardcode (Brave, Tavily, …) tidak melewati
 * guard ini — hanya URL milik sumber/laporan.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SsrfReason = "invalid_url" | "unsupported_scheme" | "private_host" | "dns_failed" | "invalid_redirect" | "too_many_redirects";

export class SsrfBlockedError extends Error {
  readonly reason: SsrfReason;
  constructor(reason: SsrfReason, detail: string) {
    super(detail);
    this.name = "SsrfBlockedError";
    this.reason = reason;
  }
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;
export type GuardOptions = {
  lookup?: LookupFn;
  /** Host yang dikecualikan dari pemeriksaan IP (persis, atau `*.sufiks`). Bawaan: env DAEDALUS_SSRF_ALLOW_HOSTS. */
  allowHosts?: string[];
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
};
export type UrlVerdict =
  | { ok: true; url: URL; /** IP publik hasil resolusi (untuk pin), kosong bila host literal/diizinkan */ addresses: string[] }
  | { ok: false; reason: SsrfReason; detail: string };

/** Host API tepercaya yang di-hardcode; tidak pernah diblokir oleh guard ini. */
const TRUSTED_API_HOSTS = new Set(["api.search.brave.com", "api.tavily.com"]);

const MAX_REDIRECTS = 5;
const DNS_TIMEOUT_MS = 3_000;

function envAllowHosts(): string[] {
  return (process.env.DAEDALUS_SSRF_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function hostAllowed(host: string, list: string[]): boolean {
  return list.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
}

/** IPv4 privat/loopback/link-local/CGNAT/dll. Menerima 4 oktet. */
export function isBlockedIPv4(o: number[]): boolean {
  const [a, b, c] = [o[0]!, o[1]!, o[2]!];
  if (a === 0 || a === 10 || a === 127) return true;                 // unspecified, privat, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;                 // CGNAT 100.64.0.0/10 (mis. Tailscale)
  if (a === 169 && b === 254) return true;                           // link-local (+ metadata cloud)
  if (a === 172 && b >= 16 && b <= 31) return true;                  // privat
  if (a === 192 && b === 168) return true;                           // privat
  if (a === 192 && b === 0 && c === 0) return true;                  // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;              // benchmarking
  if (a >= 224) return true;                                         // multicast + reserved + broadcast
  return false;
}

function parseIPv6(ip: string): number[] | undefined {
  let s = ip.split("%")[0]!.toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const o = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (o.some((n) => n > 255)) return undefined;
    s = s.slice(0, s.length - v4[0].length) + ((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 0) return undefined;
  const groups = [...head, ...(halves.length === 2 ? Array(fill).fill("0") : []), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : undefined;
}

export function isBlockedIPv6(groups: number[]): boolean {
  const g = groups;
  const v4of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((n) => n === 0)) return true;                                           // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true;                 // ::1
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isBlockedIPv4(v4of(g[6]!, g[7]!)); // ::ffff:a.b.c.d (mapped)
  if (g.slice(0, 6).every((n) => n === 0)) return isBlockedIPv4(v4of(g[6]!, g[7]!)); // ::a.b.c.d (kompatibel)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return isBlockedIPv4(v4of(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return isBlockedIPv4(v4of(g[1]!, g[2]!));                      // 6to4
  if ((g[0]! & 0xffc0) === 0xfe80) return true;                                       // link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true;                                       // ULA
  if ((g[0]! & 0xff00) === 0xff00) return true;                                       // multicast
  return false;
}

/** Apakah alamat IP literal ini terlarang? (IPv4 dotted atau IPv6, dengan/tanpa kurung). */
export function isBlockedIp(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 4) return isBlockedIPv4(bare.split(".").map(Number));
  if (isIP(bare) === 6) {
    const groups = parseIPv6(bare);
    return groups ? isBlockedIPv6(groups) : true; // tak terparse → tolak (fail-closed)
  }
  return false;
}

const BLOCKED_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp)$/;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => { t = setTimeout(() => reject(new Error("dns timeout")), ms); t.unref?.(); });
  try { return await Promise.race([p, timeout]); } finally { if (t) clearTimeout(t); }
}

/** Periksa satu URL: skema, host literal, dan hasil resolusi DNS. Tidak melakukan request ke URL itu. */
export async function checkPublicUrl(raw: string | URL, options: GuardOptions = {}): Promise<UrlVerdict> {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url", detail: `URL tidak valid: ${String(raw).slice(0, 120)}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "unsupported_scheme", detail: `Hanya URL http/https yang diambil, bukan ${url.protocol}` };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return { ok: false, reason: "invalid_url", detail: "URL tanpa nama host" };
  if (TRUSTED_API_HOSTS.has(host) || hostAllowed(host, options.allowHosts ?? envAllowHosts())) return { ok: true, url, addresses: [] };

  const refuse = (what: string): UrlVerdict => ({ ok: false, reason: "private_host", detail: `Ditolak (guard SSRF): ${what}. Sumber riset hanya boleh halaman publik.` });
  if (isIP(host) !== 0) return isBlockedIp(host) ? refuse(`alamat privat/loopback/link-local ${host}`) : { ok: true, url, addresses: [] };
  if (BLOCKED_NAME.test(host) || host === "metadata.google.internal") return refuse(`nama host internal ${host}`);

  let addresses: string[];
  try {
    const resolved = await withTimeout((options.lookup ?? ((h) => dnsLookup(h, { all: true })))(host), DNS_TIMEOUT_MS);
    addresses = resolved.map((r) => r.address);
  } catch {
    return { ok: false, reason: "dns_failed", detail: `Nama host ${host} tidak bisa di-resolve` };
  }
  if (addresses.length === 0) return { ok: false, reason: "dns_failed", detail: `Nama host ${host} tidak punya alamat` };
  const bad = addresses.find((a) => isBlockedIp(a));
  if (bad) return refuse(`${host} me-resolve ke alamat privat ${bad}`);
  return { ok: true, url, addresses };
}

/**
 * fetch GET/HEAD dengan validasi di SETIAP hop: redirect diikuti manual dan target tiap hop diperiksa ulang.
 * Melempar SsrfBlockedError bila ada hop yang ditolak. Catatan jujur: `fetch` melakukan resolusi DNS sendiri, jadi ada
 * jendela sempit DNS-rebinding antara pemeriksaan dan koneksi; jalur curl memakai `--resolve` untuk menutupnya.
 */
export async function guardedFetch(url: string, init: RequestInit = {}, options: GuardOptions = {}): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const max = options.maxRedirects ?? MAX_REDIRECTS;
  let current = url;
  for (let hop = 0; hop <= max; hop++) {
    const verdict = await checkPublicUrl(current, options);
    if (!verdict.ok) throw new SsrfBlockedError(verdict.reason, verdict.detail);
    const response = await doFetch(verdict.url.href, { ...init, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);
    try {
      current = new URL(location, verdict.url).href;
    } catch {
      throw new SsrfBlockedError("invalid_redirect", `Redirect ke URL tidak valid: ${location.slice(0, 120)}`);
    }
  }
  throw new SsrfBlockedError("too_many_redirects", `Terlalu banyak redirect (>${max}) mulai dari ${url.slice(0, 120)}`);
}

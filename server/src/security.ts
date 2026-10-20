/**
 * Penjaga akses untuk server lokal Dae Captain.
 *
 * Masalah yang ditutup: server hanya di-bind ke loopback, tetapi BROWSER di mesin yang sama bisa
 * menembak 127.0.0.1 atas nama situs mana pun. Dengan CORS `*` dan body JSON yang diparse tanpa
 * cek content-type, sebuah halaman web bisa mengirim `POST /tasks {auto_approve:true}` sebagai
 * "simple request" (tanpa preflight) dan membuat agen menjalankan perintah. WebSocket tak terkena
 * CORS sama sekali, sehingga situs lain juga bisa menyadap semua event. Browser SELALU mengirim
 * header `Origin` pada request lintas-origin dan header `Host` aslinya (anti DNS-rebinding), jadi
 * keduanya dicek di sini. Klien non-browser (curl, CLI, Tauri via tauri://localhost) tetap lolos.
 */

const ORIGIN_PATTERNS: RegExp[] = [
  /^tauri:\/\/localhost$/,
  /^https?:\/\/tauri\.localhost$/,
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/,
];

function extraOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DAEDALUS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True bila server di-bind hanya ke loopback (guard Host hanya bermakna di kasus ini). */
export function isLoopbackBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Anti DNS-rebinding: header Host harus nama loopback. */
export function hostAllowed(host: string | undefined): boolean {
  return !!host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host.trim());
}

/** Tanpa header Origin (curl, CLI, navigasi same-origin) = diizinkan. */
export function originAllowed(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (origin === undefined || origin === "") return origin === undefined;
  return extraOrigins(env).includes(origin) || ORIGIN_PATTERNS.some((p) => p.test(origin));
}

/** Gabungan keputusan untuk satu request/upgrade. */
export function requestAllowed(input: { origin: string | undefined; host: string | undefined; bindHost: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!originAllowed(input.origin, env)) return false;
  if (isLoopbackBind(input.bindHost) && !hostAllowed(input.host)) return false;
  return true;
}

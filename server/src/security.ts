// Dae Captain — origin/host guard (B1).
//
// Mencegah website asing menembak server loopback via fetch() lintas-origin.
// Browser SELALU menyertakan header `Origin` pada request lintas-origin,
// jadi situs jahat tertolak sebelum handler apa pun berjalan.
// Klien non-browser (CLI, curl, Tauri via `tauri://localhost`, UI yang
// disajikan server sendiri) tidak mengirim Origin → tetap diizinkan.

const ORIGIN_PATTERNS = [
  /^tauri:\/\/localhost$/,
  /^https?:\/\/tauri\.localhost$/,
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/,
];

// Origin tambahan yang diizinkan, dipisah koma. Untuk server yang dibuka
// via LAN (bind 0.0.0.0) dan diakses dari HP/PC lain.
const EXTRA_ORIGINS = (process.env.DAEDALUS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** True bila server di-bind ke loopback (127.0.0.1/localhost/::1). */
export function isLoopbackBind(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Anti DNS-rebinding: Host header harus loopback bila server di-bind
 * ke loopback. Mencegah evil.example yang resolve ke 127.0.0.1.
 */
export function hostAllowed(host: string | undefined): boolean {
  return !!host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host.trim());
}

/**
 * Tanpa header Origin (curl, CLI, navigasi same-origin) = diizinkan.
 * Dengan Origin: harus cocok pola loopback/tauri atau DAEDALUS_ALLOWED_ORIGINS.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return EXTRA_ORIGINS.includes(origin) || ORIGIN_PATTERNS.some((p) => p.test(origin));
}

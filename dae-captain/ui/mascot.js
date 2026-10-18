/**
 * Dae Captain — mascot v2 (SATU FILE, pengganti mascot.js + folder mascot/*.svg).
 *
 * - SVG inline (bukan <img>) → state, dekor, ekspresi bisa diganti halus tanpa reload.
 * - 9 status pill (idle, working, verifying, fixing, waiting_approval, paused, queued,
 *   done, error) + thinking + sleep, + 5 engine (coding, slide, dokumen, spreadsheet, research).
 * - 12 dekor: default (kapten), spring, summer, autumn, winter, halloween, christmas,
 *   newyear, valentine, ramadan, eid, independence — otomatis menurut tanggal.
 * - 10 kostum baju tradisional dunia (batik, kimono, hanbok, changshan, kurta, thobe,
 *   jas, beret, sombrero, aloha) — hanya lewat pilihan manual (Panel Ganti Baju).
 * - Animasi klik per dekor/kostum: triggerMascotAction() (visual saja, 1–2 detik).
 * - Mata mengikuti kursor, reaksi hover, tidur saat idle lama, animasi berhenti saat
 *   tab/jendela tersembunyi, DND, dan prefers-reduced-motion.
 *
 * Kompatibel dengan app.js lama: currentSeason, variantFor, mascotHtml,
 * refreshMascots, setMascotStatus tetap diekspor. Tidak ada perubahan wajib di app.js.
 * Opsional (1 baris di pill.js → _render): this.root.dataset.engine = s.primary?.engine ?? "";
 * supaya pose Working berganti sesuai engine (tanpa baris ini pose Working generik dipakai).
 *
 * Modul ini TIDAK menyentuh `document` saat di-import (aman untuk node:test).
 */

const NS = "http://www.w3.org/2000/svg";
const PREF_KEY = "dae-captain:mascot-decor";
const SLEEP_MS = 120_000; // idle selama ini → tidur. 0 = nonaktif.
const SLEEP_ENABLED = true;

/* ------------------------------------------------------------------ */
/* Daftar publik                                                       */
/* ------------------------------------------------------------------ */

export const PILL_STATUSES = [
  "idle", "working", "verifying", "fixing", "waiting_approval",
  "paused", "queued", "done", "error",
];

/** Semua pose yang bisa dirender. */
export const POSES = [
  "idle", "thinking", "working", "verifying", "fixing", "permission",
  "paused", "queued", "done", "error", "sleep",
  "coding", "slide", "document", "spreadsheet", "research",
];

/** engine (nama di logic.js ENGINES) → pose. */
export const ENGINE_POSE = {
  coding: "coding", slide: "slide", dokumen: "document", document: "document",
  spreadsheet: "spreadsheet", research: "research",
};

export const DECOR_LABELS = {
  default: "Kapten", spring: "Musim Semi", summer: "Musim Panas", autumn: "Musim Gugur",
  winter: "Musim Dingin", halloween: "Halloween", christmas: "Natal", newyear: "Tahun Baru",
  valentine: "Valentine", ramadan: "Ramadan", eid: "Idulfitri", independence: "HUT RI",
};
export const DECOR_KEYS = Object.keys(DECOR_LABELS);

/** Kostum baju tradisional (tidak terikat musim, hanya manual). */
export const COSTUME_LABELS = {
  batik: "Batik · Indonesia", kimono: "Kimono · Jepang", hanbok: "Hanbok · Korea",
  changshan: "Changshan · Tiongkok", kurta: "Kurta · India", thobe: "Thobe · Arab",
  jas: "Setelan Jas · Inggris", beret: "Beret · Prancis", sombrero: "Sombrero · Meksiko",
  aloha: "Aloha · Hawaii",
};
export const COSTUME_KEYS = Object.keys(COSTUME_LABELS);
export const ALL_LABELS = { ...DECOR_LABELS, ...COSTUME_LABELS };
export const ALL_KEYS = Object.keys(ALL_LABELS);

/** Opsi tersimpan: "auto" | "events" | dekor | kostum. */
export const DECOR_PREFS = ["auto", "events", ...ALL_KEYS];

/* ------------------------------------------------------------------ */
/* Dekor otomatis menurut tanggal                                      */
/* ------------------------------------------------------------------ */

/** Bulan/hari kalender Hijriah (Umm al-Qura). Bisa selisih ±1 hari dari sidang isbat. */
function hijri(date) {
  try {
    const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura-nu-latn", {
      day: "numeric", month: "numeric",
    }).formatToParts(date);
    const m = Number(parts.find((p) => p.type === "month")?.value);
    const d = Number(parts.find((p) => p.type === "day")?.value);
    return Number.isFinite(m) && Number.isFinite(d) ? { m, d } : null;
  } catch {
    return null;
  }
}

/** Dekor khusus hari/peristiwa, atau null. */
export function eventDecor(date = new Date()) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = hijri(date);
  if (h && h.m === 10 && h.d <= 3) return "eid"; // 1–3 Syawal
  if (h && h.m === 9) return "ramadan";
  if ((m === 12 && d === 31) || (m === 1 && d <= 2)) return "newyear";
  if (m === 12 && d >= 20 && d <= 26) return "christmas";
  if (m === 10 || (m === 11 && d === 1)) return "halloween";
  if (m === 2 && d >= 13 && d <= 15) return "valentine";
  if (m === 8 && d >= 10 && d <= 20) return "independence";
  return null;
}

/** Dekor musim (belahan utara, sama seperti mascot.js lama). */
export function seasonDecor(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

let memPref = null; // cadangan bila localStorage tak tersedia

export function getDecorPref() {
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v && DECOR_PREFS.includes(v)) return v;
    if (v === null && memPref) return memPref;
  } catch {
    if (memPref) return memPref;
  }
  return memPref ?? "auto";
}

/** Dekor yang berlaku sekarang. mode: "auto" (acara→musim), "events" (acara→kapten), atau kunci tetap. */
export function currentDecor(date = new Date(), mode = getDecorPref()) {
  if (ALL_KEYS.includes(mode)) return mode;
  const ev = eventDecor(date);
  if (ev) return ev;
  return mode === "events" ? "default" : seasonDecor(date);
}

/** Kompat mascot.js lama. */
export function currentSeason(date = new Date()) {
  return currentDecor(date, "auto");
}

/* ------------------------------------------------------------------ */
/* Resolusi status → pose                                              */
/* ------------------------------------------------------------------ */

export function resolvePose(status = "idle", engine = "") {
  const s = String(status || "idle").toLowerCase();
  const e = String(engine || "").toLowerCase();
  if (s === "working" || s === "coding" || s === "slide" || s === "document" || s === "dokumen"
    || s === "spreadsheet" || s === "research") {
    const key = ENGINE_POSE[s] ? s : e;
    return ENGINE_POSE[key] ?? "working";
  }
  if (s === "waiting_approval" || s === "permission") return "permission";
  if (POSES.includes(s)) return s;
  return "idle";
}

/** Kompat: nama varian lama. */
export function variantFor(status) {
  return resolvePose(status);
}

/* ------------------------------------------------------------------ */
/* Bangun SVG (fungsi murni: string)                                   */
/* ------------------------------------------------------------------ */

const STAR = "M0-14Q2-2 14 0Q2 2 0 14Q-2 2-14 0Q-2-2 0-14Z";
const HEART = "M0 7C-16-5-9-16 0-9C9-16 16-5 0 7Z";
const LEAF = "M0-9Q9-4 0 9Q-9-4 0-9Z";
const STK = 'stroke="#a5b4ff" stroke-width="2.5" fill="none" stroke-linecap="round"';

const g = (t, inner, extra = "") => `<g transform="${t}"${extra}>${inner}</g>`;
const circ = (x, y, r, fill, extra = "") => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"${extra}/>`;
const eyeC = (x, y, r = 11) => circ(x, y, r, "url(#dm-eye)");
const hl = (x, y, r = 3.5) => circ(x, y, r, "#fff");
const mouth = (d, fill = "none") => (fill === "none"
  ? `<path d="${d}" ${STK}/>`
  : `<path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="1.5" stroke-linejoin="round"/>`);
const star = (x, y, c, s = 1, delay = 0) =>
  g(`translate(${x} ${y}) scale(${s})`, `<path class="dm-tw" d="${STAR}" fill="${c}" style="animation-delay:${delay}s"/>`);
const blush = (c, o = 0.45) =>
  `<ellipse cx="-54" cy="22" rx="9" ry="5" fill="${c}" opacity="${o}"/><ellipse cx="54" cy="22" rx="9" ry="5" fill="${c}" opacity="${o}"/>`;
const heart = (c, extra = "") => `<path d="${HEART}" fill="${c}"${extra}/>`;
const drop = (x, y, delay = 0) =>
  `<path class="dm-fall" d="M${x} ${y}q6 10 0 14q-6-4 0-14Z" fill="#7ad7ff" style="animation-delay:${delay}s"/>`;
const eyesPair = (y = 2, x = 30, r = 11) =>
  `${eyeC(-x, y, r)}${eyeC(x, y, r)}${hl(-x - 3, y - 4)}${hl(x - 3, y - 4)}`;
const arcs = (up, y = 6) => up
  ? `<path d="M-42 ${y}q12-14 24 0M18 ${y}q12-14 24 0" stroke="#c7d2ff" stroke-width="4.5" fill="none" stroke-linecap="round"/>`
  : `<path d="M-42 ${y - 4}q12 12 24 0M18 ${y - 4}q12 12 24 0" stroke="#c7d2ff" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
const brows = (d, c = "#a5b4ff") => `<path d="${d}" stroke="${c}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
const wavy = "M-14 25q3.5-6 7 0t7 0t7 0t7 0";

/** Gradient dipakai bersama (sprite tersembunyi di dokumen / inline di SVG mandiri). */
function defsMarkup() {
  return `<defs>
<linearGradient id="dm-hood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f8bff"/><stop offset="1" stop-color="#2b2fd4"/></linearGradient>
<linearGradient id="dm-face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#15133d"/><stop offset="1" stop-color="#0a0a28"/></linearGradient>
<linearGradient id="dm-eye" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9af0ff"/><stop offset="1" stop-color="#3fa2ff"/></linearGradient>
<linearGradient id="dm-paw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a4b0ff"/><stop offset="1" stop-color="#6a5cff"/></linearGradient>
<linearGradient id="dm-shd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9a8bff"/><stop offset="1" stop-color="#5a46d8"/></linearGradient>
<pattern id="dm-batik" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#7a4a2e"/><circle cx="7" cy="7" r="3.4" fill="none" stroke="#e8b563" stroke-width="1.3"/><circle cx="0" cy="0" r="1.8" fill="#e8b563"/><circle cx="14" cy="0" r="1.8" fill="#e8b563"/><circle cx="0" cy="14" r="1.8" fill="#e8b563"/><circle cx="14" cy="14" r="1.8" fill="#e8b563"/></pattern>
<pattern id="dm-kef" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#f2f4ff"/><rect width="5" height="5" fill="#d9283c" opacity=".78"/><rect x="5" y="5" width="5" height="5" fill="#d9283c" opacity=".78"/></pattern>
<pattern id="dm-aloha" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#2bb3c0"/><circle cx="7" cy="7" r="4.2" fill="#ff7aa8"/><circle cx="7" cy="7" r="1.6" fill="#ffe27a"/><path d="M17 15q4-5 6 0q-3 4-6 0Z" fill="#1f8f6a"/><circle cx="19" cy="4" r="2" fill="#ffe27a"/></pattern>
<radialGradient id="dm-sh"><stop offset="0" stop-color="#3a3fe0" stop-opacity=".42"/><stop offset="1" stop-color="#3a3fe0" stop-opacity="0"/></radialGradient>
</defs>`;
}

/* ---------- badan (selalu tampil) ---------- */
const BODY = `<path d="M-82-25L-70-98-22-66Z" fill="url(#dm-hood)"/><path d="M-72-45L-67-82-42-64Z" fill="#a78bfa"/>
<path d="M82-25L70-98 22-66Z" fill="url(#dm-hood)"/><path d="M72-45L67-82 42-64Z" fill="#a78bfa"/>
<ellipse cx="0" cy="55" rx="72" ry="30" fill="#2f35c9"/>
<ellipse cx="0" cy="0" rx="92" ry="72" fill="url(#dm-hood)"/>
<ellipse cx="0" cy="6" rx="75" ry="56" fill="url(#dm-face)"/>`;

/* ---------- tangan dasar ---------- */
const PAWS = {
  base: `${circ(-58, 58, 15, "url(#dm-paw)")}${circ(58, 58, 15, "url(#dm-paw)")}`,
  left: circ(-58, 58, 15, "url(#dm-paw)"),
  right: circ(58, 58, 15, "url(#dm-paw)"),
  none: "",
};
const POSE_PAWS = { idle: "left", thinking: "right", done: "none", sleep: "base" };

/* ---------- wajah (tiap wajah membawa mulutnya sendiri) ---------- */
const FACE = {
  idle: () => `<g class="dm-bl">${eyesPair()}</g>${mouth("M-9 21q4.5 5 9 0q4.5 5 9 0")}`,
  ready: () => `${brows("M-46-17L-16-12M46-17L16-12", "#8fb0ff")}<g class="dm-bl">${eyesPair(3, 28)}</g>${mouth("M-9 21q9 8 18-4")}`,
  dreamy: () => `${blush("#ff8fb8")}${mouth("M-12 19q12 16 24 0Z", "#7c5cff")}${arcs(true)}`
    + g("translate(86 -30) scale(.9)", `<g class="dm-pu">${heart("#ff8fb8")}</g>`)
    + g("translate(-90 -20) scale(.6)", `<g class="dm-pu" style="animation-delay:.6s">${heart("#ff8fb8")}</g>`),
  grin: () => `${blush("#ff9d7a", 0.5)}<path d="M-18 19q18 22 36 0Z" fill="#7c5cff"/><rect x="-4" y="19" width="8" height="5" rx="1.5" fill="#fff"/>${drop(70, -8)}`
    + `<g class="dm-bl">${eyesPair(2, 30, 9)}</g>`,
  cozy: () => `${blush("#ff9d7a", 0.5)}${mouth("M-9 21q9 7 18 0")}${arcs(false, 6)}`,
  devious: () => `<g class="dm-pu"><path d="M-46-8L-14 4-18 15-44 10Z" fill="#ffe27a"/><path d="M46-8L14 4 18 15 44 10Z" fill="#ffe27a"/></g>`
    + `<ellipse cx="-27" cy="9" rx="2.5" ry="5" fill="#1a1240"/><ellipse cx="27" cy="9" rx="2.5" ry="5" fill="#1a1240"/>`
    + `<path d="M-22 17Q0 40 22 17Q0 25-22 17Z" fill="#2a1560" stroke="#a5b4ff" stroke-width="2"/><path d="M-12 20l4 7 4-5M12 20l-4 7-4-5" fill="#fff"/>`,
  shiver: () => `<g class="dm-shv">${blush("#7ab8ff", 0.5)}${mouth(wavy)}<path d="M-44-4l16 8-16 8M44-4l-16 8 16 8" stroke="#c7d2ff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>`
    + `<circle class="dm-pu" cx="26" cy="38" r="4" fill="#fff" opacity=".7"/><circle class="dm-pu" cx="38" cy="45" r="6" fill="#fff" opacity=".6" style="animation-delay:.3s"/><circle class="dm-pu" cx="52" cy="52" r="8" fill="#fff" opacity=".5" style="animation-delay:.6s"/>`,
  sparkle: () => `${blush("#ff8fd0")}${mouth("M-14 19q14 18 28 0Z", "#7c5cff")}<g class="dm-bl">${eyeC(-30, 0, 13)}${eyeC(30, 0, 13)}${hl(-34, -4, 4)}${hl(26, -4, 4)}${hl(-25, 5, 2)}${hl(35, 5, 2)}</g>`
    + star(-62, -22, "#9aa8ff", 0.7),
  love: () => `${blush("#ff8fb8", 0.55)}${mouth("M-10 20q10 10 20 0")}`
    + `<g transform="translate(-30 2) scale(1.25)"><g class="dm-beat">${heart("#ff5c8a")}</g></g><g transform="translate(30 2) scale(1.25)"><g class="dm-beat" style="animation-delay:.15s">${heart("#ff5c8a")}</g></g>`,
  thinking: () => `${brows("M-46-20L-16-11M46-20L16-11")}<g class="dm-bl"><g class="dm-look">${eyeC(-26, -2)}${eyeC(34, -2)}${hl(-23, -7)}${hl(37, -7)}</g></g>${mouth("M-8 24q8-4 16 0")}`,
  working: () => `<path d="M-44-8L-14 4-18 15-42 10Z" fill="url(#dm-eye)"/><path d="M44-8L14 4 18 15 42 10Z" fill="url(#dm-eye)"/>${mouth("M-8 22q8 4 16 0")}`,
  verifying: () => `${brows("M-46-14h30M46-14H16", "#4fd1c5")}<g class="dm-bl"><g class="dm-look"><ellipse cx="-28" cy="4" rx="12" ry="7" fill="url(#dm-eye)"/><ellipse cx="28" cy="4" rx="12" ry="7" fill="url(#dm-eye)"/>${hl(-31, 2, 3)}${hl(25, 2, 3)}</g></g>${mouth("M-7 23h14")}`,
  fixing: () => `<path d="M-44-8L-14 4-18 15-42 10Z" fill="url(#dm-eye)"/><path d="M44-8L14 4 18 15 42 10Z" fill="url(#dm-eye)"/>${mouth("M-10 22l4-3 4 3 4-3 4 3 4-3")}`,
  permission: () => `${brows("M-44-18q14-8 28 0M16-18q14-8 28 0")}<g class="dm-bl">${eyesPair()}</g><ellipse cx="0" cy="24" rx="4" ry="5" fill="none" stroke="#a5b4ff" stroke-width="2.5"/>`,
  paused: () => `<path d="M-42 5h22M20 5h22" stroke="#c7d2ff" stroke-width="4.5" stroke-linecap="round"/>${mouth("M-7 23h14")}`,
  queued: () => `<g class="dm-bl"><g class="dm-look">${eyeC(-24, 2)}${eyeC(36, 2)}${hl(-20, -2)}${hl(40, -2)}</g></g><ellipse cx="0" cy="23" rx="4" ry="2.5" fill="none" stroke="#a5b4ff" stroke-width="2.5"/>`,
  done: () => `${arcs(true)}${mouth("M-12 22q12 18 24 0Z", "#7c5cff")}`,
  error: () => `<g class="dm-shv">${mouth(wavy)}<path d="M-42-4l18 16M-24-4l-18 16M24-4l18 16M42-4l-18 16" stroke="#ff8a9a" stroke-width="4.5" stroke-linecap="round"/></g>`,
  sleep: () => `${arcs(false, 8)}${mouth("M-6 24q6 4 12 0")}`,
  coding: () => `${brows("M-46-16L-16-12M46-16L16-12", "#8fb0ff")}<g class="dm-bl"><g class="dm-look">${eyeC(-24, 8, 10)}${eyeC(32, 8, 10)}${hl(-22, 12, 3)}${hl(34, 12, 3)}</g></g>${mouth("M-8 22q9 7 17-3")}`,
  document: () => `${brows("M-44-2q14-9 28 0M16-2q14-9 28 0")}<g class="dm-bl" style="animation-duration:6s"><g class="dm-look"><ellipse cx="-30" cy="4" rx="12" ry="6.5" fill="url(#dm-eye)"/><ellipse cx="30" cy="4" rx="12" ry="6.5" fill="url(#dm-eye)"/></g></g>${mouth("M-8 22q8 6 16 0")}`,
  research: () => `${brows("M-44-22q14-10 28-3")}${brows("M14-30q16-10 30 0")}<g class="dm-bl"><g class="dm-look">${eyeC(-28, 2, 10)}${eyeC(32, 0, 15)}${hl(-31, -2, 3)}${hl(27, -5, 5)}</g></g><ellipse cx="0" cy="25" rx="5" ry="6" fill="none" stroke="#a5b4ff" stroke-width="2.5"/>`,
  spreadsheet: () => `${brows("M14-28q16-9 30 0")}<g class="dm-bl">${eyesPair(2, 29)}</g>${mouth("M-9 21q9 7 18 0")}`,
};
FACE.surprised = () => `${brows("M-46-26q14-10 28 0M18-26q14-10 28 0")}${eyeC(-28, 2, 16)}${eyeC(28, 2, 16)}${circ(-28, 2, 5, "#0a0a28")}${circ(28, 2, 5, "#0a0a28")}${hl(-32, -3, 4)}${hl(24, -3, 4)}<ellipse cx="0" cy="28" rx="7" ry="9" fill="#0a0a28" stroke="#a5b4ff" stroke-width="2.5"/>`;
FACE.kiss = () => `${blush("#ff8fb8", 0.55)}${arcs(true)}<ellipse cx="0" cy="24" rx="4.5" ry="3.8" fill="#ff5c8a"/>`;
FACE.wink = () => `${blush("#ff8fb8")}${eyeC(-30, 2)}${hl(-33, -2)}<path d="M18 4q12-12 24 0" stroke="#c7d2ff" stroke-width="4.5" fill="none" stroke-linecap="round"/>${mouth("M-12 19q12 14 24 0Z", "#7c5cff")}`;
FACE.slide = FACE.sparkle;
FACE.captain = FACE.ready;

/** Wajah pose idle mengikuti suasana dekor. */
const MOOD = {
  default: "ready", spring: "dreamy", summer: "grin", autumn: "cozy", halloween: "devious",
  winter: "shiver", christmas: "dreamy", newyear: "sparkle", valentine: "love",
  ramadan: "cozy", eid: "dreamy", independence: "ready",
  batik: "cozy", kimono: "cozy", hanbok: "dreamy", changshan: "ready", kurta: "dreamy",
  thobe: "cozy", jas: "ready", beret: "dreamy", sombrero: "sparkle", aloha: "dreamy",
};
export function faceKeyFor(pose, decor) {
  if (pose === "idle") return MOOD[decor] ?? "idle";
  return pose;
}

/* ---------- aksesori depan per pose ---------- */
const laptop = () => g("translate(36 42)", `<g transform="rotate(-8)"><rect x="-40" y="-40" width="80" height="56" rx="6" fill="#4a4fb8" stroke="#8a93ff" stroke-width="2"/><path d="${STAR}" transform="translate(0 -12)" fill="#a5b4ff"/><rect x="-50" y="16" width="100" height="8" rx="4" fill="#3b3f9c"/></g>`);
const checks = [-14, 2, 18].map((y, i) =>
  `<path class="dm-pu" style="animation-delay:${i * 0.4}s" d="M-18 ${y}l4 4 8-8" stroke="#2fb89f" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M-4 ${y}h18" stroke="#8a93ff" stroke-width="4" stroke-linecap="round"/>`).join("");

const ACC = {
  idle: () => `<g class="dm-sip">${g("translate(78 28)",
    `<path class="dm-pu" d="M-5-20q-6-8 0-14q6-6 0-14M7-20q-6-8 0-14" stroke="#a5b4ff" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M14-6q15 0 15 11q0 11-15 11" stroke="#d7dbff" stroke-width="5" fill="none"/><rect x="-16" y="-16" width="32" height="36" rx="6" fill="#d7dbff"/><ellipse cx="0" cy="-16" rx="16" ry="5" fill="#7a4a2e"/>${circ(-12, 22, 15, "url(#dm-paw)")}`)}</g>`,
  thinking: () => `<circle class="dm-tap" cx="-22" cy="52" r="16" fill="url(#dm-paw)"/>`
    + `<ellipse class="dm-pu" cx="62" cy="-102" rx="26" ry="8" fill="none" stroke="#a5b4ff" stroke-width="5"/>`
    + `<circle class="dm-d1" cx="98" cy="-72" r="8" fill="#5b6cff"/><circle class="dm-d2" cx="84" cy="-48" r="5" fill="#5b6cff"/>`
    + `<text class="dm-pu" x="104" y="-86" font-size="26" font-weight="700" fill="#a5b4ff">?</text>`,
  working: () => `${laptop()}<text class="dm-pu" x="78" y="-68" font-size="30" font-weight="700" fill="#7c8cff">&lt;/&gt;</text>`,
  verifying: () => g("translate(80 36) rotate(6)", `<rect x="-26" y="-34" width="52" height="68" rx="5" fill="#d7dbff"/><rect x="-10" y="-40" width="20" height="10" rx="3" fill="#6f7cff"/>${checks}`),
  fixing: () => g("translate(82 30)", `<g class="dm-sk"><g transform="rotate(35)"><rect x="-4" y="-30" width="8" height="62" rx="4" fill="#b7bfff"/><circle cx="0" cy="-32" r="11" fill="#b7bfff"/><rect x="-3" y="-48" width="6" height="14" fill="#0b0c2a"/></g></g>`)
    + g("translate(-96 -62)", `<g class="dm-spin"><circle r="11" fill="none" stroke="#ffb84a" stroke-width="6" stroke-dasharray="4.3 4.3"/><circle r="5" fill="none" stroke="#ffb84a" stroke-width="3"/></g>`)
    + star(100, -30, "#ffd66b") + drop(-72, -14),
  permission: () => g("translate(66 40)", `<g class="dm-bn"><path d="M0-34L30-22V8Q30 30 0 44Q-30 30-30 8V-22Z" fill="url(#dm-shd)" stroke="#c4bcff" stroke-width="2"/><circle cx="0" cy="-3" r="7" fill="#12103a"/><rect x="-2.5" y="0" width="5" height="16" fill="#12103a"/></g>`)
    + `<g class="dm-sk"><rect x="82" y="-92" width="7" height="26" rx="3.5" fill="#8b7bff"/><circle cx="85.5" cy="-56" r="4.5" fill="#8b7bff"/></g>`,
  paused: () => g("translate(92 -62)", `<g class="dm-pu"><circle r="19" fill="#23266a" stroke="#8c93d9" stroke-width="2.5"/><rect x="-8" y="-9" width="5.5" height="18" rx="2" fill="#c7d2ff"/><rect x="2.5" y="-9" width="5.5" height="18" rx="2" fill="#c7d2ff"/></g>`)
    + `<text class="dm-pu" x="-104" y="-58" font-size="22" font-weight="700" fill="#8c93d9">z</text><text class="dm-pu" x="-90" y="-78" font-size="16" font-weight="700" fill="#8c93d9" style="animation-delay:.6s">z</text>`,
  queued: (ctx) => g("translate(94 14)", `<g class="dm-flip"><path d="M-12-20h24l-9 20 9 20h-24l9-20Z" fill="#23266a" stroke="#b7bfff" stroke-width="3"/><path d="M-6-14h12l-6 10Z" fill="#ffd66b"/></g>`)
    + g("translate(106 -50)", `<circle r="13" fill="#7c4dff"/><text y="5" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${Math.min(99, Math.max(1, Number(ctx?.count) || 2))}</text>`),
  done: () => `<g class="dm-bn">${circ(-92, -2, 16, "url(#dm-paw)")}${circ(-92, 0, 6, "#6a5cff")}</g>`
    + `<g class="dm-bn" style="animation-delay:.5s">${circ(92, -2, 16, "url(#dm-paw)")}${circ(92, 0, 6, "#6a5cff")}</g>`
    + star(98, -82, "#fff", 1.4) + star(-100, -50, "#9aa8ff") + star(110, -45, "#9aa8ff", 1, 0.5),
  error: () => `<g class="dm-sk"><rect x="82" y="-92" width="8" height="26" rx="4" fill="#ff6b81"/><circle cx="86" cy="-55" r="5" fill="#ff6b81"/></g>`
    + drop(-76, -10) + g("translate(-6 -98)", `<g class="dm-spin"><path transform="translate(28 0)" d="${STAR}" fill="#ffd66b"/><path transform="translate(-14 24)" d="${STAR}" fill="#ffd66b"/><path transform="translate(-14 -24)" d="${STAR}" fill="#ffd66b"/></g>`),
  sleep: () => `<text class="dm-pu" x="70" y="-60" font-size="26" font-weight="700" fill="#8c93d9">z</text><text class="dm-pu" x="90" y="-84" font-size="19" font-weight="700" fill="#8c93d9" style="animation-delay:.7s">z</text><text class="dm-pu" x="104" y="-102" font-size="14" font-weight="700" fill="#8c93d9" style="animation-delay:1.4s">z</text>`,
  coding: () => `${laptop()}<g class="dm-pu"><rect x="58" y="-100" width="80" height="48" rx="6" fill="#343a9e" stroke="#7580ff"/><path d="M68-86h10M84-86h40M68-74h8M82-74h30M68-62h40" stroke="#a5b4ff" stroke-width="4" stroke-linecap="round"/></g>`,
  slide: () => g("translate(78 40) rotate(-4)", `<rect x="-38" y="-28" width="76" height="56" rx="5" fill="#d7dbff"/><rect x="-30" y="-20" width="26" height="6" rx="2" fill="#6f7cff"/><path d="M-30 20L-8-2 6 12 16 2 30 20Z" fill="#8b93ff"/>${circ(18, -8, 4, "#6f7cff")}`)
    + `<path class="dm-pu" d="M95-85l8 14M112-70h18" stroke="#6fa0ff" stroke-width="4" stroke-linecap="round"/>`,
  document: () => g("translate(78 42) rotate(8)", `<rect x="-26" y="-34" width="52" height="68" rx="5" fill="#c9cdff"/><path d="M-16-18h32M-16-8h32M-16 2h32M-16 12h20" stroke="#6f7cff" stroke-width="4" stroke-linecap="round"/>`)
    + `<path class="dm-pu" d="M62-92l6 12M78-90h14" stroke="#8b7bff" stroke-width="4" stroke-linecap="round"/>`,
  research: () => `<g class="dm-sk" style="transform-origin:50% 50%"><circle cx="82" cy="-4" r="22" fill="#6f7cff" fill-opacity=".25" stroke="#b7bfff" stroke-width="6"/><path d="M98 12l18 22" stroke="#7580ff" stroke-width="8" stroke-linecap="round"/></g>`
    + g("translate(122 52) rotate(10)", `<rect x="-24" y="-30" width="48" height="60" rx="5" fill="#3a3f9e"/><path d="M-14-14h28M-14-4h28M-14 6h18" stroke="#a5b4ff" stroke-width="4" stroke-linecap="round"/>`)
    + `<path class="dm-pu" d="M100-92l8 14M118-75h16" stroke="#a5b4ff" stroke-width="4" stroke-linecap="round"/>`,
  spreadsheet: () => g("translate(82 40) rotate(-4)", `<rect x="-36" y="-30" width="72" height="60" rx="5" fill="#d7dbff"/><rect x="-36" y="-30" width="72" height="11" rx="5" fill="#4fd18a"/><path d="M-12-19V0M12-19V0M-36-8h72" stroke="#8a93ff" stroke-width="2"/><rect class="dm-bar" x="-28" y="12" width="12" height="14" fill="#6f7cff"/><rect class="dm-bar" x="-10" y="4" width="12" height="22" fill="#4fd18a" style="animation-delay:.3s"/><rect class="dm-bar" x="8" y="9" width="12" height="17" fill="#8b7bff" style="animation-delay:.6s"/>`),
};

/* ---------- dekor ---------- */
const scarf = (c, d) => `<path d="M-62 46Q0 78 62 46L58 64Q0 92-58 64Z" fill="${c}"/><path d="M30 70l10 30 14-6-8-28Z" fill="${d}"/>`;
const flower = (x, y, c) => g(`translate(${x} ${y})`,
  `<g fill="${c}"><circle cy="-6" r="5"/><circle cx="6" cy="-2" r="5"/><circle cx="4" cy="5" r="5"/><circle cx="-4" cy="5" r="5"/><circle cx="-6" cy="-2" r="5"/></g>${circ(0, 0, 3.5, "#ffe27a")}`);
const leaf = (x, y, c, delay = 0) => g(`translate(${x} ${y})`, `<path class="dm-fall" d="${LEAF}" fill="${c}" style="animation-delay:${delay}s"/>`);
const petal = (x, y, c, delay = 0) => `<ellipse class="dm-fall" cx="${x}" cy="${y}" rx="6" ry="3" fill="${c}" style="animation-delay:${delay}s"/>`;
const flake = (x, y, r, delay = 0) => `<circle class="dm-fall" cx="${x}" cy="${y}" r="${r}" fill="#e8efff" style="animation-delay:${delay}s"/>`;
const bat = (x, y, delay = 0) => g(`translate(${x} ${y})`, `<g class="dm-fly" style="animation-delay:${delay}s"><g class="dm-flap"><path d="M-14-4Q-7-10 0 0Q7-10 14-4Q8 0 7 6Q0 2-7 6Q-8 0-14-4Z" fill="#1a1240" stroke="#8b7bff" stroke-width="1.5"/></g></g>`);
const confetti = (x, y, c, delay) => `<rect class="dm-fall" x="${x}" y="${y}" width="7" height="4" rx="1" fill="${c}" style="animation-delay:${delay}s"/>`;
const riseHeart = (x, y, c, s, delay) => g(`translate(${x} ${y}) scale(${s})`, `<path class="dm-rise" d="${HEART}" fill="${c}" style="animation-delay:${delay}s"/>`);
const songkok = `<path d="M-36-58V-80Q-36-90-26-90H26Q36-90 36-80V-58Z" fill="#14122e" stroke="#3a3d7a" stroke-width="2"/><rect x="-36" y="-70" width="72" height="6" fill="#ffc13a"/>`;

const DECOR = {
  default: {
    head: `<path d="M-42-62Q0-108 42-62Z" fill="#2b2fd4" stroke="#8a93ff" stroke-width="2"/><rect x="-52" y="-66" width="104" height="11" rx="5.5" fill="#15187a"/>${star(0, -82, "#ffd66b", 0.9)}`,
    amb: star(-100, -50, "#9aa8ff") + star(102, -40, "#9aa8ff", 1, 0.6),
  },
  spring: {
    head: `<path d="M-62-52Q0-86 62-52" stroke="#5bd18a" stroke-width="5" fill="none"/>${flower(-55, -56, "#ff9ec7")}${flower(-28, -68, "#ffe27a")}${flower(0, -74, "#ff9ec7")}${flower(28, -68, "#ffe27a")}${flower(55, -56, "#ff9ec7")}`,
    amb: petal(-100, -60, "#ff9ec7") + petal(104, -70, "#ffc2dc", 1.5) + petal(0, -100, "#ff9ec7", 2.6),
  },
  summer: {
    eyes: `<rect x="-52" y="-10" width="42" height="26" rx="10" fill="#0b0b22" fill-opacity=".62" stroke="#8fb0ff" stroke-width="2.5"/><rect x="10" y="-10" width="42" height="26" rx="10" fill="#0b0b22" fill-opacity=".62" stroke="#8fb0ff" stroke-width="2.5"/><path d="M-10 0h20M-44-2l10-3M18-2l10-3" stroke="#8fb0ff" stroke-width="3" stroke-linecap="round"/>`,
    amb: g("translate(108 -70)", `${circ(0, 0, 16, "#ffd04a")}<g class="dm-spin"><path d="M0-26v-8M0 26v8M-26 0h-8M26 0h8M18-18l6-6M-18 18l-6 6M18 18l6 6M-18-18l-6-6" stroke="#ffd04a" stroke-width="4" stroke-linecap="round"/></g>`),
  },
  autumn: {
    neck: scarf("#e8833a", "#c9621f"),
    head: g("translate(52 -68) rotate(30)", `<path d="M0-12Q12-5 0 12Q-12-5 0-12Z" fill="#e0523a"/>`),
    amb: leaf(-100, -80, "#ff8a2a") + leaf(0, -110, "#e0523a", 1.3) + leaf(105, -60, "#ffc13a", 2.4),
  },
  halloween: {
    head: `<ellipse cx="0" cy="-66" rx="58" ry="11" fill="#3a1f7a"/><path d="M-32-68L6-136Q10-142 18-132L32-68Z" fill="#5a2fb0"/><rect x="-33" y="-82" width="66" height="12" fill="#2a1560"/><rect x="-7" y="-83" width="14" height="14" fill="none" stroke="#ffc13a" stroke-width="3"/>`,
    amb: g("translate(-100 54)", `<ellipse rx="22" ry="18" fill="#ff8a1f"/><ellipse rx="9" ry="18" fill="#ff9d3f" opacity=".6"/><rect x="-2" y="-26" width="5" height="9" fill="#4a8a3a"/><g class="dm-pu" fill="#ffe27a"><path d="M-12-5l5-6 5 6zM2-5l5-6 5 6z"/><path d="M-10 6q10 8 20 0l-4-2-3 3-3-3-3 3-3-3z"/></g>`)
      + bat(98, -92) + bat(-98, -70, 1),
  },
  winter: {
    neck: scarf("#4fa3ff", "#2b6fd4"),
    head: `<path d="M-40-60Q0-112 40-60Z" fill="#e0526a"/><rect x="-44" y="-64" width="88" height="12" rx="6" fill="#f2f4ff"/>${circ(0, -102, 9, "#f2f4ff")}`,
    amb: flake(-100, -70, 3.5) + flake(-40, -115, 3, 1) + flake(60, -110, 4, 2) + flake(105, -70, 3, 3),
  },
  christmas: {
    head: `<path d="M-40-62Q-30-112 20-116Q52-116 62-90Q44-98 30-84L38-62Z" fill="#e0323c"/><rect x="-46" y="-68" width="90" height="14" rx="7" fill="#f6f7ff"/><g class="dm-bn">${circ(62, -90, 9, "#f6f7ff")}</g>`,
    amb: flake(-100, -70, 3.5) + flake(-40, -118, 3, 1) + flake(104, -75, 4, 2) + star(-104, -30, "#ffd66b", 0.8, 0.4),
  },
  newyear: {
    head: `<path d="M-26-66L6-132 38-66Z" fill="#7c5cff"/>${circ(4, -100, 3, "#fff")}${circ(-8, -84, 3, "#ffd66b")}${circ(16, -84, 3, "#fff")}${circ(-2, -72, 3, "#ff8fb8")}${star(6, -134, "#ffd66b", 0.9)}`,
    amb: confetti(-100, -90, "#ff6b81", 0) + confetti(-60, -110, "#ffd66b", 0.8) + confetti(70, -105, "#4fd1c5", 1.6)
      + confetti(104, -80, "#8b7bff", 2.2) + confetti(-110, -40, "#4fd1c5", 2.8) + confetti(112, -30, "#ff6b81", 3.2)
      + star(-96, -40, "#ffd66b", 0.8) + star(100, -55, "#fff", 0.7, 0.5),
  },
  valentine: {
    head: g("translate(44 -68) rotate(15) scale(1.6)", heart("#ff5c8a")),
    amb: riseHeart(-96, 20, "#ff8fb8", 1, 0) + riseHeart(100, 10, "#ff5c8a", 1.2, 1.2) + riseHeart(-70, -40, "#ff8fb8", 0.8, 2.4),
  },
  ramadan: {
    head: songkok,
    amb: g("translate(104 -78)", `<path d="M4-14a14 14 0 1 0 0 28a11 11 0 1 1 0-28Z" fill="#ffd66b"/>`) + star(78, -100, "#ffd66b", 0.7)
      + g("translate(-100 -70)", `<g class="dm-sk"><path d="M0-22V-8" stroke="#b7bfff" stroke-width="2"/><path d="M-9-8h18l-3 22h-12Z" fill="#ff9d3f" stroke="#ffd66b" stroke-width="2"/><rect x="-6" y="14" width="12" height="4" fill="#ffd66b"/></g>`),
  },
  eid: {
    head: songkok,
    amb: g("translate(-100 44)", `<path d="M0-34V-16" stroke="#b7bfff" stroke-width="2"/><g transform="rotate(45)"><rect x="-15" y="-15" width="30" height="30" rx="3" fill="#4fb870" stroke="#2a8a50" stroke-width="2"/><path d="M-15 0H15M0-15V15M-8-8L8 8M8-8L-8 8" stroke="#2a8a50" stroke-width="1.5"/></g>`)
      + star(-96, -64, "#ffd66b", 0.8) + star(100, -66, "#ffd66b", 1, 0.5) + star(108, -10, "#fff", 0.6, 1),
  },
  independence: {
    head: `<path d="M-84-28Q-50-62 0-62" stroke="#e8283c" stroke-width="12" fill="none"/><path d="M0-62Q50-62 84-28" stroke="#f4f4ff" stroke-width="12" fill="none"/>`,
    amb: `<rect x="100" y="-112" width="4" height="92" rx="2" fill="#cdd1ff"/>` + g("translate(104 -110)", `<g class="dm-wave"><rect width="44" height="14" fill="#e8283c"/><rect y="14" width="44" height="14" fill="#f4f4ff"/></g>`),
  },
};


/* ---------- kostum baju tradisional (hanya manual) ---------- */
const robe = (fill, extra = "") => `<path d="M-62 44Q0 68 62 44L66 84Q0 100-66 84Z" fill="${fill}"${extra}/>`;
const lantern = (x, y, c) => g(`translate(${x} ${y})`, `<g class="dm-sk"><path d="M0-22V-8" stroke="#b7bfff" stroke-width="2"/><path d="M-9-8h18l-3 22h-12Z" fill="${c}" stroke="#ffd66b" stroke-width="2"/><rect x="-6" y="14" width="12" height="4" fill="#ffd66b"/></g>`);
const note = (x, y, ch, delay) => `<text class="dm-rise" x="${x}" y="${y}" font-size="22" font-weight="700" fill="#ffd66b" style="animation-delay:${delay}s">${ch}</text>`;

const COSTUME = {
  batik: {
    neck: `${robe("url(#dm-batik)")}<path d="M-24 46L0 76 24 46Z" fill="#f4e2b8"/><path d="M-62 44Q0 68 62 44" stroke="#e8b563" stroke-width="3" fill="none"/>`,
    head: `<path d="M-38-58Q-38-86 0-88Q38-86 38-58Q38-50 0-52Q-38-50-38-58Z" fill="url(#dm-batik)" stroke="#3b2314" stroke-width="2"/><path d="M-38-60Q0-54 38-60" stroke="#3b2314" stroke-width="4" fill="none"/>`,
    amb: star(-100, -50, "#e8b563", 0.8) + star(102, -44, "#e8b563", 0.7, 0.6),
  },
  kimono: {
    neck: `${robe("#d94a6a")}<path d="M-26 46L2 84M26 46L-2 84" stroke="#f6f7ff" stroke-width="7" stroke-linecap="round"/><rect x="-66" y="68" width="132" height="14" rx="3" fill="#ffd66b" stroke="#e8a93a" stroke-width="2"/><rect x="34" y="62" width="22" height="24" rx="4" fill="#e8a93a"/>${circ(-44, 58, 2.4, "#ffd1e0")}${circ(-30, 62, 2.4, "#ffd1e0")}${circ(40, 54, 2.4, "#ffd1e0")}${circ(-52, 74, 2.4, "#ffd1e0")}`,
    head: flower(58, -62, "#ffb7d1") + `<path d="M50-52L36-40" stroke="#ffd66b" stroke-width="3" stroke-linecap="round"/>`,
    amb: petal(-100, -60, "#ffc2dc") + petal(104, -70, "#ffb7d1", 1.4) + petal(0, -104, "#ffc2dc", 2.5),
  },
  hanbok: {
    neck: `<path d="M-64 62Q0 78 64 62L78 88Q0 106-78 88Z" fill="#ff8fb8"/><ellipse cx="-76" cy="60" rx="14" ry="20" fill="#ffe27a" stroke="#f4c14a" stroke-width="2"/><ellipse cx="76" cy="60" rx="14" ry="20" fill="#ffe27a" stroke="#f4c14a" stroke-width="2"/><path d="M-60 44Q0 66 60 44L58 66Q0 80-58 66Z" fill="#ffe27a" stroke="#f4c14a" stroke-width="2"/><path d="M-18 46L0 66 18 46" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="-9" cy="62" rx="9" ry="5" transform="rotate(-20 -9 62)" fill="#e8283c"/><ellipse cx="9" cy="62" rx="9" ry="5" transform="rotate(20 9 62)" fill="#e8283c"/><path d="M0 64l-6 22M0 64l6 22" stroke="#e8283c" stroke-width="4" stroke-linecap="round"/>`,
    head: `<g transform="translate(56 -58) rotate(18)"><ellipse cx="-8" cy="0" rx="9" ry="5.5" fill="#e8283c"/><ellipse cx="8" cy="0" rx="9" ry="5.5" fill="#e8283c"/>${circ(0, 0, 4, "#ffd66b")}<path d="M0 4l-5 18M0 4l5 18" stroke="#e8283c" stroke-width="3.5" stroke-linecap="round"/></g>`,
    amb: petal(-100, -60, "#ff9ec7") + petal(104, -70, "#ffc2dc", 1.5),
  },
  changshan: {
    neck: `${robe("#c9202f")}<path d="M-62 44Q0 68 62 44" stroke="#ffd66b" stroke-width="3" fill="none"/><path d="M-24 42Q0 54 24 42L22 56Q0 66-22 56Z" fill="#a8161f"/><path d="M-20 56L30 80" stroke="#ffd66b" stroke-width="3" stroke-linecap="round"/>${circ(-10, 62, 3, "#ffd66b")}${circ(6, 70, 3, "#ffd66b")}${circ(20, 77, 3, "#ffd66b")}`,
    head: `<path d="M-34-58Q-34-84 0-84Q34-84 34-58Q0-52-34-58Z" fill="#14122e" stroke="#ffd66b" stroke-width="2"/>${circ(0, -86, 5, "#d9283c")}`,
    amb: lantern(-100, -66, "#e8283c") + star(102, -48, "#ffd66b", 0.8, 0.5),
  },
  kurta: {
    neck: `${robe("#1fa89a")}<path d="M-22 44Q0 56 22 44" stroke="#ffd66b" stroke-width="4" fill="none"/><path d="M0 54V84" stroke="#ffd66b" stroke-width="3"/>${circ(0, 62, 2.6, "#ffd66b")}${circ(0, 72, 2.6, "#ffd66b")}${circ(0, 82, 2.6, "#ffd66b")}<path d="M-56 48L30 82" stroke="#ff9d3f" stroke-width="10" stroke-linecap="round" opacity=".92"/><path d="M-56 48L30 82" stroke="#ffd66b" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round"/>`,
    head: flower(52, -62, "#ff9d3f") + flower(66, -48, "#ffc13a"),
    amb: petal(-100, -60, "#ff9d3f") + petal(104, -70, "#ffc13a", 1.4) + petal(0, -104, "#ff9d3f", 2.5),
  },
  thobe: {
    neck: `${robe("#f2f4ff")}<path d="M0 48V82" stroke="#c7ccf0" stroke-width="3"/><path d="M-20 44Q0 58 20 44" stroke="#c7ccf0" stroke-width="4" fill="none"/>${circ(0, 62, 2.2, "#c7ccf0")}${circ(0, 72, 2.2, "#c7ccf0")}`,
    head: `<path d="M-86-14Q-84-84 0-88Q84-84 86-14L72 0Q64-44 0-52Q-64-44-72 0Z" fill="url(#dm-kef)" stroke="#c7ccf0" stroke-width="1.5"/><ellipse cx="0" cy="-70" rx="46" ry="9" fill="none" stroke="#14122e" stroke-width="6"/>`,
    amb: star(-100, -50, "#ffd66b", 0.8) + star(102, -44, "#ffd66b", 0.7, 0.6),
  },
  jas: {
    neck: `${robe("#3a3f5c")}<path d="M-16 48L0 82 16 48Z" fill="#f6f7ff"/><path d="M-16 48L-34 64M16 48L34 64" stroke="#2a2e48" stroke-width="4" stroke-linecap="round"/><path d="M-4 56L4 56 6 78 0 84-6 78Z" fill="#d9283c"/>`,
    head: `<ellipse cx="0" cy="-64" rx="54" ry="9" fill="#0d0d22"/><path d="M-36-62Q-36-98 0-98Q36-98 36-62Z" fill="#14122e"/><rect x="-36" y="-74" width="72" height="8" fill="#5a5f8a"/>`,
    amb: "",
  },
  beret: {
    neck: `${scarf("#3a5bd9", "#2a45b0")}<path d="M-40 56l6 14M-14 62l4 14M14 62l-4 14M40 56l-6 14" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`,
    head: `<g transform="rotate(-8)"><path d="M-44-62Q-42-94 6-94Q46-92 50-66Q50-60 0-58Q-44-58-44-62Z" fill="#d9283c"/><rect x="2" y="-101" width="6" height="9" rx="2" fill="#9a1623"/></g>`,
    amb: star(-100, -50, "#ffd66b", 0.7) + star(102, -44, "#fff", 0.7, 0.6),
  },
  sombrero: {
    neck: `<path d="M-66 44Q0 68 66 44L78 90Q0 112-78 90Z" fill="#e0523a"/><path d="M-72 66Q0 90 72 66" stroke="#ffd66b" stroke-width="6" fill="none"/><path d="M-75 80Q0 104 75 80" stroke="#4fd1c5" stroke-width="6" fill="none"/>`,
    head: `<ellipse cx="0" cy="-60" rx="80" ry="15" fill="#e8b24a" stroke="#b8862a" stroke-width="2"/><path d="M-28-62Q-26-104 0-106Q26-104 28-62Z" fill="#e8b24a" stroke="#b8862a" stroke-width="2"/><path d="M-28-70Q0-64 28-70" stroke="#d9283c" stroke-width="8" fill="none"/>${circ(-58, -58, 2.4, "#d9283c")}${circ(-36, -50, 2.4, "#d9283c")}${circ(36, -50, 2.4, "#d9283c")}${circ(58, -58, 2.4, "#d9283c")}`,
    amb: note(-104, -40, "♪", 0) + note(104, -60, "♫", 1.2),
  },
  aloha: {
    neck: `${robe("url(#dm-aloha)")}<path d="M-24 46L0 72 24 46Z" fill="#1d8f9b"/>`
      + [-50, -34, -17, 0, 17, 34, 50].map((x, i) => circ(x, +(46 + (1 - (x / 54) ** 2) * 24).toFixed(1), 6, ["#ff5c8a", "#ffd66b", "#ff9d3f", "#fff"][i % 4])).join(""),
    head: g("translate(58 -58) scale(1.4)", `<g fill="#ff5c8a"><circle cy="-6" r="5"/><circle cx="6" cy="-2" r="5"/><circle cx="4" cy="5" r="5"/><circle cx="-4" cy="5" r="5"/><circle cx="-6" cy="-2" r="5"/></g>${circ(0, 0, 3.5, "#ffe27a")}`),
    amb: g("translate(108 -70)", `${circ(0, 0, 16, "#ffd04a")}<g class="dm-spin"><path d="M0-26v-8M0 26v8M-26 0h-8M26 0h8M18-18l6-6M-18 18l-6 6M18 18l6 6M-18-18l-6-6" stroke="#ffd04a" stroke-width="4" stroke-linecap="round"/></g>`)
      + petal(-100, -60, "#ff9ec7"),
  },
};
Object.assign(DECOR, COSTUME);

/* ------------------------------------------------------------------ */
/* Animasi klik                                                        */
/* ------------------------------------------------------------------ */

const armLine = (x1, y1, x2, y2, w = 13) => `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="url(#dm-hood)" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;
const pawC = (x, y, r = 13) => `${circ(x, y, r, "url(#dm-paw)")}${circ(x, y + r * 0.35, r * 0.4, "#6a5cff")}`;
const pop = (inner, delay = 0) => `<g class="dm-pop" style="animation-delay:${delay}s">${inner}</g>`;
const rotatingPaw = (tx, ty, inner) => g(`translate(${tx} ${ty})`, `<g class="dm-pawwave">${inner}</g>`);

/** Percikan partikel dari tengah (deterministik, tanpa Math.random). */
function burst(n, make, dist = 90, cy = -20) {
  let out = "";
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.35;
    const d = dist * (0.72 + 0.28 * ((i * 7) % 5) / 4);
    const dx = (Math.cos(a) * d).toFixed(0);
    const dy = (Math.sin(a) * d * 0.85 - 12).toFixed(0);
    const rot = ((i * 97) % 360) - 180;
    out += make(i, `--dx:${dx}px;--dy:${dy}px;--rot:${rot}deg;animation-delay:${((i % 4) * 0.04).toFixed(2)}s`);
  }
  return g(`translate(0 ${cy})`, out);
}
const confettiBurst = () => burst(16, (i, st) =>
  `<rect class="dm-burst" x="-3" y="-2" width="7" height="4" rx="1" fill="${["#ff6b81", "#ffd66b", "#4fd1c5", "#8b7bff", "#fff"][i % 5]}" style="${st}"/>`);
const dropBurst = () => burst(10, (i, st) => `<circle class="dm-burst" r="4" fill="${i % 2 ? "#7ad7ff" : "#bfeeff"}" style="${st}"/>`, 80);
const leafBurst = () => burst(10, (i, st) => `<path class="dm-burst" d="${LEAF}" fill="${["#ff8a2a", "#e0523a", "#ffc13a"][i % 3]}" style="${st}"/>`);
const petalBurst = () => burst(12, (i, st) => `<ellipse class="dm-burst" rx="6" ry="3" fill="${["#ff9ec7", "#ffc2dc", "#ffe27a", "#fff"][i % 4]}" style="${st}"/>`, 95);
const snowBurst = () => burst(12, (i, st) => `<circle class="dm-burst" r="${3 + (i % 3)}" fill="#e8efff" style="${st}"/>`, 100);
const twinkles = () => [[-96, -70], [98, -76], [-70, -108], [74, -112], [-108, -10], [110, -20]]
  .map(([x, y], i) => g(`translate(${x} ${y})`, `<path class="dm-twfx" d="${STAR}" fill="#ffd66b" style="animation-delay:${(i * 0.12).toFixed(2)}s"/>`)).join("");
const flyBat = (y, d) => g(`translate(0 ${y})`, `<g class="dm-fxbat" style="animation-delay:${d}s"><g class="dm-flap"><path d="M-14-4Q-7-10 0 0Q7-10 14-4Q8 0 7 6Q0 2-7 6Q-8 0-14-4Z" fill="#1a1240" stroke="#8b7bff" stroke-width="1.5"/></g></g>`);
const fallingSnow = () => [-104, -80, -52, -24, 6, 34, 62, 88, 108, -66].map((x, i) =>
  `<circle class="dm-fall" cx="${x}" cy="-112" r="${3 + (i % 3)}" fill="#e8efff" style="animation-duration:1.7s;animation-delay:${(i * 0.09).toFixed(2)}s"/>`).join("");
const rising = (items) => items.map(([x, y, c, s, d]) => riseHeart(x, y, c, s, d)).join("");
const joinedPaws = (y) => `${circ(-8, y, 14, "url(#dm-paw)")}${circ(8, y, 14, "url(#dm-paw)")}<path d="M0 ${y - 10}v20" stroke="#6a5cff" stroke-width="2"/>`;

/**
 * Tiap aksi: s=detik, face=wajah sementara, paws=tangan dasar saat aksi,
 * hideAcc=sembunyikan aksesori pose, fxb=efek menempel badan, fxa=efek di luar badan.
 */
const ACTIONS = {
  salute: { s: 1.5, face: "ready", paws: "left", hideAcc: true,
    fxb: () => pop(armLine(66, 24, 52, -48) + pawC(50, -54)) + star(64, -78, "#ffd66b", 1, 0.3) },
  tiphat: { s: 1.6, face: "ready", paws: "left", hideAcc: true,
    fxb: () => pop(armLine(66, 24, 52, -48) + pawC(50, -54)) },
  twirl: { s: 1.5, face: "dreamy", fxa: petalBurst },
  splash: { s: 1.5, face: "grin", fxa: dropBurst },
  leaves: { s: 1.6, face: "cozy", fxa: leafBurst },
  shiverfx: { s: 1.5, face: "shiver", fxa: snowBurst },
  startle: { s: 1.7, face: "surprised", fxa: () => flyBat(-92, 0) + flyBat(-62, 0.15) + flyBat(-112, 0.3) },
  sway: { s: 1.8, face: "dreamy", fxa: fallingSnow },
  jump: { s: 1.5, face: "sparkle", fxa: confettiBurst },
  kiss: { s: 1.6, face: "kiss",
    fxa: () => g("translate(12 24)", `<path class="dm-fxheart" d="${HEART}" fill="#ff5c8a"/>`)
      + rising([[-90, 10, "#ff8fb8", 1, 0.1], [96, 0, "#ff5c8a", 1.2, 0.5], [-60, -50, "#ff8fb8", 0.8, 0.9]]) },
  nod: { s: 1.8, face: "cozy", fxa: twinkles },
  wave: { s: 1.7, face: "ready", paws: "left", hideAcc: true,
    fxb: () => pop(rotatingPaw(62, 38, `${armLine(0, 0, 24, -48)}${pawC(24, -52, 14)}`)) },
  sembah: { s: 1.8, face: "cozy", paws: "none", hideAcc: true,
    fxb: () => pop(joinedPaws(34)) + star(0, 8, "#e8b563", 0.8, 0.5) },
  ojigi: { s: 1.9, face: "cozy", fxa: () => petalBurst() },
  sleeve: { s: 1.7, face: "dreamy", paws: "left", hideAcc: true,
    fxb: () => pop(rotatingPaw(60, 50, `<path d="M0-10L52-48Q70-28 54 10Z" fill="#ffe27a" stroke="#f4c14a" stroke-width="2"/>${pawC(56, -42, 12)}`)),
    fxa: petalBurst },
  gongshou: { s: 1.8, face: "ready", paws: "none", hideAcc: true,
    fxb: () => pop(`<rect x="-10" y="26" width="26" height="22" rx="10" fill="url(#dm-paw)"/>${circ(-12, 38, 11, "#8c9bff", ' stroke="#6a5cff" stroke-width="2"')}`) },
  namaste: { s: 1.8, face: "dreamy", paws: "none", hideAcc: true,
    fxb: () => pop(joinedPaws(40)),
    fxa: () => burst(8, (i, st) => `<ellipse class="dm-burst" rx="5" ry="3" fill="${i % 2 ? "#ff9d3f" : "#ffc13a"}" style="${st}"/>`, 85) },
  greet: { s: 1.7, face: "cozy", paws: "left", hideAcc: true,
    fxb: () => pop(rotatingPaw(62, 40, `${armLine(0, 0, 26, -46)}${pawC(28, -52, 15)}`)) + star(98, -74, "#ffd66b", 0.9, 0.4) },
  wink: { s: 1.5, face: "wink",
    fxa: () => rising([[70, -20, "#ff8fb8", 0.9, 0.1], [-84, 0, "#ff5c8a", 1, 0.5]]) + star(52, -2, "#fff", 0.8, 0.1) },
  mariachi: { s: 1.8, face: "sparkle",
    fxa: () => note(-104, -30, "♪", 0) + note(100, -50, "♫", 0.3) + note(-76, -80, "♫", 0.6) + note(78, -96, "♪", 0.9) },
  shaka: { s: 1.8, face: "dreamy", paws: "left", hideAcc: true,
    fxb: () => pop(rotatingPaw(62, 38, `${armLine(0, 0, 24, -46)}${pawC(26, -52, 14)}${circ(38, -58, 5, "#a4b0ff")}${circ(14, -64, 5, "#a4b0ff")}`)),
    fxa: petalBurst },
};
ACTIONS.hop = { s: 1.2, face: null };

export const ACTION_OF = {
  default: "salute", spring: "twirl", summer: "splash", autumn: "leaves", winter: "shiverfx",
  halloween: "startle", christmas: "sway", newyear: "jump", valentine: "kiss", ramadan: "nod",
  eid: "nod", independence: "wave", batik: "sembah", kimono: "ojigi", hanbok: "sleeve",
  changshan: "gongshou", kurta: "namaste", thobe: "greet", jas: "tiphat", beret: "wink",
  sombrero: "mariachi", aloha: "shaka",
};

/** Gerak badan per aksi: [keyframes, detik, transform-origin]. */
const O_BOT = "0px 70px";
const MOTION = {
  salute: ["0%,100%{transform:none}30%,70%{transform:rotate(-3deg)}", 1.5, O_BOT],
  tiphat: ["0%,100%{transform:none}30%,70%{transform:rotate(-3deg)}", 1.6, O_BOT],
  twirl: ["0%,100%{transform:scale(1,1)}50%{transform:scale(-1,1) translateY(-14px)}", 1.5, "0px 0px"],
  splash: ["0%,100%{transform:none}25%{transform:translateY(-14px) rotate(-5deg)}50%{transform:rotate(5deg)}75%{transform:translateY(-8px) rotate(-3deg)}", 1.5, O_BOT],
  leaves: ["0%,100%{transform:rotate(0)}25%{transform:rotate(-5deg)}60%{transform:rotate(5deg)}", 1.6, O_BOT],
  shiverfx: ["0%,100%{transform:translateX(0)}10%{transform:translateX(-3px)}20%{transform:translateX(3px)}30%{transform:translateX(-3px)}40%{transform:translateX(3px)}50%{transform:translateX(-3px)}60%{transform:translateX(3px)}70%{transform:translateX(-2px)}80%{transform:translateX(2px)}", 1.5, O_BOT],
  startle: ["0%{transform:none}12%{transform:translate(-10px,-8px) scale(1.08)}30%{transform:translate(-6px,-3px) scale(1.05)}100%{transform:none}", 1.7, O_BOT],
  sway: ["0%,100%{transform:rotate(0)}20%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}80%{transform:rotate(-4deg)}", 1.8, O_BOT],
  jump: ["0%,100%{transform:none}20%{transform:translateY(-30px) scale(.97,1.04)}40%{transform:translateY(0) scale(1.05,.94)}60%{transform:translateY(-30px) scale(.97,1.04)}80%{transform:translateY(0) scale(1.05,.94)}", 1.5, O_BOT],
  kiss: ["0%,100%{transform:none}30%,60%{transform:rotate(-6deg) translateX(-4px)}", 1.6, O_BOT],
  nod: ["0%,100%{transform:rotate(0)}35%,60%{transform:rotate(9deg) translateY(4px)}", 1.8, O_BOT],
  wave: ["0%,100%{transform:rotate(0)}25%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}75%{transform:rotate(-3deg)}", 1.7, O_BOT],
  sembah: ["0%,100%{transform:none}30%,65%{transform:rotate(14deg) translate(6px,6px)}", 1.8, O_BOT],
  ojigi: ["0%,100%{transform:none}30%,70%{transform:rotate(22deg) translate(8px,10px)}", 1.9, O_BOT],
  sleeve: ["0%,100%{transform:rotate(0)}30%{transform:rotate(-4deg)}65%{transform:rotate(4deg)}", 1.7, O_BOT],
  gongshou: ["0%,100%{transform:none}30%,65%{transform:rotate(9deg) translate(3px,3px)}", 1.8, O_BOT],
  namaste: ["0%,100%{transform:none}30%,65%{transform:rotate(7deg) translate(2px,3px)}", 1.8, O_BOT],
  greet: ["0%,100%{transform:none}25%{transform:translateY(-8px)}50%{transform:rotate(3deg)}", 1.7, O_BOT],
  wink: ["0%,100%{transform:none}40%,70%{transform:rotate(-7deg)}", 1.5, O_BOT],
  mariachi: ["0%,100%{transform:rotate(0)}12%{transform:rotate(-8deg)}25%{transform:rotate(8deg)}37%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}62%{transform:rotate(-8deg)}75%{transform:rotate(8deg)}87%{transform:rotate(-4deg)}", 1.8, O_BOT],
  shaka: ["0%,100%{transform:rotate(0)}30%{transform:rotate(-5deg)}65%{transform:rotate(5deg)}", 1.8, O_BOT],
  hop: ["0%,100%{transform:none}30%{transform:translateY(-12px) scale(1.04)}60%{transform:translateY(1px)}", 1.2, O_BOT],
};
const CSS_ACT = Object.entries(MOTION).map(([n, [kf, sec, org]]) =>
  `@keyframes dm-m-${n}{${kf}}.dae-m[data-act="${n}"] .dm-rx{transform-origin:${org};animation:dm-m-${n} ${sec}s ease both}`).join("")
  + `.dm-pop{transform-box:fill-box;transform-origin:center;animation:dm-pop .28s cubic-bezier(.2,1.3,.4,1) both}
@keyframes dm-pop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
.dm-burst{transform-box:fill-box;transform-origin:center;animation:dm-burst 1.3s cubic-bezier(.2,.8,.3,1) both}
@keyframes dm-burst{0%{transform:translate(0,0) rotate(0) scale(.3);opacity:0}12%{opacity:1}100%{transform:translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}
.dm-fxbat{animation:dm-fxbat 1.6s linear both}
@keyframes dm-fxbat{0%{transform:translate(-190px,0);opacity:0}10%{opacity:1}100%{transform:translate(190px,-26px);opacity:1}}
.dm-fxheart{transform-box:fill-box;transform-origin:center;animation:dm-fxheart 1.4s ease-out both}
@keyframes dm-fxheart{0%{transform:translate(0,0) scale(.4);opacity:0}15%{opacity:1}100%{transform:translate(90px,-50px) scale(1.4);opacity:0}}
.dm-twfx{transform-box:fill-box;transform-origin:center;animation:dm-twfx 1.2s ease-in-out both}
@keyframes dm-twfx{0%{transform:scale(0) rotate(0)}40%{transform:scale(1.5) rotate(45deg)}100%{transform:scale(0) rotate(90deg)}}
.dm-pawwave{transform-origin:0 0;animation:dm-pawwave .5s ease-in-out infinite alternate}
@keyframes dm-pawwave{from{transform:rotate(-16deg)}to{transform:rotate(16deg)}}
.dae-m[data-act="tiphat"] [data-slot="head"]{transform-box:fill-box;transform-origin:center;animation:dm-lift 1.6s ease both}
.dae-m[data-act="salute"] [data-slot="head"]{transform-box:fill-box;transform-origin:center;animation:dm-lift2 1.5s ease both}
@keyframes dm-lift{0%,100%{transform:none}25%,70%{transform:translate(12px,-22px) rotate(14deg)}}
@keyframes dm-lift2{0%,100%{transform:none}25%,70%{transform:translateY(-8px)}}
.dae-m[data-act="wave"] .dm-wave{animation-duration:.5s}
`;

/* ------------------------------------------------------------------ */
/* CSS (animasi + pill)                                                */
/* ------------------------------------------------------------------ */

const CSS_ANIM = `
.dae-m{display:block;width:100%;height:100%;overflow:visible}
.dm-v{opacity:0;transition:opacity .22s ease}.dm-v.on{opacity:1}
.dm-gz{transition:transform .14s ease-out}
.dm-fl{animation:dm-fl 3.2s ease-in-out infinite}
@keyframes dm-fl{50%{transform:translateY(-7px)}}
.dm-shw{transform-box:fill-box;transform-origin:center;animation:dm-shw 3.2s ease-in-out infinite}
@keyframes dm-shw{50%{transform:scale(.9)}}
.dm-bl{transform-box:fill-box;transform-origin:center;animation:dm-bl 4.5s infinite}
@keyframes dm-bl{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
.dm-pu{animation:dm-pu 1.8s ease-in-out infinite}
@keyframes dm-pu{50%{opacity:.35}}
.dm-tw{transform-box:fill-box;transform-origin:center;animation:dm-tw 1.6s ease-in-out infinite}
@keyframes dm-tw{50%{transform:scale(.4) rotate(45deg);opacity:.5}}
.dm-sk{transform-box:fill-box;transform-origin:50% 100%;animation:dm-sk 1.4s ease-in-out infinite}
@keyframes dm-sk{0%,100%{transform:rotate(0)}25%{transform:rotate(-12deg)}75%{transform:rotate(12deg)}}
.dm-bn{animation:dm-bn 2s ease-in-out infinite}
@keyframes dm-bn{50%{transform:translateY(-5px)}}
.dm-d1,.dm-d2,.dm-d3{animation:dm-dd 1.2s infinite}
.dm-d2{animation-delay:.2s}.dm-d3{animation-delay:.4s}
@keyframes dm-dd{0%,100%{opacity:.25}40%{opacity:1}}
.dm-fall{transform-box:fill-box;transform-origin:center;animation:dm-fall 4s linear infinite}
@keyframes dm-fall{0%{transform:translate(0,-10px) rotate(0);opacity:0}15%{opacity:1}100%{transform:translate(14px,70px) rotate(200deg);opacity:0}}
.dm-rise{transform-box:fill-box;transform-origin:center;animation:dm-rise 3.6s ease-in infinite}
@keyframes dm-rise{0%{transform:translateY(0);opacity:0}20%{opacity:1}100%{transform:translateY(-70px);opacity:0}}
.dm-spin{transform-box:fill-box;transform-origin:center;animation:dm-spin 8s linear infinite}
@keyframes dm-spin{to{transform:rotate(360deg)}}
.dm-fly{animation:dm-fly 3s ease-in-out infinite}
@keyframes dm-fly{50%{transform:translate(14px,-10px)}}
.dm-flap{transform-box:fill-box;transform-origin:center;animation:dm-flap .5s ease-in-out infinite}
@keyframes dm-flap{50%{transform:scaleY(.5)}}
.dm-shv{animation:dm-shv .15s linear infinite}
@keyframes dm-shv{0%,100%{transform:translateX(-1.5px)}50%{transform:translateX(1.5px)}}
.dm-sip{animation:dm-sip 5s ease-in-out infinite}
@keyframes dm-sip{0%,55%,100%{transform:none}68%,85%{transform:translate(-30px,-22px) rotate(-14deg)}}
.dm-look{animation:dm-look 3.5s ease-in-out infinite}
@keyframes dm-look{0%,100%{transform:translate(0,0)}30%{transform:translate(7px,-3px)}65%{transform:translate(-5px,-3px)}}
.dm-tap{animation:dm-tap 1s ease-in-out infinite}
@keyframes dm-tap{50%{transform:translateY(-4px)}}
.dm-flip{transform-box:fill-box;transform-origin:center;animation:dm-flip 4s ease-in-out infinite}
@keyframes dm-flip{0%,45%{transform:rotate(0)}60%,100%{transform:rotate(180deg)}}
.dm-bar{transform-box:fill-box;transform-origin:50% 100%;animation:dm-bar 2s ease-in-out infinite}
@keyframes dm-bar{50%{transform:scaleY(.55)}}
.dm-beat{transform-box:fill-box;transform-origin:center;animation:dm-beat 1.1s ease-in-out infinite}
@keyframes dm-beat{50%{transform:scale(1.18)}}
.dm-wave{transform-box:fill-box;transform-origin:left center;animation:dm-wave 1.6s ease-in-out infinite}
@keyframes dm-wave{50%{transform:skewY(7deg) scaleX(.93)}}
.dm-react .dm-rx{animation:dm-hop .55s ease}
@keyframes dm-hop{30%{transform:translateY(-10px) scale(1.04)}60%{transform:translateY(1px)}}
.dae-m[data-size="sm"] .dm-amb{display:none}
.dae-m.dm-frozen *,.dm-away .dae-m *{animation-play-state:paused!important}
@media (prefers-reduced-motion:reduce){.dae-m *{animation:none!important}}
${CSS_ACT}`;

/** Penyesuaian pill/header supaya maskot tampil utuh (menimpa styles.css lama). */
const CSS_LAYOUT = `
.pill .mascot.mascot-sm,.pill-ring .mascot.mascot-sm{width:30px!important;height:30px!important;border-radius:0!important;overflow:visible!important;outline:none!important;animation:none!important}
.identity .mascot{width:44px;height:44px}
.pill.pill-dnd .dae-m *{animation-play-state:paused!important}
`;

/* ------------------------------------------------------------------ */
/* SVG mandiri (untuk preview / ekspor / uji)                          */
/* ------------------------------------------------------------------ */

const VIEWBOX = { sm: "-100 -112 200 200", md: "-125 -135 250 250", lg: "-150 -150 300 300" };

function layers({ pose, decor, ctx }) {
  const dec = DECOR[decor] ?? DECOR.default;
  const pawKey = POSE_PAWS[pose] ?? "base";
  const faceKey = faceKeyFor(pose, decor);
  return {
    amb: dec.amb ?? "",
    neck: dec.neck ?? "",
    paws: PAWS[pawKey],
    face: (FACE[faceKey] ?? FACE.idle)(),
    eyes: dec.eyes ?? "",
    head: dec.head ?? "",
    acc: (ACC[pose] ?? ACC.idle)(ctx),
  };
}

/**
 * SVG lengkap & berdiri sendiri (animasi CSS ikut di dalamnya).
 * @param {{pose?:string,status?:string,engine?:string,decor?:string,size?:"sm"|"md"|"lg",count?:number}} o
 */
export function mascotSvgString(o = {}) {
  const pose = o.pose ?? resolvePose(o.status ?? "idle", o.engine);
  const decor = ALL_KEYS.includes(o.decor) ? o.decor : currentDecor();
  const size = VIEWBOX[o.size] ? o.size : "lg";
  const l = layers({ pose, decor, ctx: { count: o.count } });
  return `<svg xmlns="${NS}" class="dae-m" viewBox="${VIEWBOX[size]}" data-size="${size}" data-pose="${pose}" data-decor="${decor}">`
    + (o.bare ? "" : `<style>${CSS_ANIM}</style>${defsMarkup()}`)
    + `<g class="dm-amb">${l.amb}</g><ellipse class="dm-shw" cx="0" cy="72" rx="100" ry="16" fill="url(#dm-sh)"/>`
    + `<g class="dm-rx"><g class="dm-fl">${BODY}${l.neck}${l.paws}<g class="dm-gz">${l.face}</g>${l.eyes}${l.head}${l.acc}</g></g></svg>`;
}

/** Kompat mascot.js lama (dulu <img>, sekarang SVG inline mandiri). */
export function mascotHtml(status = "idle", cls = "") {
  const decor = currentDecor();
  return `<span class="mascot-inline ${cls}" data-season="${decor}" data-variant="${resolvePose(status)}">${mascotSvgString({ status, decor, size: "md" })}</span>`;
}

/* ------------------------------------------------------------------ */
/* Runtime DOM                                                         */
/* ------------------------------------------------------------------ */

const instances = new Set();
let booted = false;
let pillEl = null;
let pillObserver = null;
let globalState = { status: "idle", engine: "", count: 0 };
let decorTimer = null;

function ensureAssets() {
  if (document.getElementById("dae-m-style")) return;
  const st = document.createElement("style");
  st.id = "dae-m-style";
  st.textContent = CSS_ANIM + CSS_LAYOUT;
  document.head.appendChild(st);
  const sprite = document.createElementNS(NS, "svg");
  sprite.setAttribute("id", "dae-m-sprite");
  sprite.setAttribute("width", "0");
  sprite.setAttribute("height", "0");
  sprite.setAttribute("aria-hidden", "true");
  sprite.setAttribute("focusable", "false");
  sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  sprite.innerHTML = defsMarkup();
  document.body.appendChild(sprite);
}

class Mascot {
  constructor(host) {
    this.host = host;
    this.pose = null;
    this.decor = null;
    this.cur = {};
    this.count = 0;
    this.sleepTimer = null;
    this.size = host.dataset.size
      || (host.classList.contains("mascot-sm") ? "sm" : host.closest(".identity") ? "md" : "lg");
    host.innerHTML = `<svg xmlns="${NS}" class="dae-m" viewBox="${VIEWBOX[this.size] ?? VIEWBOX.lg}" data-size="${this.size}" aria-hidden="true" focusable="false">`
      + `<g class="dm-amb" data-slot="amb"></g><ellipse class="dm-shw" cx="0" cy="72" rx="100" ry="16" fill="url(#dm-sh)"/>`
      + `<g class="dm-rx"><g class="dm-fl">${BODY}<g data-slot="neck"></g><g data-slot="paws"></g><g class="dm-gz" data-slot="face"></g>`
      + `<g data-slot="eyes"></g><g data-slot="head"></g><g data-slot="acc"></g><g data-slot="fxb"></g></g></g><g data-slot="fxa"></g></svg>`;
    this.svg = host.firstElementChild;
    this.slots = {};
    this.svg.querySelectorAll("[data-slot]").forEach((n) => { this.slots[n.dataset.slot] = n; });
    this._onEnter = () => this._react();
    this._onClick = () => this.act();
    host.addEventListener("pointerenter", this._onEnter);
    host.addEventListener("click", this._onClick);
  }

  destroy() {
    clearTimeout(this.sleepTimer);
    clearTimeout(this._actT);
    this.host.removeEventListener("pointerenter", this._onEnter);
    this.host.removeEventListener("click", this._onClick);
  }

  _put(slot, key, html) {
    if (this.cur[slot] === key) return;
    this.cur[slot] = key;
    const node = this.slots[slot];
    if (!node) return;
    const instant = document.hidden || !this.svg.isConnected;
    [...node.children].forEach((old) => {
      old.classList.remove("on");
      if (instant) old.remove(); else setTimeout(() => old.remove(), 300);
    });
    if (!html) return;
    const v = document.createElementNS(NS, "g");
    v.setAttribute("class", "dm-v");
    v.innerHTML = html;
    node.appendChild(v);
    if (instant) v.classList.add("on");
    else requestAnimationFrame(() => requestAnimationFrame(() => v.classList.add("on")));
  }

  /** Terapkan status/engine/dekor. */
  apply({ status, engine, decor, count }) {
    const want = resolvePose(status, engine);
    if (want === "idle" && this._asleep) {
      this._pose("sleep", decor, count);
      return;
    }
    this._asleep = false;
    clearTimeout(this.sleepTimer);
    this._pose(want, decor, count);
    if (SLEEP_ENABLED && SLEEP_MS > 0 && want === "idle") {
      this.sleepTimer = setTimeout(() => {
        this._asleep = true;
        this._pose("sleep", this.decor, this.count);
      }, SLEEP_MS);
    }
  }

  _pose(pose, decor, count) {
    const d = ALL_KEYS.includes(decor) ? decor : this.decor ?? "default";
    const c = Number.isFinite(count) ? count : this.count;
    const same = pose === this.pose && d === this.decor && c === this.count;
    if (same) return;
    const l = layers({ pose, decor: d, ctx: { count: c } });
    this.pose = pose;
    this.decor = d;
    this.count = c;
    this.svg.dataset.pose = pose;
    this.svg.dataset.decor = d;
    this.host.dataset.pose = pose;
    this.host.dataset.decor = d;
    this._put("amb", `amb:${d}`, l.amb);
    this._put("neck", `neck:${d}`, l.neck);
    this._put("eyes", `eyes:${d}`, l.eyes);
    this._put("head", `head:${d}`, l.head);
    if (!this._acting) this._putBase(l);
    this.slots.face.style.transform = "";
  }

  /** Slot yang bergantung pada pose (dilewati selama animasi klik, dipulihkan sesudahnya). */
  _putBase(l) {
    const { pose, decor: d, count: c } = this;
    this._put("paws", `paws:${POSE_PAWS[pose] ?? "base"}`, l.paws);
    this._put("face", `face:${faceKeyFor(pose, d)}`, l.face);
    this._put("acc", `acc:${pose}:${pose === "queued" ? c : ""}`, l.acc);
  }

  /** Animasi klik sesuai dekor/kostum aktif (visual saja, 1–2 detik). */
  act(name) {
    if (this._acting || prefersReducedMotion()) return false;
    if (this._asleep) { this._asleep = false; this.apply(globalState_as(this)); }
    const key = name && ACTIONS[name] ? name : ACTION_OF[this.decor] ?? "hop";
    const a = ACTIONS[key];
    this._acting = true;
    this.svg.dataset.act = key;
    if (a.face) this._put("face", `fx:${key}`, FACE[a.face]());
    if (a.paws) this._put("paws", `fx:${key}`, PAWS[a.paws]);
    if (a.hideAcc) this._put("acc", `fx:${key}`, "");
    this._put("fxb", `fx:${key}`, a.fxb ? a.fxb() : "");
    this._put("fxa", `fx:${key}`, a.fxa ? a.fxa() : "");
    clearTimeout(this._actT);
    this._actT = setTimeout(() => this._endAct(), Math.round(a.s * 1000) + 120);
    return true;
  }

  _endAct() {
    this._acting = false;
    delete this.svg.dataset.act;
    this._put("fxb", "", "");
    this._put("fxa", "", "");
    const l = layers({ pose: this.pose, decor: this.decor, ctx: { count: this.count } });
    this.cur.paws = null; this.cur.face = null; this.cur.acc = null;
    this._putBase(l);
  }

  _react() {
    if (this._asleep) { this._asleep = false; this.apply(globalState_as(this)); }
    this.svg.classList.add("dm-react");
    clearTimeout(this._reactT);
    this._reactT = setTimeout(() => this.svg.classList.remove("dm-react"), 600);
  }

  gaze(dx, dy) {
    if (!this.slots.face || this.pose === "sleep" || this.pose === "error") return;
    this.slots.face.style.transform = `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)`;
  }
}

function globalState_as(inst) {
  return { status: globalState.status, engine: globalState.engine, decor: inst.decor, count: globalState.count };
}

let previewKey = null;

function prefersReducedMotion() {
  try { return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true; } catch { return false; }
}

/** Tandai <html data-decor> supaya CSS tema ikut berganti + beri tahu panel lain. */
function syncRootDecor(decor) {
  const root = document.documentElement;
  if (root.dataset.decor === decor) return;
  root.dataset.decor = decor;
  root.dataset.decorKind = COSTUME_KEYS.includes(decor) ? "costume" : "season";
  try {
    window.dispatchEvent(new CustomEvent("dae:decor", { detail: { decor, kind: root.dataset.decorKind, pref: getDecorPref() } }));
  } catch { /* abaikan */ }
}

function applyAll() {
  const decor = previewKey ?? currentDecor();
  syncRootDecor(decor);
  instances.forEach((m) => m.apply({ ...globalState, decor }));
}

/* ---------- gaze: mata mengikuti kursor ---------- */
let gazeRaf = 0;
let gazePoint = null;
function onPointerMove(e) {
  gazePoint = { x: e.clientX, y: e.clientY };
  if (gazeRaf) return;
  gazeRaf = requestAnimationFrame(() => {
    gazeRaf = 0;
    if (!gazePoint) return;
    instances.forEach((m) => {
      const r = m.host.getBoundingClientRect();
      if (!r.width) return;
      const dx = gazePoint.x - (r.left + r.width / 2);
      const dy = gazePoint.y - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, dist / 160);
      m.gaze((dx / dist) * k * 4.5, (dy / dist) * k * 3);
    });
  });
}
function onPointerLeave() {
  gazePoint = null;
  instances.forEach((m) => m.gaze(0, 0));
}

function readPill() {
  if (!pillEl) return null;
  const status = pillEl.dataset.status || "idle";
  const engine = pillEl.dataset.engine || "";
  let count = 0;
  if (status === "queued") {
    const m = /(\d+)/.exec(pillEl.querySelector("#pill-text")?.textContent ?? "");
    count = m ? Number(m[1]) : 0;
  }
  return { status, engine, count };
}

function watchPill() {
  const el = document.getElementById("pill");
  if (!el || el === pillEl) return;
  pillObserver?.disconnect();
  pillEl = el;
  pillObserver = new MutationObserver(() => {
    const s = readPill();
    if (!s) return;
    globalState = s;
    applyAll();
  });
  pillObserver.observe(el, { attributes: true, attributeFilter: ["data-status", "data-engine"] });
  const text = el.querySelector("#pill-text");
  if (text) pillObserver.observe(text, { childList: true, characterData: true, subtree: true });
  const s = readPill();
  if (s) globalState = s;
}

function boot() {
  if (booted) return;
  booted = true;
  document.addEventListener("pointermove", onPointerMove, { passive: true });
  document.documentElement.addEventListener("mouseleave", onPointerLeave);
  window.addEventListener("blur", onPointerLeave);
  document.addEventListener("visibilitychange", () => {
    document.documentElement.classList.toggle("dm-away", document.hidden);
  });
  // Dekor otomatis: cek ulang tiap 30 menit (ganti hari/peristiwa tanpa restart).
  decorTimer = setInterval(applyAll, 30 * 60 * 1000);
}

/** Pasang maskot ke semua `.mascot` yang belum terpasang. Idempotent. */
export function mountMascots(root = document) {
  ensureAssets();
  boot();
  root.querySelectorAll(".mascot").forEach((host) => {
    if (host.querySelector(":scope > svg.dae-m")) return;
    const m = new Mascot(host);
    host._dae = m;
    instances.add(m);
  });
  for (const m of [...instances]) {
    if (!m.host.isConnected) { m.destroy(); instances.delete(m); }
  }
  watchPill();
  applyAll();
}

/** Kompat: dipanggil app.js saat boot → refreshMascots("idle"). */
export function refreshMascots(status = "idle") {
  mountMascots();
  const fromPill = readPill();
  globalState = fromPill && fromPill.status !== "idle" ? fromPill : { status, engine: "", count: 0 };
  applyAll();
}

/**
 * Ganti status maskot. Contoh: setMascotStatus("thinking"),
 * setMascotStatus("working", "slide"), setMascotStatus("queued", "", 3).
 */
export function setMascotStatus(status, engine = "", count = 0) {
  if (!booted) mountMascots();
  globalState = { status, engine, count };
  applyAll();
}

/** Simpan pilihan dekor ("auto" | "events" | "default" | kunci dekor) lalu terapkan. */
export function setMascotDecor(pref = "auto") {
  if (!DECOR_PREFS.includes(pref)) throw new Error(`dekor tidak dikenal: ${pref}`);
  memPref = pref;
  try { localStorage.setItem(PREF_KEY, pref); } catch { /* abaikan */ }
  previewKey = null;
  if (booted) applyAll();
  return currentDecor();
}

/** Pastikan CSS + sprite gradient terpasang (dipakai panel yang menampilkan SVG bare). */
export function ensureMascotAssets() {
  ensureAssets();
}

/** Info dekor yang sedang berlaku. */
export function getDecorInfo() {
  const pref = getDecorPref();
  const decor = previewKey ?? currentDecor();
  const isCostume = COSTUME_KEYS.includes(decor);
  return {
    pref, decor, auto: pref === "auto" || pref === "events", previewing: previewKey !== null,
    kind: isCostume ? "costume" : eventDecor() === decor ? "event" : "season",
    label: ALL_LABELS[decor] ?? decor,
  };
}

/** Pratinjau sementara (tidak disimpan). previewMascotDecor(null) mengembalikan pilihan tersimpan. */
export function previewMascotDecor(key = null) {
  if (key !== null && !ALL_KEYS.includes(key)) throw new Error(`dekor tidak dikenal: ${key}`);
  previewKey = key;
  if (booted) applyAll();
}

/**
 * Mainkan animasi aksi (visual saja). Tanpa argumen: semua maskot yang terlihat
 * memainkan aksi sesuai dekor aktif. name = nama aksi tertentu (lihat ACTION_OF).
 */
export function triggerMascotAction(name) {
  if (!booted) return false;
  let any = false;
  instances.forEach((m) => {
    if (!m.host.isConnected || !m.host.getClientRects().length) return;
    if (m.act(name)) any = true;
  });
  return any;
}

/** Lepas observer/timer (untuk uji atau hot-reload). */
export function disposeMascots() {
  instances.forEach((m) => m.destroy());
  instances.clear();
  pillObserver?.disconnect();
  pillObserver = null;
  pillEl = null;
  clearInterval(decorTimer);
  previewKey = null;
  booted = false;
}

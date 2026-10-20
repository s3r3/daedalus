/**
 * Model per peran — 2 tier (Fase 5, Dae Captain v2).
 *
 * Master design §7 "Model per Peran (2 Tier)": model dipilih **per peran,
 * bukan per engine**. Dua tier:
 *
 * - 🧠 `strong` — reasoning dalam: tulis, analisis, desain, sintesis.
 * - ⚡ `light`  — cepat + murah: chat, list, format, UI.
 *
 * Default cerdas: user cukup isi 1 model (`default`) → semua peran pakai itu.
 * Tier ringan opsional: kalau `light` kosong, peran ringan jatuh ke `default`.
 *
 * CATATAN NAMA: `ModelTier` di sini ("strong" | "light") adalah tier peran
 * Dae Captain, BERBEDA dari `ModelTier` di `contracts.ts`
 * ("strong" | "balanced" | "fast") yang dipakai model-pool untuk failover.
 * Keduanya hidup di namespace ekspor yang berbeda (workflow vs contracts).
 *
 * Fase 5 hanya menyediakan mapping + resolver + config. Wiring aktual ke
 * pemanggilan LLM (provider swap / opsi model per panggilan) dilakukan
 * bertahap di fase berikutnya.
 */

import type { WorkflowEngine } from "./types.ts";

/** Tier model per peran Dae Captain: 🧠 kuat (tulis/analisis/desain/sintesis) atau ⚡ ringan (chat/list/format/UI). */
export type ModelTier = "strong" | "light";

export const MODEL_TIERS: readonly ModelTier[] = ["strong", "light"] as const;

/** Label UI (Indonesia) per tier, untuk settings di Fase 8. */
export const MODEL_TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  strong: "🧠 Kuat",
  light: "⚡ Ringan",
} as const;

/**
 * Konfigurasi model per peran.
 *
 * - `default`: satu model yang user isi — semua peran pakai ini kecuali
 *   dioverride. (Smart default: 1 model = semua peran.)
 * - `strong` / `light`: override opsional per tier. Kalau `light` kosong,
 *   peran ringan ikut `default`.
 */
export type RoleModelConfig = {
  default: string;
  strong?: string;
  light?: string;
};

/** Peran model sebagai string bebas: "<engine>.<peran>". */
export type ModelRole = string;

// ---------------------------------------------------------------------------
// Konstanta peran per engine (sesuai tabel master design §7)
// ---------------------------------------------------------------------------

/** Coding: tulis/plan → 🧠; baca/ringkas/chat → ⚡. */
export const CODING_ROLES = {
  WRITE: "coding.write",
  PLAN: "coding.plan",
  READ: "coding.read",
  SUMMARIZE: "coding.summarize",
  CHAT: "coding.chat",
} as const;

/** Slide: mayoritas 🧠 (inti = generasi konten + desain); chat/progress → ⚡. */
export const SLIDE_ROLES = {
  OUTLINE: "slide.outline",
  GENERATE: "slide.generate",
  REFINE: "slide.refine",
  NOTES: "slide.notes",
  CHAT: "slide.chat",
} as const;

/** Dokumen: klasifikasi/ekstraksi/generate/banding → 🧠; chat/format → ⚡. */
export const DOKUMEN_ROLES = {
  CLASSIFY: "dokumen.classify",
  EXTRACT: "dokumen.extract",
  GENERATE: "dokumen.generate",
  COMPARE: "dokumen.compare",
  CHAT: "dokumen.chat",
} as const;

/** Spreadsheet: rencana/interpretasi/blueprint → 🧠; chat/format → ⚡. Angka deterministik (bukan LLM). */
export const SPREADSHEET_ROLES = {
  PLAN: "spreadsheet.plan",
  INSIGHT: "spreadsheet.insight",
  BLUEPRINT: "spreadsheet.blueprint",
  CHAT: "spreadsheet.chat",
} as const;

/** Research: mayoritas 🧠 (inti = sintesis); chat/progress/bibliografi → ⚡. */
export const RESEARCH_ROLES = {
  PLAN: "research.plan",
  SYNTHESIZE: "research.synthesize",
  WRITE: "research.write",
  COMPARE: "research.compare",
  CHAT: "research.chat",
} as const;

// ---------------------------------------------------------------------------
// ROLE_TIER_MAP: peran → tier, persis mengikuti tabel master design §7
// ---------------------------------------------------------------------------

/** Mapping peran → tier untuk semua 5 engine. Peran tak dikenal = fallback ke `default`. */
export const ROLE_TIER_MAP: Readonly<Record<string, ModelTier>> = {
  // Coding (§7: tulis/refactor/debug + rencana → 🧠; baca/list, ringkas output, chat → ⚡)
  [CODING_ROLES.WRITE]: "strong",
  [CODING_ROLES.PLAN]: "strong",
  [CODING_ROLES.READ]: "light",
  [CODING_ROLES.SUMMARIZE]: "light",
  [CODING_ROLES.CHAT]: "light",
  // Slide (§7: outline, generate, varian, speaker notes → 🧠; chat/kartu template/progress → ⚡)
  [SLIDE_ROLES.OUTLINE]: "strong",
  [SLIDE_ROLES.GENERATE]: "strong",
  [SLIDE_ROLES.REFINE]: "strong",
  [SLIDE_ROLES.NOTES]: "strong",
  [SLIDE_ROLES.CHAT]: "light",
  // Dokumen (§7: klasifikasi, ekstraksi, generate, banding → 🧠; chat/format/kartu → ⚡)
  [DOKUMEN_ROLES.CLASSIFY]: "strong",
  [DOKUMEN_ROLES.EXTRACT]: "strong",
  [DOKUMEN_ROLES.GENERATE]: "strong",
  [DOKUMEN_ROLES.COMPARE]: "strong",
  [DOKUMEN_ROLES.CHAT]: "light",
  // Spreadsheet (§7: rencana analisis, interpretasi insight, blueprint → 🧠; chat/format/progress → ⚡)
  [SPREADSHEET_ROLES.PLAN]: "strong",
  [SPREADSHEET_ROLES.INSIGHT]: "strong",
  [SPREADSHEET_ROLES.BLUEPRINT]: "strong",
  [SPREADSHEET_ROLES.CHAT]: "light",
  // Research (§7: rencana, baca+sintesis, tulis laporan, banding → 🧠; chat/progress/bibliografi → ⚡)
  [RESEARCH_ROLES.PLAN]: "strong",
  [RESEARCH_ROLES.SYNTHESIZE]: "strong",
  [RESEARCH_ROLES.WRITE]: "strong",
  [RESEARCH_ROLES.COMPARE]: "strong",
  [RESEARCH_ROLES.CHAT]: "light",
} as const;

/** Info satu peran untuk settings UI (Fase 8): label Indonesia + tier + engine. */
export type ModelRoleInfo = {
  role: string;
  engine: WorkflowEngine;
  /** Label Indonesia sesuai tabel master design §7. */
  label: string;
  tier: ModelTier;
};

/** Label Indonesia per peran (urutan mengikuti tabel master design §7). */
const ROLE_INFOS: readonly ModelRoleInfo[] = [
  { role: CODING_ROLES.WRITE, engine: "coding", label: "Tulis / refactor / debug kode", tier: "strong" },
  { role: CODING_ROLES.PLAN, engine: "coding", label: "Rencana (plan mode)", tier: "strong" },
  { role: CODING_ROLES.READ, engine: "coding", label: "Baca file, list struktur", tier: "light" },
  { role: CODING_ROLES.SUMMARIZE, engine: "coding", label: "Ringkas output terminal", tier: "light" },
  { role: CODING_ROLES.CHAT, engine: "coding", label: "Balas chat", tier: "light" },
  { role: SLIDE_ROLES.OUTLINE, engine: "slide", label: "Generate outline", tier: "strong" },
  { role: SLIDE_ROLES.GENERATE, engine: "slide", label: "Generate slide (konten + layout)", tier: "strong" },
  { role: SLIDE_ROLES.REFINE, engine: "slide", label: "Perbaiki / varian desain", tier: "strong" },
  { role: SLIDE_ROLES.NOTES, engine: "slide", label: "Speaker notes", tier: "strong" },
  { role: SLIDE_ROLES.CHAT, engine: "slide", label: "Balas chat, kartu template, progress", tier: "light" },
  { role: DOKUMEN_ROLES.CLASSIFY, engine: "dokumen", label: "Klasifikasi dokumen", tier: "strong" },
  { role: DOKUMEN_ROLES.EXTRACT, engine: "dokumen", label: "Ekstraksi field", tier: "strong" },
  { role: DOKUMEN_ROLES.GENERATE, engine: "dokumen", label: "Generate makalah / laporan", tier: "strong" },
  { role: DOKUMEN_ROLES.COMPARE, engine: "dokumen", label: "Banding dua dokumen (interpretasi)", tier: "strong" },
  { role: DOKUMEN_ROLES.CHAT, engine: "dokumen", label: "Balas chat, format JSON/CSV, kartu hasil", tier: "light" },
  { role: SPREADSHEET_ROLES.PLAN, engine: "spreadsheet", label: "Rencana analisis", tier: "strong" },
  { role: SPREADSHEET_ROLES.INSIGHT, engine: "spreadsheet", label: "Interpretasi hasil → insight", tier: "strong" },
  { role: SPREADSHEET_ROLES.BLUEPRINT, engine: "spreadsheet", label: "Blueprint workbook", tier: "strong" },
  { role: SPREADSHEET_ROLES.CHAT, engine: "spreadsheet", label: "Balas chat, format output, progress", tier: "light" },
  { role: RESEARCH_ROLES.PLAN, engine: "research", label: "Rencana riset", tier: "strong" },
  { role: RESEARCH_ROLES.SYNTHESIZE, engine: "research", label: "Baca & sintesis sumber", tier: "strong" },
  { role: RESEARCH_ROLES.WRITE, engine: "research", label: "Tulis laporan", tier: "strong" },
  { role: RESEARCH_ROLES.COMPARE, engine: "research", label: "Banding sumber, dalami temuan", tier: "strong" },
  { role: RESEARCH_ROLES.CHAT, engine: "research", label: "Balas chat, progress, format bibliografi", tier: "light" },
];

/** Daftar peran yang dikenal, opsional difilter per engine (untuk settings UI). */
export function listRoles(engine?: WorkflowEngine): ModelRoleInfo[] {
  return engine === undefined
    ? [...ROLE_INFOS]
    : ROLE_INFOS.filter((info) => info.engine === engine);
}

/** Tier untuk satu peran; `undefined` kalau peran tak dikenal (resolveModel lalu fallback ke default). */
export function roleTier(role: string): ModelTier | undefined {
  return ROLE_TIER_MAP[role];
}

// ---------------------------------------------------------------------------
// Config: normalisasi + resolve
// ---------------------------------------------------------------------------

/**
 * Normalisasi config mentah (mis. dari settings.json / API) menjadi
 * RoleModelConfig. String kosong = unset. Tidak pernah throw — field sampah
 * diabaikan, field wajib `default` boleh kosong (resolver lalu kembalikan "").
 */
export function normalizeRoleModelConfig(value: unknown): RoleModelConfig {
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const raw = record[key];
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const config: RoleModelConfig = { default: pick("default") ?? "" };
  const strong = pick("strong");
  const light = pick("light");
  if (strong !== undefined) config.strong = strong;
  if (light !== undefined) config.light = light;
  return config;
}

/**
 * Bangun RoleModelConfig dari sumber yang punya `modelRoles` (mis. core
 * `Settings`) — dengan `default` jatuh ke `llm.model` (satu model user =
 * semua peran). Terima tipe struktural agar workflow tidak bergantung ke
 * core/settings (hindari import cycle).
 */
export function roleModelConfigFrom(source?: ModelRolesSource): RoleModelConfig {
  const stored = source?.modelRoles ?? {};
  const config = normalizeRoleModelConfig(stored);
  if (config.default === "") {
    const llmModel = typeof source?.llm?.model === "string" ? source.llm.model.trim() : "";
    config.default = llmModel;
  }
  return config;
}

/**
 * Kembalikan model ID untuk satu peran.
 *
 * - Peran tier `strong` → `config.strong` bila diisi, kalau tidak `config.default`.
 * - Peran tier `light` → `config.light` bila diisi, kalau tidak `config.default`.
 * - Peran tak dikenal → `config.default`.
 * - `config` boleh di-skip: resolve murni dari tier (pakai "" sebagai default).
 */
export function resolveModel(role: string, config: RoleModelConfig = { default: "" }): string {
  const tier = roleTier(role);
  // Peran tak dikenal → default (bukan strong): aman, tidak mengasumsikan tier.
  if (tier === undefined) return config.default.trim();
  const override = tier === "light" ? config.light : config.strong;
  const trimmed = typeof override === "string" ? override.trim() : "";
  return trimmed !== "" ? trimmed : config.default.trim();
}

/** Sumber ber-`modelRoles` (mis. core `Settings`): `default` jatuh ke `llm.model`. */
export type ModelRolesSource = {
  llm?: { model?: string | null };
  modelRoles?: Partial<Pick<RoleModelConfig, "default" | "strong" | "light">> | null;
};

function isRoleModelConfig(value: unknown): value is RoleModelConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof (value as { default?: unknown }).default === "string"
  );
}

/**
 * Helper siap-panggil dari router/engine: terima config langsung atau
 * sumber ber-`modelRoles` (mis. core `Settings`). Tidak menyentuh cara
 * engine memanggil LLM saat ini — hanya memilih model ID per peran.
 */
export function getModelFor(role: string, source?: RoleModelConfig | ModelRolesSource): string {
  if (isRoleModelConfig(source)) {
    return resolveModel(role, normalizeRoleModelConfig(source));
  }
  return resolveModel(role, roleModelConfigFrom(source));
}

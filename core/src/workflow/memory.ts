import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomicSync } from "../fs-atomic.ts";
import { join } from "node:path";

/**
 * Dae Captain long-term memory (v2, Fase 4A): per-user, cross-session.
 *
 * The event timeline (timeline.ts) is per-run. This store is per USER and
 * survives across runs and restarts: preferences (template favorit, format
 * default), facts (nama, proyek aktif), and correction patterns
 * (mis. format NPWP per perusahaan — written by the dokumen engine via
 * `learnFromCorrection()`).
 *
 * Design source: "Dae Captain - Master Design.md", Arsitektur Global
 * #8.1 (Memori antar-sesi). The user can inspect and wipe everything via
 * settings ("apa yang kamu ingat tentang saya?") — `getAllMemories()` and
 * `forgetAll()` exist for exactly that.
 *
 * Persistence: one JSON file per user, same directory pattern as the run
 * store — `<root>/workflow/memory/<userId>.json`. Synchronous fs.
 *
 * PRIVACY RULE (hard): memories never store credentials or secrets. Any
 * write whose key matches a blocked pattern (password, token, secret,
 * api_key, credential — case-insensitive) throws a descriptive Error and
 * nothing is persisted. Sensitive document contents are likewise never
 * written here; only the distilled preference/fact/pattern.
 */

/** One learned pattern: a correction or habit tied to a context. */
export interface CorrectionPattern {
  kind: string;
  pattern: string;
  value: string;
  updatedAt: string;
}

export interface UserMemoryData {
  userId: string;
  preferences: Record<string, unknown>;
  facts: Record<string, string>;
  patterns: CorrectionPattern[];
  updatedAt: string;
}

/** Input for `learnFromCorrection` — the dokumen engine calls this. */
export interface CorrectionInput {
  /** What was corrected, e.g. "format NPWP untuk PT Maju Jaya". */
  context: string;
  /** The corrected / preferred value, e.g. "12.345.678.9-012.345". */
  corrected: string;
  /** Optional observer, e.g. "dokumen" — prefixed to the stored pattern. */
  source?: string;
}

/**
 * Key substrings that may never be stored. Checked case-insensitively
 * against preference keys, fact keys, and pattern identifiers.
 */
export const SENSITIVE_KEY_PATTERNS = [
  "password",
  "token",
  "secret",
  "api_key",
  "credential",
] as const;

function assertSafeKey(what: string, key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error(`memory: ${what} key must be a non-empty string`);
  }
  const hit = SENSITIVE_KEY_PATTERNS.find((p) =>
    key.toLowerCase().includes(p),
  );
  if (hit) {
    throw new Error(
      `memory: refusing to store ${what} under sensitive key "${key}" ` +
        `(matched blocked pattern "${hit}"). Long-term memory never stores ` +
        `credentials, tokens, or secrets.`,
    );
  }
}

/** Make a userId safe for use as a single path segment. */
function safeFileStem(userId: string): string {
  const stem = userId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  if (stem.length === 0) throw new Error("memory: userId must not be empty");
  return stem;
}

function emptyData(userId: string): UserMemoryData {
  return {
    userId,
    preferences: {},
    facts: {},
    patterns: [],
    updatedAt: new Date().toISOString(),
  };
}

function isCorrectionPattern(value: unknown): value is CorrectionPattern {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.kind === "string" &&
    typeof v.pattern === "string" &&
    typeof v.value === "string" &&
    typeof v.updatedAt === "string"
  );
}

/**
 * Per-user long-term memory. Every method reads the JSON file fresh and
 * writes it back, so concurrent instances on the same file cannot clobber
 * each other's writes with stale state. Corrupt files are treated as
 * empty (never thrown on read).
 */
export class UserMemory {
  readonly root: string;
  readonly userId: string;

  constructor(root: string, userId: string) {
    if (!root) throw new Error("memory: root must be a non-empty string");
    this.root = root;
    this.userId = userId;
    // Validate eagerly so a bad userId fails fast, not on first write.
    safeFileStem(userId);
  }

  private dir(): string {
    return join(this.root, "workflow", "memory");
  }

  private file(): string {
    return join(this.dir(), `${safeFileStem(this.userId)}.json`);
  }

  private load(): UserMemoryData {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file(), "utf8"));
    } catch {
      return emptyData(this.userId);
    }
    if (typeof raw !== "object" || raw === null) return emptyData(this.userId);
    const r = raw as Record<string, unknown>;
    const data = emptyData(
      typeof r.userId === "string" ? r.userId : this.userId,
    );
    if (typeof r.preferences === "object" && r.preferences !== null) {
      data.preferences = r.preferences as Record<string, unknown>;
    }
    if (typeof r.facts === "object" && r.facts !== null) {
      data.facts = r.facts as Record<string, string>;
    }
    if (Array.isArray(r.patterns)) {
      data.patterns = (r.patterns as unknown[]).filter(isCorrectionPattern);
    }
    return data;
  }

  private save(data: UserMemoryData): void {
    mkdirSync(this.dir(), { recursive: true });
    data.updatedAt = new Date().toISOString();
    writeFileAtomicSync(this.file(), JSON.stringify(data, null, 2));
  }

  /**
   * Store a preference (template favorit, format default, ...).
   * Throws on sensitive keys — nothing is persisted.
   */
  rememberPreference(key: string, value: unknown): void {
    assertSafeKey("preference", key);
    const data = this.load();
    data.preferences[key] = value;
    this.save(data);
  }

  /** Store a fact (nama, proyek aktif, ...). Throws on sensitive keys. */
  rememberFact(key: string, value: string): void {
    assertSafeKey("fact", key);
    const data = this.load();
    data.facts[key] = value;
    this.save(data);
  }

  /**
   * Store a correction/habit pattern. Same (kind, pattern) upserts: the
   * value and timestamp are refreshed instead of appending a duplicate.
   * Throws when `pattern` looks like a sensitive key.
   */
  rememberPattern(kind: string, pattern: string, value: string): void {
    assertSafeKey("pattern", pattern);
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw new Error("memory: pattern kind must be a non-empty string");
    }
    const data = this.load();
    const existing = data.patterns.find(
      (p) => p.kind === kind && p.pattern === pattern,
    );
    if (existing) {
      existing.value = value;
      existing.updatedAt = new Date().toISOString();
    } else {
      data.patterns.push({
        kind,
        pattern,
        value,
        updatedAt: new Date().toISOString(),
      });
    }
    this.save(data);
  }

  /**
   * Record a user correction as a "correction" pattern for later engines
   * (the dokumen engine calls this when the user fixes an extracted
   * field, e.g. NPWP formatting per company). Thin wrapper over
   * `rememberPattern("correction", ...)` — the upsert rule applies, so a
   * repeated correction for the same context refreshes the value.
   */
  learnFromCorrection(input: CorrectionInput): void {
    const pattern = input.source
      ? `[${input.source}] ${input.context}`
      : input.context;
    this.rememberPattern("correction", pattern, input.corrected);
  }

  /**
   * Look up a key: preferences first, then facts. Returns undefined when
   * unknown. (Patterns are addressed by (kind, pattern) — use
   * `getAllMemories()` to inspect them.)
   */
  recall(key: string): unknown {
    const data = this.load();
    if (Object.prototype.hasOwnProperty.call(data.preferences, key)) {
      return data.preferences[key];
    }
    if (Object.prototype.hasOwnProperty.call(data.facts, key)) {
      return data.facts[key];
    }
    return undefined;
  }

  /** Everything remembered about this user — a deep copy, safe to mutate. */
  getAllMemories(): UserMemoryData {
    return JSON.parse(JSON.stringify(this.load())) as UserMemoryData;
  }

  /**
   * Remove a key from preferences and facts. Returns true when anything
   * was actually removed.
   */
  forget(key: string): boolean {
    const data = this.load();
    let removed = false;
    if (Object.prototype.hasOwnProperty.call(data.preferences, key)) {
      delete data.preferences[key];
      removed = true;
    }
    if (Object.prototype.hasOwnProperty.call(data.facts, key)) {
      delete data.facts[key];
      removed = true;
    }
    if (removed) this.save(data);
    return removed;
  }

  /** Wipe everything remembered about this user. The file is deleted. */
  forgetAll(): void {
    try {
      rmSync(this.file(), { force: true });
    } catch {
      // Missing file is already "forgotten".
    }
  }
}

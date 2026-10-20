import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomicSync } from "../fs-atomic.ts";
import { join } from "node:path";
import { appendEvent } from "./timeline.ts";
import type { TimelineEvent } from "./timeline.ts";
import type { RunContext } from "./types.ts";

/**
 * Dae Captain reminders & in-process scheduler (v2, Fase 4B).
 *
 * Design source: "Dae Captain - Master Design.md", Arsitektur Global
 * #8.2 (Pengingat & task terjadwal): "ingatkan saya ..." schedules a
 * reminder that fires later — the pill pulses and a chat message appears.
 * One-shot or repeating ("tiap Senin pagi"); scheduled tasks ("cek X tiap
 * jam 8 pagi") reuse the same mechanism with `repeat`.
 *
 * Persistence: one JSON file per reminder —
 * `<root>/workflow/reminders/<id>.json`. Synchronous fs, same pattern as
 * the run store. Corrupt files are skipped on scan, never thrown.
 *
 * SCHEDULER IS IN-PROCESS: `startScheduler()` runs a `setInterval` loop in
 * this process. Restarting the server restarts the scheduler; every tick
 * re-reads persisted data, so reminders survive restarts — but this is NOT
 * a system cron. While the server is down, due reminders fire on the first
 * tick after restart, and repeating reminders skip missed occurrences
 * (their next fire time is advanced past "now").
 *
 * Delivery to the pill/chat UI is a later phase (Fase 6/7). This module
 * exposes the `onDue` callback plus `emitReminderCreated`/`emitReminderDue`
 * helpers that record reminder lifecycle on the run timeline as `agent`
 * events with a `kind` marker — the 8-type timeline schema stays fixed.
 */

export type RepeatKind = "daily" | "weekly" | "hourly";

export function isRepeatKind(value: unknown): value is RepeatKind {
  return value === "daily" || value === "weekly" || value === "hourly";
}

/** Fixed step per repeat kind. Wall-clock drift (DST) is accepted. */
export const REPEAT_INTERVAL_MS: Record<RepeatKind, number> = {
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

export interface Reminder {
  id: string;
  userId: string;
  runId?: string;
  message: string;
  /** Epoch milliseconds when the reminder becomes due. */
  deliverAt: number;
  repeat?: RepeatKind;
  done: boolean;
  createdAt: number;
}

export interface ReminderInput {
  userId: string;
  message: string;
  deliverAt: number;
  repeat?: RepeatKind;
  /** Run that created this reminder (for timeline correlation). */
  runId?: string;
}

function isReminder(value: unknown): value is Reminder {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.userId === "string" &&
    typeof v.message === "string" &&
    typeof v.deliverAt === "number" &&
    Number.isFinite(v.deliverAt) &&
    typeof v.done === "boolean" &&
    typeof v.createdAt === "number" &&
    (v.repeat === undefined || isRepeatKind(v.repeat)) &&
    (v.runId === undefined || typeof v.runId === "string")
  );
}

/** UUIDs are hex+hyphens; strip anything else so ids can't escape the dir. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9-]/g, "");
}

export class ReminderStore {
  readonly root: string;

  constructor(root: string) {
    if (!root) throw new Error("reminder: root must be a non-empty string");
    this.root = root;
  }

  private dir(): string {
    return join(this.root, "workflow", "reminders");
  }

  private file(id: string): string {
    return join(this.dir(), `${safeId(id)}.json`);
  }

  /** Create and persist a reminder. Past `deliverAt` is allowed — it fires on the next tick. */
  scheduleReminder(input: ReminderInput): Reminder {
    const message = input.message?.trim();
    if (!message) {
      throw new Error("reminder: message must be a non-empty string");
    }
    if (!input.userId || input.userId.trim().length === 0) {
      throw new Error("reminder: userId must be a non-empty string");
    }
    if (!Number.isFinite(input.deliverAt)) {
      throw new Error("reminder: deliverAt must be a finite epoch-ms timestamp");
    }
    if (input.repeat !== undefined && !isRepeatKind(input.repeat)) {
      throw new Error(
        `reminder: repeat must be one of "daily"|"weekly"|"hourly", got ${JSON.stringify(input.repeat)}`,
      );
    }
    const reminder: Reminder = {
      id: randomUUID(),
      userId: input.userId,
      ...(input.runId ? { runId: input.runId } : {}),
      message,
      deliverAt: input.deliverAt,
      ...(input.repeat ? { repeat: input.repeat } : {}),
      done: false,
      createdAt: Date.now(),
    };
    this.saveReminder(reminder);
    return reminder;
  }

  /** Upsert a reminder by id. Used by the scheduler (done/advance) and by "tunda" edits. */
  saveReminder(reminder: Reminder): void {
    if (!isReminder(reminder)) throw new Error("reminder: invalid reminder object");
    mkdirSync(this.dir(), { recursive: true });
    writeFileAtomicSync(this.file(reminder.id), JSON.stringify(reminder, null, 2));
  }

  /** Unknown or corrupt ids return undefined, never throw. */
  getReminder(id: string): Reminder | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file(id), "utf8"));
    } catch {
      return undefined;
    }
    return isReminder(raw) ? raw : undefined;
  }

  /** Delete a reminder. Returns false when the id is unknown. */
  cancelReminder(id: string): boolean {
    if (!this.getReminder(id)) return false;
    try {
      rmSync(this.file(id), { force: true });
    } catch {
      return false;
    }
    return true;
  }

  /** Pending (not done) reminders for a user, soonest first. */
  listReminders(userId: string): Reminder[] {
    return this.all()
      .filter((r) => r.userId === userId && !r.done)
      .sort((a, b) => a.deliverAt - b.deliverAt || a.createdAt - b.createdAt);
  }

  /** Reminders whose time has come and that are not done yet, soonest first. */
  getDueReminders(now: number = Date.now()): Reminder[] {
    return this.all()
      .filter((r) => !r.done && r.deliverAt <= now)
      .sort((a, b) => a.deliverAt - b.deliverAt || a.createdAt - b.createdAt);
  }

  /** All parseable reminders. Unreadable/corrupt files are skipped. */
  private all(): Reminder[] {
    let files: string[];
    try {
      files = readdirSync(this.dir());
    } catch {
      return [];
    }
    const out: Reminder[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const r = this.getReminder(file.slice(0, -".json".length));
      if (r) out.push(r);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// parseReminderRequest: deterministic Indonesian reminder parsing.
// Strict on purpose — returns null when the text is not clearly a reminder
// request instead of guessing (a null means "not a reminder", not "parse
// harder"). `now` is injectable for tests; wall-clock is local time.
// ---------------------------------------------------------------------------

export interface ParsedReminderRequest {
  message: string;
  /** Epoch ms, local wall-clock as written ("besok jam 9" = tomorrow 09:00). */
  deliverAt: number;
  repeat?: RepeatKind;
}

const TRIGGER_RE = /^(?:tolong\s+)?(?:ingetin|ingatkan)(?:\s+(?:saya|aku|gue))?\s+/i;
const RELATIVE_RE =
  /^(?<message>.+?)\s+dalam\s+(?<n>\d+)\s+(?<unit>menit|jam)\s*$/i;
// Waktu = "jam H[.MM|:MM] [pagi|siang|sore|malam]" ATAU hanya "pagi|siang|sore|malam" (contoh desain A8: "tiap Senin pagi").
const TIME = String.raw`(?:jam\s+(?<h>\d{1,2})(?:[.:](?<m>[0-5]\d))?(?:\s*(?<q>pagi|siang|sore|malam))?|(?<only>pagi|siang|sore|malam))`;
const TOMORROW_RE = new RegExp(String.raw`^(?<message>.+?)\s+besok\s+${TIME}\s*$`, "i");
const WEEKLY_RE = new RegExp(
  String.raw`^(?<message>.+?)\s+(?:tiap|setiap)\s+(?:hari\s+)?(?<day>senin|selasa|rabu|kamis|jumat|sabtu|minggu)\s+${TIME}\s*$`,
  "i",
);
const DAILY_RE = new RegExp(String.raw`^(?<message>.+?)\s+(?:tiap|setiap)\s+(?:hari\s+)?${TIME}\s*$`, "i");

/** Jam default untuk penanda waktu tanpa angka ("besok pagi", "tiap Senin sore"). */
const PART_OF_DAY_HOUR: Record<string, number> = { pagi: 8, siang: 12, sore: 15, malam: 19 };

const WEEKDAY: Record<string, number> = {
  minggu: 0,
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  sabtu: 6,
};

function group(m: RegExpMatchArray, name: string): string | undefined {
  const v = m.groups?.[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Convert "jam H [qualifier]" to 24h. Bare "jam 9" = 09:00.
 * pagi: 12->0 | siang/sore: H<12 -> H+12 | malam: 12->0, H<12 -> H+12.
 * Returns null for out-of-range hours.
 */
function hour24(h: number, qualifier: string | undefined): number | null {
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  switch (qualifier?.toLowerCase()) {
    case "pagi":
      return h === 12 ? 0 : h;
    case "siang":
    case "sore":
      return h < 12 ? h + 12 : h;
    case "malam":
      return h === 12 ? 0 : h < 12 ? h + 12 : h;
    default:
      return h;
  }
}

/** Local-time epoch ms: `addDays` from `base`, at hour:minute. */
function atLocal(base: Date, addDays: number, hour: number, minute = 0): number {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + addDays);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** Baca grup waktu dari match → {hour, minute}, atau null bila di luar rentang. */
function readTime(m: RegExpMatchArray): { hour: number; minute: number } | null {
  const only = group(m, "only")?.toLowerCase();
  if (only) return { hour: PART_OF_DAY_HOUR[only] ?? 8, minute: 0 };
  const hour = hour24(Number(group(m, "h")), group(m, "q"));
  if (hour === null) return null;
  const minuteRaw = group(m, "m");
  return { hour, minute: minuteRaw === undefined ? 0 : Number(minuteRaw) };
}

export function parseReminderRequest(
  text: string,
  now: number = Date.now(),
): ParsedReminderRequest | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  const trigger = TRIGGER_RE.exec(normalized);
  if (!trigger) return null;
  const body = normalized.slice(trigger[0].length).trim();
  if (!body) return null;
  const base = new Date(now);

  // "ingatkan saya X dalam 30 menit" / "... dalam 2 jam"
  const rel = RELATIVE_RE.exec(body);
  if (rel) {
    const message = group(rel, "message")?.trim();
    const n = Number(group(rel, "n"));
    const unit = group(rel, "unit")?.toLowerCase();
    if (!message || !Number.isFinite(n)) return null;
    const step = unit === "jam" ? 3_600_000 : 60_000;
    return { message, deliverAt: now + n * step };
  }

  // "ingatkan saya X besok jam 9 [pagi]"
  const tom = TOMORROW_RE.exec(body);
  if (tom) {
    const message = group(tom, "message")?.trim();
    const t = readTime(tom);
    if (!message || t === null) return null;
    return { message, deliverAt: atLocal(base, 1, t.hour, t.minute) };
  }

  // "ingatkan saya X tiap senin jam 8 [pagi]" — weekly, next occurrence
  const week = WEEKLY_RE.exec(body);
  if (week) {
    const message = group(week, "message")?.trim();
    const dayName = group(week, "day")?.toLowerCase();
    const t = readTime(week);
    const target = dayName !== undefined ? WEEKDAY[dayName] : undefined;
    if (!message || t === null || target === undefined) return null;
    const delta = (target - base.getDay() + 7) % 7;
    const candidate = atLocal(base, delta, t.hour, t.minute);
    const deliverAt = candidate > now ? candidate : atLocal(base, delta + 7, t.hour, t.minute);
    return { message, deliverAt, repeat: "weekly" };
  }

  // "ingatkan saya X setiap jam 8 pagi" — daily, next occurrence
  const daily = DAILY_RE.exec(body);
  if (daily) {
    const message = group(daily, "message")?.trim();
    const t = readTime(daily);
    if (!message || t === null) return null;
    const candidate = atLocal(base, 0, t.hour, t.minute);
    const deliverAt = candidate > now ? candidate : atLocal(base, 1, t.hour, t.minute);
    return { message, deliverAt, repeat: "daily" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// In-process scheduler.
// ---------------------------------------------------------------------------

export interface SchedulerOptions {
  root: string;
  /**
   * Called once per due reminder. The reminder's state (done / advanced
   * repeat) is persisted BEFORE this runs, so a throwing callback can
   * never cause a double delivery. Async callbacks are fire-and-forget;
   * rejections go to `onError`.
   */
  onDue: (reminder: Reminder) => void | Promise<void>;
  /** Tick interval; default 60s. */
  intervalMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Defaults to console.error. A throwing onError is swallowed. */
  onError?: (error: unknown, reminder: Reminder) => void;
}

export interface ReminderScheduler {
  stop(): void;
  /** Run one due-check immediately. Deterministic — tests use this. */
  tick(): void;
}

export function startScheduler(opts: SchedulerOptions): ReminderScheduler {
  const store = new ReminderStore(opts.root);
  const clock = opts.now ?? Date.now;
  const reportError =
    opts.onError ??
    ((error: unknown, reminder: Reminder) => {
      console.error(`reminder: onDue failed for "${reminder.message}":`, error);
    });

  function tick(): void {
    try {
      tickUnsafe();
    } catch (error) {
      // tick berjalan di callback setInterval: exception yang lolos dari sini = uncaughtException yang mematikan
      // seluruh server (mis. disk penuh saat saveReminder). Laporkan dan coba lagi pada tick berikutnya.
      try {
        reportError(error, { id: "tick", userId: "", message: "scheduler tick", deliverAt: 0, done: false, createdAt: 0 });
      } catch {
        /* jangan pernah menjatuhkan loop */
      }
    }
  }

  function tickUnsafe(): void {
    const now = clock();
    for (const reminder of store.getDueReminders(now)) {
      if (reminder.repeat) {
        // Skip missed occurrences; keep the reminder pending.
        const step = REPEAT_INTERVAL_MS[reminder.repeat];
        let next = reminder.deliverAt;
        let guard = 0;
        while (next <= now && guard++ < 100_000) next += step;
        reminder.deliverAt = next;
      } else {
        reminder.done = true;
      }
      store.saveReminder(reminder);
      try {
        const result = opts.onDue(reminder);
        if (
          result !== undefined &&
          result !== null &&
          typeof (result as Promise<void>).catch === "function"
        ) {
          (result as Promise<void>).catch((error: unknown) => {
            try {
              reportError(error, reminder);
            } catch {
              // Never let error reporting break the tick loop.
            }
          });
        }
      } catch (error) {
        try {
          reportError(error, reminder);
        } catch {
          // Never let error reporting break the tick loop.
        }
      }
    }
  }

  const timer = setInterval(tick, opts.intervalMs ?? 60_000);
  // The scheduler must not keep the process (or a test runner) alive.
  if (typeof timer.unref === "function") timer.unref();
  return {
    stop: () => clearInterval(timer),
    tick,
  };
}

// ---------------------------------------------------------------------------
// Timeline integration: reminder lifecycle as `agent` events with a `kind`
// marker (the 8-type schema stays fixed — no new event type).
// ---------------------------------------------------------------------------

function formatLocal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const REPEAT_LABEL: Record<RepeatKind, string> = {
  hourly: "setiap jam",
  daily: "harian",
  weekly: "mingguan",
};

/** Record on the run timeline that a reminder was scheduled. */
export function emitReminderCreated(
  run: RunContext,
  reminder: Reminder,
): TimelineEvent<"agent"> {
  const repeat = reminder.repeat ? ` (${REPEAT_LABEL[reminder.repeat]})` : "";
  return appendEvent(run, "agent", {
    text: `⏰ Pengingat dibuat: "${reminder.message}" — ${formatLocal(reminder.deliverAt)}${repeat}`,
    kind: "reminder_created",
    reminderId: reminder.id,
  });
}

/** Record on the run timeline that a reminder fired. */
export function emitReminderDue(
  run: RunContext,
  reminder: Reminder,
): TimelineEvent<"agent"> {
  return appendEvent(run, "agent", {
    text: `⏰ Waktunya: ${reminder.message}`,
    kind: "reminder_due",
    reminderId: reminder.id,
  });
}

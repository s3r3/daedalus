import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ReminderStore,
  createWorkflowRun,
  emitReminderCreated,
  emitReminderDue,
  getEvents,
  isRepeatKind,
  parseReminderRequest,
  startScheduler,
} from "../src/workflow/index.ts";
import type { Reminder } from "../src/workflow/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dae-captain-reminder-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Local-time epoch ms for (y, mo, d, h, mi). */
function localAt(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo, d, h, mi, 0, 0).getTime();
}

// Friday 2026-10-16 10:30 local — the "today" for parser tests.
const FRIDAY = localAt(2026, 9, 16, 10, 30);

// ---------------------------------------------------------------------------
// ReminderStore CRUD
// ---------------------------------------------------------------------------

describe("ReminderStore", () => {
  test("schedule/get round-trips a reminder", () => {
    const store = new ReminderStore(dir);
    const r = store.scheduleReminder({
      userId: "farid",
      message: "review slide",
      deliverAt: FRIDAY + 3_600_000,
      runId: "run-1",
    });
    expect(r.id).toBeTruthy();
    expect(r.done).toBe(false);
    expect(r.runId).toBe("run-1");
    const loaded = store.getReminder(r.id);
    expect(loaded).toMatchObject({
      id: r.id,
      userId: "farid",
      message: "review slide",
      deliverAt: FRIDAY + 3_600_000,
    });
  });

  test("reminders persist in <root>/workflow/reminders/<id>.json", () => {
    const store = new ReminderStore(dir);
    const r = store.scheduleReminder({
      userId: "farid",
      message: "x",
      deliverAt: FRIDAY,
    });
    const fresh = new ReminderStore(dir);
    expect(fresh.getReminder(r.id)?.message).toBe("x");
  });

  test("scheduleReminder validates input", () => {
    const store = new ReminderStore(dir);
    expect(() =>
      store.scheduleReminder({ userId: "farid", message: "   ", deliverAt: FRIDAY }),
    ).toThrow(/message/);
    expect(() =>
      store.scheduleReminder({ userId: "farid", message: "x", deliverAt: NaN }),
    ).toThrow(/deliverAt/);
    expect(() =>
      store.scheduleReminder({
        userId: "farid",
        message: "x",
        deliverAt: FRIDAY,
        repeat: "monthly" as never,
      }),
    ).toThrow(/repeat/);
    expect(() =>
      store.scheduleReminder({ userId: "", message: "x", deliverAt: FRIDAY }),
    ).toThrow(/userId/);
  });

  test("cancelReminder deletes; unknown ids return false", () => {
    const store = new ReminderStore(dir);
    const r = store.scheduleReminder({ userId: "farid", message: "x", deliverAt: FRIDAY });
    expect(store.cancelReminder(r.id)).toBe(true);
    expect(store.getReminder(r.id)).toBeUndefined();
    expect(store.cancelReminder(r.id)).toBe(false);
    expect(store.cancelReminder("nope")).toBe(false);
  });

  test("listReminders: pending only, per user, soonest first", () => {
    const store = new ReminderStore(dir);
    const a = store.scheduleReminder({ userId: "farid", message: "later", deliverAt: FRIDAY + 2000 });
    const b = store.scheduleReminder({ userId: "farid", message: "sooner", deliverAt: FRIDAY + 1000 });
    store.scheduleReminder({ userId: "budi", message: "other", deliverAt: FRIDAY });
    const done = store.scheduleReminder({ userId: "farid", message: "done", deliverAt: FRIDAY });
    done.done = true;
    store.saveReminder(done);
    const list = store.listReminders("farid");
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(store.listReminders("budi")).toHaveLength(1);
    expect(store.listReminders("nobody")).toHaveLength(0);
  });

  test("getDueReminders: due and not done only, soonest first", () => {
    const store = new ReminderStore(dir);
    const due1 = store.scheduleReminder({ userId: "farid", message: "due1", deliverAt: FRIDAY - 2000 });
    const due2 = store.scheduleReminder({ userId: "farid", message: "due2", deliverAt: FRIDAY - 1000 });
    store.scheduleReminder({ userId: "farid", message: "future", deliverAt: FRIDAY + 60_000 });
    const done = store.scheduleReminder({ userId: "farid", message: "done", deliverAt: FRIDAY - 5000 });
    done.done = true;
    store.saveReminder(done);
    const due = store.getDueReminders(FRIDAY);
    expect(due.map((r) => r.id)).toEqual([due1.id, due2.id]);
  });

  test("isRepeatKind guard", () => {
    expect(isRepeatKind("daily")).toBe(true);
    expect(isRepeatKind("weekly")).toBe(true);
    expect(isRepeatKind("hourly")).toBe(true);
    expect(isRepeatKind("monthly")).toBe(false);
    expect(isRepeatKind(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseReminderRequest
// ---------------------------------------------------------------------------

describe("parseReminderRequest", () => {
  test("'ingatkan saya X besok jam 9' -> tomorrow 09:00", () => {
    const p = parseReminderRequest("ingatkan saya review slide besok jam 9", FRIDAY);
    expect(p).toMatchObject({ message: "review slide", deliverAt: localAt(2026, 9, 17, 9) });
    expect(p?.repeat).toBeUndefined();
  });

  test("'ingatkan saya X dalam 30 menit' -> now + 30min", () => {
    const p = parseReminderRequest("ingatkan saya beli susu dalam 30 menit", FRIDAY);
    expect(p).toMatchObject({ message: "beli susu", deliverAt: FRIDAY + 30 * 60_000 });
  });

  test("'ingatkan saya X dalam 2 jam' -> now + 2h", () => {
    const p = parseReminderRequest("ingatkan saya minum obat dalam 2 jam", FRIDAY);
    expect(p).toMatchObject({ message: "minum obat", deliverAt: FRIDAY + 2 * 3_600_000 });
  });

  test("'tiap senin jam 8' -> weekly, next Monday 08:00", () => {
    // Friday 2026-10-16 -> next Monday is 2026-10-19.
    const p = parseReminderRequest("Tolong ingatkan saya lari tiap senin jam 8", FRIDAY);
    expect(p).toMatchObject({
      message: "lari",
      deliverAt: localAt(2026, 9, 19, 8),
      repeat: "weekly",
    });
  });

  test("weekly on the same weekday: later today vs next week", () => {
    const mondayEarly = localAt(2026, 9, 19, 7, 0); // Monday 07:00
    const p1 = parseReminderRequest("ingatkan saya rapat tiap senin jam 8", mondayEarly);
    expect(p1?.deliverAt).toBe(localAt(2026, 9, 19, 8));
    const mondayLate = localAt(2026, 9, 19, 9, 0); // Monday 09:00, 08:00 passed
    const p2 = parseReminderRequest("ingatkan saya rapat tiap senin jam 8", mondayLate);
    expect(p2?.deliverAt).toBe(localAt(2026, 9, 26, 8));
    expect(p2?.repeat).toBe("weekly");
  });

  test("'setiap jam 8 pagi' -> daily, next 08:00", () => {
    // Friday 10:30 -> today's 08:00 passed -> tomorrow.
    const p = parseReminderRequest("ingatkan saya minum air setiap jam 8 pagi", FRIDAY);
    expect(p).toMatchObject({
      message: "minum air",
      deliverAt: localAt(2026, 9, 17, 8),
      repeat: "daily",
    });
  });

  test("daily later today stays today", () => {
    const morning = localAt(2026, 9, 16, 7, 0);
    const p = parseReminderRequest("ingatkan saya standup tiap hari jam 9", morning);
    expect(p?.deliverAt).toBe(localAt(2026, 9, 16, 9));
    expect(p?.repeat).toBe("daily");
  });

  test("qualifiers map to 24h: 'jam 2 siang' -> 14:00, 'jam 8 malam' -> 20:00", () => {
    const p1 = parseReminderRequest("ingetin aku Makan Siang besok jam 2 siang", FRIDAY);
    expect(p1).toMatchObject({ message: "Makan Siang", deliverAt: localAt(2026, 9, 17, 14) });
    const p2 = parseReminderRequest("ingatkan saya nonton bola besok jam 8 malam", FRIDAY);
    expect(p2?.deliverAt).toBe(localAt(2026, 9, 17, 20));
    const p3 = parseReminderRequest("ingatkan saya sahur besok jam 3 pagi", FRIDAY);
    expect(p3?.deliverAt).toBe(localAt(2026, 9, 17, 3));
  });

  test("out-of-range hour is not a reminder", () => {
    expect(parseReminderRequest("ingatkan saya x besok jam 25", FRIDAY)).toBeNull();
  });

  test("non-reminder text returns null — never guesses", () => {
    expect(parseReminderRequest("halo apa kabar", FRIDAY)).toBeNull();
    expect(parseReminderRequest("belikan saya kopi", FRIDAY)).toBeNull();
    expect(parseReminderRequest("ingatkan saya", FRIDAY)).toBeNull();
    expect(parseReminderRequest("ingatkan saya makan", FRIDAY)).toBeNull();
    expect(parseReminderRequest("", FRIDAY)).toBeNull();
    expect(parseReminderRequest("ingatkan saya dalam 30 menit", FRIDAY)).toBeNull();
  });

  test("trigger variants: ingetin/aku/gue/tolong", () => {
    const p = parseReminderRequest("ingetin gue cabut dalam 10 menit", FRIDAY);
    expect(p).toMatchObject({ message: "cabut", deliverAt: FRIDAY + 10 * 60_000 });
  });
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

describe("startScheduler", () => {
  test("tick() delivers due one-shot reminders and marks them done", () => {
    const store = new ReminderStore(dir);
    const due = store.scheduleReminder({ userId: "farid", message: "ping", deliverAt: FRIDAY - 1000 });
    store.scheduleReminder({ userId: "farid", message: "future", deliverAt: FRIDAY + 60_000 });
    const seen: Reminder[] = [];
    const sched = startScheduler({
      root: dir,
      now: () => FRIDAY,
      onDue: (r) => { seen.push(r); },
    });
    sched.tick();
    sched.stop();
    expect(seen.map((r) => r.id)).toEqual([due.id]);
    expect(store.getReminder(due.id)?.done).toBe(true);
    expect(store.getDueReminders(FRIDAY)).toHaveLength(0);
    expect(store.listReminders("farid")).toHaveLength(1); // only "future"
  });

  test("tick() advances repeating reminders instead of completing them", () => {
    const store = new ReminderStore(dir);
    const hourly = store.scheduleReminder({
      userId: "farid",
      message: "cek",
      deliverAt: FRIDAY - 30 * 60_000, // 30 min overdue
      repeat: "hourly",
    });
    const seen: Reminder[] = [];
    const sched = startScheduler({
      root: dir,
      now: () => FRIDAY,
      onDue: (r) => { seen.push(r); },
    });
    sched.tick();
    sched.stop();
    expect(seen).toHaveLength(1);
    const after = store.getReminder(hourly.id);
    expect(after?.done).toBe(false);
    // 30 min overdue + 1h step -> 30 min in the future.
    expect(after?.deliverAt).toBe(FRIDAY - 30 * 60_000 + 3_600_000);
  });

  test("tick() skips all missed occurrences of a long-overdue repeat", () => {
    const store = new ReminderStore(dir);
    const r = store.scheduleReminder({
      userId: "farid",
      message: "harian",
      deliverAt: FRIDAY - 5 * 86_400_000, // 5 days overdue
      repeat: "daily",
    });
    const sched = startScheduler({ root: dir, now: () => FRIDAY, onDue: () => {} });
    sched.tick();
    sched.stop();
    const after = store.getReminder(r.id);
    expect(after?.done).toBe(false);
    expect(after!.deliverAt).toBeGreaterThan(FRIDAY);
    expect(after!.deliverAt).toBeLessThanOrEqual(FRIDAY + 86_400_000);
  });

  test("state is persisted before onDue — a restart never double-delivers", () => {
    const store = new ReminderStore(dir);
    store.scheduleReminder({ userId: "farid", message: "sekali", deliverAt: FRIDAY - 1000 });
    const s1 = startScheduler({ root: dir, now: () => FRIDAY, onDue: () => {} });
    s1.tick();
    s1.stop();
    // Simulate a restart: a brand-new scheduler over the same root.
    const seen: Reminder[] = [];
    const s2 = startScheduler({ root: dir, now: () => FRIDAY, onDue: (r) => { seen.push(r); } });
    s2.tick();
    s2.stop();
    expect(seen).toHaveLength(0);
  });

  test("a throwing onDue does not break the tick loop; onError is called", () => {
    const store = new ReminderStore(dir);
    store.scheduleReminder({ userId: "farid", message: "a", deliverAt: FRIDAY - 2000 });
    store.scheduleReminder({ userId: "farid", message: "b", deliverAt: FRIDAY - 1000 });
    const seen: string[] = [];
    const errors: unknown[] = [];
    const sched = startScheduler({
      root: dir,
      now: () => FRIDAY,
      onDue: (r) => {
        seen.push(r.message);
        if (r.message === "a") throw new Error("boom");
      },
      onError: (e) => { errors.push(e); },
    });
    sched.tick();
    sched.stop();
    expect(seen).toEqual(["a", "b"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  test("an async onDue rejection goes to onError", async () => {
    const store = new ReminderStore(dir);
    store.scheduleReminder({ userId: "farid", message: "x", deliverAt: FRIDAY - 1000 });
    const errors: unknown[] = [];
    const sched = startScheduler({
      root: dir,
      now: () => FRIDAY,
      onDue: () => Promise.reject(new Error("async boom")),
      onError: (e) => { errors.push(e); },
    });
    sched.tick();
    sched.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("async boom");
  });

  test("startScheduler fires on its interval (real timer)", async () => {
    const store = new ReminderStore(dir);
    store.scheduleReminder({ userId: "farid", message: "live", deliverAt: Date.now() - 100 });
    let sched: { stop(): void } | undefined;
    try {
      const seen = new Promise<Reminder>((resolve) => {
        sched = startScheduler({ root: dir, intervalMs: 20, onDue: (r) => { resolve(r); } });
      });
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("scheduler did not fire in time")), 3000);
      });
      const r = await Promise.race([seen, timeout]);
      expect(r.message).toBe("live");
      expect(store.getReminder(r.id)?.done).toBe(true);
    } finally {
      sched?.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// timeline integration
// ---------------------------------------------------------------------------

describe("reminder timeline events", () => {
  test("emitReminderCreated/emitReminderDue use agent events with kind markers", () => {
    const run = createWorkflowRun(dir);
    const store = new ReminderStore(dir);
    const r = store.scheduleReminder({
      userId: "farid",
      message: "review slide",
      deliverAt: FRIDAY + 3_600_000,
      repeat: "daily",
    });
    const created = emitReminderCreated(run, r);
    expect(created.type).toBe("agent");
    expect(created.payload.kind).toBe("reminder_created");
    expect(created.payload.reminderId).toBe(r.id);
    expect(created.payload.text).toContain("review slide");
    expect(created.payload.text).toContain("harian");

    const due = emitReminderDue(run, r);
    expect(due.type).toBe("agent");
    expect(due.payload.kind).toBe("reminder_due");
    expect(due.payload.reminderId).toBe(r.id);
    expect(due.payload.text).toContain("review slide");

    expect(getEvents(run)).toHaveLength(2);
  });

  test("plain agent events still work without kind markers", () => {
    const run = createWorkflowRun(dir);
    const store = new ReminderStore(dir);
    emitReminderCreated(
      run,
      store.scheduleReminder({ userId: "f", message: "m", deliverAt: FRIDAY }),
    );
    const events = getEvents(run);
    expect(events[0]?.type).toBe("agent");
    // The 8-type schema is unchanged: no new event type was introduced.
    expect(events.every((e) => e.type === "agent")).toBe(true);
  });
});

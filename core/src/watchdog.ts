/**
 * Watchdog task macet (S4).
 *
 * Masalah: task bisa berhenti membuat kemajuan tanpa pernah berakhir — panggilan model yang tidak pernah dijawab,
 * tool yang menggantung, atau runner yang menunggu sesuatu yang tak akan datang. Pengguna melihat "Bekerja…" tanpa
 * ujung dan slot concurrency (S5) tertahan selamanya.
 *
 * Kelas ini murni logika deteksi (tanpa I/O sendiri); pemanggil (server) menyediakan sumber data dan aksi:
 *  - `lastProgressAt(id)`   penanda progres terakhir task (mis. TaskStore.lastActivityAt, termasuk task anak)
 *  - `isWaiting(id)`        task sedang SENGAJA menunggu (jeda, persetujuan, pertanyaan) → tidak dianggap macet
 *  - `onStall(info)`        aksi saat macet (lapor + hentikan)
 *
 * Satu task hanya ditandai sekali; `clear(id)` dipanggil saat task selesai agar tidak bocor.
 */
export type StallInfo = { taskId: string; idleMs: number; stallMs: number; since: number };

export type WatchdogOptions = {
  /** Ambang tanpa progres (ms). ≤ 0 = nonaktif. */
  stallMs: number;
  /** Jeda antar-pemindaian (ms). Bawaan: seperempat ambang, dibatasi 1–30 dtk. */
  intervalMs?: number;
  now?: () => number;
  activeTaskIds: () => string[];
  lastProgressAt: (taskId: string) => number | undefined;
  isWaiting?: (taskId: string) => boolean;
  onStall: (info: StallInfo) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export class TaskWatchdog {
  readonly #options: WatchdogOptions;
  readonly #now: () => number;
  /** Penanda progres efektif per task: yang terbaru dari progres nyata, saat terakhir terlihat menunggu, dan saat pertama terlihat. */
  readonly #touched = new Map<string, number>();
  readonly #flagged = new Map<string, StallInfo>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WatchdogOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.#options.stallMs > 0;
  }

  get stallMs(): number {
    return this.#options.stallMs;
  }

  start(): void {
    if (!this.enabled || this.#timer) return;
    const interval = this.#options.intervalMs ?? Math.min(30_000, Math.max(1_000, Math.floor(this.#options.stallMs / 4)));
    this.#timer = setInterval(() => void this.tick(), interval);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Task yang sedang ditandai macet (terlihat oleh server: /tasks, /health, /ready). */
  flagged(): StallInfo[] {
    return [...this.#flagged.values()];
  }

  isFlagged(taskId: string): boolean {
    return this.#flagged.has(taskId);
  }

  getFlag(taskId: string): StallInfo | undefined {
    return this.#flagged.get(taskId);
  }

  /** Lupakan task (dipanggil saat task selesai) supaya peta tidak membesar selamanya. */
  clear(taskId: string): void {
    this.#touched.delete(taskId);
    this.#flagged.delete(taskId);
  }

  /** Satu pemindaian. Dipanggil timer; terbuka agar tes bisa memanggilnya langsung. Tidak pernah melempar. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      const now = this.#now();
      const active = new Set(this.#options.activeTaskIds());
      // Task yang sudah tidak aktif dilupakan.
      for (const id of [...this.#touched.keys()]) if (!active.has(id)) this.clear(id);
      for (const id of active) {
        if (this.#flagged.has(id)) continue;
        if (!this.#touched.has(id)) this.#touched.set(id, now);
        if (this.#options.isWaiting?.(id)) {
          this.#touched.set(id, now); // menunggu pengguna bukan macet: jam diulang dari sekarang
          continue;
        }
        const progress = this.#options.lastProgressAt(id);
        const last = Math.max(this.#touched.get(id) ?? now, progress ?? 0);
        this.#touched.set(id, last);
        const idleMs = now - last;
        if (idleMs < this.#options.stallMs) continue;
        const info: StallInfo = { taskId: id, idleMs, stallMs: this.#options.stallMs, since: now };
        this.#flagged.set(id, info);
        try {
          await this.#options.onStall(info);
        } catch (error) {
          this.#options.onError?.(error);
        }
      }
    } catch (error) {
      this.#options.onError?.(error);
    }
  }
}

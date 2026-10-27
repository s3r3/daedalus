/**
 * Batas GLOBAL jumlah task yang berjalan bersamaan dalam satu proses (S5).
 *
 * Yang sudah ada sebelumnya: batas proses per-harness dan batas subagent per induk. Tidak ada yang membatasi
 * jumlah task TINGGI-TINGKAT: setiap POST /tasks membuat runner baru, sehingga sepuluh klik cepat berarti sepuluh
 * loop agen + sepuluh pool proses bersamaan (RAM, rate limit penyedia, biaya).
 *
 * Limiter ini dibagi oleh semua TaskRunner di proses yang sama. Penegakannya ada di `TaskRunner.run()` (core),
 * server memeriksa lebih awal (`hasCapacity`) agar bisa menjawab 429 yang jelas sebelum membuat task. Task anak
 * (subagent, `parentTaskId`) TIDAK dihitung: mereka berjalan di bawah slot induknya dan sudah dibatasi cap subagent;
 * menghitungnya membuat induk yang menunggu anaknya bisa menemui buntu (deadlock).
 */

/** Bawaan: 3 slot untuk rencana multi-engine (desain A5: maks 3 engine paralel) + 1 untuk chat/tugas interaktif + 1 cadangan. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 5;

export class TaskConcurrencyError extends Error {
  readonly code = 'concurrency_limit';
  readonly limit: number;
  readonly active: number;
  constructor(limit: number, active: number) {
    super(
      `Sudah ada ${active} task yang berjalan (batas maksimal ${limit}). Tunggu salah satunya selesai atau hentikan salah satunya, lalu coba lagi.`,
    );
    this.name = 'TaskConcurrencyError';
    this.limit = limit;
    this.active = active;
  }
}

export class TaskLimiter {
  #max: number;
  readonly #held = new Set<string>();

  /** `max` ≤ 0 berarti tanpa batas. */
  constructor(max: number = DEFAULT_MAX_CONCURRENT_TASKS) {
    this.#max = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : DEFAULT_MAX_CONCURRENT_TASKS;
  }

  get max(): number {
    return this.#max;
  }

  get active(): number {
    return this.#held.size;
  }

  setMax(max: number): void {
    this.#max = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : this.#max;
  }

  hasCapacity(): boolean {
    return this.#max === 0 || this.#held.size < this.#max;
  }

  holds(key: string): boolean {
    return this.#held.has(key);
  }

  /**
   * Ambil satu slot untuk `key` (id task). Mengembalikan fungsi pelepas yang idempoten, atau undefined bila penuh.
   * Sinkron: tidak ada `await` di antara pengecekan dan pengambilan, jadi tidak ada celah balapan.
   */
  tryAcquire(key: string): (() => void) | undefined {
    if (this.#held.has(key)) return () => this.release(key);
    if (!this.hasCapacity()) return undefined;
    this.#held.add(key);
    return () => this.release(key);
  }

  /** Lepas slot `key` (idempoten). Dipakai juga untuk memaksa pelepasan task yang macet dan tak bisa dihentikan. */
  release(key: string): boolean {
    return this.#held.delete(key);
  }
}

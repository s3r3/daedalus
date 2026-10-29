import type { Event, TaskState } from '../contracts.ts';

/**
 * Penjelasan akhir run dalam bahasa manusia (Indonesia): berhenti di mana dan KENAPA.
 *
 * Sebelumnya laporan run yang berakhir karena batas langkah / error beruntun / balasan tidak valid / dibatalkan
 * berisi evidence KOSONG (atau hanya kalimat teknis Inggris): pengguna melihat "gagal" tanpa alasan — keluhan
 * "agent berhenti di tengah task tanpa penjelasan". Fungsi ini murni (tanpa efek samping) agar mudah diuji.
 */
export type TerminationInput = {
  state: TaskState;
  /** Outcome run (success | partial | failed | stopped). */
  outcome: string;
  /** Batas langkah yang berlaku untuk run ini. */
  maxIterations: number;
  /** Event run (untuk membaca model_error dari TASK_COMPLETED). */
  events: Event[];
};

const MODEL_REASON_ID: Record<string, string> = {
  timeout: 'waktu habis (tidak merespons)',
  rate_limit: 'terkena batas laju (rate limit)',
  quota: 'kuota penyedia habis',
  context_or_token_limit: 'melebihi batas konteks/token model',
  model_not_found: 'model tidak tersedia',
  network: 'penyedia tidak dapat dihubungi (jaringan)',
  format_or_empty: 'mengembalikan respons yang tidak bisa dipakai',
  auth: 'autentikasi gagal',
  content_policy: 'menolak permintaan (kebijakan konten)',
};

function lastModelError(events: Event[]): { reason?: string; consecutive?: number; model?: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'TASK_COMPLETED') continue;
    const payload = event.payload as { model_error?: { reason?: unknown; consecutive?: unknown; model?: unknown } };
    const me = payload.model_error;
    if (me && typeof me === 'object') {
      return {
        ...(typeof me.reason === 'string' ? { reason: me.reason } : {}),
        ...(typeof me.consecutive === 'number' ? { consecutive: me.consecutive } : {}),
        ...(typeof me.model === 'string' ? { model: me.model } : {}),
      };
    }
  }
  return undefined;
}

/** Siapa yang menghentikan: 'user' (tombol Stop), 'model' (balasan diawali "stop"), atau tidak diketahui. */
function cancelledBy(events: Event[]): 'user' | 'model' | 'watchdog' | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'TASK_COMPLETED') continue;
    const by = (event.payload as { cancelled_by?: unknown }).cancelled_by;
    return by === 'user' || by === 'model' || by === 'watchdog' ? by : undefined;
  }
  return undefined;
}

/** Posisi berhenti: giliran model yang sudah berjalan + langkah rencana yang sedang dikerjakan. */
function whereText(state: TaskState): string {
  const turns = state.turns ?? 0;
  const active = state.steps.find((step) => step.status === 'active');
  const doneCount = state.steps.filter((step) => step.status === 'done').length;
  const parts = [`setelah ${turns} giliran model`];
  if (state.steps.length > 0) parts.push(`${doneCount}/${state.steps.length} langkah rencana selesai`);
  const where = parts.join(', ');
  return active ? `${where}; langkah yang sedang dikerjakan: "${active.intent}"` : where;
}

/** Mengembalikan satu kalimat penjelasan, atau undefined bila run sukses / tidak ada yang perlu dijelaskan. */
export function explainTermination(input: TerminationInput): string | undefined {
  const { state, outcome } = input;
  if (outcome === 'success') return undefined;
  const code = (state.last_error ?? '').trim();
  const where = whereText(state);

  if ((code === 'aborted' || code === 'stop requested') && cancelledBy(input.events) === 'watchdog') {
    const stalled = [...input.events].reverse().find((event) => event.type === 'TASK_STALLED');
    const idle = Number((stalled?.payload as { idle_ms?: unknown } | undefined)?.idle_ms);
    const span = !Number.isFinite(idle) || idle <= 0 ? undefined : idle < 120_000 ? `${Math.max(1, Math.round(idle / 1000))} detik` : `±${Math.round(idle / 60_000)} menit`;
    return `Task macet: tidak ada progres${span ? ` selama ${span}` : ''} (${where}). Dihentikan otomatis oleh watchdog, bukan oleh pengguna. Pekerjaan yang sudah tersimpan tetap ada; coba lagi dengan tugas yang lebih kecil atau model lain.`;
  }
  if ((code === 'aborted' || code === 'stop requested') && cancelledBy(input.events) === 'model') {
    return `Model memutuskan berhenti sendiri (membalas "stop:") sebelum tujuan tercapai (${where}). Ini keputusan model, bukan Stop dari pengguna; coba lagi dengan tujuan yang lebih jelas atau model lain.`;
  }
  if (code === 'aborted' || code === 'stop requested') {
    return `Dihentikan oleh pengguna (${where}). Perubahan yang sudah tersimpan tetap ada; tidak ada langkah lanjutan yang dijalankan.`;
  }
  if (code === 'max_iterations') {
    return `Berhenti karena mencapai batas ${input.maxIterations} langkah tanpa menyelesaikan tujuan (${where}). Naikkan batas langkah atau pecah tugas menjadi bagian yang lebih kecil.`;
  }
  if (code === 'max_errors') {
    const me = lastModelError(input.events);
    if (me?.reason) {
      const subject = me.model ? `Model ${me.model}` : 'Penyedia model';
      return `Berhenti karena permintaan ke model gagal ${me.consecutive ?? 'beberapa'} kali berturut-turut: ${subject} ${MODEL_REASON_ID[me.reason] ?? 'gagal'} (${where}). Coba lagi nanti atau ganti model.`;
    }
    return `Berhenti karena terlalu banyak kegagalan beruntun tanpa pemulihan (${where}).`;
  }
  if (code === 'provider_timeout') {
    return `Berhenti karena penyedia model tidak merespons (waktu habis) dua kali berturut-turut (${where}). Coba tugas yang lebih kecil, prompt yang lebih pendek, atau model lain.`;
  }
  if (code === 'no_progress') {
    return `Berhenti karena beberapa langkah berturut-turut tidak menghasilkan kemajuan; hasil yang sama terus berulang (${where}).`;
  }
  if (code === 'invalid_action') {
    return `Berhenti karena model berulang kali membalas teks biasa, bukan memanggil alat atau menyatakan selesai (${where}). Ini perilaku model; coba model lain atau perjelas tujuan.`;
  }
  if (code === 'budget_exhausted') {
    return `Berhenti karena anggaran token habis (${where}).`;
  }
  if (code === 'loop_hard_pause') {
    return `Berhenti karena agen berputar: memanggil alat yang sama berulang kali tanpa kemajuan dan tidak dilanjutkan (${where}).`;
  }
  if (/^auth:/.test(code)) return `Berhenti karena autentikasi ke penyedia model gagal — periksa API key atau penyedia (${where}).`;
  if (/^content_policy:/.test(code)) return `Berhenti karena penyedia model menolak permintaan (kebijakan konten) (${where}).`;
  if (/^fatal_provider_error:/.test(code)) return `Berhenti karena kesalahan fatal dari penyedia model (${where}).`;
  if (outcome === 'partial') {
    return `Selesai sebagian: pekerjaan belum memenuhi semua syarat penyelesaian (${where}).`;
  }
  if (code) return `Berhenti karena: ${code.slice(0, 200)} (${where}).`;
  return `Berhenti sebelum selesai (${where}).`;
}

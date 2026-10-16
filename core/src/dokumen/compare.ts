/**
 * Bandingkan dua dokumen (Fase C / desain 4.2): diff deterministik per
 * paragraf dengan detail per kata. Dipakai route POST /dokumen/compare
 * setelah kedua berkas diekstrak teksnya via parseSourceFile (native).
 *
 * Tidak ada model di sini: LCS atas paragraf untuk penjajaran, lalu
 * pasangan paragraf yang mirip tapi tidak identik dilaporkan sebagai
 * "changed" beserta ringkasan kata yang berubah ("denda 2%" → "denda 5%").
 */

export type DiffKind = 'same' | 'added' | 'removed' | 'changed';

export type DiffBlock = {
  kind: DiffKind;
  /** Indeks paragraf (0-based) di teks lama — ada untuk same/removed/changed. */
  oldIndex?: number;
  /** Indeks paragraf (0-based) di teks baru — ada untuk same/added/changed. */
  newIndex?: number;
  oldText?: string;
  newText?: string;
  /** Ringkasan perubahan kata, mis. «denda 2%» → «denda 5%». Hanya untuk changed. */
  detail?: string;
};

export type CompareCounts = { added: number; removed: number; changed: number; same: number };

export type CompareResult = {
  blocks: DiffBlock[];
  counts: CompareCounts;
  /** Baris ringkasan siap tampil, mis. "~ Pasal 4: «denda 2%» → «denda 5%»". */
  summary: string[];
};

/** Pecah teks menjadi paragraf (dibatasi baris kosong), buang yang kosong. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Rasio kemiripan 0..1 ala SequenceMatcher: 2*M / (lenA + lenB),
 * M = panjang LCS atas token kata. Dipakai untuk memasangkan paragraf
 * yang berubah (bukan duplikat persis).
 */
export function textSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;
  const m = lcsLength(wa, wb);
  return (2 * m) / (wa.length + wb.length);
}

/** Panjang LCS dua array token (DP satu baris — hemat memori). */
function lcsLength(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      if (a[i - 1] === b[j - 1]) prev[j] = diag + 1;
      else prev[j] = Math.max(prev[j]!, prev[j - 1]!);
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * LCS penuh dengan backtrack: mengembalikan pasangan indeks yang
 * cocok persis. Dipakai untuk penjajaran paragraf.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export type WordToken = { kind: 'same' | 'del' | 'ins'; text: string };

/** Diff per kata antara dua paragraf (LCS atas kata). */
export function wordDiff(oldText: string, newText: string): WordToken[] {
  const wa = words(oldText);
  const wb = words(newText);
  const n = wa.length;
  const m = wb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = wa[i] === wb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const tokens: WordToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (wa[i] === wb[j]) {
      tokens.push({ kind: 'same', text: wa[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      tokens.push({ kind: 'del', text: wa[i]! });
      i++;
    } else {
      tokens.push({ kind: 'ins', text: wb[j]! });
      j++;
    }
  }
  while (i < n) tokens.push({ kind: 'del', text: wa[i++]! });
  while (j < m) tokens.push({ kind: 'ins', text: wb[j++]! });
  return tokens;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\s+\S*$/, '');
  return `${cut || t.slice(0, max)}…`;
}

/**
 * Ringkas word-diff menjadi «kata lama» → «kata baru», gabungan
 * del/ins yang berurutan menjadi satu hunk, maks. 3 hunk.
 */
export function describeWordDiff(oldText: string, newText: string): string {
  const tokens = wordDiff(oldText, newText);
  const hunks: string[] = [];
  let del: string[] = [];
  let ins: string[] = [];
  const flush = () => {
    if (del.length === 0 && ins.length === 0) return;
    const left = del.length ? `«${del.join(' ')}»` : '«»';
    const right = ins.length ? `«${ins.join(' ')}»` : '«»';
    hunks.push(`${left} → ${right}`);
    del = [];
    ins = [];
  };
  for (const t of tokens) {
    if (t.kind === 'same') flush();
    else if (t.kind === 'del') del.push(t.text);
    else ins.push(t.text);
  }
  flush();
  return hunks.slice(0, 3).join(' … ') + (hunks.length > 3 ? ' …' : '');
}

/** Ambang kemiripan agar dua paragraf dianggap "berubah" (bukan tambah/hapus). */
export const CHANGED_SIMILARITY_THRESHOLD = 0.4;

export function compareTexts(oldText: string, newText: string): CompareResult {
  const oldParas = splitParagraphs(oldText);
  const newParas = splitParagraphs(newText);
  const matches = lcsPairs(oldParas, newParas);

  const blocks: DiffBlock[] = [];
  const counts: CompareCounts = { added: 0, removed: 0, changed: 0, same: 0 };
  const summary: string[] = [];

  // Selipkan sentinel agar gap terakhir ikut diproses.
  const extended: Array<[number, number]> = [...matches, [oldParas.length, newParas.length]];
  let oi = 0;
  let ni = 0;
  for (const [mi, mj] of extended) {
    // Gap: oldParas[oi..mi), newParas[ni..mj) — sejajarkan secara greedy
    // berdasarkan kemiripan terbaik.
    const oldGap: number[] = [];
    for (let k = oi; k < mi; k++) oldGap.push(k);
    const newGap: number[] = [];
    for (let k = ni; k < mj; k++) newGap.push(k);
    const usedNew = new Set<number>();
    for (const o of oldGap) {
      let best = -1;
      let bestSim = 0;
      for (const nn of newGap) {
        if (usedNew.has(nn)) continue;
        const sim = textSimilarity(oldParas[o]!, newParas[nn]!);
        if (sim > bestSim) {
          bestSim = sim;
          best = nn;
        }
      }
      if (best >= 0 && bestSim >= CHANGED_SIMILARITY_THRESHOLD) {
        usedNew.add(best);
        const detail = describeWordDiff(oldParas[o]!, newParas[best]!);
        blocks.push({ kind: 'changed', oldIndex: o, newIndex: best, oldText: oldParas[o], newText: newParas[best], detail });
        counts.changed++;
        summary.push(`~ ${truncate(oldParas[o]!, 60)}: ${detail}`);
      } else {
        blocks.push({ kind: 'removed', oldIndex: o, oldText: oldParas[o] });
        counts.removed++;
        summary.push(`- dihapus: ${truncate(oldParas[o]!, 80)}`);
      }
    }
    for (const nn of newGap) {
      if (usedNew.has(nn)) continue;
      blocks.push({ kind: 'added', newIndex: nn, newText: newParas[nn] });
      counts.added++;
      summary.push(`+ ditambah: ${truncate(newParas[nn]!, 80)}`);
    }
    if (mi < oldParas.length && mj < newParas.length) {
      blocks.push({ kind: 'same', oldIndex: mi, newIndex: mj, oldText: oldParas[mi], newText: newParas[mj] });
      counts.same++;
    }
    oi = mi + 1;
    ni = mj + 1;
  }

  // Blok sudah dalam urutan baca: tiap gap diproses berurutan (paragraf
  // lama dulu, lalu sisipan baru di wilayah itu), diikuti paragraf yang sama.

  // Ringkasan: maks. 10 baris perubahan + sisa diringkas.
  const changes = summary;
  const capped = changes.slice(0, 10);
  if (changes.length > 10) capped.push(`… dan ${changes.length - 10} perubahan lain`);
  return { blocks, counts, summary: capped };
}

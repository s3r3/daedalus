import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Tulis file secara atomik: isi ditulis ke berkas sementara di direktori yang
 * sama, lalu `rename` (atomik di POSIX dan menimpa di Windows). Proses yang
 * mati di tengah penulisan meninggalkan file LAMA yang utuh, bukan JSON
 * terpotong yang membuat state/run/riwayat chat "hilang" saat dimuat ulang.
 * Direktori tujuan harus sudah ada (pemanggil memanggil mkdirSync lebih dulu).
 */
export function writeFileAtomicSync(path: string, data: string | Uint8Array, mode?: number): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp belum sempat dibuat */
    }
    throw error;
  }
}

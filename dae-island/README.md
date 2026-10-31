# dae-island — Dae Captain Island (native Rust, tanpa webview)

Island dinamis Daedalus: pil kecil di top edge yang membesar jadi panel
saat dibutuhkan. Konsep mengikuti
[zickrian/isle](https://github.com/zickrian/isle) (notch GNOME) — tapi
**kode ditulis dari nol**: isle berlisensi GPL-3.0, crate ini MIT, jadi
yang diambil hanya idenya (tiga presentasi, spring yang sama, hover
120 ms, tutup 300 ms, alert sticky). Isle butuh GNOME Shell extension
karena Wayland hanya mengizinkan shell menggambar notch; di Hyprland,
layer-shell sudah native, jadi satu window GTK4 layer-shell cukup —
tidak ada extension, tidak ada daemon D-Bus. Sumber datanya server
Daedalus `:3080` lewat HTTP.

**Arah 2026-10-31:** island pindah ke dae-island SAJA. Dae Captain
(Tauri) tidak lagi punya pil/panel island — ia jendela chat full-webview
biasa. dae-island adalah satu-satunya island.

## Status

- **Fase 1** (skeleton): layer-shell window + pil statis + animasi
  expand/collapse manual. Sudah di main (`0c52c163`).
- **Fase 2 (data live) + Fase 3 (chat/approve)**: selesai di branch
  `finish-dae-captain-island`, belum live-test. Pil menampilkan status
  server secara live (polling `GET /workflow/runs` tiap 2 detik);
  panel punya peek approval (Izinkan/Tolak, sticky sampai dijawab) +
  tab Chat (streaming SSE ke `POST /workflow/chat/stream`) + tab Antrean
  (daftar task, baca saja). Animasi memakai spring isle (stiffness 155,
  damping 18); hover 120 ms membuka, pointer pergi 300 ms menutup
  (ditahan saat entry chat fokus). v1 sengaja polling, bukan WebSocket
  `/tasks/events` — itu follow-up (trade-off jujur vs "never poll" isle).
- Follow-up (bukan v1): pause/resume/cancel per baris Antrean,
  highlight engine aktif, streaming WebSocket, hormat
  `gtk-enable-animations` (saat ini spring selalu jalan).

## Dependensi build

- Arch (laptop Farid): `sudo pacman -S gtk4 gtk4-layer-shell`
- Ubuntu (VM): `libgtk-4-dev` dari apt + `gtk4-layer-shell` dari source
  (tidak ada di repo Ubuntu) — lihat `~/workspace/dae-island-build/`.
  Catatan VM: paket sistem + install `/usr/local` hilang saat VM
  diganti; kalau `cargo check` gagal `gtk4.pc` / `gtk4-layer-shell`
  tidak ditemukan, install ulang dulu dari clone tersebut.
  Build layer-shell: `meson setup build && ninja -C build && sudo ninja -C build install`.
- Env: `DAEDALUS_ISLAND_SERVER` (default `127.0.0.1:3080`) kalau server
  jalan di alamat lain. Token approve dibaca dari
  `~/.daedalus/daemon.json` (ditulis server); kalau tidak ada, tombol
  approve tetap dikirim tanpa token — server yang memutuskan (401 kalau
  ia punya token).

## Jalankan

```sh
cd dae-island
cargo run
```

Hanya jalan di Wayland dengan compositor yang mendukung layer-shell
(Hyprland). Di X11 / tanpa layer-shell, window tidak akan muncul sebagai
island.

## Checklist live-test (di Hyprland, server :3080 jalan)

Fase 1 (tetap berlaku):

1. Pil muncul di top edge, tengah layar.
2. Pil muncul tanpa merebut fokus (window lain tetap fokus).
3. Klik pil → panel membuka dengan animasi halus.
4. Klik pil lagi → panel menutup dengan animasi, kembali jadi pil.
5. Klik di luar island → tembus ke window di bawahnya.
6. Saat panel terbuka, klik entry chat → bisa mengetik (keyboard on-demand).
7. Window lain tidak terdorong ke bawah (exclusive zone 0).

Fase 2/3 (baru):

8. Server mati → pil merah "server tidak terhubung"; server nyala →
   pil hijau "siap" (tanpa restart island).
9. Jalankan task dari Dae Captain/CLI → pil biru "N berjalan" dalam
   ≤2 detik; task selesai → kembali "siap".
10. Task minta approval → pil kuning + peek "Butuh izin: …" muncul di
    panel; klik Izinkan → task lanjut, peek hilang; klik Tolak → task
    ditolak (cek di Dae Captain).
11. Hover pil 120 ms (tanpa klik) → panel membuka; geser pointer keluar
    → panel menutup setelah ±300 ms.
12. Tab Chat: kirim pesan → jawaban streaming muncul di transkrip;
    tab Antrean: daftar task sesuai workspace aktif.
13. Saat mengetik di entry chat, panel TIDAK auto-tutup walau pointer
    keluar dari island.

## Struktur

- `src/main.rs` — seluruh island: parser JSON std-only (tanpa
  serde_json), HTTP std-only (tanpa ureq), derivasi status dari
  `/workflow/runs`, UI GTK4 layer-shell, spring, hover/leave timer,
  thread polling + chat SSE + approve.
- `Cargo.toml` — `gtk4 0.10` + `gtk4-layer-shell 0.7` (pasangan yang
  dikonfirmasi resolver; gtk 0.10 menerima GTK sistem 4.14+).

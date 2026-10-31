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
  `finish-dae-captain-island`, merge ke main PR #145 (`db9196ab`).
  Pil menampilkan status server secara live (polling
  `GET /workflow/runs` tiap 2 detik); panel punya peek approval
  (Izinkan/Tolak, sticky sampai dijawab) + tab Chat (streaming SSE
  ke `POST /workflow/chat/stream`) + tab Antrean (daftar task dengan
  tombol aksi per task: Jeda/Lanjut/Batal via `POST
  /tasks/:id/pause|resume|cancel` + token daemon.json; cancel
  dikecualikan token) + baris engine (5 engine, yang sedang bekerja
  disorot). Animasi memakai spring isle (stiffness 155,
  damping 18); hover 120 ms membuka, pointer pergi 300 ms menutup
  (ditahan saat entry chat fokus). v1 sengaja polling, bukan WebSocket
  `/tasks/events` — itu follow-up (trade-off jujur vs "never poll" isle).
- **Port konsep dynamic island Dae Captain** (branch `dae-island-concept`,
  belum merge): seluruh konsep pill Tauri lama pindah ke sini, bukan
  cuma kerangkanya. Panel kini menampilkan **maskot Kapten** (modul
  `src/mascot.rs`: data seni SVG disalin verbatim dari
  `dae-captain/ui/mascot.js`, renderer Cairo baru — pose ikut status
  pill + engine, mata mengikuti kursor, tidur setelah 120 detik idle,
  12 dekor musiman + 10 kostum lewat dropdown di panel, tersimpan di
  `~/.daedalus/island-prefs.json`). Pill memakai **9 status lengkap**
  dengan prioritas yang sama (approval > error > dijeda > verifikasi >
  memperbaiki > bekerja > antrian > selesai-flash > idle), **progress
  ring** dari narasi engine (`8/12`), **smart click** (klik saat dijeda
  → lanjut; saat error → akui error), **mode notifikasi + DND**
  (Pulse/Bunyi/Mati; bunyi = dua-nada 880→660 Hz via ffplay,
  best-effort), dan **posisi pill** (Tengah/Kiri/Kanan via anchor
  layer-shell). Preferensi lain (notifikasi/DND/posisi) juga di file
  prefs yang sama.
- Follow-up (bukan port ini): streaming WebSocket, hormat
  `gtk-enable-animations` (saat ini spring selalu jalan), hotkey global
  (dulu Ctrl+Shift+D di Tauri; GTK saja tidak bisa grab hotkey global —
  butuh mekanisme toggle eksternal, mis. bind Hyprland + IPC), animasi
  klik maskot (wajah surprised/kiss/wink tidak ikut di-port).
  Delta jujur port maskot: auto-dekor ramadan/eid tidak otomatis
  (butuh kalender Hijri; keduanya tetap bisa dipilih manual), auto-dekor
  memakai UTC (bisa beda di sekitar tengah malam lokal), badge angka
  pose antrian tetap 2, teks dirender via cairo toy API (font sedikit
  berbeda dari browser).

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
    tab Antrean: daftar task sesuai workspace aktif, tombol
    Jeda/Lanjut/Batal per task bekerja (Jeda → task dijeda, Lanjut →
    lanjut dari checkpoint, Batal → task berhenti), dan baris engine
    menyorot engine yang sedang bekerja.
13. Saat mengetik di entry chat, panel TIDAK auto-tutup walau pointer
    keluar dari island.

Port konsep (baru):

14. Maskot Kapten muncul di panel; pose berubah ikut status pill dan
    engine task utama (mis. coding/slide saat bekerja, permission saat
    approval); mata mengikuti kursor; idle 120 detik → pose tidur.
    Dropdown Dekor (Otomatis + 12) dan Kostum (10) mengubah tampilan
    maskot dan tersimpan di `~/.daedalus/island-prefs.json`.
15. Status pill 9-tahap: task verifikasi → "Memverifikasi…", gagal
    validasi → "Memperbaiki (n/2)", task antre → "Antrian: N task",
    task selesai → flash "✓ Selesai" singkat; narasi engine dengan
    `8/12` menampilkan progress ring di dot pill.
16. Smart click: klik pill saat dijeda → task lanjut (tanpa buka
    panel); klik saat error → error diakui, pill kembali ke status
    berikutnya.
17. Preferensi pill: mode Bunyi → satu ping dua-nada saat masuk
    approval/selesai/error; DND aktif → approval tidak memunculkan
    peek dan pill tidak berbunyi/berdenyut; Posisi Kiri/Kanan
    memindahkan pill ke sudut atas.

## Struktur

- `src/main.rs` — seluruh island: parser JSON std-only (tanpa
  serde_json), HTTP std-only (tanpa ureq), derivasi status dari
  `/workflow/runs`, UI GTK4 layer-shell, spring, hover/leave timer,
  thread polling + chat SSE + approve.
- `src/mascot.rs` — maskot Kapten: data seni SVG port verbatim dari
  Dae Captain + renderer Cairo (parser path, gradient, pattern).
- `Cargo.toml` — `gtk4 0.10` + `gtk4-layer-shell 0.7` (pasangan yang
  dikonfirmasi resolver; gtk 0.10 menerima GTK sistem 4.14+).

> **DIARSIPKAN 2026-10-31** — Widget ini dipensiunkan atas keputusan Farid.
> Peran pill/panel-nya digantikan dae-island standalone (`dae-island/`, GTK4 +
> layer-shell, live pill dari server :3080 + approval peek + tab Chat/Antrean).
> File-file di sini dipertahankan apa adanya sebagai arsip; tidak lagi
> dikembangkan dan tidak lagi jadi jalur install yang didukung. Instruksi
> install di bawah ini hanya berlaku untuk salinan yang sudah terpasang
> sebelum pengarsipan.
>
# Dae Captain — Dynamic Island di Hyprland (Quickshell)

Widget QML layer-shell (overlay, di atas semua window) yang menampilkan
status Dae Captain sebagai dynamic island. Poll `GET /tasks` tiap 2 detik.

## 1. Install Quickshell (Arch)

```bash
yay -S quickshell
# atau: paru -S quickshell
```

## 2. Pasang widget

```bash
mkdir -p ~/.config/quickshell/dae-island
cp shell.qml ~/.config/quickshell/dae-island/shell.qml
```

## 3. Jalankan

```bash
quickshell -c dae-island
```

Pill muncul di tengah-atas layar:
- hijau "Dae Captain" = server nyala, idle
- biru "N jalan" = ada task running
- merah "N gagal" = ada task failed
- abu "Dae offline" = server 127.0.0.1:3080 mati

## 4. Autostart (hyprland.conf)

```
exec-once = quickshell -c dae-island
```

## 5. Klik pill

Default: coba fokus window Dae Captain, kalau nggak ada jalankan `dae-captain`.
Sesuaikan command di `onClicked` di shell.qml sesuai setup-mu.

## 6. Sembunyikan pill Tauri (opsional)

Kalau island Quickshell sudah jadi pill utama, pill bawaan Tauri jadi dobel.
Opsi: jangan jalankan AppImage-nya (server tetap jalan terpisah), atau tambahkan
flag di Tauri untuk mode headless.

## Catatan

- Widget ini cuma baca status (GET /tasks). Aksi cancel/approve tetap via panel Tauri.
- Kalau response /tasks bukan array plain, sesuaikan parsing di fungsi refresh().
- Layer = Overlay, exclusionMode = Ignore: ngambang, tidak menggeser window lain.

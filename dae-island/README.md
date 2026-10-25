# dae-island — Dae Captain Island (native Rust, tanpa webview)

Fase 1: skeleton. Layer-shell window + pil statis + animasi expand/collapse
manual. Belum terhubung ke server Daedalus (`:3080`) — data live menyusul
di Fase 2, aksi chat/approve di Fase 3. Island Tauri yang sekarang tetap
jalan berdampingan sampai island ini mencapai paritas.

## Dependensi build

- Arch (laptop Farid): `sudo pacman -S gtk4 gtk4-layer-shell`
- Ubuntu (VM): `libgtk-4-dev` dari apt + `gtk4-layer-shell` dari source
  (tidak ada di repo Ubuntu) — lihat `~/workspace/dae-island-build/`.

## Jalankan

```sh
cd dae-island
cargo run
```

Hanya jalan di Wayland dengan compositor yang mendukung layer-shell
(Hyprland). Di X11 / tanpa layer-shell, window tidak akan muncul sebagai
island.

## Checklist live-test Fase 1 (di Hyprland)

1. Pil muncul di top edge, tengah layar.
2. Pil muncul tanpa merebut fokus (window lain tetap fokus).
3. Klik pil → panel membuka dengan animasi halus (±250ms).
4. Klik pil lagi → panel menutup dengan animasi, kembali jadi pil.
5. Klik di luar island → tembus ke window di bawahnya.
6. Saat panel terbuka, klik entry chat → bisa mengetik (keyboard on-demand).
7. Window lain tidak terdorong ke bawah (exclusive zone 0).

## Struktur

- `src/main.rs` — seluruh skeleton Fase 1 (layer-shell, state machine
  pil ↔ panel, animasi ease-out cubic manual, UI pil + panel).
- `Cargo.toml` — `gtk4 0.10` + `gtk4-layer-shell 0.7` (pasangan yang
  dikonfirmasi resolver; gtk 0.10 menerima GTK sistem 4.14+).

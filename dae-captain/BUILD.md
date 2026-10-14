# BUILD.md — Dae Captain di Arch Linux (laptop Farid)

Binary Tauri tidak bisa di-build di VM (tanpa Rust toolchain + webkit).
Langkah di bawah dijalankan di laptop Arch.

## 1. Dependensi sistem

```bash
sudo pacman -Syu
sudo pacman -S --needed \
  base-devel curl wget file openssl \
  webkit2gtk-4.1 \
  appmenu-gtk-module libappindicator-gtk3 librsvg
```

(Paket-paket di atas adalah prasyarat Linux resmi Tauri v2 untuk Arch.
`libappindicator-gtk3` juga dipakai tray helper Daedalus yang sudah ada.)

## 2. Rust toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup default stable
```

## 3. Tauri CLI

```bash
cargo install tauri-cli --version "^2" --locked
```

## 4. Build & jalankan (dev)

```bash
cd ~/workspace/repos/daedalus/dae-captain/src-tauri
cargo tauri dev
```

Aplikasi meminta **repo root Daedalus** sekali (untuk sidecar server),
lalu workspace awal. Server Node di-spawn otomatis bila belum jalan.

## 5. Build rilis

```bash
cd ~/workspace/repos/daedalus/dae-captain/src-tauri
cargo tauri build
# hasil: src-tauri/target/release/bundle/
#   - appimage/Dae Captain_0.1.0_amd64.AppImage
#   - deb/dae-captain_0.1.0_amd64.deb
```

## 6. Test frontend (tanpa Rust, bisa di mana saja)

```bash
cd ~/workspace/repos/daedalus/dae-captain
node --test tests/logic.test.js tests/api.test.js
```

## 7. Verifikasi live (checklist laptop)

1. Buka aplikasi → pill biru (idle) muncul top-center.
2. Stop server (`daedalus stop`), buka ulang aplikasi → server ke-spawn
   sebagai sidecar (cek `daedalus status` — PID sama).
3. Chat: "buatkan slide tentang X" → pill Slide hijau, turn tercatat.
4. Buat task coding dengan auto-approve off → kartu approval muncul +
   island mekar otomatis → Allow/Deny bekerja.
5. Settings → ganti provider/model → tersimpan, berlaku untuk engine.
6. Workspace picker → pindah folder → dispatch berikutnya di folder itu.
7. Quit → dialog keep-alive → "biarkan jalan" = server tetap hidup.

## 8. Opsional: pin di Hyprland (sementara, sampai layer-shell native)

```ini
# ~/.config/hypr/hyprland.conf
windowrulev2 = float, title:^(Dae Captain)$
windowrulev2 = pin, title:^(Dae Captain)$
windowrulev2 = noborder, title:^(Dae Captain)$
windowrulev2 = move 50% 8, title:^(Dae Captain)$
```

## 9. Follow-up yang disengaja TIDAK masuk v1

- **Layer-shell pinning sejati** (`zwlr_layer_shell_v1`): butuh integrasi
  native — opsi yang diteliti: `gtk4-layer-shell` membungkus window GTK
  Tauri, atau `wayland-protocols-wlr` + `smithay-client-toolkit` di Rust.
  v1 = panel borderless always-on-top (jujur, bukan pura-pura layer-shell).
- **Ikon final**: Farid desain sendiri; placeholder "D" di
  `src-tauri/icons/` (regenerasi: `python3 render-icon.py`).
- **Bundling node + repo**: v1 berjalan dari checkout repo; packaging
  AppImage yang bundel semuanya = langkah distribusi terpisah.

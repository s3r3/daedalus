# Dae Captain

Dynamic-island companion untuk Daedalus: satu chat + satu pulau kecil yang
mengatur **lima engine agentic** (Coding, Slide, Dokumen, Spreadsheet,
Research) — pantau agent yang berjalan, approve/deny inline, tanpa buka
tab browser.

## Arsitektur

```
┌──────────────────────────────────────────┐
│ Dae Captain (aplikasi Tauri ini)         │  ← dynamic island: pill ↔ panel
│ chat + pill per engine + approve/deny   │     thin client, tanpa logika engine
└───────────────┬──────────────────────────┘
                │ HTTP 127.0.0.1:3080
┌───────────────▼──────────────────────────┐
│ Daedalus server (Node, background)       │
│ router + RunContext + 5 engines          │
└──────────────────────────────────────────┘
```

- **Thin client**: semua logika engine tetap di server Node. Aplikasi hanya
  memanggil API yang sudah ada (`/workflow/*`, `/tasks/*`, `/settings`,
  `/providers`, `/models`, `/health`).
- **Lifecycle**: saat dibuka, aplikasi cek server; kalau belum jalan, spawn
  sebagai sidecar (`node --experimental-strip-types <repo>/server/src/main.ts`
  — invocasi yang persis sama dipakai `cli/src/launcher.ts`). Saat quit,
  tanya: biarkan server jalan atau matikan (pilihan bisa diingat).
- **Settings**: provider + model picker → API settings server → store yang
  sama (`~/.daedalus/`). Kunci API tidak pernah ditampilkan kembali oleh
  server dan tidak disimpan aplikasi ini.
- **Workspace**: pilih folder mana pun → jadi `workspace_root` untuk
  dispatch berikutnya (daftar terakhir dipakai disimpan).
- **Batas keras**: `daedalus-web/` (Vite) dan `cli/` **tidak disentuh** —
  untuk presentasi skripsi. Direktori ini (`dae-captain/`) sepenuhnya baru.

## Struktur

```
dae-captain/
  README.md            ← file ini
  BUILD.md             ← perintah build persis untuk laptop Arch
  src-tauri/           ← backend Rust (tipis): window, sidecar, prefs
    Cargo.toml         ← hanya tauri + serde (+ tauri-build); tanpa plugin
    tauri.conf.json
    src/main.rs
    icons/             ← icon.png (placeholder "D") + render-icon.py
  ui/                  ← frontend TANPA build step: HTML/CSS/JS polos
    index.html
    styles.css
    logic.js           ← fungsi murni (di-test)
    api.js             ← client HTTP server (di-test, fetch injectable)
    app.js             ← wiring DOM + bridge Tauri
  tests/               ← node:test, tanpa dependensi
```

Frontend sengaja tanpa bundler/framework: yang diserve Tauri adalah file
statis di `ui/`. Bridge Tauri dipakai lewat `window.__TAURI__` yang
di-inject runtime (tanpa npm package).

## Perilaku island

- **Compact pill**: dot "D" + warna status — hijau (ada yang running),
  amber (butuh approval — berdenyut), biru (idle). Teks: "!" atau jumlah
  yang running.
- **Expand** → panel: pill per engine (live), kartu approval (Allow/Deny),
  transcript chat + input (chip override engine: Auto/Coding/…), Settings,
  Workspace picker.
- Island mekar otomatis saat approval baru masuk; menciut manual via tombol.

## Status jujur

- **Layer-shell**: v1 memakai panel borderless always-on-top di top-center
  (pendekatan yang terbukti di WhisperShell). Pinning layer-shell sejati
  (`zwlr_layer_shell`, seperti coucou) butuh integrasi native
  (gtk-layer-shell / wayland-protocols-wlr) — follow-up terdokumentasi,
  bukan janji v1. Di Hyprland bisa dibantu windowrule (lihat BUILD.md).
- Binary Tauri **tidak bisa** di-build di VM ini (tanpa Rust toolchain /
  webkit) — build + live proof milik laptop Arch Farid (lihat BUILD.md).

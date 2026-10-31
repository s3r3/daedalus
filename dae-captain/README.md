# Dae Captain

Desktop chat companion untuk Daedalus: satu jendela chat yang mengatur
**lima engine agentic** (Coding, Slide, Dokumen, Spreadsheet,
Research) — pantau agent yang berjalan, approve/deny inline, tanpa buka
tab browser.

## Arsitektur

```
┌──────────────────────────────────────────┐
│ Dae Captain (aplikasi Tauri ini)         │  ← jendela chat normal
│ chat + chip per engine + approve/deny   │     thin client, tanpa logika engine
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
    Cargo.toml         ← tauri + serde + dialog (+ tauri-build)
    tauri.conf.json
    src/main.rs
    icons/             ← icon.png (placeholder "D") + render-icon.py
  ui/                  ← frontend TANPA build step: HTML/CSS/JS polos
    index.html
    styles.css
    theme-mascot.css   ← tema selaras maskot (dimuat setelah styles.css)
    logic.js           ← fungsi murni (di-test)
    api.js             ← client HTTP server (di-test, fetch injectable)
    bridge.js          ← invoke Tauri v2 (di-test)
    cards.js           ← kartu chat (di-test, butuh jsdom)
    events.js          ← event stream server (di-test)
    mascot.js          ← maskot v2 (status dari renderHeaderStatus)
    app.js             ← wiring DOM + bridge Tauri
  tests/               ← node:test (chat-cards butuh jsdom dari node_modules
                         root repo)
```

Frontend sengaja tanpa bundler/framework: yang diserve Tauri adalah file
statis di `ui/`. Bridge Tauri dipakai lewat
`window.__TAURI_INTERNALS__.invoke` (Tauri 2, tanpa npm package).

## Perilaku jendela

- **Jendela chat normal**: decorated, resizable, default 1024×720.
  Header menunjukkan workspace aktif + status jujur (siap / berjalan /
  butuh perhatian / terputus).
- **Chat**: chip per engine (live), kartu approval (Allow/Deny),
  transcript + input (chip override engine: Auto/Coding/…), Settings,
  Workspace picker.
- **Task berjalan**: tombol Jeda/Lanjut/Batal muncul di chat, bekerja
  pada task utama (pause/resume/cancel via API server).
- **Maskot** mengikuti status task (dari `renderHeaderStatus`, bukan
  observer pill lagi).

## Status jujur

- **Island / pinning**: bukan lagi urusan aplikasi ini — pindah ke
  `dae-island` (GTK4 + gtk4-layer-shell, native Rust tanpa webview).
  Aplikasi ini jendela desktop biasa.
- Binary Tauri **tidak bisa** di-build di VM ini (tanpa Rust toolchain /
  webkit) — build + live proof milik laptop Arch Farid (lihat BUILD.md).

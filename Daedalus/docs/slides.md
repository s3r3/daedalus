# Agentic Slide

Domain presentasi Daedalus: agent membangun deck slide terstruktur di
workspace yang sama, dengan mode policy, approval, dan event log yang
sama seperti pekerjaan coding. Satu file `deck.json` adalah sumber
kebenaran tunggal; canvas Web, PDF (rencana), dan PPTX hanyalah turunan.

## DeckSpec

File kerja: `<workspace>/deck/deck.json`, aset di `<workspace>/deck/assets/`.

```ts
type DeckSpec = {
  version: 1
  id: string
  title: string
  theme: { accent?: string; dark?: boolean }
  slides: Slide[]
}
type Slide = {
  id: string
  layout: string            // salah satu id katalog di bawah
  content: Record<string, unknown>  // terikat skema layout
  notes?: string            // speaker notes (masuk ke PPTX)
}
```

Format didefinisikan di `core/src/slides/deck.ts`; registry layout di
`core/src/slides/layouts.ts` (module murni, juga dipakai Web). Isi slide
divalidasi skema-lite per layout sebelum ditulis/diekspor
(`validateDeck` di `core/src/slides/store.ts`): layout tak dikenal,
field wajib hilang, dan jumlah item berlebih adalah error; teks sangat
panjang dan field tak dikenal adalah peringatan.

## Katalog layout v1 (visual-first)

| Layout | Isi |
|---|---|
| `title` | title, subtitle? |
| `section` | title, number? |
| `bullets` | title, points[≤7] |
| `two-column` | title, left/right {heading, points} |
| `image-side` | title, points, image (file di assets), alt?, side? |
| `diagram-flow` | title, steps[3–6] {title, desc?} |
| `diagram-cycle` | title, nodes[4] |
| `diagram-hierarchy` | title, root, groups[] {label, items} |
| `timeline` | title, events[] {when, title, desc?} |
| `comparison` | title, left/right {title, points}, verdict? |
| `chart-bar` | title, data[] {label, value}, unit? |
| `chart-line` | title, series[] {name, points}, unit? |
| `chart-donut` | title, slices[] {label, value}, unit? |
| `table` | title, columns[], rows[][] |
| `stats` | title, stats[≤4] {value, label} |
| `quote` | text, author? |
| `icon-grid` | title, items[] {icon (nama lucide), title, desc?} |
| `closing` | title, cta? |

## Tool agent (core/src/tools/slides.ts)

| Tool | Kelas | Fungsi |
|---|---|---|
| `create_deck` | mutating | buat `deck/deck.json` kosong |
| `read_deck` | read | ringkasan deck + isu validasi (bukan dump JSON) |
| `add_slide` | mutating | tambah slide (content digabung di atas defaults layout) |
| `update_slide` | mutating | merge content satu slide |
| `move_slide` | mutating | urutkan ulang |
| `delete_slide` | mutating | hapus slide |
| `set_deck_theme` | mutating | accent/dark deck |
| `validate_deck` | read | laporan isu (error/peringatan) |
| `export_deck` | executing | ekspor PPTX (menolak bila ada error validasi) |

Kelas mengikuti matriks mode yang ada: read bebas di semua mode;
mutating di-approve di Manual dan ditolak di Ask/Plan; `export_deck`
kelas executing (di Auto perlu approval kecuali auto-approve).

Alur yang diajarkan ke model: `create_deck` → `add_slide` per butir
outline (utamakan layout visual — diagram, chart, icon-grid, stats —
di atas bullets polos) → `validate_deck` → perbaiki isu → `export_deck`.

## Ekspor PPTX

`core/src/slides/export-pptx.ts` (pptxgenjs, dependency pertama core):
16:9, palet Daedalus/tema deck, **semua teks native editable**. Diagram
menjadi shape + konektor, chart menjadi chart native (bar/line/
doughnut), table menjadi table native, `image-side` memakai `addImage`
bila aset ada (placeholder berlabel bila belum), `notes` menjadi
speaker notes. Hasil: `<workspace>/deck/<slug-judul>.pptx`.

## Web

Domain Slide hidup di rute **`/slide`** (Coding di `/`): membuka
`/slide` langsung mengaktifkan domain Slide — rute memenangkan
localStorage saat load, dan mengklik saklar domain **Coding | Slide**
di TopBar menulis URL yang sesuai (`history.pushState`), jadi refresh
dan deep-link konsisten. Server menyajikan shell SPA yang sama untuk
kedua rute. Launcher CLI menawarkan domain yang sama sejak awal:
menu `daedalus` telanjang kini **1 Daedalus Coding** (membuka `/`),
**2 Daedalus Slide** (membuka `/slide`), 3 Hide to Tray, 4 Exit.
Saklar domain di TopBar juga persisten (localStorage).
Domain Slide mengganti kolom tengah editor kode menjadi canvas slide
(16:9 scaled-to-fit + filmstrip; thumbnail adalah renderer yang sama),
panel Outline deck muncul di kolom kiri, chat/composer/plan chip tidak
berubah. Deck dibaca dari `deck/deck.json` lewat API file workspace dan
disegarkan saat workspace berubah (tombol refresh selalu tersedia).
Renderer per layout ada di `daedalus-web/src/components/slides/`
(chart/diagram SVG tulisan tangan, ikon lucide by-name).

## Batasan v1 (jujur)

- Ekspor baru PPTX; ekspor PDF belum ada.
- Tanpa drag-drop/WYSIWYG editing di Web — edit lewat chat (tool),
  canvas bersifat preview + navigasi.
- Aset gambar lokal tampil sebagai placeholder di Web (file lokal tidak
  disajikan sebagai URL); PPTX tetap menanam file aslinya.
- Satu deck per workspace (`deck/deck.json`), tanpa riwayat versi.
- Outline checkpoint, interview Plan khusus deck, dan event khusus
  slide belum ada — alur memakai machinery task/plan yang sudah ada.

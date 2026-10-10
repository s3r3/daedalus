# daedalus-sheet-sidecar

Go sidecar for **Agentic Spreadsheet**: injects the native OOXML parts
exceljs cannot write — charts, pivot tables, slicers — into an exported
`.xlsx`. Built on [Excelize](https://github.com/xuri/excelize)
(BSD-3-Clause; see `../docs/THIRD_PARTY.md`).

## Role & rules

- `workbook.json` (TypeScript core) is the **only** source of truth.
  The sidecar never reads it; it receives chart/pivot/slicer *specs*
  from the core over stdin and opens the **already-exported** xlsx.
- Export stage only. If the binary is absent, export proceeds without
  natives and the export record **says so**, plus a formula-summary
  fallback sheet (`Ringkasan`, live `SUMIF`s) is appended so the
  numbers still exist in the file.
- No VBA. Ever. (A macro-bearing `.xlsm` template package is a v1.1
  candidate and would be injected the same way, never authored.)

## Discovery (core side, `core/src/sheets/export.ts`)

Mirrors how the server finds Pratinjau Asli engines:

1. `DAEDALUS_SHEET_SIDECAR` env var (explicit path), else
2. `daedalus-sheet-sidecar` on `PATH`.

Probe: `--version`. Inject: `daedalus-sheet-sidecar inject` with one
JSON object on stdin `{input, output, charts, pivots, slicers}`; exit 0
+ one JSON line on stdout reports what was **actually** injected
(specs it cannot honor are skipped with a note — the core quotes that
in the export record rather than the request).

## Bundled at install

Per design decision, the binary ships per-platform at install time
(linux-x64, win32-x64) and lands on `PATH` (or the env var above).
Build:

```bash
./build.sh                 # → bin/daedalus-sheet-sidecar
GOOS=windows ./build.sh    # cross-compile; packaging renames to .exe
```

`bin/` is gitignored — binaries are never committed. Requires Go ≥ 1.23
and one-time module network access (Excelize); the binary is static.

## Spike record (2026-10-10, gate before promising natives)

Fixture: sales recap — `Data` (12 bulan, formula `Laba =C-D`),
`Asumsi`, `Dashboard` (KPI `SUM`/`SUMIF` + column chart spec), pivot
spec `Kanal × SUM(Laba)` → `Pivot`, one table slicer.

- ✅ Native parts present after inject: `xl/charts/chart1.xml`,
  `xl/pivotTables/pivotTable1.xml`, `xl/pivotCache/pivotCacheDefinition1.xml`,
  `xl/slicers/slicer1.xml` + `xl/slicerCaches/slicerCache1.xml`.
- ✅ LibreOffice headless render: column chart draws natively; pivot
  renders `Online 351.000.000 · Toko 370.800.000 · Total 721.800.000`
  (cross-checked against hand-computed sums and Dashboard KPIs after a
  LibreOffice recalc round-trip). Slicers render as LibreOffice's
  placeholder note — expected; interactivity is Excel-side.
- ✅ Round-trip: exceljs reopens the injected file; openpyxl reads it;
  frozen panes, conditional formatting, data validations, formulas all
  survive Excelize's rewrite.
- Decisions recorded: pivots ship `refreshOnLoad="true"` with no
  embedded cache records (Excel/LibreOffice refresh from the source
  range on open — the numbers a user sees are always computed from the
  file's own data, never from a frozen cache); the sidecar restores
  `fullCalcOnLoad` at the ZIP level because Excelize 2.9 has no
  calc-properties setter; pivot table ranges must go to Excelize
  **unquoted** (`Sheet!A1:B5`) — its parser rejects `'Sheet'!` form.
- Real-Excel no-repair open remains Farid's Windows dual-boot check,
  same as the PowerPoint COM engine's first live run.

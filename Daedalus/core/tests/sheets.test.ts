import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  EventBus,
  QuestionBroker,
  TaskStore,
  SpreadsheetEngine,
  SHEET_OP_NAMES,
  applySheetOps,
  evaluateWorkbook,
  exportSheetToCsvText,
  exportWorkbookToXlsx,
  importCsvToWorkbook,
  importXlsxToWorkbook,
  newSheet,
  newWorkbook,
  parseCsvText,
  readWorkbook,
  validateWorkbook,
  verifyWorkbook,
  verifyWorkbookCore,
  writeWorkbook,
  type WorkbookSpec,
} from '../src/index.ts';
import type { LLMProvider } from '../src/providers/llm/types.ts';

/**
 * Agentic Spreadsheet acceptance tests (design doc §Acceptance):
 * workbook.json schema, golden formula recompute (evaluator),
 * live-formula invariant, invalid-op byte-identical, closed edit
 * vocabulary, honest sidecar-absent fallback, verify gate paths.
 */

const tmps: string[] = [];
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-sheets-test-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop() as string, { recursive: true, force: true });
  delete process.env.DAEDALUS_SHEET_SIDECAR;
});

/** Golden sales fixture: Data (formulas) + Asumsi + Dashboard. */
function goldenWorkbook(): WorkbookSpec {
  const wb = newWorkbook('Rekap Penjualan', { createdBy: 'test' });
  wb.stage = 'ready';
  const data = newSheet('Data');
  ['Bulan', 'Kanal', 'Pendapatan', 'Biaya', 'Laba', 'LabaBersih'].forEach((h, i) => {
    data.cells[`${'ABCDEF'[i]}1`] = { v: h, bold: true };
  });
  const rows: Array<[string, string, number, number]> = [
    ['Jan', 'Online', 100, 40],
    ['Feb', 'Toko', 200, 50],
    ['Mar', 'Online', 300, 60],
  ];
  rows.forEach(([bulan, kanal, pendapatan, biaya], i) => {
    const r = i + 2;
    data.cells[`A${r}`] = { v: bulan };
    data.cells[`B${r}`] = { v: kanal };
    data.cells[`C${r}`] = { v: pendapatan };
    data.cells[`D${r}`] = { v: biaya };
    data.cells[`E${r}`] = { f: `=C${r}-D${r}` };
    data.cells[`F${r}`] = { f: `=E${r}-(E${r}*Asumsi!$B$2)` };
  });
  wb.sheets.push(data);
  const asumsi = newSheet('Asumsi');
  asumsi.cells['A1'] = { v: 'Nama', bold: true };
  asumsi.cells['B1'] = { v: 'Nilai', bold: true };
  asumsi.cells['A2'] = { v: 'Pajak' };
  asumsi.cells['B2'] = { v: 0.11 };
  wb.sheets.push(asumsi);
  const dash = newSheet('Dashboard');
  dash.cells['A1'] = { v: 'KPI', bold: true };
  dash.cells['B1'] = { v: 'Nilai', bold: true };
  dash.cells['A2'] = { v: 'Total Laba' };
  dash.cells['B2'] = { f: '=SUM(Data!E2:E4)' };
  dash.cells['A3'] = { v: 'Laba Online' };
  dash.cells['B3'] = { f: '=SUMIF(Data!B2:B4,"Online",Data!E2:E4)' };
  dash.cells['A4'] = { v: 'Cek VLOOKUP' };
  dash.cells['B4'] = { f: '=VLOOKUP("Toko",Data!B2:E4,4,FALSE)' };
  dash.cells['A5'] = { v: 'Cek INDEX-MATCH' };
  dash.cells['B5'] = { f: '=INDEX(Data!E2:E4,MATCH("Mar",Data!A2:A4,0))' };
  dash.cells['A6'] = { v: 'Cek IF' };
  dash.cells['B6'] = { f: '=IF(B2>400,"LEWAT","BELUM")' };
  wb.sheets.push(dash);
  return wb;
}

describe('workbook.json schema', () => {
  test('cell with both value and formula is a structural error', () => {
    const wb = goldenWorkbook();
    (wb.sheets[0] as WorkbookSpec['sheets'][number]).cells['C2'] = { v: 5, f: '=1+1' };
    const issues = validateWorkbook(wb).filter((i) => i.severity === 'error');
    expect(issues.some((i) => i.code === 'cell-value-and-formula')).toBe(true);
  });

  test('duplicate sheet names and bad merges are errors; golden fixture is clean', () => {
    const wb = goldenWorkbook();
    expect(validateWorkbook(wb).filter((i) => i.severity === 'error')).toEqual([]);
    wb.sheets.push(newSheet('data'));
    wb.sheets[0].merges = ['not-a-range'];
    const codes = validateWorkbook(wb).map((i) => i.code);
    expect(codes).toContain('duplicate-sheet-name');
    expect(codes).toContain('invalid-merge');
  });
});

describe('formula evaluator (golden recompute)', () => {
  test('SUM, SUMIF, VLOOKUP, INDEX-MATCH, IF and Asumsi cross-refs recompute exactly', () => {
    const wb = goldenWorkbook();
    const evaluation = evaluateWorkbook(wb);
    const dash = evaluation.results.get('Dashboard') as Map<string, { kind: string; value?: unknown; error?: string }>;
    expect(dash.get('B2')).toEqual({ kind: 'value', value: 450 });
    expect(dash.get('B3')).toEqual({ kind: 'value', value: 300 });
    expect(dash.get('B4')).toEqual({ kind: 'value', value: 150 });
    expect(dash.get('B5')).toEqual({ kind: 'value', value: 240 });
    expect(dash.get('B6')).toEqual({ kind: 'value', value: 'LEWAT' });
  });

  test('derived cells stay formulas and evaluator matches hand sums (never frozen)', () => {
    const wb = goldenWorkbook();
    const dataSheet = wb.sheets[0] as WorkbookSpec['sheets'][number];
    for (const ref of ['E2', 'E3', 'E4', 'F2', 'F3', 'F4']) {
      expect(dataSheet.cells[ref]?.f).toBeTruthy();
      expect(dataSheet.cells[ref]?.v).toBeUndefined();
    }
    const evaluation = evaluateWorkbook(wb);
    const data = evaluation.results.get('Data') as Map<string, { kind: string; value?: unknown }>;
    expect(data.get('F2')).toEqual({ kind: 'value', value: 53.4 });
    expect(data.get('F4')).toEqual({ kind: 'value', value: 213.6 });
    expect(evaluation.errors).toEqual([]);
  });

  test('error literals: #DIV/0!, #REF! and cycles are named, not hidden', () => {
    const wb = goldenWorkbook();
    const dash = wb.sheets[2] as WorkbookSpec['sheets'][number];
    dash.cells['B7'] = { f: '=1/0' };
    dash.cells['B8'] = { f: '=SUM(Hilang!A1:A2)' };
    dash.cells['B9'] = { f: '=B10' };
    dash.cells['B10'] = { f: '=B9' };
    const evaluation = evaluateWorkbook(wb);
    const byCell = new Map(evaluation.errors.map((e) => [`${e.sheet}!${e.cell}`, e.error]));
    expect(byCell.get('Dashboard!B7')).toBe('#DIV/0!');
    expect(byCell.get('Dashboard!B8')).toBe('#REF!');
    expect(byCell.get('Dashboard!B9')).toBe('#CYCLE!');
  });

  test('unknown functions are reported unsupported (gate honesty)', () => {
    const wb = goldenWorkbook();
    (wb.sheets[2] as WorkbookSpec['sheets'][number]).cells['B7'] = { f: '=XLOOKUP("a",Data!A2:A4,Data!E2:E4)' };
    const evaluation = evaluateWorkbook(wb);
    expect(evaluation.unsupported.length).toBe(1);
    const core = verifyWorkbookCore(wb);
    expect(core.unsupported).toBe(1);
    expect(core.errors).toEqual([]);
  });
});

describe('verify gate', () => {
  test('audit flags frozen numbers inside a formula column', () => {
    const wb = goldenWorkbook();
    (wb.sheets[0] as WorkbookSpec['sheets'][number]).cells['E3'] = { v: 150 };
    const core = verifyWorkbookCore(wb);
    expect(core.warnings.some((w) => w.code === 'frozen-where-formula-expected' && w.cell === 'E3')).toBe(true);
  });

  test('duplicate rows are flagged once', () => {
    const wb = goldenWorkbook();
    const data = wb.sheets[0] as WorkbookSpec['sheets'][number];
    data.cells['A5'] = { v: 'Jan' };
    data.cells['B5'] = { v: 'Online' };
    data.cells['C5'] = { v: 100 };
    data.cells['D5'] = { v: 40 };
    data.cells['E5'] = { f: '=C5-D5' };
    data.cells['F5'] = { f: '=E5-(E5*Asumsi!$B$2)' };
    const core = verifyWorkbookCore(wb);
    expect(core.warnings.filter((w) => w.code === 'duplicate-row').length).toBe(1);
  });

  test('core-only path is named honestly; clean workbook passes', async () => {
    const report = await verifyWorkbook(goldenWorkbook(), { coreOnly: true });
    expect(report.path).toBe('core');
    expect(report.ok).toBe(true);
    expect(report.formulasChecked).toBeGreaterThan(10);
  });

  test('unsupported formulas downgrade the verdict to partial (never silent pass)', async () => {
    const wb = goldenWorkbook();
    (wb.sheets[2] as WorkbookSpec['sheets'][number]).cells['B7'] = { f: '=WEBSERVICE("https://example.invalid")' };
    const report = await verifyWorkbook(wb, { coreOnly: true });
    expect(report.path).toBe('partial');
    expect(report.unsupported).toBe(1);
  });
});

describe('structured edit ops', () => {
  test('vocabulary is exactly the design tool table', () => {
    expect([...SHEET_OP_NAMES]).toEqual([
      'create_workbook', 'get_workbook_summary', 'read_range', 'set_cells',
      'set_formula', 'insert_rows', 'insert_columns', 'delete_range',
      'sort_range', 'set_format', 'add_sheet', 'rename_sheet', 'delete_sheet',
      'define_named_range', 'validate_workbook', 'export_workbook',
    ]);
    for (const codingTool of ['write_file', 'run_command', 'edit_file', 'spawn_subagent']) {
      expect(SHEET_OP_NAMES as readonly string[]).not.toContain(codingTool);
    }
  });

  test('an invalid op rejects the whole batch; workbook stays byte-identical', async () => {
    const root = tempWorkspace();
    const wb = goldenWorkbook();
    await writeWorkbook(root, wb);
    const before = readFileSync(join(root, 'workbook', 'workbook.json'), 'utf8');
    const inMemoryBefore = JSON.stringify(wb);
    const result = applySheetOps(wb, {
      kind: 'sheet-ops',
      ops: [
        { op: 'set_cells', sheet: 'Data', range: 'C2', values: [[999]] },
        { op: 'set_cells', sheet: 'TidakAda', range: 'A1', values: [[1]] },
      ],
    });
    expect(result.ok).toBe(false);
    const after = readFileSync(join(root, 'workbook', 'workbook.json'), 'utf8');
    expect(after).toBe(before);
    // The input object itself is never mutated either (clone-apply).
    expect(JSON.stringify(wb)).toBe(inMemoryBefore);
  });

  test('set_formula fill shifts relative refs but keeps $ absolute refs pinned', () => {
    const wb = goldenWorkbook();
    const result = applySheetOps(wb, {
      kind: 'sheet-ops',
      ops: [{ op: 'set_formula', sheet: 'Data', range: 'F2:F4', formula: '=E2*(1-Asumsi!$B$2)' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.workbook.sheets[0] as WorkbookSpec['sheets'][number];
    expect(data.cells['F2']?.f).toBe('=E2*(1-Asumsi!$B$2)');
    expect(data.cells['F4']?.f).toBe('=E4*(1-Asumsi!$B$2)');
  });

  test('insert_rows shifts cells and cross-sheet references', () => {
    const wb = goldenWorkbook();
    const result = applySheetOps(wb, {
      kind: 'sheet-ops',
      ops: [{ op: 'insert_rows', sheet: 'Data', at: 3, count: 1 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dash = result.workbook.sheets[2] as WorkbookSpec['sheets'][number];
    expect(dash.cells['B2']?.f).toBe('=SUM(Data!E2:E5)');
    const data = result.workbook.sheets[0] as WorkbookSpec['sheets'][number];
    expect(data.cells['C4']?.v).toBe(200);
  });
});

describe('import', () => {
  test('CSV parses quoted fields and infers typed values', () => {
    const rows = parseCsvText('Bulan,Kanal,Pendapatan\n"Jan, awal",Online,"120.000"\nFeb,Toko,95000\n');
    expect(rows[1]).toEqual(['Jan, awal', 'Online', '120.000']);
    const wb = importCsvToWorkbook('Jualan', 'Bulan,Pendapatan,Pajak\nJan,1000,0.11\nFeb,2000,0.11\n', { createdBy: 'test' });
    const sheet = wb.sheets[0] as WorkbookSpec['sheets'][number];
    expect(sheet.cells['B2']).toEqual({ v: 1000 });
    expect(sheet.cells['C2']).toEqual({ v: 0.11 });
  });

  test('XLSX import preserves formulas for the verify gate', async () => {
    const source = new ExcelJS.Workbook();
    const ws = source.addWorksheet('Data');
    ws.getCell('A1').value = 'Nilai';
    ws.getCell('A2').value = 10;
    ws.getCell('A3').value = 20;
    ws.getCell('A4').value = { formula: 'SUM(A2:A3)' };
    const buffer = Buffer.from(await source.xlsx.writeBuffer());
    const wb = await importXlsxToWorkbook('Impor', buffer, { createdBy: 'test' });
    const sheet = wb.sheets[0] as WorkbookSpec['sheets'][number];
    expect(sheet.cells['A4']?.f).toBe('=SUM(A2:A3)');
    const evaluation = evaluateWorkbook(wb);
    expect(evaluation.results.get('Data')?.get('A4')).toEqual({ kind: 'value', value: 30 });
  });
});

describe('export', () => {
  test('xlsx carries live formulas with cached results; CSV carries computed values', async () => {
    const root = tempWorkspace();
    const wb = goldenWorkbook();
    await writeWorkbook(root, wb);
    const record = await exportWorkbookToXlsx(wb, root, { sidecar: false });
    expect(existsSync(record.path)).toBe(true);
    const back = new ExcelJS.Workbook();
    await back.xlsx.readFile(record.path);
    const dash = back.getWorksheet('Dashboard');
    const b2 = dash?.getCell('B2').value as { formula?: string; result?: unknown };
    expect(b2.formula).toBe('SUM(Data!E2:E4)');
    expect(b2.result).toBe(450);
    // exceljs does not surface calcPr on read; assert at the XML level.
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(readFileSync(record.path));
    const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
    expect(workbookXml).toContain('fullCalcOnLoad');
    const csv = exportSheetToCsvText(wb, 'Dashboard');
    expect(csv.ok).toBe(true);
    if (csv.ok) {
      expect(csv.text).toContain('Total Laba,450');
      expect(csv.text).not.toContain('=SUM(');
    }
  });

  test('sidecar absent: export proceeds without natives, says so, adds formula summary', async () => {
    const root = tempWorkspace();
    process.env.DAEDALUS_SHEET_SIDECAR = join(root, 'no-such-binary');
    const wb = goldenWorkbook();
    const dash = wb.sheets[2] as WorkbookSpec['sheets'][number];
    dash.charts = [{ id: 'c1', type: 'column', range: 'Data!A1:C4', sheet: 'Dashboard', anchor: 'D2' }];
    dash.pivots = [{ id: 'p1', source: 'Data!A1:F4', target: 'Pivot', rows: ['Kanal'], values: [{ field: 'Laba', agg: 'sum' }] }];
    await writeWorkbook(root, wb);
    const record = await exportWorkbookToXlsx(wb, root);
    expect(record.via).toBe('exceljs');
    expect(record.note).toContain('tidak disuntikkan');
    const back = new ExcelJS.Workbook();
    await back.xlsx.readFile(record.path);
    expect(back.getWorksheet('Ringkasan')).toBeTruthy();
    const ringkasan = back.getWorksheet('Ringkasan');
    const formulas: string[] = [];
    ringkasan?.eachRow((row) => row.eachCell((cell) => {
      const v = cell.value as { formula?: string };
      if (v?.formula) formulas.push(v.formula);
    }));
    expect(formulas.some((f) => f.startsWith('SUMIF('))).toBe(true);
  });
});

describe('SpreadsheetEngine end to end (scripted provider)', () => {
  const BLUEPRINT = JSON.stringify({
    title: 'Rekap Uji',
    sheets: [
      {
        name: 'Data', purpose: 'data penjualan',
        columns: [
          { name: 'Kanal', type: 'text', source: 'input' },
          { name: 'Pendapatan', type: 'currency', source: 'input' },
          { name: 'Biaya', type: 'currency', source: 'input' },
          { name: 'Laba', type: 'currency', source: 'formula', formula: '=B{r}-C{r}' },
          { name: 'LabaBersih', type: 'currency', source: 'formula', formula: '=D{r}-(D{r}*Asumsi!$B$2)' },
        ],
      },
      {
        name: 'Ringkasan', purpose: 'per kanal',
        columns: [
          { name: 'Kategori', type: 'text', source: 'input' },
          { name: 'TotalLaba', type: 'currency', source: 'formula', formula: '=SUMIF(Data!$A$2:$A$4,$A{r},Data!$D$2:$D$4)' },
        ],
      },
    ],
    assumptions: [{ name: 'Pajak', value: 0.11, note: 'PPN' }],
  });

  function scriptedProvider(editMode: { bad: boolean } = { bad: false }): LLMProvider {
    return {
      name: 'fake',
      async chat(messages) {
        const system = String(messages[0]?.content ?? '');
        const user = String(messages[1]?.content ?? '');
        let content = '{}';
        if (system.includes('blueprint stage')) content = BLUEPRINT;
        else if (system.includes('You fill the input columns')) {
          content = user.includes('Sheet: Data')
            ? JSON.stringify({ rows: [['Online', 100, 40], ['Toko', 200, 50], ['Online', 300, 60]] })
            : JSON.stringify({ rows: [['Online'], ['Toko']] });
        } else if (system.includes('You edit a spreadsheet')) {
          content = editMode.bad
            ? JSON.stringify({ kind: 'sheet-ops', ops: [{ op: 'set_cells', sheet: 'Hilang', range: 'A1', values: [[1]] }, { op: 'bogus_op' }] })
            : JSON.stringify({ kind: 'sheet-ops', ops: [{ op: 'set_cells', sheet: 'Data', range: 'B5', values: [[400]] }, { op: 'set_formula', sheet: 'Data', range: 'D5', formula: '=B5-C5' }] });
        }
        return { message: { role: 'assistant', content }, usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
      },
    } as unknown as LLMProvider;
  }

  function makeEngine(root: string, provider: LLMProvider): SpreadsheetEngine {
    const store = new TaskStore(join(root, '.store'));
    return new SpreadsheetEngine({
      provider,
      bus: new EventBus(),
      store,
      questions: new QuestionBroker({ timeoutMs: 1000 }),
      workspaceRoot: root,
    });
  }

  async function waitForStaged(root: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const wb = await readWorkbook(root).catch(() => null);
      if (wb?.blueprint && wb.stage === 'blueprint') return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('blueprint never staged');
  }

  test('blueprint parks at Buat; build produces live formulas, verify passes, xlsx exported', async () => {
    const root = tempWorkspace();
    const engine = makeEngine(root, scriptedProvider());
    const spec = { id: 'sheet-t1', goal: 'buatkan rekap penjualan', repo_path: root, constraints: [], done_criteria: [], created_at: new Date().toISOString() };
    const runPromise = engine.run(spec as never);
    await waitForStaged(root);
    const staged = await readWorkbook(root);
    expect(staged?.stage).toBe('blueprint');
    expect(staged?.sheets.map((s) => s.name)).toContain('Data');
    const completion = engine.generateStagedWorkbook();
    expect(completion).not.toBeNull();
    const result = await runPromise;
    expect(result.outcome).toBe('success');
    const wb = await readWorkbook(root);
    expect(wb?.stage).toBe('ready');
    const data = wb?.sheets.find((s) => s.name === 'Data');
    expect(data?.cells['D2']?.f).toBe('=B2-C2');
    expect(data?.cells['E4']?.f).toBe('=D4-(D4*Asumsi!$B$2)');
    expect(data?.cells['D2']?.v).toBeUndefined();
    const asumsi = wb?.sheets.find((s) => s.name === 'Asumsi');
    expect(asumsi?.cells['B2']?.v).toBe(0.11);
    const evaluation = evaluateWorkbook(wb as WorkbookSpec);
    expect(evaluation.results.get('Data')?.get('E2')).toEqual({ kind: 'value', value: 53.4 });
    expect(wb?.verify?.ok).toBe(true);
    expect(result.exported?.path).toBeTruthy();
    expect(existsSync(result.exported?.path as string)).toBe(true);
    engine.stop();
  }, 90_000);

  test('edit: one validated op batch applies; invalid batch leaves workbook byte-identical', async () => {
    const root = tempWorkspace();
    const engine = makeEngine(root, scriptedProvider());
    const gen = { id: 'sheet-t2', goal: 'buatkan rekap penjualan', repo_path: root, constraints: [], done_criteria: [], created_at: new Date().toISOString() };
    const runPromise = engine.run(gen as never);
    await waitForStaged(root);
    engine.generateStagedWorkbook();
    const built = await runPromise;
    expect(built.outcome).toBe('success');

    const editEngine = makeEngine(root, scriptedProvider());
    const edited = await editEngine.run({ id: 'sheet-t3', goal: 'tambah baris penjualan 400', repo_path: root, constraints: [], done_criteria: [], created_at: new Date().toISOString() } as never);
    expect(edited.outcome).toBe('success');
    const afterEdit = await readWorkbook(root);
    expect(afterEdit?.sheets.find((s) => s.name === 'Data')?.cells['B5']?.v).toBe(400);
    expect(afterEdit?.sheets.find((s) => s.name === 'Data')?.cells['D5']?.f).toBe('=B5-C5');

    const beforeBad = readFileSync(join(root, 'workbook', 'workbook.json'), 'utf8');
    const badEngine = makeEngine(root, scriptedProvider({ bad: true }));
    const rejected = await badEngine.run({ id: 'sheet-t4', goal: 'edit yang tidak valid', repo_path: root, constraints: [], done_criteria: [], created_at: new Date().toISOString() } as never);
    expect(rejected.outcome).toBe('failed');
    expect(readFileSync(join(root, 'workbook', 'workbook.json'), 'utf8')).toBe(beforeBad);
    editEngine.stop();
    badEngine.stop();
  }, 90_000);
});

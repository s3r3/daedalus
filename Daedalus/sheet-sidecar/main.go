// daedalus-sheet-sidecar: the Go native-parts injector for Agentic
// Spreadsheet exports.
//
// workbook.json (TypeScript core) is the only source of truth. The
// core first exports a complete xlsx with exceljs; this binary then —
// and only then — opens that file and injects the native OOXML parts
// exceljs cannot write: charts, pivot tables, slicers. It NEVER reads
// workbook.json, so content can never fork: kill the sidecar and the
// export simply ships without natives (the core reports exactly
// that).
//
// Contract (one JSON object on stdin):
//
//	{ "input": "in.xlsx", "output": "out.xlsx",
//	  "charts": [{ "type": "column|bar|line|pie", "range": "Data!A1:B13",
//	               "sheet": "Dashboard", "anchor": "D2", "title": "..." }],
//	  "pivots": [{ "source": "Data!A1:F100", "target": "Ringkasan",
//	               "anchor": "A1", "rows": ["Kategori"], "cols": [],
//	               "values": [{ "field": "Total", "agg": "sum" }] }],
//	  "slicers": [] }
//
// Exit 0 = output written. The JSON result on stdout reports what was
// actually injected (a slicer whose API path fails is skipped with a
// note, never silently faked). `--version` prints the binary identity
// the core probes for.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

const version = "daedalus-sheet-sidecar 0.1.0 (excelize)"

type chartSpec struct {
	Type   string `json:"type"`
	Range  string `json:"range"`
	Sheet  string `json:"sheet"`
	Anchor string `json:"anchor"`
	Title  string `json:"title"`
}

type pivotValue struct {
	Field string `json:"field"`
	Agg   string `json:"agg"`
}

type pivotSpec struct {
	Source string       `json:"source"`
	Target string       `json:"target"`
	Anchor string       `json:"anchor"`
	Rows   []string     `json:"rows"`
	Cols   []string     `json:"cols"`
	Values []pivotValue `json:"values"`
}

type injectRequest struct {
	Input   string      `json:"input"`
	Output  string      `json:"output"`
	Charts  []chartSpec `json:"charts"`
	Pivots  []pivotSpec `json:"pivots"`
	Slicers []struct {
		Source string `json:"source"`
		Field  string `json:"field"`
		Target string `json:"target"`
		Cell   string `json:"cell"`
	} `json:"slicers"`
}

type injectResult struct {
	Charts  int      `json:"charts"`
	Pivots  int      `json:"pivots"`
	Slicers int      `json:"slicers"`
	Notes   []string `json:"notes"`
}

var rangeRe = regexp.MustCompile(`^(?:'([^']+)'|([^!]+))!\$?([A-Za-z]{1,3})\$?([0-9]+)(?::\$?([A-Za-z]{1,3})\$?([0-9]+))?$`)

type cellRange struct {
	Sheet               string
	MinCol, MinRow      int // 1-based
	MaxCol, MaxRow      int
}

func colIdx(letters string) int {
	n := 0
	for _, ch := range strings.ToUpper(letters) {
		n = n*26 + int(ch-'A') + 1
	}
	return n
}

func colName(idx int) string {
	name := ""
	for idx > 0 {
		idx--
		name = string(rune('A'+idx%26)) + name
		idx /= 26
	}
	return name
}

func parseRange(text string) (cellRange, error) {
	m := rangeRe.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return cellRange{}, fmt.Errorf("range %q is not a Sheet!A1:B2 reference", text)
	}
	sheet := m[1]
	if sheet == "" {
		sheet = m[2]
	}
	r := cellRange{Sheet: sheet, MinCol: colIdx(m[3]), MinRow: atoi(m[4])}
	r.MaxCol, r.MaxRow = r.MinCol, r.MinRow
	if m[5] != "" {
		r.MaxCol = colIdx(m[5])
		r.MaxRow = atoi(m[6])
	}
	return r, nil
}

func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func cellRef(col, row int) string {
	return fmt.Sprintf("%s%d", colName(col), row)
}

func absRef(sheet string, col, row int) string {
	return fmt.Sprintf("'%s'!$%s$%d", sheet, colName(col), row)
}

// fieldIndex resolves a header name to its 1-based column offset within
// the source range (header row = first row of the range).
func fieldIndex(f *excelize.File, r cellRange, field string) (int, error) {
	for col := r.MinCol; col <= r.MaxCol; col++ {
		v, err := f.GetCellValue(r.Sheet, cellRef(col, r.MinRow))
		if err != nil {
			return 0, err
		}
		if strings.EqualFold(strings.TrimSpace(v), field) {
			return col - r.MinCol + 1, nil
		}
	}
	return 0, fmt.Errorf("field %q not found in header row of %s", field, r.Sheet)
}

func addChart(f *excelize.File, spec chartSpec) error {
	r, err := parseRange(spec.Range)
	if err != nil {
		return err
	}
	if r.MaxCol <= r.MinCol || r.MaxRow <= r.MinRow {
		return fmt.Errorf("chart range %q needs a header row and at least two columns", spec.Range)
	}
	sheet := spec.Sheet
	if sheet == "" {
		sheet = r.Sheet
	}
	categories := fmt.Sprintf("'%s'!$%s$%d:$%s$%d", r.Sheet, colName(r.MinCol), r.MinRow+1, colName(r.MinCol), r.MaxRow)
	series := make([]excelize.ChartSeries, 0, r.MaxCol-r.MinCol)
	for col := r.MinCol + 1; col <= r.MaxCol; col++ {
		series = append(series, excelize.ChartSeries{
			Name:       absRef(r.Sheet, col, r.MinRow),
			Categories: categories,
			Values:     fmt.Sprintf("'%s'!$%s$%d:$%s$%d", r.Sheet, colName(col), r.MinRow+1, colName(col), r.MaxRow),
		})
	}
	chartType := excelize.Col
	switch strings.ToLower(spec.Type) {
	case "bar":
		chartType = excelize.Bar
	case "line":
		chartType = excelize.Line
	case "pie":
		chartType = excelize.Pie
	}
	chart := &excelize.Chart{
		Type:   chartType,
		Series: series,
	}
	if spec.Title != "" {
		chart.Title = []excelize.RichTextRun{{Text: spec.Title}}
	}
	if chartType == excelize.Pie {
		chart.Legend.Position = "bottom"
		chart.Dimension.Width = 20
		chart.Dimension.Height = 12
	}
	anchor := spec.Anchor
	if anchor == "" {
		anchor = "A1"
	}
	return f.AddChart(sheet, anchor, chart)
}

// uniqueCount counts distinct non-empty values of `field` in the rows
// below the header. Used to size the pivot table's target range so the
// table definition matches the data Excel will render.
func uniqueCount(f *excelize.File, r cellRange, fieldIdx int) (int, error) {
	seen := map[string]bool{}
	for row := r.MinRow + 1; row <= r.MaxRow; row++ {
		v, err := f.GetCellValue(r.Sheet, cellRef(r.MinCol+fieldIdx-1, row))
		if err != nil {
			return 0, err
		}
		if strings.TrimSpace(v) != "" {
			seen[v] = true
		}
	}
	return len(seen), nil
}

func subtotalOf(agg string) string {
	switch strings.ToLower(agg) {
	case "count":
		return "Count"
	case "average":
		return "Average"
	case "min":
		return "Min"
	case "max":
		return "Max"
	default:
		return "Sum"
	}
}

func addPivot(f *excelize.File, spec pivotSpec) error {
	src, err := parseRange(spec.Source)
	if err != nil {
		return err
	}
	target := spec.Target
	if target == "" {
		target = "Ringkasan"
	}
	if idx, _ := f.GetSheetIndex(target); idx < 0 {
		if _, err := f.NewSheet(target); err != nil {
			return fmt.Errorf("create pivot sheet %q: %w", target, err)
		}
	}
	anchor := spec.Anchor
	if anchor == "" {
		anchor = "A1"
	}
	anchorRange, err := parseRange(fmt.Sprintf("'%s'!%s", target, anchor))
	if err != nil {
		return err
	}
	rows := make([]excelize.PivotTableField, 0, len(spec.Rows))
	maxRows := 1
	for _, name := range spec.Rows {
		idx, err := fieldIndex(f, src, name)
		if err != nil {
			return err
		}
		count, err := uniqueCount(f, src, idx)
		if err != nil {
			return err
		}
		// Data rows stack under one another per row field; approximate generously.
		if count > maxRows {
			maxRows = count
		}
		rows = append(rows, excelize.PivotTableField{Data: name, DefaultSubtotal: true})
	}
	cols := make([]excelize.PivotTableField, 0, len(spec.Cols))
	colKeys := 0
	for _, name := range spec.Cols {
		idx, err := fieldIndex(f, src, name)
		if err != nil {
			return err
		}
		count, err := uniqueCount(f, src, idx)
		if err != nil {
			return err
		}
		colKeys += count
		cols = append(cols, excelize.PivotTableField{Data: name})
	}
	data := make([]excelize.PivotTableField, 0, len(spec.Values))
	for _, v := range spec.Values {
		if _, err := fieldIndex(f, src, v.Field); err != nil {
			return err
		}
		data = append(data, excelize.PivotTableField{Data: v.Field, Name: "", Subtotal: subtotalOf(v.Agg)})
	}
	// PivotTableRange: title row + rows + grand-total row; columns =
	// row fields + (col keys × value fields, at least 1) + total col.
	totalRows := maxRows + 3
	valueCols := len(data)
	if valueCols < 1 {
		valueCols = 1
	}
	spread := colKeys
	if spread < 1 {
		spread = 1
	}
	totalCols := len(rows) + spread*valueCols
	endCol := anchorRange.MinCol + totalCols - 1
	endRow := anchorRange.MinRow + totalRows
	return f.AddPivotTable(&excelize.PivotTableOptions{
		DataRange:       spec.Source,
		// NOTE: Excelize's PivotTableRange parser rejects 'Quoted'!
		// sheet names; the range must go in unquoted (verified by spike).
		PivotTableRange: fmt.Sprintf("%s!%s:%s", target, cellRef(anchorRange.MinCol, anchorRange.MinRow), cellRef(endCol, endRow)),
		Rows:            rows,
		Columns:         cols,
		Data:            data,
		RowGrandTotals:  true,
		ColGrandTotals:  true,
		ShowDrill:       true,
	})
}

func run() int {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return 0
	}
	if len(os.Args) < 2 || os.Args[1] != "inject" {
		fmt.Fprintln(os.Stderr, "usage: daedalus-sheet-sidecar --version | inject < request.json")
		return 2
	}
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read stdin: %v\n", err)
		return 1
	}
	var req injectRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		fmt.Fprintf(os.Stderr, "parse request: %v\n", err)
		return 1
	}
	if req.Input == "" || req.Output == "" {
		fmt.Fprintln(os.Stderr, "request needs input and output paths")
		return 1
	}
	f, err := excelize.OpenFile(req.Input)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open %s: %v\n", req.Input, err)
		return 1
	}
	defer f.Close()

	result := injectResult{Notes: []string{}}
	// Pivots first: a chart may read a pivot's output sheet.
	for _, pivot := range req.Pivots {
		if err := addPivot(f, pivot); err != nil {
			result.Notes = append(result.Notes, fmt.Sprintf("pivot %s skipped: %v", pivot.Source, err))
			continue
		}
		result.Pivots++
	}
	for _, chart := range req.Charts {
		if err := addChart(f, chart); err != nil {
			result.Notes = append(result.Notes, fmt.Sprintf("chart %s skipped: %v", chart.Range, err))
			continue
		}
		result.Charts++
	}
	// Slicers: tied to a table over the pivot source when requested.
	for _, slicer := range req.Slicers {
		src, err := parseRange(slicer.Source)
		if err != nil {
			result.Notes = append(result.Notes, fmt.Sprintf("slicer skipped: %v", err))
			continue
		}
		tableName := "SumberData"
		if err := f.AddTable(src.Sheet, &excelize.Table{
			Range:     fmt.Sprintf("%s:%s", cellRef(src.MinCol, src.MinRow), cellRef(src.MaxCol, src.MaxRow)),
			Name:      tableName,
			StyleName: "TableStyleMedium2",
		}); err != nil {
			result.Notes = append(result.Notes, fmt.Sprintf("slicer table skipped: %v", err))
			continue
		}
		targetSheet := slicer.Target
		if targetSheet == "" {
			targetSheet = src.Sheet
		}
		cell := slicer.Cell
		if cell == "" {
			cell = "A1"
		}
		if err := f.AddSlicer(targetSheet, &excelize.SlicerOptions{
			Name:       slicer.Field,
			Cell:       cell,
			TableSheet: src.Sheet,
			TableName:  tableName,
			Caption:    slicer.Field,
		}); err != nil {
			result.Notes = append(result.Notes, fmt.Sprintf("slicer skipped: %v", err))
			continue
		}
		result.Slicers++
	}

	if err := f.SaveAs(req.Output); err != nil {
		fmt.Fprintf(os.Stderr, "save %s: %v\n", req.Output, err)
		return 1
	}
	// Excelize rewrites the workbook without calcPr: restore the
	// fullCalcOnLoad flag the core set on the exceljs export, so the
	// injected file recomputes live formulas on open exactly like the
	// plain export does. Done at the ZIP level because Excelize 2.9
	// exposes no calc-properties setter.
	if err := ensureFullCalcOnLoad(req.Output); err != nil {
		result.Notes = append(result.Notes, fmt.Sprintf("fullCalcOnLoad restore failed: %v", err))
	}
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(result)
	return 0
}

// ensureFullCalcOnLoad sets <calcPr fullCalcOnLoad="1"/> in
// xl/workbook.xml of an already-written xlsx, rewriting the archive.
func ensureFullCalcOnLoad(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, entry := range zr.File {
		rc, err := entry.Open()
		if err != nil {
			return err
		}
		content, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return err
		}
		if entry.Name == "xl/workbook.xml" {
			xmlText := string(content)
			if strings.Contains(xmlText, "<calcPr") {
				xmlText = regexp.MustCompile(`fullCalcOnLoad="(0|false)"`).ReplaceAllString(xmlText, `fullCalcOnLoad="1"`)
				if !strings.Contains(xmlText, "fullCalcOnLoad") {
					xmlText = strings.Replace(xmlText, "<calcPr", `<calcPr fullCalcOnLoad="1"`, 1)
				}
			} else {
				xmlText = strings.Replace(xmlText, "</workbook>", `<calcPr fullCalcOnLoad="1"/></workbook>`, 1)
			}
			content = []byte(xmlText)
		}
		w, err := zw.CreateHeader(&entry.FileHeader)
		if err != nil {
			return err
		}
		if _, err := w.Write(content); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

func main() {
	os.Exit(run())
}

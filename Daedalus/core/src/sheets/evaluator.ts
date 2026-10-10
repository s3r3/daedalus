import {
  formatCellRef,
  parseCellRef,
  sheetHeaders,
  type SheetSpec,
  type WorkbookSpec,
} from './workbook.ts';

/**
 * In-core formula evaluator — the first arm of the Verify gate. The
 * design's research is blunt: when verification is skipped, ~40% of
 * generated files hold wrong values while 0% "fail" loudly. This
 * evaluator recomputes every formula cell from workbook.json (the
 * source of truth) so broken references and error literals are caught
 * before export. It deliberately covers the common function library
 * (SUM family, IF family, lookups, aggregation, text, rounding); a
 * formula using something outside the subset is reported as
 * `unsupported`, which downgrades the gate verdict to "partial"
 * instead of pretending the cell was checked.
 *
 * Error values follow Excel's literals (#DIV/0!, #VALUE!, #REF!,
 * #NAME?, #N/A, #NUM!, #NULL!) so the core gate and the LibreOffice
 * recalc scan speak the same vocabulary.
 */

export type EvalError = '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!' | '#NULL!' | '#CYCLE!';

export type EvalResult =
  | { kind: 'value'; value: number | string | boolean | null }
  | { kind: 'error'; error: EvalError }
  | { kind: 'unsupported'; detail: string };

const err = (error: EvalError): EvalResult => ({ kind: 'error', error });
const val = (value: number | string | boolean | null): EvalResult => ({ kind: 'value', value });
const unsupported = (detail: string): EvalResult => ({ kind: 'unsupported', detail });

/* ------------------------------------------------------------- lexer */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ident'; v: string } // function names, sheet names, named ranges, TRUE/FALSE
  | { t: 'ref'; sheet?: string; col: number; row: number }
  | { t: 'range'; sheet?: string; start: { col: number; row: number }; end: { col: number; row: number } }
  | { t: 'op'; v: string }
  | { t: 'lparen' } | { t: 'rparen' } | { t: 'comma' } | { t: 'pct' };

function lex(input: string): Tok[] | null {
  const s = input;
  let i = 0;
  const toks: Tok[] = [];
  const push = (t: Tok): void => { toks.push(t); };
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (ch === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return null;
      push({ t: 'str', v: s.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === "'") {
      // Quoted sheet name: 'My Sheet'!A1 → ident with the sheet flag.
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      const name = s.slice(i + 1, end);
      if (s[end + 1] === '!') {
        const refMatch = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}/.exec(s.slice(end + 2));
        if (!refMatch) return null;
        const ref = parseCellRef(refMatch[0]);
        if (!ref) return null;
        let next = end + 2 + refMatch[0].length;
        if (s[next] === ':') {
          const ref2Match = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}/.exec(s.slice(next + 1));
          if (!ref2Match) return null;
          const ref2 = parseCellRef(ref2Match[0]);
          if (!ref2) return null;
          push({ t: 'range', sheet: name, start: ref, end: { col: ref2.col, row: ref2.row } });
          next = next + 1 + ref2Match[0].length;
        } else {
          push({ t: 'ref', sheet: name, col: ref.col, row: ref.row });
        }
        i = next;
        continue;
      }
      return null;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|^\.[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(s.slice(i));
      if (!m) return null;
      push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      // Bare word: function call, boolean, sheet!ref, or named range.
      const wordMatch = /^[A-Za-z_$][A-Za-z0-9_.$]*/.exec(s.slice(i));
      if (!wordMatch) return null;
      const word = wordMatch[0];
      let next = i + word.length;
      if (s[next] === '!') {
        const refMatch = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}/.exec(s.slice(next + 1));
        if (!refMatch) return null;
        const ref = parseCellRef(refMatch[0]);
        if (!ref) return null;
        let end = next + 1 + refMatch[0].length;
        if (s[end] === ':') {
          const ref2Match = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}/.exec(s.slice(end + 1));
          if (!ref2Match) return null;
          const ref2 = parseCellRef(ref2Match[0]);
          if (!ref2) return null;
          push({ t: 'range', sheet: word, start: ref, end: { col: ref2.col, row: ref2.row } });
          end = end + 1 + ref2Match[0].length;
        } else {
          push({ t: 'ref', sheet: word, col: ref.col, row: ref.row });
        }
        i = end;
        continue;
      }
      // Plain A1 ref on the current sheet? e.g. B2, $B$2 (col letters then digits).
      // Not when a '(' follows: LOG10( is a function name, not a ref.
      const refMatch = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(word);
      if (refMatch && s[next] !== '(' && !/^(TRUE|FALSE)$/i.test(word)) {
        const ref = parseCellRef(word);
        if (ref) {
          if (s[next] === ':') {
            const ref2Match = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})/.exec(s.slice(next + 1));
            if (!ref2Match) return null;
            const ref2 = parseCellRef(ref2Match[0]);
            if (!ref2) return null;
            push({ t: 'range', start: ref, end: { col: ref2.col, row: ref2.row } });
            i = next + 1 + ref2Match[0].length;
            continue;
          }
          push({ t: 'ref', col: ref.col, row: ref.row });
          i = next;
          continue;
        }
      }
      if (/^TRUE$/i.test(word)) { push({ t: 'bool', v: true }); i = next; continue; }
      if (/^FALSE$/i.test(word)) { push({ t: 'bool', v: false }); i = next; continue; }
      push({ t: 'ident', v: word.toUpperCase() });
      i = next;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&%=<>'.includes(ch)) {
      if (ch === '%') push({ t: 'pct' });
      else push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    if (ch === '(') { push({ t: 'lparen' }); i += 1; continue; }
    if (ch === ')') { push({ t: 'rparen' }); i += 1; continue; }
    if (ch === ',') { push({ t: 'comma' }); i += 1; continue; }
    return null;
  }
  return toks;
}

/* ------------------------------------------------------------ parser */

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; sheet?: string; col: number; row: number }
  | { k: 'range'; sheet?: string; start: { col: number; row: number }; end: { col: number; row: number } }
  | { k: 'name'; v: string }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'neg'; x: Node }
  | { k: 'pct'; x: Node };

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }

  parse(): Node | null {
    const node = this.parseComparison();
    if (!node || this.pos !== this.toks.length) return null;
    return node;
  }
  private parseComparison(): Node | null {
    let left = this.parseConcat();
    if (!left) return null;
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
        this.next();
        const right = this.parseConcat();
        if (!right) return null;
        left = { k: 'bin', op: t.v, l: left, r: right };
      } else return left;
    }
  }
  private parseConcat(): Node | null {
    let left = this.parseAddSub();
    if (!left) return null;
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && t.v === '&') {
        this.next();
        const right = this.parseAddSub();
        if (!right) return null;
        left = { k: 'bin', op: '&', l: left, r: right };
      } else return left;
    }
  }
  private parseAddSub(): Node | null {
    let left = this.parseMulDiv();
    if (!left) return null;
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        const right = this.parseMulDiv();
        if (!right) return null;
        left = { k: 'bin', op: t.v, l: left, r: right };
      } else return left;
    }
  }
  private parseMulDiv(): Node | null {
    let left = this.parsePow();
    if (!left) return null;
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && (t.v === '*' || t.v === '/')) {
        this.next();
        const right = this.parsePow();
        if (!right) return null;
        left = { k: 'bin', op: t.v, l: left, r: right };
      } else return left;
    }
  }
  private parsePow(): Node | null {
    let left = this.parseUnary();
    if (!left) return null;
    for (;;) {
      const t = this.peek();
      if (t?.t === 'op' && t.v === '^') {
        this.next();
        const right = this.parseUnary();
        if (!right) return null;
        left = { k: 'bin', op: '^', l: left, r: right };
      } else return left;
    }
  }
  private parseUnary(): Node | null {
    const t = this.peek();
    if (t?.t === 'op' && t.v === '-') {
      this.next();
      const x = this.parseUnary();
      return x ? { k: 'neg', x } : null;
    }
    if (t?.t === 'op' && t.v === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePostfix();
  }
  private parsePostfix(): Node | null {
    const node = this.parseAtom();
    if (!node) return null;
    if (this.peek()?.t === 'pct') {
      this.next();
      return { k: 'pct', x: node };
    }
    return node;
  }
  private parseAtom(): Node | null {
    const t = this.next();
    if (!t) return null;
    switch (t.t) {
      case 'num': return { k: 'num', v: t.v };
      case 'str': return { k: 'str', v: t.v };
      case 'bool': return { k: 'bool', v: t.v };
      case 'ref': return { k: 'ref', sheet: t.sheet, col: t.col, row: t.row };
      case 'range': return { k: 'range', sheet: t.sheet, start: t.start, end: t.end };
      case 'lparen': {
        const inner = this.parseComparison();
        if (!inner || this.next()?.t !== 'rparen') return null;
        return inner;
      }
      case 'ident': {
        if (this.peek()?.t === 'lparen') {
          this.next();
          const args: Node[] = [];
          if (this.peek()?.t !== 'rparen') {
            for (;;) {
              const arg = this.parseComparison();
              if (!arg) return null;
              args.push(arg);
              if (this.peek()?.t === 'comma') { this.next(); continue; }
              break;
            }
          }
          if (this.next()?.t !== 'rparen') return null;
          return { k: 'call', name: t.v, args };
        }
        return { k: 'name', v: t.v };
      }
      default: return null;
    }
  }
}

export function parseFormula(formula: string): Node | null {
  const body = formula.startsWith('=') ? formula.slice(1) : formula;
  const toks = lex(body);
  if (!toks) return null;
  return new Parser(toks).parse();
}

/* --------------------------------------------------------- evaluator */

export type EvalContext = {
  workbook: WorkbookSpec;
  sheetByName: Map<string, SheetSpec>;
  memo: Map<string, EvalResult>;
  visiting: Set<string>;
};

export function createEvalContext(workbook: WorkbookSpec): EvalContext {
  const sheetByName = new Map<string, SheetSpec>();
  for (const sheet of workbook.sheets) sheetByName.set(sheet.name.toLowerCase(), sheet);
  return { workbook, sheetByName, memo: new Map(), visiting: new Set() };
}

function resolveSheet(ctx: EvalContext, current: SheetSpec, name: string | undefined): SheetSpec | null {
  if (!name) return current;
  return ctx.sheetByName.get(name.toLowerCase()) ?? null;
}

function cellScalar(sheet: SheetSpec, col: number, row: number, ctx: EvalContext): EvalResult {
  const ref = formatCellRef(col, row);
  const cell = sheet.cells[ref];
  if (!cell) return val(null);
  if (cell.f) {
    const key = `${sheet.name}!${ref}`;
    const memo = ctx.memo.get(key);
    if (memo) return memo;
    if (ctx.visiting.has(key)) return err('#CYCLE!');
    ctx.visiting.add(key);
    const result = evaluateFormula(cell.f, sheet, ctx);
    ctx.visiting.delete(key);
    ctx.memo.set(key, result);
    return result;
  }
  return val(cell.v ?? null);
}

function rangeValues(node: Extract<Node, { k: 'range' }>, current: SheetSpec, ctx: EvalContext): EvalResult[] | EvalResult {
  const sheet = resolveSheet(ctx, current, node.sheet);
  if (!sheet) return err('#REF!');
  const out: EvalResult[] = [];
  const minCol = Math.min(node.start.col, node.end.col);
  const maxCol = Math.max(node.start.col, node.end.col);
  const minRow = Math.min(node.start.row, node.end.row);
  const maxRow = Math.max(node.start.row, node.end.row);
  for (let r = minRow; r <= maxRow; r += 1) {
    for (let c = minCol; c <= maxCol; c += 1) {
      const v = cellScalar(sheet, c, r, ctx);
      if (v.kind === 'error' || v.kind === 'unsupported') return v;
      out.push(v);
    }
  }
  return out;
}

function toNumber(v: EvalResult): number | EvalResult {
  if (v.kind !== 'value') return v;
  if (typeof v.value === 'number') return v.value;
  if (typeof v.value === 'boolean') return v.value ? 1 : 0;
  if (v.value === null) return 0;
  const n = Number(v.value);
  return Number.isNaN(n) ? err('#VALUE!') : n;
}

function toText(v: EvalResult): string | EvalResult {
  if (v.kind !== 'value') return v;
  if (v.value === null) return '';
  if (typeof v.value === 'boolean') return v.value ? 'TRUE' : 'FALSE';
  return String(v.value);
}

function truthy(v: EvalResult): boolean | EvalResult {
  if (v.kind !== 'value') return v;
  if (typeof v.value === 'boolean') return v.value;
  if (typeof v.value === 'number') return v.value !== 0;
  if (v.value === null) return false;
  const text = v.value.toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return err('#VALUE!');
}

/** Criteria match for SUMIF/COUNTIF family: number, text, or comparison string. */
function criteriaMatch(cellValue: number | string | boolean | null, criteria: number | string | boolean | null): boolean {
  if (criteria === null) return cellValue === null;
  if (typeof criteria === 'number') return typeof cellValue === 'number' && cellValue === criteria;
  if (typeof criteria === 'boolean') return cellValue === criteria;
  const crit = criteria;
  const m = /^(>=|<=|<>|>|<|=)(.*)$/.exec(crit);
  if (m) {
    const op = m[1] as string;
    const rhsRaw = (m[2] as string).trim();
    const rhsNum = Number(rhsRaw);
    const isNum = rhsRaw !== '' && !Number.isNaN(rhsNum);
    const lhs = cellValue;
    if (isNum && typeof lhs === 'number') {
      switch (op) {
        case '>': return lhs > rhsNum;
        case '<': return lhs < rhsNum;
        case '>=': return lhs >= rhsNum;
        case '<=': return lhs <= rhsNum;
        case '=': return lhs === rhsNum;
        case '<>': return lhs !== rhsNum;
        default: return false;
      }
    }
    const lhsText = lhs === null ? '' : String(lhs);
    switch (op) {
      case '=': return lhsText.toLowerCase() === rhsRaw.toLowerCase();
      case '<>': return lhsText.toLowerCase() !== rhsRaw.toLowerCase();
      default: return false;
    }
  }
  // Wildcard-ish equality (supports trailing * like Excel).
  if (crit.includes('*')) {
    const pattern = new RegExp(`^${crit.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return pattern.test(cellValue === null ? '' : String(cellValue));
  }
  if (typeof cellValue === 'number') {
    const n = Number(crit);
    return !Number.isNaN(n) && cellValue === n;
  }
  return String(cellValue ?? '').toLowerCase() === crit.toLowerCase();
}

function flatten(args: Node[], current: SheetSpec, ctx: EvalContext): EvalResult[] | EvalResult {
  const out: EvalResult[] = [];
  for (const arg of args) {
    if (arg.k === 'range') {
      const values = rangeValues(arg, current, ctx);
      if (!Array.isArray(values)) return values;
      out.push(...values);
    } else {
      const v = evaluateNode(arg, current, ctx);
      if (v.kind !== 'value') return v;
      out.push(v);
    }
  }
  return out;
}

function numbersOf(results: EvalResult[]): number[] | EvalResult {
  const nums: number[] = [];
  for (const r of results) {
    if (r.kind !== 'value') return r;
    if (typeof r.value === 'number') nums.push(r.value);
  }
  return nums;
}

function evalCall(node: Extract<Node, { k: 'call' }>, current: SheetSpec, ctx: EvalContext): EvalResult {
  const name = node.name;
  const args = node.args;
  const need = (n: number): EvalResult | null => (args.length < n ? err('#VALUE!') : null);
  const rangeArg = (i: number): EvalResult[] | EvalResult => {
    const arg = args[i];
    if (!arg) return err('#VALUE!');
    if (arg.k === 'range') return rangeValues(arg, current, ctx);
    const single = evaluateNode(arg, current, ctx);
    return single.kind === 'value' ? [single] : single;
  };
  const scalar = (i: number): EvalResult => {
    const arg = args[i];
    if (!arg) return err('#VALUE!');
    return evaluateNode(arg, current, ctx);
  };

  switch (name) {
    case 'SUM': case 'COUNT': case 'COUNTA': case 'AVERAGE': case 'MIN': case 'MAX': {
      const flat = flatten(args, current, ctx);
      if (!Array.isArray(flat)) return flat;
      if (name === 'COUNTA') return val(flat.filter((r) => r.kind === 'value' && r.value !== null && r.value !== '').length);
      const nums = numbersOf(flat);
      if (!Array.isArray(nums)) return nums;
      if (name === 'COUNT') return val(nums.length);
      if (name === 'SUM') return val(nums.reduce((a, b) => a + b, 0));
      if (name === 'MIN') return val(nums.length ? Math.min(...nums) : 0);
      if (name === 'MAX') return val(nums.length ? Math.max(...nums) : 0);
      if (nums.length === 0) return err('#DIV/0!');
      return val(nums.reduce((a, b) => a + b, 0) / nums.length);
    }
    case 'SUMIF': case 'COUNTIF': case 'AVERAGEIF': {
      const missing = need(2); if (missing) return missing;
      const criteriaRange = rangeArg(0); if (!Array.isArray(criteriaRange)) return criteriaRange;
      const criteria = scalar(1); if (criteria.kind !== 'value') return criteria;
      const valueRange = name === 'COUNTIF' ? criteriaRange : (args[2] ? rangeArg(2) : criteriaRange);
      if (!Array.isArray(valueRange)) return valueRange;
      let sum = 0; let count = 0;
      for (let i = 0; i < criteriaRange.length; i += 1) {
        const c = criteriaRange[i] as Extract<EvalResult, { kind: 'value' }>;
        if (!criteriaMatch(c.value, criteria.value)) continue;
        count += 1;
        const v = valueRange[i];
        if (v && v.kind === 'value' && typeof v.value === 'number') sum += v.value;
      }
      if (name === 'COUNTIF') return val(count);
      if (name === 'AVERAGEIF') return count === 0 ? err('#DIV/0!') : val(sum / count);
      return val(sum);
    }
    case 'SUMIFS': case 'COUNTIFS': case 'AVERAGEIFS': {
      if (args.length < 3 || args.length % 2 === 0) return err('#VALUE!');
      const valueRange = rangeArg(0); if (!Array.isArray(valueRange)) return valueRange;
      const critRanges: Array<{ values: EvalResult[]; criteria: EvalResult }> = [];
      for (let i = 1; i < args.length; i += 2) {
        const values = rangeArg(i); if (!Array.isArray(values)) return values;
        const criteria = scalar(i + 1); if (criteria.kind !== 'value') return criteria;
        critRanges.push({ values, criteria });
      }
      let sum = 0; let count = 0;
      for (let i = 0; i < valueRange.length; i += 1) {
        const ok = critRanges.every(({ values, criteria }) => {
          const c = values[i];
          return c !== undefined && c.kind === 'value' && criteria.kind === 'value' && criteriaMatch(c.value, criteria.value);
        });
        if (!ok) continue;
        count += 1;
        const v = valueRange[i] as Extract<EvalResult, { kind: 'value' }>;
        if (typeof v.value === 'number') sum += v.value;
      }
      if (name === 'COUNTIFS') return val(count);
      if (name === 'AVERAGEIFS') return count === 0 ? err('#DIV/0!') : val(sum / count);
      return val(sum);
    }
    case 'IF': {
      const missing = need(2); if (missing) return missing;
      const cond = scalar(0); if (cond.kind !== 'value') return cond;
      const t = truthy(cond); if (typeof t !== 'boolean') return t;
      if (t) return scalar(1);
      return args[2] ? scalar(2) : val(false);
    }
    case 'IFS': {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const cond = scalar(i); if (cond.kind !== 'value') return cond;
        const t = truthy(cond); if (typeof t !== 'boolean') return t;
        if (t) return scalar(i + 1);
      }
      return err('#N/A');
    }
    case 'IFERROR': {
      const missing = need(2); if (missing) return missing;
      const first = scalar(0);
      if (first.kind === 'error') return scalar(1);
      return first;
    }
    case 'AND': case 'OR': {
      const flat = flatten(args, current, ctx);
      if (!Array.isArray(flat)) return flat;
      const bools: boolean[] = [];
      for (const r of flat) {
        const t = truthy(r);
        if (typeof t !== 'boolean') return t;
        bools.push(t);
      }
      return val(name === 'AND' ? bools.every(Boolean) : bools.some(Boolean));
    }
    case 'NOT': {
      const missing = need(1); if (missing) return missing;
      const v = scalar(0); if (v.kind !== 'value') return v;
      const t = truthy(v); if (typeof t !== 'boolean') return t;
      return val(!t);
    }
    case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': case 'ABS': case 'INT': case 'SQRT': case 'POWER': {
      const v0 = scalar(0); if (v0.kind !== 'value') return v0;
      const n0 = toNumber(v0); if (typeof n0 !== 'number') return n0;
      if (name === 'ABS') return val(Math.abs(n0));
      if (name === 'INT') return val(Math.floor(n0));
      if (name === 'SQRT') return n0 < 0 ? err('#NUM!') : val(Math.sqrt(n0));
      if (name === 'POWER') {
        const v1 = scalar(1); if (v1.kind !== 'value') return v1;
        const n1 = toNumber(v1); if (typeof n1 !== 'number') return n1;
        return val(Math.pow(n0, n1));
      }
      const v1 = args[1] ? scalar(1) : val(0); if (v1.kind !== 'value') return v1;
      const digits = toNumber(v1); if (typeof digits !== 'number') return digits;
      const factor = Math.pow(10, digits);
      if (name === 'ROUND') return val(Math.round(n0 * factor) / factor);
      if (name === 'ROUNDUP') return val(Math.ceil(Math.abs(n0) * factor) / factor * Math.sign(n0));
      return val(Math.trunc(n0 * factor) / factor);
    }
    case 'VLOOKUP': case 'HLOOKUP': {
      const missing = need(3); if (missing) return missing;
      const lookup = scalar(0); if (lookup.kind !== 'value') return lookup;
      const tableArg = args[1];
      if (!tableArg || tableArg.k !== 'range') return err('#VALUE!');
      const tableSheet = resolveSheet(ctx, current, tableArg.sheet);
      if (!tableSheet) return err('#REF!');
      const idxResult = scalar(2); if (idxResult.kind !== 'value') return idxResult;
      const idx = toNumber(idxResult); if (typeof idx !== 'number') return idx;
      const exact = args[3] ? truthy(scalar(3)) : false;
      if (typeof exact !== 'boolean') return exact;
      const rowCount = Math.abs(tableArg.end.row - tableArg.start.row) + 1;
      const colCount = Math.abs(tableArg.end.col - tableArg.start.col) + 1;
      const span = name === 'VLOOKUP' ? rowCount : colCount;
      for (let i = 0; i < span; i += 1) {
        const probeCol = name === 'VLOOKUP' ? tableArg.start.col : tableArg.start.col + i;
        const probeRow = name === 'VLOOKUP' ? tableArg.start.row + i : tableArg.start.row;
        const probe = cellScalar(tableSheet, probeCol, probeRow, ctx);
        if (probe.kind !== 'value') return probe;
        const match = typeof probe.value === 'number' && typeof lookup.value === 'number'
          ? probe.value === lookup.value
          : String(probe.value ?? '').toLowerCase() === String(lookup.value ?? '').toLowerCase();
        if (match) {
          const outCol = name === 'VLOOKUP' ? tableArg.start.col + idx - 1 : probeCol;
          const outRow = name === 'VLOOKUP' ? probeRow : tableArg.start.row + idx - 1;
          return cellScalar(tableSheet, outCol, outRow, ctx);
        }
        if (!exact && i === span - 1) break;
      }
      return err('#N/A');
    }
    case 'INDEX': {
      const missing = need(2); if (missing) return missing;
      const rangeNode = args[0];
      if (!rangeNode || (rangeNode.k !== 'range' && rangeNode.k !== 'ref')) return err('#VALUE!');
      const rowRes = scalar(1); if (rowRes.kind !== 'value') return rowRes;
      const rowN = toNumber(rowRes); if (typeof rowN !== 'number') return rowN;
      const colRes = args[2] ? scalar(2) : val(1); if (colRes.kind !== 'value') return colRes;
      const colN = toNumber(colRes); if (typeof colN !== 'number') return colN;
      if (rangeNode.k === 'ref') {
        const sheet = resolveSheet(ctx, current, rangeNode.sheet);
        if (!sheet) return err('#REF!');
        return cellScalar(sheet, rangeNode.col, rangeNode.row, ctx);
      }
      const sheet = resolveSheet(ctx, current, rangeNode.sheet);
      if (!sheet) return err('#REF!');
      return cellScalar(sheet, rangeNode.start.col + colN - 1, rangeNode.start.row + rowN - 1, ctx);
    }
    case 'MATCH': {
      const missing = need(2); if (missing) return missing;
      const lookup = scalar(0); if (lookup.kind !== 'value') return lookup;
      const rangeNode = args[1];
      if (!rangeNode || rangeNode.k !== 'range') return err('#VALUE!');
      const values = rangeValues(rangeNode, current, ctx);
      if (!Array.isArray(values)) return values;
      for (let i = 0; i < values.length; i += 1) {
        const probe = values[i] as Extract<EvalResult, { kind: 'value' }>;
        const match = typeof probe.value === 'number' && typeof lookup.value === 'number'
          ? probe.value === lookup.value
          : String(probe.value ?? '').toLowerCase() === String(lookup.value ?? '').toLowerCase();
        if (match) return val(i + 1);
      }
      return err('#N/A');
    }
    case 'CONCAT': case 'CONCATENATE': {
      const flat = flatten(args, current, ctx);
      if (!Array.isArray(flat)) return flat;
      let out = '';
      for (const r of flat) {
        const t = toText(r);
        if (typeof t !== 'string') return t;
        out += t;
      }
      return val(out);
    }
    case 'TEXT': {
      const missing = need(2); if (missing) return missing;
      const v = scalar(0); if (v.kind !== 'value') return v;
      const fmtResult = scalar(1); if (fmtResult.kind !== 'value') return fmtResult;
      const fmt = toText(fmtResult); if (typeof fmt !== 'string') return fmt;
      return val(formatWithNumFmt(v.value, fmt));
    }
    case 'LEFT': case 'RIGHT': case 'MID': case 'LEN': case 'UPPER': case 'LOWER': case 'TRIM': {
      const v = scalar(0); if (v.kind !== 'value') return v;
      const text = toText(v); if (typeof text !== 'string') return text;
      if (name === 'LEN') return val(text.length);
      if (name === 'UPPER') return val(text.toUpperCase());
      if (name === 'LOWER') return val(text.toLowerCase());
      if (name === 'TRIM') return val(text.trim().replace(/\s+/g, ' '));
      const nRes = args[1] ? scalar(1) : val(1); if (nRes.kind !== 'value') return nRes;
      const n = toNumber(nRes); if (typeof n !== 'number') return n;
      if (name === 'LEFT') return val(text.slice(0, Math.max(0, n)));
      if (name === 'RIGHT') return val(n <= 0 ? '' : text.slice(-n));
      const lenRes = args[2] ? scalar(2) : val(0); if (lenRes.kind !== 'value') return lenRes;
      const len = toNumber(lenRes); if (typeof len !== 'number') return len;
      return val(text.slice(Math.max(0, n - 1), Math.max(0, n - 1) + Math.max(0, len)));
    }
    case 'TODAY': return val(serialFromDate(new Date()));
    case 'NOW': return val(serialFromDate(new Date()));
    case 'DATE': {
      const parts: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = scalar(i); if (r.kind !== 'value') return r;
        const n = toNumber(r); if (typeof n !== 'number') return n;
        parts.push(n);
      }
      const yy = parts[0] as number; const mm = parts[1] as number; const dd = parts[2] as number;
      return val(serialFromDate(new Date(Date.UTC(yy, mm - 1, dd))));
    }
    case 'YEAR': case 'MONTH': case 'DAY': {
      const v = scalar(0); if (v.kind !== 'value') return v;
      const n = toNumber(v); if (typeof n !== 'number') return n;
      const d = dateFromSerial(n);
      if (name === 'YEAR') return val(d.getUTCFullYear());
      if (name === 'MONTH') return val(d.getUTCMonth() + 1);
      return val(d.getUTCDate());
    }
    default:
      return unsupported(`function ${name} is not in the core evaluator subset`);
  }
}

function serialFromDate(d: Date): number {
  const epoch = Date.UTC(1899, 11, 30);
  return Math.floor((d.getTime() - epoch) / 86_400_000);
}
function dateFromSerial(serial: number): Date {
  return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000);
}

/** Minimal numFmt rendering for TEXT()/CSV display (not a full Excel formatter). */
export function formatWithNumFmt(value: number | string | boolean | null, fmt: string): string {
  if (typeof value !== 'number') return value === null ? '' : String(value);
  if (fmt.includes('%')) {
    const decimals = (fmt.split('.')[1] ?? '').replace(/[^0#]/g, '').length;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  const decimals = (fmt.split('.')[1] ?? '').replace(/[^0#]/g, '').length;
  const grouped = fmt.includes(',');
  const fixed = value.toFixed(decimals);
  if (!grouped) return fixed;
  const [intPart, fracPart] = fixed.split('.');
  const groupedInt = (intPart as string).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart ? `${groupedInt}.${fracPart}` : groupedInt;
}

function evaluateNode(node: Node, current: SheetSpec, ctx: EvalContext): EvalResult {
  switch (node.k) {
    case 'num': return val(node.v);
    case 'str': return val(node.v);
    case 'bool': return val(node.v);
    case 'ref': {
      const sheet = resolveSheet(ctx, current, node.sheet);
      if (!sheet) return err('#REF!');
      return cellScalar(sheet, node.col, node.row, ctx);
    }
    case 'range': return unsupported('a range used where a single value is required');
    case 'name': {
      const named = ctx.workbook.namedRanges?.[node.v] ?? ctx.workbook.namedRanges?.[Object.keys(ctx.workbook.namedRanges ?? {}).find((k) => k.toUpperCase() === node.v) ?? ''];
      if (!named) return err('#NAME?');
      const sheetMatch = /^(?:'([^']+)'|([A-Za-z0-9_]+))!\$?([A-Za-z]{1,3})\$?([0-9]+)$/.exec(named);
      if (!sheetMatch) return unsupported(`named range ${node.v} reference "${named}" is outside the evaluator subset`);
      const sheet = ctx.sheetByName.get((sheetMatch[1] ?? sheetMatch[2] ?? '').toLowerCase());
      if (!sheet) return err('#REF!');
      const ref = parseCellRef(`${sheetMatch[3]}${sheetMatch[4]}`);
      if (!ref) return err('#REF!');
      return cellScalar(sheet, ref.col, ref.row, ctx);
    }
    case 'neg': {
      const x = evaluateNode(node.x, current, ctx);
      if (x.kind !== 'value') return x;
      const n = toNumber(x);
      return typeof n === 'number' ? val(-n) : n;
    }
    case 'pct': {
      const x = evaluateNode(node.x, current, ctx);
      if (x.kind !== 'value') return x;
      const n = toNumber(x);
      return typeof n === 'number' ? val(n / 100) : n;
    }
    case 'bin': {
      const l = evaluateNode(node.l, current, ctx);
      if (l.kind !== 'value') return l;
      const r = evaluateNode(node.r, current, ctx);
      if (r.kind !== 'value') return r;
      if (node.op === '&') {
        const lt = toText(l); if (typeof lt !== 'string') return lt;
        const rt = toText(r); if (typeof rt !== 'string') return rt;
        return val(lt + rt);
      }
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
        const bothNumbers = typeof l.value === 'number' && typeof r.value === 'number';
        const cmp = bothNumbers
          ? ((l.value as number) - (r.value as number) === 0 ? 0 : (l.value as number) < (r.value as number) ? -1 : 1)
          : String(l.value ?? '').toLowerCase().localeCompare(String(r.value ?? '').toLowerCase());
        switch (node.op) {
          case '=': return val(cmp === 0);
          case '<>': return val(cmp !== 0);
          case '<': return val(cmp < 0);
          case '>': return val(cmp > 0);
          case '<=': return val(cmp <= 0);
          case '>=': return val(cmp >= 0);
          default: return err('#VALUE!');
        }
      }
      const ln = toNumber(l); if (typeof ln !== 'number') return ln;
      const rn = toNumber(r); if (typeof rn !== 'number') return rn;
      switch (node.op) {
        case '+': return val(ln + rn);
        case '-': return val(ln - rn);
        case '*': return val(ln * rn);
        case '/': return rn === 0 ? err('#DIV/0!') : val(ln / rn);
        case '^': {
          const result = Math.pow(ln, rn);
          return Number.isNaN(result) ? err('#NUM!') : val(result);
        }
        default: return err('#VALUE!');
      }
    }
    case 'call': return evalCall(node, current, ctx);
    default: return unsupported('unrecognized formula node');
  }
}

export function evaluateFormula(formula: string, current: SheetSpec, ctx: EvalContext): EvalResult {
  const ast = parseFormula(formula);
  if (!ast) return unsupported(`formula "${formula}" could not be parsed by the core evaluator`);
  return evaluateNode(ast, current, ctx);
}

export type WorkbookEvaluation = {
  /** sheet name → cell ref → result */
  results: Map<string, Map<string, EvalResult>>;
  formulaCells: number;
  errors: Array<{ sheet: string; cell: string; error: EvalError }>;
  unsupported: Array<{ sheet: string; cell: string; detail: string }>;
};

/** Evaluate every formula cell in the workbook (used by verify + CSV export). */
export function evaluateWorkbook(workbook: WorkbookSpec): WorkbookEvaluation {
  const ctx = createEvalContext(workbook);
  const results = new Map<string, Map<string, EvalResult>>();
  const errors: WorkbookEvaluation['errors'] = [];
  const unsupportedList: WorkbookEvaluation['unsupported'] = [];
  let formulaCells = 0;
  for (const sheet of workbook.sheets) {
    const perSheet = new Map<string, EvalResult>();
    results.set(sheet.name, perSheet);
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (!cell.f) continue;
      formulaCells += 1;
      const result = cellScalar(sheet, parseCellRef(ref)?.col ?? 0, parseCellRef(ref)?.row ?? 0, ctx);
      perSheet.set(ref, result);
      if (result.kind === 'error') errors.push({ sheet: sheet.name, cell: ref, error: result.error });
      else if (result.kind === 'unsupported') unsupportedList.push({ sheet: sheet.name, cell: ref, detail: result.detail });
    }
  }
  return { results, formulaCells, errors, unsupported: unsupportedList };
}

/** Display string for a cell (literal value, evaluated formula, or error literal). */
export function displayValue(workbook: WorkbookSpec, evaluation: WorkbookEvaluation, sheet: SheetSpec, ref: string): string {
  const cell = sheet.cells[ref];
  if (!cell) return '';
  if (cell.f) {
    const result = evaluation.results.get(sheet.name)?.get(ref);
    if (!result || result.kind === 'unsupported') return cell.f;
    if (result.kind === 'error') return result.error;
    return result.value === null ? '' : typeof result.value === 'number' && cell.fmt ? formatWithNumFmt(result.value, cell.fmt) : String(result.value);
  }
  if (cell.v === undefined || cell.v === null) return '';
  return typeof cell.v === 'number' && cell.fmt ? formatWithNumFmt(cell.v, cell.fmt) : String(cell.v);
}

/** Column header name → index (for audit checks that reason per column). */
export function headerIndex(sheet: SheetSpec): Map<string, number> {
  const out = new Map<string, number>();
  for (const [col, name] of sheetHeaders(sheet)) out.set(name.toLowerCase(), col);
  return out;
}

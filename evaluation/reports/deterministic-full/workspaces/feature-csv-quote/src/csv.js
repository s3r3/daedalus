export function quoteCsvCell(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function csvRow(values) { return values.map(quoteCsvCell).join(','); }

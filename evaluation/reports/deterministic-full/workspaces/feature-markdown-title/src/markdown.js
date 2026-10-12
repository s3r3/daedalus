export function firstLine(markdown) { return markdown.split('\n')[0] ?? ''; }
export function extractTitle(markdown) {
  const line = markdown.split('\n').find((item) => item.startsWith('# '));
  return line ? line.slice(2).trim() : '';
}

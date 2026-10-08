export interface ActiveFileMention {
  start: number;
  query: string;
}

/** Match an @ token only at a word boundary immediately before the caret. */
export function fileMentionAtCursor(value: string, cursor: number): ActiveFileMention | null {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return {
    start: before.lastIndexOf("@"),
    query: match[1] ?? "",
  };
}

export function replaceFileMention(
  value: string,
  cursor: number,
  mention: ActiveFileMention,
  fileName: string,
): { value: string; cursor: number } {
  const token = `@${fileName}`;
  const suffix = value.slice(cursor);
  const separator = !suffix || /^\s/.test(suffix) ? "" : " ";
  return {
    value: `${value.slice(0, mention.start)}${token}${separator}${suffix}`,
    cursor: mention.start + token.length + separator.length,
  };
}

/**
 * Pull every complete top-level object out of a JSON array while the array is
 * still being streamed. Nested option arrays/objects and escaped quotes are
 * handled; an unfinished trailing object is intentionally ignored until the
 * next text delta arrives.
 */
export function completeJsonArrayObjects(raw: string): unknown[] {
  const start = raw.indexOf("[");
  if (start < 0) return [];

  const objects: unknown[] = [];
  let objectStart = -1;
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      arrayDepth += 1;
      continue;
    }
    if (char === "]") {
      arrayDepth = Math.max(0, arrayDepth - 1);
      continue;
    }
    if (char === "{") {
      if (arrayDepth === 1 && objectDepth === 0) objectStart = i;
      objectDepth += 1;
      continue;
    }
    if (char !== "}" || objectDepth === 0) continue;

    objectDepth -= 1;
    if (objectDepth !== 0 || objectStart < 0) continue;
    try {
      objects.push(JSON.parse(raw.slice(objectStart, i + 1)));
    } catch {
      // A malformed object should not block later valid streamed entries.
    }
    objectStart = -1;
  }

  return objects;
}

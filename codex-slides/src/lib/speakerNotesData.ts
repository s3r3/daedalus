export interface GeneratedSpeakerNote {
  index: number;
  note: string;
}

const MAX_NOTE_LENGTH = 20_000;

/** Accept compact agent response shapes while keeping requested slide indexes
 * authoritative and rejecting invented or duplicate entries. */
export function normalizeGeneratedSpeakerNotes(
  raw: unknown,
  requestedIndexes: readonly number[],
): GeneratedSpeakerNote[] {
  const requested = new Set(requestedIndexes);
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { notes?: unknown }).notes)
      ? (raw as { notes: unknown[] }).notes
      : raw && typeof raw === "object"
        ? Object.entries(raw as Record<string, unknown>).map(([index, note]) => ({ index, note }))
        : [];
  const seen = new Set<number>();
  const normalized: GeneratedSpeakerNote[] = [];

  source.forEach((item, position) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    const fallbackIndex = requestedIndexes[position];
    const index = Number(record?.index ?? record?.slideIndex ?? fallbackIndex);
    const value = record?.note ?? record?.speakerNotes ?? record?.notes ?? record?.text ?? (record ? "" : item);
    const note = String(value ?? "").trim().slice(0, MAX_NOTE_LENGTH);
    if (!Number.isInteger(index) || !requested.has(index) || seen.has(index) || !note) return;
    seen.add(index);
    normalized.push({ index, note });
  });

  return normalized.sort((a, b) => a.index - b.index);
}

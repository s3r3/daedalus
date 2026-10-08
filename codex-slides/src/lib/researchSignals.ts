import type { ResearchSource } from "./types";

export interface WebSearchSignal {
  callId: string;
  queries: string[];
  state: "running" | "complete";
  urls: string[];
}

function sourceId(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(36)}`;
}

function validWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function researchSourceHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function sourceExcerpt(markdown: string, index: unknown): string | undefined {
  if (!markdown.trim() || typeof index !== "number" || !Number.isFinite(index)) return undefined;
  const prefix = markdown.slice(Math.max(0, index - 320), Math.max(0, index));
  const boundary = Math.max(
    prefix.lastIndexOf("\n\n"),
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf("！"),
    prefix.lastIndexOf("？"),
    prefix.lastIndexOf(". "),
    prefix.lastIndexOf("! "),
    prefix.lastIndexOf("? "),
  );
  const excerpt = prefix.slice(Math.max(0, boundary + 1))
    .replace(/^\s*[-*#>\d.)]+\s*/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return excerpt ? excerpt.slice(-240) : undefined;
}

/** Extract web-search call details from output-item events and the final
 * response. `web_search_call.*` status events only carry an item id, so the
 * completed output item is where queries and source URLs are recovered. */
export function extractWebSearchSignals(event: any): WebSearchSignal[] {
  const items: any[] = [];
  if (event?.item?.type === "web_search_call") items.push(event.item);
  if (Array.isArray(event?.response?.output)) {
    items.push(...event.response.output.filter((item: any) => item?.type === "web_search_call"));
  }
  if (/^response\.web_search_call\.(in_progress|searching|completed)$/.test(String(event?.type ?? ""))) {
    items.push({
      id: event.item_id,
      type: "web_search_call",
      status: event.type.endsWith(".completed") ? "completed" : "in_progress",
    });
  }

  const byId = new Map<string, WebSearchSignal>();
  for (const item of items) {
    const callId = String(item?.id ?? event?.item_id ?? `web-${event?.output_index ?? 0}`);
    const action = item?.action ?? {};
    const queries = Array.from(new Set<string>([
      ...(Array.isArray(action.queries) ? action.queries : []),
      ...(typeof action.query === "string" ? [action.query] : []),
    ].map((query: unknown) => String(query).trim()).filter(Boolean)));
    const urls = Array.from(new Set<string>([
      ...(Array.isArray(action.sources) ? action.sources.map((source: any) => source?.url) : []),
      ...(validWebUrl(action.url) ? [action.url] : []),
    ].filter(validWebUrl)));
    const complete = item?.status === "completed"
      || String(event?.type ?? "").endsWith(".done")
      || String(event?.type ?? "").endsWith(".completed")
      || event?.type === "response.completed";
    const previous = byId.get(callId);
    byId.set(callId, {
      callId,
      queries: queries.length ? queries : previous?.queries ?? [],
      urls: Array.from(new Set([...(previous?.urls ?? []), ...urls])),
      state: complete ? "complete" : previous?.state ?? "running",
    });
  }
  return [...byId.values()];
}

/** Extract citation metadata wherever the Responses stream can expose it:
 * annotation events, completed content parts, output items, or the final
 * response. */
export function extractCitationSources(event: any, markdown = ""): ResearchSource[] {
  const annotations: any[] = [];
  if (event?.annotation) annotations.push(event.annotation);
  if (Array.isArray(event?.part?.annotations)) annotations.push(...event.part.annotations);
  const collectContent = (content: any) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (Array.isArray(part?.annotations)) annotations.push(...part.annotations);
    }
  };
  collectContent(event?.item?.content);
  if (Array.isArray(event?.response?.output)) {
    for (const item of event.response.output) collectContent(item?.content);
  }

  const sources = new Map<string, ResearchSource>();
  for (const annotation of annotations) {
    const value = annotation?.url_citation ?? annotation;
    if (value?.type !== "url_citation" && annotation?.type !== "url_citation") continue;
    if (!validWebUrl(value?.url)) continue;
    const url = value.url;
    sources.set(url, {
      id: sourceId(url),
      url,
      title: String(value.title || researchSourceHost(url)).trim(),
      snippet: String(value.snippet || sourceExcerpt(markdown, value.start_index) || "").trim() || undefined,
    });
  }
  return [...sources.values()];
}

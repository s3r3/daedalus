// Deep research mode (M5). Zero-config, out-of-the-box:
//   topic -> Codex researches with its BUILT-IN web_search tool (multi-angle) ->
//   cited markdown brief -> gap-fill round -> brief seeds the outline.
//
// Ref patterns: dzhng/deep-research, Alibaba-NLP/DeepResearch,
// langchain-ai/open_deep_research — search fan-out + read + synthesize + gap-check.
//
// Why codex web_search and not DuckDuckGo: the DDG HTML/Lite endpoints bot-block
// server requests (HTTP 202 anomaly page). Codex's own web_search tool works
// through the same zero-config responses endpoint and returns real, cited results.
// ddgSearch() is kept as a documented fallback utility.

import {
  CODEX_RESPONSES_MODEL,
  postCodexResponses,
  sseEvents,
} from "./codex-sse";
import { researchSourceId } from "./researchProgress";
import {
  extractCitationSources,
  extractWebSearchSignals,
  researchSourceHost,
} from "./researchSignals";
import type { ResearchSource } from "./types";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type ResearchEvent =
  | { type: "queries"; queries: string[]; round: number; totalRounds: number }
  | { type: "search"; query: string; count: number; callId: string; state: "running" | "complete"; round: number; totalRounds: number }
  | { type: "source"; source: ResearchSource; round: number; totalRounds: number }
  | { type: "synth"; round: number; totalRounds: number }
  | { type: "writing"; round: number; totalRounds: number }
  | { type: "delta"; delta: string; round: number; totalRounds: number }
  | { type: "log"; message: string }
  | { type: "doc"; markdown: string; round: number; totalRounds: number; final: boolean }
  | { type: "done"; markdown: string; round: number; totalRounds: number }
  | { type: "error"; error: string };

// --- primary path: Codex built-in web_search --------------------------------

function researchPrompt(topic: string, priorDoc: string, workflowContext = ""): string {
  if (priorDoc) {
    return [
      `You are extending a research brief about: ${topic}.`,
      workflowContext,
      "Identify what is missing, thin, or outdated in the draft below, then USE WEB SEARCH to fill those gaps.",
      "Return an improved, extended markdown brief in the same format (more/updated facts and sources).",
      "",
      "DRAFT:",
      priorDoc,
    ].join("\n");
  }
  return [
    `Research this topic for a slide deck using web search: ${topic}.`,
    workflowContext,
    "Search several angles (definition/context, market size & trends, key players/examples, recent developments, risks/open questions).",
    "Then write a clean markdown research brief: a short intro, 4-8 thematic sections with concrete, current facts and figures",
    "(not filler), and a final '## Sources' list of [title](url) you actually found. Cite inline as [n].",
    "Return ONLY the markdown.",
  ].join("\n");
}

async function codexSearchSynthesize(
  topic: string,
  priorDoc: string,
  emit: (e: ResearchEvent) => void,
  round: number,
  totalRounds: number,
  signal?: AbortSignal,
  workflowContext = "",
): Promise<string> {
  const payload = {
    model: CODEX_RESPONSES_MODEL,
    instructions:
      "You are a research analyst. Use the web_search tool to gather current, cited facts, then write a clean markdown brief.",
    input: [{ role: "user", content: [{ type: "input_text", text: researchPrompt(topic, priorDoc, workflowContext) }] }],
    tools: [{ type: "web_search" }],
    store: false,
    stream: true,
  };
  const resp = await postCodexResponses(payload, { signal, timeoutMs: 300_000 });

  let text = "";
  let completedText = "";
  let writingStarted = false;
  const searchSignatures = new Map<string, string>();
  const sourceSignatures = new Map<string, string>();
  const emitSource = (source: ResearchSource) => {
    const signature = `${source.title}\n${source.snippet ?? ""}`;
    if (sourceSignatures.get(source.url) === signature) return;
    sourceSignatures.set(source.url, signature);
    emit({ type: "source", source: { ...source, round }, round, totalRounds });
  };
  for await (const ev of sseEvents(resp, signal)) {
    const t = ev.type as string;
    for (const search of extractWebSearchSignals(ev)) {
      const queries = search.queries.length ? search.queries : [""];
      queries.forEach((query, index) => {
        const callId = index === 0 ? search.callId : `${search.callId}-${index + 1}`;
        const signature = `${search.state}\n${query}`;
        if (searchSignatures.get(callId) === signature) return;
        searchSignatures.set(callId, signature);
        emit({
          type: "search",
          query,
          count: 1,
          callId,
          state: search.state,
          round,
          totalRounds,
        });
      });
      for (const url of search.urls) {
        emitSource({ id: researchSourceId(url), url, title: researchSourceHost(url), round });
      }
    }
    if (t === "response.output_text.delta" && typeof ev.delta === "string") {
      if (!writingStarted) {
        writingStarted = true;
        emit({ type: "writing", round, totalRounds });
      }
      text += ev.delta;
      emit({ type: "delta", delta: ev.delta, round, totalRounds });
    }
    if (t === "response.output_text.done" && typeof ev.text === "string") text = ev.text;
    for (const source of extractCitationSources(ev, text || completedText)) emitSource(source);
    if (t === "response.completed" && ev.response?.output) {
      for (const item of ev.response.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === "output_text" && typeof c.text === "string") completedText = c.text;
          }
        }
      }
    }
  }
  return (text || completedText).trim();
}

export interface RunResearchOptions {
  rounds?: number; // synthesis rounds (default 2)
  signal?: AbortSignal;
  workflowContext?: string;
}

/** Run the deep-research loop, emitting progress. Returns the final markdown doc. */
export async function runResearch(
  topic: string,
  emit: (e: ResearchEvent) => void,
  opts: RunResearchOptions = {},
): Promise<string> {
  const { rounds = 2, signal, workflowContext = "" } = opts;
  let doc = "";
  try {
    for (let round = 1; round <= rounds; round++) {
      if (signal?.aborted) break;
      emit({ type: "synth", round, totalRounds: rounds });
      const next = await codexSearchSynthesize(topic, doc, emit, round, rounds, signal, workflowContext);
      if (next) doc = next;
      emit({ type: "doc", markdown: doc, round, totalRounds: rounds, final: round === rounds });
    }
    emit({ type: "done", markdown: doc, round: rounds, totalRounds: rounds });
    return doc;
  } catch (e: any) {
    emit({ type: "error", error: String(e?.message ?? e) });
    return doc;
  }
}

// --- fallback utility: DuckDuckGo HTML (currently bot-blocked on servers) ----

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").trim();
}

/** DuckDuckGo HTML search (no key). Returns [] when DDG serves its anomaly page. */
export async function ddgSearch(query: string, limit = 6): Promise<SearchResult[]> {
  try {
    const resp = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: `q=${encodeURIComponent(query)}`,
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    const results: SearchResult[] = [];
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html)) && results.length < limit) {
      results.push({ url: lm[1], title: stripTags(lm[2]), snippet: "" });
    }
    return results;
  } catch {
    return [];
  }
}

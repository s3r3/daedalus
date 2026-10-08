// Zero-config TEXT generation via the Codex Responses endpoint.
// Used for the outline and per-page copy stages when engine === "codex".

import {
  CODEX_RESPONSES_MODEL,
  CodexResponsesError,
  postCodexResponses,
  sseEvents,
} from "./codex-sse";

export interface CodexTextOptions {
  system?: string;
  signal?: AbortSignal;
  attachments?: CodexInputAttachment[];
  /** Receives the growing assistant text as Responses API deltas arrive. */
  onText?: (text: string) => void;
}

export interface CodexInputAttachment {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  bytes: Buffer;
  /** Local-agent engines can read this workspace path directly. */
  path?: string;
}

function inputContent(prompt: string, attachments: CodexInputAttachment[] = []): any[] {
  const content: any[] = attachments.map((attachment) => {
    const dataUrl = `data:${attachment.mimeType || "application/octet-stream"};base64,${attachment.bytes.toString("base64")}`;
    if (attachment.kind === "image") {
      return { type: "input_image", image_url: dataUrl, detail: "auto" };
    }
    return {
      type: "input_file",
      filename: attachment.name,
      file_data: dataUrl,
      ...(attachment.mimeType === "application/pdf" || attachment.name.toLowerCase().endsWith(".pdf")
        ? { detail: "high" }
        : {}),
    };
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

/** Run a text-only Responses request and return the assistant's full text. */
export async function codexText(
  prompt: string,
  opts: CodexTextOptions = {},
): Promise<string> {
  const payload = {
    model: CODEX_RESPONSES_MODEL,
    instructions:
      opts.system ??
      "You are a precise assistant. Follow the user's output-format instructions exactly.",
    input: [{ role: "user", content: inputContent(prompt, opts.attachments) }],
    store: false,
    stream: true,
  };

  const resp = await postCodexResponses(payload, { signal: opts.signal });

  let text = "";
  let completedText = "";
  let streamedText = "";
  for await (const ev of sseEvents(resp, opts.signal)) {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      streamedText += ev.delta;
      opts.onText?.(streamedText);
    }
    if (ev.type === "response.output_text.done" && typeof ev.text === "string") {
      text = ev.text;
      if (!streamedText || streamedText !== text) opts.onText?.(text);
    }
    if (ev.type === "response.completed" && ev.response?.output) {
      for (const item of ev.response.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === "output_text" && typeof c.text === "string") {
              completedText = c.text;
            }
          }
        }
      }
    }
  }
  const out = (text || completedText).trim();
  if (!out) throw new CodexResponsesError("Codex returned empty text");
  return out;
}

/** Like codexText but strips code fences / prose and JSON.parse()s the result. */
export async function codexJson<T = unknown>(
  prompt: string,
  opts: CodexTextOptions = {},
): Promise<T> {
  const raw = await codexText(prompt, {
    ...opts,
    system:
      opts.system ??
      "You output ONLY valid JSON. No prose, no explanation, no markdown code fences.",
  });
  return parseLooseJson<T>(raw);
}

/** Tolerant JSON extraction: handles ```json fences and leading/trailing prose. */
export function parseLooseJson<T = unknown>(raw: string): T {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Slice to the outermost JSON array/object if there is surrounding prose.
  const firstArr = s.indexOf("[");
  const firstObj = s.indexOf("{");
  const start =
    firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstArr, firstObj);
  if (start > 0) s = s.slice(start);
  const lastArr = s.lastIndexOf("]");
  const lastObj = s.lastIndexOf("}");
  const end = Math.max(lastArr, lastObj);
  if (end >= 0 && end < s.length - 1) s = s.slice(0, end + 1);
  return JSON.parse(s) as T;
}

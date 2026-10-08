// Zero-config IMAGE generation via the Codex Responses endpoint + built-in
// image_generation tool (gpt-image-1). Ported from banana-slides' codex_provider.py
// and validated against the live backend.
//
// Reference images (base64 PNGs) are supported — this is what powers the
// "mark / annotate a slide and send the screenshot back for an edit" flow.

import type { Aspect, Resolution } from "./types";
import {
  CODEX_RESPONSES_MODEL,
  CodexResponsesError,
  postCodexResponses,
  sseEvents,
} from "./codex-sse";

const RESOLUTION_LONG_EDGE: Record<string, number> = {
  "1K": 1280,
  "2K": 2048,
  "4K": 3840,
};
const MAX_PIXELS = 8_294_400;

/** WxH for gpt-image-*: both edges multiples of 16, long edge per resolution. */
export function computeGptImageSize(aspect: string, resolution: Resolution = "2K"): string {
  const parts = aspect.split(":");
  if (parts.length !== 2) return "auto";
  const aw = Number(parts[0]);
  const ah = Number(parts[1]);
  if (!Number.isFinite(aw) || !Number.isFinite(ah) || aw <= 0 || ah <= 0) return "auto";

  const longEdge = RESOLUTION_LONG_EDGE[resolution.toUpperCase()] ?? 2048;
  let w: number;
  let h: number;
  if (aw >= ah) {
    w = longEdge;
    h = Math.round((w * ah) / aw);
  } else {
    h = longEdge;
    w = Math.round((h * aw) / ah);
  }
  w = Math.max(16, Math.floor(w / 16) * 16);
  h = Math.max(16, Math.floor(h / 16) * 16);
  if (w * h > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(16, Math.floor((w * scale) / 16) * 16);
    h = Math.max(16, Math.floor((h * scale) / 16) * 16);
  }
  return `${w}x${h}`;
}

export interface GenerateImageOptions {
  refImages?: Buffer[]; // reference images (PNG/JPEG bytes)
  aspect?: Aspect | string;
  resolution?: Resolution;
  quality?: "low" | "medium" | "high" | "auto";
  imageModel?: string;
  signal?: AbortSignal;
}

function imageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "image/png";
}

/** Generate one slide image. Returns PNG bytes. */
export async function generateSlideImage(
  prompt: string,
  opts: GenerateImageOptions = {},
): Promise<Buffer> {
  const {
    refImages = [],
    aspect = "16:9",
    resolution = "2K",
    quality = "high",
    imageModel = "gpt-image-1",
    signal,
  } = opts;

  const content: any[] = [];
  for (const buf of refImages) {
    const b64 = buf.toString("base64");
    content.push({ type: "input_image", image_url: `data:${imageMime(buf)};base64,${b64}` });
  }
  content.push({ type: "input_text", text: prompt });

  const payload = {
    model: CODEX_RESPONSES_MODEL,
    instructions: "You are a helpful assistant that generates images.",
    input: [{ role: "user", content }],
    tools: [
      {
        type: "image_generation",
        model: imageModel,
        size: computeGptImageSize(String(aspect), resolution),
        quality,
      },
    ],
    tool_choice: { type: "image_generation" },
    store: false,
    stream: true,
  };

  const resp = await postCodexResponses(payload, { signal });

  let b64: string | null = null;
  let completed: any = null;
  for await (const ev of sseEvents(resp, signal)) {
    const t = ev.type as string;
    if (t === "response.output_item.done" || t === "response.image_generation_call.done") {
      const item = ev.item ?? ev;
      if (item?.type === "image_generation_call" && item.result) b64 = item.result;
    }
    if (t === "response.completed") completed = ev.response ?? ev;
    if (b64) break;
  }
  if (!b64 && completed?.output) {
    for (const item of completed.output) {
      if (item?.type === "image_generation_call" && item.result) b64 = item.result;
    }
  }
  if (!b64) throw new CodexResponsesError("No image found in Codex Responses stream");
  const clean = b64.startsWith("data:") ? b64.split(",", 2)[1] : b64;
  return Buffer.from(clean, "base64");
}

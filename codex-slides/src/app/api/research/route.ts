import { runResearch, type ResearchEvent } from "@/lib/research";
import { scenarioPromptContext } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** SSE: run the deep-research loop for a topic, streaming progress + the doc. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const topic = String(body?.requirement ?? body?.topic ?? "").trim();
  if (!topic) {
    return new Response(JSON.stringify({ error: "requirement is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const rounds = Math.max(1, Math.min(4, Number(body?.rounds) || 2));
  const workflowContext = scenarioPromptContext(String(body?.scenarioId ?? ""));

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ResearchEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* closed */
        }
      };
      try {
        await runResearch(topic, send, { rounds, signal: abort.signal, workflowContext });
      } catch (e: any) {
        send({ type: "error", error: String(e?.message ?? e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

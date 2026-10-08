import { coerceConfig } from "@/lib/config";
import { runGeneration } from "@/lib/pipeline";
import { runResearch } from "@/lib/research";
import { scenarioPromptContext } from "@/lib/scenarios";
import { type ProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const config = coerceConfig(body);
  if (!config.requirement) {
    return new Response(JSON.stringify({ error: "requirement is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ProgressEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      try {
        if (config.mode === "research" && !config.researchDoc?.trim()) {
          const doc = await runResearch(
            config.requirement,
            (event) => {
              if (event.type === "search") send({
                type: "research",
                phase: "searching",
                detail: event.query,
                callId: event.callId,
                state: event.state,
                round: event.round,
                totalRounds: event.totalRounds,
              });
              else if (event.type === "source") send({
                type: "research",
                phase: "source",
                source: event.source,
                round: event.round,
                totalRounds: event.totalRounds,
              });
              else if (event.type === "synth") send({ type: "research", phase: "planning", detail: `round ${event.round}`, round: event.round, totalRounds: event.totalRounds });
              else if (event.type === "writing") send({ type: "research", phase: "writing", round: event.round, totalRounds: event.totalRounds });
              else if (event.type === "delta") send({ type: "research", phase: "delta", delta: event.delta, round: event.round, totalRounds: event.totalRounds });
              else if (event.type === "doc") send({ type: "research", phase: "brief", markdown: event.markdown, final: event.final, round: event.round, totalRounds: event.totalRounds });
              else if (event.type === "done") send({ type: "research", phase: "complete", markdown: event.markdown, round: event.round, totalRounds: event.totalRounds });
              else if (event.type === "error") send({ type: "research", phase: "error", detail: event.error });
            },
            { signal: abort.signal, workflowContext: scenarioPromptContext(config.scenarioId) },
          );
          if (doc.trim()) config.researchDoc = doc;
        }
        await runGeneration(config, send, { signal: abort.signal });
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

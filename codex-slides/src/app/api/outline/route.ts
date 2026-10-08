// Step 2 of the staged flow (搜索 + 写大纲): optional deep research, then write the
// outline and persist a DRAFT project. Streams progress as SSE ProgressEvents; no
// slides are rendered here — the client lets the user edit + confirm first.

import { coerceConfig } from "@/lib/config";
import { planOutline } from "@/lib/pipeline";
import { runResearch } from "@/lib/research";
import { reduceResearchProgress } from "@/lib/researchProgress";
import { loadProject, saveProject } from "@/lib/store";
import { type ProgressEvent, type ResearchProgressEvent } from "@/lib/types";
import { scenarioPromptContext } from "@/lib/scenarios";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const config = coerceConfig(body);
  const projectId = typeof body.projectId === "string" && body.projectId.trim()
    ? body.projectId.trim()
    : undefined;
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
        // 2a — optional deep research grounds the outline in a cited brief.
        if (config.mode === "research" && !config.researchDoc?.trim()) {
          let researchState = projectId ? loadProject(projectId)?.research : undefined;
          let lastDeltaSave = 0;
          const publishResearch = (event: ResearchProgressEvent) => {
            send(event);
            const now = Date.now();
            researchState = reduceResearchProgress(researchState, event, now);
            if (!projectId) return;
            const shouldPersist = event.phase !== "delta" || now - lastDeltaSave >= 600;
            if (!shouldPersist) return;
            if (event.phase === "delta") lastDeltaSave = now;
            const latest = loadProject(projectId);
            if (!latest) return;
            latest.research = researchState;
            latest.workflow = {
              ...(latest.workflow ?? { stage: "research" as const }),
              stage: event.phase === "complete" || event.phase === "error" ? "outlining" : "research",
            };
            if (event.phase === "complete" && researchState.markdown.trim()) {
              latest.researchDoc = researchState.markdown;
              latest.config.researchDoc = researchState.markdown;
            }
            saveProject(latest);
          };
          publishResearch({ type: "research", phase: "starting", round: 0, totalRounds: 2 });
          const doc = await runResearch(
            config.requirement,
            (ev) => {
              if (ev.type === "search") publishResearch({
                type: "research",
                phase: "searching",
                detail: ev.query,
                callId: ev.callId,
                state: ev.state,
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "source") publishResearch({
                type: "research",
                phase: "source",
                source: ev.source,
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "synth") publishResearch({
                type: "research",
                phase: "planning",
                detail: `round ${ev.round}`,
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "writing") publishResearch({
                type: "research",
                phase: "writing",
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "delta") publishResearch({
                type: "research",
                phase: "delta",
                delta: ev.delta,
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "doc") publishResearch({
                type: "research",
                phase: "brief",
                markdown: ev.markdown,
                final: ev.final,
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "done") publishResearch({
                type: "research",
                phase: "complete",
                markdown: ev.markdown,
                round: ev.round,
                totalRounds: ev.totalRounds,
              });
              else if (ev.type === "error") publishResearch({
                type: "research",
                phase: "error",
                detail: ev.error,
              });
            },
            { signal: abort.signal, workflowContext: scenarioPromptContext(config.scenarioId) },
          );
          if (doc.trim()) config.researchDoc = doc;
        }
        // 2b — write the outline and save the draft project.
        await planOutline(config, send, { signal: abort.signal, projectId });
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

import { NextResponse } from "next/server";
import { detectAgents } from "@/lib/agents";
import { hasCodexToken } from "@/lib/codex-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const agents = detectAgents();
  const codexReady = hasCodexToken();
  const codexCli = agents.find((a) => a.id === "codex");
  return NextResponse.json({
    codexReady,
    agents,
    // Detection summary consumed by the Codex setup dialog: the zero-config
    // Responses backend needs the ChatGPT token; the CLI on PATH is a bonus.
    codex: {
      tokenPresent: codexReady,
      cliAvailable: Boolean(codexCli?.available),
      cliPath: codexCli?.path ?? null,
    },
    // Codex is the only orchestration engine (zero-config Responses backend).
    // The local-CLI variants (claude/gemini) are intentionally not surfaced.
    engines: [{ engine: "codex", label: "Codex", available: codexReady }],
  });
}

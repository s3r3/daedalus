// Rank the community style catalog against the user's topic + outline so the
// post-outline inspiration step can surface the best-fitting visual directions.

import { NextResponse } from "next/server";
import { rankCommunityTemplates } from "@/lib/inspire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const requirement = String(body?.requirement ?? "").trim();
  const outlineTitles: string[] = Array.isArray(body?.outlineTitles)
    ? body.outlineTitles.map((s: any) => String(s ?? "").trim()).filter(Boolean).slice(0, 40)
    : [];
  if (!requirement && !outlineTitles.length) {
    return NextResponse.json({ error: "requirement or outline required" }, { status: 400 });
  }
  try {
    const result = await rankCommunityTemplates(requirement, outlineTitles);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

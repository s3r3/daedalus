import { NextResponse } from "next/server";
import { COMMUNITY_GROUPS, COMMUNITY_SOURCES, COMMUNITY_TEMPLATES } from "@/lib/community";
import { createProjectTemplate, listProjectTemplates } from "@/lib/projectTemplates";
import { CATEGORIES, TEMPLATES } from "@/lib/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Machine-readable template catalog for Codex/MCP clients. */
export async function GET() {
  return NextResponse.json({
    categories: CATEGORIES,
    templates: TEMPLATES,
    communityGroups: COMMUNITY_GROUPS,
    communityStyles: COMMUNITY_TEMPLATES,
    communitySources: COMMUNITY_SOURCES,
    projectTemplates: listProjectTemplates(),
  });
}

/** Save an existing project's visual system as a reusable project template. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  try {
    const template = createProjectTemplate(projectId, {
      name: body.name,
      description: body.description,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (error: any) {
    const message = String(error?.message ?? error);
    return NextResponse.json({ error: message }, { status: message === "project not found" ? 404 : 400 });
  }
}

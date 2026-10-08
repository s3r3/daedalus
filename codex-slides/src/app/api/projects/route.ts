import { NextResponse } from "next/server";
import { coerceConfig } from "@/lib/config";
import { attachMaterialsToProject } from "@/lib/materials";
import { applyProjectTemplateAssets } from "@/lib/projectTemplates";
import { ensureProjectRun } from "@/lib/projectRuns";
import { listProjects, loadProject, newProjectId, saveProject } from "@/lib/store";
import type { Project } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List projects (slim summaries for the home "recent projects" strip). */
export async function GET() {
  const projects = listProjects().map((stored) => {
    const p = stored.activeRun ? ensureProjectRun(stored.id) ?? stored : stored;
    const rendered = p.pages.filter((s) => s.status === "rendered");
    return {
      id: p.id,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      aspect: p.config.aspect,
      total: p.pages.length,
      rendered: rendered.length,
      cover: rendered[0]?.image ?? null,
      workflowStage: p.workflow?.stage,
      activeRun: p.activeRun,
    };
  });
  return NextResponse.json({ projects });
}

/** Create the durable project shell before clarification begins. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const config = coerceConfig(body.config ?? body);
  if (!config.requirement.trim()) {
    return NextResponse.json({ error: "requirement is required" }, { status: 400 });
  }

  const title = String(body.title ?? config.requirement.split("\n")[0])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Untitled deck";
  const requestedId = typeof body.id === "string" && /^[a-zA-Z0-9_-]{8,120}$/.test(body.id)
    ? body.id
    : undefined;
  const id = requestedId ?? newProjectId(title);
  const existing = loadProject(id);
  if (existing) return NextResponse.json(existing);
  const now = new Date().toISOString();
  const project: Project = {
    id,
    createdAt: now,
    updatedAt: now,
    config,
    agent: config.engine,
    title,
    outline: [],
    pages: [],
    status: "draft",
    workflow: {
      stage: "clarify",
      researchMode: config.mode === "research",
      workspaceMode: "canvas",
      selectedDesignFileId: "questions",
    },
  };

  if (config.materialIds?.length) {
    project.materials = attachMaterialsToProject(id, config.materialIds);
    const attachedIds = new Set(project.materials.map((material) => material.id));
    project.config.materialIds = config.materialIds.filter((materialId) => attachedIds.has(materialId));
  }
  applyProjectTemplateAssets(project);
  saveProject(project);
  return NextResponse.json(project, { status: 201 });
}

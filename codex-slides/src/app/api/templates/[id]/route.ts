import { NextResponse } from "next/server";
import { deleteProjectTemplate, loadProjectTemplate } from "@/lib/projectTemplates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const template = loadProjectTemplate(params.id);
  if (!template) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ template });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  if (!deleteProjectTemplate(params.id)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}


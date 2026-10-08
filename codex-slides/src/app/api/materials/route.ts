import { NextResponse } from "next/server";
import {
  isSupportedContextItem,
  MAX_CONTEXT_ITEM_BYTES,
  saveStagedMaterial,
} from "@/lib/materials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stage an uploaded image/document before a project exists. multipart: file */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected multipart form" }, { status: 400 });
  const file = form.get("file") ?? form.get("image");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  const name = (file as any).name ?? "context-item";
  if (!isSupportedContextItem(name, file.type)) {
    return NextResponse.json({ error: "unsupported file type" }, { status: 415 });
  }
  if (file.size > MAX_CONTEXT_ITEM_BYTES) {
    return NextResponse.json({ error: "file exceeds the 20 MB limit" }, { status: 413 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const item = saveStagedMaterial(bytes, name, file.type);
  return NextResponse.json({ ...item, url: `/api/materials/${item.id}` });
}

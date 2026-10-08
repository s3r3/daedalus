import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

import { getGeneratedProjectsDir } from '@/lib/server/project-store';

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MANIFEST_FILE = '.manifest.json';

interface ImageManifestEntry {
  fileName: string;
  size: number;
  updatedAt: string;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  orientation: 'landscape' | 'portrait' | 'square' | 'unknown';
}

function sanitizeBaseName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getOrientation(width: number | null, height: number | null): ImageManifestEntry['orientation'] {
  if (!width || !height) return 'unknown';
  if (Math.abs(width - height) <= 4) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

async function readManifest(imagesDir: string): Promise<Record<string, ImageManifestEntry>> {
  const manifestPath = path.join(imagesDir, MANIFEST_FILE);
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as Record<string, ImageManifestEntry>;
  } catch {
    return {};
  }
}

async function writeManifest(imagesDir: string, manifest: Record<string, ImageManifestEntry>) {
  const manifestPath = path.join(imagesDir, MANIFEST_FILE);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const generatedProjectsDir = await getGeneratedProjectsDir();
    const imagesDir = path.join(generatedProjectsDir, id, 'input', 'images');

    await fs.mkdir(imagesDir, { recursive: true });
    const entries = await fs.readdir(imagesDir, { withFileTypes: true });
    const manifest = await readManifest(imagesDir);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name !== MANIFEST_FILE)
        .map(async (entry) => {
          const fullPath = path.join(imagesDir, entry.name);
          const stats = await fs.stat(fullPath);
          const metadata = manifest[entry.name];
          return {
            fileName: entry.name,
            size: stats.size,
            updatedAt: stats.mtime.toISOString(),
            width: metadata?.width ?? null,
            height: metadata?.height ?? null,
            aspectRatio: metadata?.aspectRatio ?? null,
            orientation: metadata?.orientation ?? 'unknown',
          };
        })
    );

    return NextResponse.json({ success: true, files });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const formData = await request.formData();
    const file = formData.get('file');
    const semanticName = String(formData.get('semanticName') || '');
    const width = Number(formData.get('width') || 0);
    const height = Number(formData.get('height') || 0);

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'Image file is required.' }, { status: 400 });
    }

    const originalExtension = path.extname(file.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(originalExtension)) {
      return NextResponse.json({ success: false, error: 'Unsupported image type.' }, { status: 400 });
    }

    const sanitizedBase = sanitizeBaseName(semanticName);
    if (!sanitizedBase) {
      return NextResponse.json(
        { success: false, error: 'Please provide a semantic image file name.' },
        { status: 400 }
      );
    }

    const generatedProjectsDir = await getGeneratedProjectsDir();
    const imagesDir = path.join(generatedProjectsDir, id, 'input', 'images');
    await fs.mkdir(imagesDir, { recursive: true });

    const finalFileName = `${sanitizedBase}${originalExtension}`;
    const finalPath = path.join(imagesDir, finalFileName);
    const bytes = await file.arrayBuffer();
    await fs.writeFile(finalPath, Buffer.from(bytes));

    const aspectRatio = width > 0 && height > 0 ? Number((width / height).toFixed(4)) : null;
    const manifest = await readManifest(imagesDir);
    const entry: ImageManifestEntry = {
      fileName: finalFileName,
      size: bytes.byteLength,
      updatedAt: new Date().toISOString(),
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
      aspectRatio,
      orientation: getOrientation(width > 0 ? width : null, height > 0 ? height : null),
    };
    manifest[finalFileName] = entry;
    await writeManifest(imagesDir, manifest);

    return NextResponse.json({
      success: true,
      file: entry,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}


import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import mime from 'mime';
import { getGeneratedProjectsDir } from '@/lib/server/project-store';

const ROOT_DIR = path.resolve(process.cwd(), '..');
const WORK_DIR = path.join(ROOT_DIR, 'pipeline_work');
const HTML_DIR = path.join(WORK_DIR, '1_html_slides');

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const fileName = searchParams.get('file');
    const projectId = searchParams.get('projectId');

    if (!fileName) {
        return new NextResponse('File not specified', { status: 400 });
    }

    const normalizedRelativePath = path.posix.normalize(fileName.replace(/\\/g, '/'));
    if (normalizedRelativePath.startsWith('..') || path.isAbsolute(normalizedRelativePath)) {
        return new NextResponse('Invalid file path', { status: 400 });
    }

    let filePath = '';

    // 1. Try Project Archive First (if ID provided)
    if (projectId) {
        const archiveDir = await getGeneratedProjectsDir();
        const layoutPath = path.join(archiveDir, projectId, 'layout', normalizedRelativePath);
        const assetPath = path.join(archiveDir, projectId, 'assets', normalizedRelativePath);

        try {
            await fs.access(layoutPath);
            filePath = layoutPath;
        } catch {
            try {
                await fs.access(assetPath);
                filePath = assetPath;
            } catch {
                // Not found in archive, proceed to fallback
            }
        }
    }

    // 2. Fallback to Ephemeral Work Dir (Current Project)
    if (!filePath) {
        const workPath = path.join(HTML_DIR, normalizedRelativePath);
        const assetPath = path.join(WORK_DIR, normalizedRelativePath);

        try {
            await fs.access(workPath);
            filePath = workPath;
        } catch {
            filePath = assetPath; // Fallback to root work dir
        }
    }

    try {
        const detectedContentType = mime.getType(filePath) || 'application/octet-stream';

        if (detectedContentType === 'text/html') {
            let html = await fs.readFile(filePath, 'utf-8');
            const currentDir = path.posix.dirname(normalizedRelativePath);

            html = html.replace(
                /\b(src|href)=["']([^"']+)["']/gi,
                (_match, attr, rawValue) => {
                    const value = String(rawValue);
                    if (
                        value.startsWith('http://')
                        || value.startsWith('https://')
                        || value.startsWith('data:')
                        || value.startsWith('blob:')
                        || value.startsWith('#')
                        || value.startsWith('/')
                    ) {
                        return `${attr}="${value}"`;
                    }

                    const resolvedPath = path.posix.normalize(
                        currentDir && currentDir !== '.'
                            ? path.posix.join(currentDir, value)
                            : value
                    );

                    if (resolvedPath.startsWith('..')) {
                        return `${attr}="${value}"`;
                    }

                    const previewUrl = `/api/preview?file=${encodeURIComponent(resolvedPath)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`;
                    return `${attr}="${previewUrl}"`;
                }
            );

            return new NextResponse(html, {
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                },
            });
        }

        const fileBuffer = await fs.readFile(filePath);
        return new NextResponse(fileBuffer, {
            headers: {
                'Content-Type': detectedContentType,
            },
        });
    } catch (error) {
        return new NextResponse('File not found', { status: 404 });
    }
}

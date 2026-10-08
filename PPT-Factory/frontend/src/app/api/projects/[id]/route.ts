import { NextResponse } from 'next/server';
import {
    deleteProject,
    getProjectById,
    getStorageMode,
    listGeneratedFiles,
    listPipelineResults,
    patchProject,
} from '@/lib/server/project-store';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const project = await getProjectById(id);
        if (!project) {
            return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
        }
        const results = await listPipelineResults(id);
        const files = await listGeneratedFiles(id);

        return NextResponse.json({
            success: true,
            project: {
                ...project,
                pipeline_results: results,
                generated_files: files,
            },
            storageMode: getStorageMode(),
        });
    } catch (error: unknown) {
        console.error('API Error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json();
        const project = await patchProject(id, body);
        return NextResponse.json({ success: true, project, storageMode: getStorageMode() });
    } catch (error: unknown) {
        console.error('API Error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        await deleteProject(id);
        return NextResponse.json({ success: true, storageMode: getStorageMode() });
    } catch (error: unknown) {
        console.error('API Error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
}

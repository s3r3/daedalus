import { NextResponse } from 'next/server';
import { getStorageMode, listProjects, upsertProject } from '@/lib/server/project-store';
import { getLocalSettings } from '@/lib/server/local-settings';

export async function GET() {
    try {
        if (getStorageMode() === 'local') {
            const settings = await getLocalSettings();
            if (!settings.projectRoot) {
                return NextResponse.json({
                    success: true,
                    projects: [],
                    storageMode: 'local',
                    requiresProjectRoot: true,
                });
            }
        }
        const projects = await listProjects();
        return NextResponse.json({ success: true, projects, storageMode: getStorageMode() });
    } catch (error: unknown) {
        console.error('API Error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        if (getStorageMode() === 'local') {
            const settings = await getLocalSettings();
            if (!settings.projectRoot) {
                return NextResponse.json(
                    { success: false, error: 'Project save folder is not configured.' },
                    { status: 400 }
                );
            }
        }
        const body = await request.json();
        const { id, project_name, user_prompt, brief_json, content_draft, model_used } = body;

        if (!project_name) {
            return NextResponse.json(
                { success: false, error: 'project_name is required' },
                { status: 400 }
            );
        }

        const project = await upsertProject({
            id,
            project_name,
            user_prompt,
            brief_json: brief_json || {},
            content_draft: content_draft || null,
            status: 'draft',
            model_used,
        });

        return NextResponse.json({ success: true, project, storageMode: getStorageMode() });
    } catch (error: unknown) {
        console.error('API Error:', error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
}

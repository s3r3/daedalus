
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

// Assuming frontend is in root/frontend
const ROOT_DIR = path.resolve(process.cwd(), '..');
const WORK_DIR = path.join(ROOT_DIR, 'pipeline_work');
const HTML_DIR = path.join(WORK_DIR, '1_html_slides');
const METRICS_DIR = path.join(WORK_DIR, '2_metrics');
const FINAL_OUTPUT = path.join(ROOT_DIR, 'pipeline_output', 'Final_Presentation.pptx');

export async function GET() {
    try {
        const status = {
            layout: { files: [] as string[] },
            metrics: { files: [] as string[] },
            assembly: { exists: false, path: FINAL_OUTPUT },
        };

        // Check Layout
        try {
            const htmlFiles = await fs.readdir(HTML_DIR);
            status.layout.files = htmlFiles.filter(f => f.endsWith('.html'));
        } catch (e) {
            // ignore if not exists
        }

        // Check Metrics
        try {
            const metricDirs = await fs.readdir(METRICS_DIR);
            status.metrics.files = metricDirs; // These are folders
        } catch (e) {
            // ignore
        }

        // Check Assembly
        try {
            await fs.access(FINAL_OUTPUT);
            status.assembly.exists = true;
        } catch (e) {
            status.assembly.exists = false;
        }

        return NextResponse.json({ success: true, status });
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

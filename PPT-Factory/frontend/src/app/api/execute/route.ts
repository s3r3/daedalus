import { NextResponse } from 'next/server';
import { exec, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getGeneratedProjectsDir, getStorageMode, getProjectById, insertPipelineResult, recordGeneratedFile } from '@/lib/server/project-store';
import { requireLlmConfig } from '@/lib/server/local-settings';

const execPromise = util.promisify(exec);

// --- Configuration ---
const ROOT_DIR = path.resolve(process.cwd(), '..');
const SKILLS_DIR = path.join(ROOT_DIR, 'my_skills');

const DNA_SCRIPT = path.join(SKILLS_DIR, 'define_visual_dna', 'scripts', 'generate_dna.py');
const BUILDER_SCRIPT = path.join(SKILLS_DIR, 'architect_html_layouts', 'scripts', 'build_slides.py');
const LINT_SCRIPT = path.join(SKILLS_DIR, 'assemble_pptx_file', 'scripts', 'lint_ppt_html.py');
const ASSEMBLER_SCRIPT = path.join(SKILLS_DIR, 'assemble_pptx_file', 'scripts', 'batch_convert.js');
const QC_SCRIPT = path.join(SKILLS_DIR, 'inspect_pptx_quality', 'scripts', 'qc_inspector.py');

const ASSEMBLER_VENV = path.join(ROOT_DIR, 'venv', 'bin', 'python3');

// --- Legacy / Default Paths (Fallbacks) ---
const WORK_DIR = path.join(ROOT_DIR, 'pipeline_work');
const BRIEF_PATH = path.join(ROOT_DIR, 'pipeline_input', 'full_brief.json');
const DRAFT_PATH = path.join(ROOT_DIR, 'pipeline_input', 'content_draft.json');
const HTML_DIR = path.join(WORK_DIR, '1_html_slides');
const PPTX_DIR = path.join(WORK_DIR, '3_pptx');
const FINAL_OUTPUT = path.join(PPTX_DIR, 'output.pptx');

const getBaseEnv = async (modelOverride?: string) => {
    const llm = await requireLlmConfig();
    return {
        ...process.env,
        OPENAI_API_KEY: llm.apiKey,
        OPENAI_BASE_URL: llm.baseUrl || process.env.OPENAI_BASE_URL || '',
        OPENAI_MODEL: modelOverride || llm.model,
        ANTHROPIC_API_KEY: llm.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '',
    };
};

async function registerArtifact(projectId: string, sourcePath: string, fileName: string, fileType: string, minTimestamp?: number) {
    if (!projectId) return null;
    const generatedProjectsDir = await getGeneratedProjectsDir();
    let stats;
    try {
        stats = await fs.stat(sourcePath);
    } catch {
        return null;
    }
    if (minTimestamp && stats.mtimeMs < minTimestamp) {
        return null;
    }
    await recordGeneratedFile({
        project_id: projectId,
        file_type: fileType,
        file_name: fileName,
        storage_path: path.relative(generatedProjectsDir, sourcePath),
        file_size: stats.size,
    });
    return sourcePath;
}

async function cleanupLegacyProjectArtifacts(projectRoot: string) {
    const legacyPaths = [
        path.join(projectRoot, 'work'),
        path.join(projectRoot, 'theme.css'),
        path.join(projectRoot, 'components.html'),
        path.join(projectRoot, 'components_preview.html'),
        path.join(projectRoot, 'components_log.html'),
        path.join(projectRoot, 'debug_logs'),
    ];

    for (const target of legacyPaths) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
}

// --- Helper: Sync Artifacts (metadata only; files already live in final directories) ---
async function syncArtifacts(
    step: string,
    projectId: string,
    projectDnaDir: string,
    projectAssetsDir: string,
    projectLayoutDir: string,
    projectAssemblyDir: string,
    startTime: number
) {
    console.log(`[API] Starting DB Sync for step: ${step} (Modified since ${startTime})`);
    let output: any = {};

    try {
        if (step === 'dna') {
            const themePath = path.join(projectDnaDir, 'theme.css');
            if ((await fs.stat(themePath).catch(() => false))) {
                const stats = await fs.stat(themePath);
                await registerArtifact(projectId, themePath, 'theme.css', 'theme_css', startTime);
                output = { size: stats.size };
            }
        }
        else if (step === 'assets') {
            const componentsPath = path.join(projectAssetsDir, 'components.html');
            const previewPath = path.join(projectAssetsDir, 'components_preview.html');
            if ((await fs.stat(componentsPath).catch(() => false))) await registerArtifact(projectId, componentsPath, 'components.html', 'html_assets', startTime);
            if ((await fs.stat(previewPath).catch(() => false))) await registerArtifact(projectId, previewPath, 'components_preview.html', 'html_assets', startTime);
            output = { generated: true };
        }
        else if (step === 'layout') {
            if ((await fs.stat(projectLayoutDir).catch(() => false))) {
                const files = await fs.readdir(projectLayoutDir);
                const htmlFiles = files.filter(f => f.endsWith('.html'));
                for (const f of htmlFiles) {
                    await registerArtifact(projectId, path.join(projectLayoutDir, f), f, 'html_slide', startTime);
                }

                output = { count: htmlFiles.length, files: htmlFiles };
            }
        }
        else if (step === 'assembly') {
            const projectFinalOutput = path.join(projectAssemblyDir, 'output.pptx');
            if ((await fs.stat(projectFinalOutput).catch(() => false))) {
                const stats = await fs.stat(projectFinalOutput);
                await registerArtifact(projectId, projectFinalOutput, 'output.pptx', 'pptx_output', startTime);
                output = { size: stats.size };
            }
        }
        else if (step === 'qc') {
            // QC usually outputs to stdout, captured by stream. Assuming no specific file to archive unless specified.
            // Maybe archive 'qc_report.json' if it exists.
            output = { qc_completed: true };
        }

        // Update pipeline_results
        await insertPipelineResult({
            project_id: projectId, step_name: step, status: 'success', message: 'Execution success', output
        });
        console.log(`[API] DB Sync completed for step: ${step}`);

    } catch (e: any) {
        console.error(`[API] Error inside syncArtifacts: ${e.message}`);
    }
    return output;
}


// --- Streaming Helper 2.0 ---
async function spawnCommand(commandStr: string, env: NodeJS.ProcessEnv = process.env, onComplete?: () => Promise<void>): Promise<ReadableStream> {
    console.log(`[API] Spawning Command (stream): ${commandStr}`);
    const [cmd, ...args] = commandStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    const cleanCmd = cmd ? cmd.replace(/(^"|"$)/g, '') : '';
    const cleanArgs = args.map(arg => arg.replace(/(^"|"$)/g, ''));

    return new ReadableStream({
        start(controller) {
            // Use shell: true for complex commands
            const childProcess = spawn(commandStr, { env, shell: true });

            childProcess.stdout.on('data', (chunk) => {
                controller.enqueue(chunk);
            });

            childProcess.stderr.on('data', (chunk) => {
                controller.enqueue(chunk);
            });

            childProcess.on('close', async (code) => {
                if (code !== 0) {
                    controller.enqueue(new TextEncoder().encode(`\n[Process exited with code ${code}]\n`));
                } else {
                    controller.enqueue(new TextEncoder().encode(`\n[Process completed successfully]\n`));
                    // Trigger callback on success
                    if (onComplete) {
                        try {
                            controller.enqueue(new TextEncoder().encode(`\n[Syncing artifacts to database...]\n`));
                            await onComplete();
                            controller.enqueue(new TextEncoder().encode(`\n[Sync completed]\n`));
                        } catch (e: any) {
                            controller.enqueue(new TextEncoder().encode(`\n[Sync failed: ${e.message}]\n`));
                        }
                    }
                }
                controller.close();
            });

            childProcess.on('error', (err) => {
                controller.enqueue(new TextEncoder().encode(`\n[Process Error: ${err.message}]\n`));
                controller.close();
            });
        }
    });
}

// --- Legacy Helper: Buffered Execution ---
async function runCommand(command: string, env: NodeJS.ProcessEnv = process.env) {
    console.log(`[API] Executing Command: ${command}`);
    const startTime = Date.now();
    try {
        const { stdout, stderr } = await execPromise(command, { env });
        const duration = Date.now() - startTime;
        console.log(`[API] Command Completed in ${duration}ms`);

        if (stdout) console.log(`[API] Stdout (first 100 chars): ${stdout.substring(0, 100).replace(/\n/g, ' ')}...`);
        if (stderr && !stderr.includes('Debugger attached')) {
            console.warn(`[API] Stderr: ${stderr}`);
        }
        return stdout;
    } catch (error: any) {
        console.error(`[API] Command Failed: ${command}`, error);
        const output = error.stdout ? `\nOutput:\n${error.stdout}` : '';
        const errOutput = error.stderr ? `\nError Output:\n${error.stderr}` : '';
        throw new Error(`${error.message || String(error)}${output}${errOutput}`);
    }
}


export async function POST(request: Request) {
    try {
        if (getStorageMode() === 'local') {
            await getGeneratedProjectsDir();
        }
        const body = await request.json();
        const { step, fromLog, model, projectId, filterSlides, useStream } = body;
        let output: any = '';

        // Dynamic Env
        const baseEnv = await getBaseEnv(model);
        const currentEnv: NodeJS.ProcessEnv = {
            ...baseEnv,
            OPENAI_MODEL: model || baseEnv.OPENAI_MODEL
        };

        // --- Dynamic Paths Resolution ---
        let projectBriefPath = BRIEF_PATH;
        let projectDraftPath = DRAFT_PATH;
        let projectDnaDir = WORK_DIR;
        let projectAssetsDir = WORK_DIR;
        let projectLayoutDir = HTML_DIR;
        let projectAssemblyDir = PPTX_DIR;
        let projectFinalOutput = FINAL_OUTPUT;
        let projectRoot: string | null = null;

        if (projectId) {
            const generatedProjectsDir = await getGeneratedProjectsDir();
            projectRoot = path.join(generatedProjectsDir, projectId);
            const inputDir = path.join(projectRoot, 'input');

            projectBriefPath = path.join(inputDir, 'brief.json');
            projectDraftPath = path.join(inputDir, 'draft.json');
            projectDnaDir = path.join(projectRoot, 'dna');
            projectAssetsDir = path.join(projectRoot, 'assets');
            projectLayoutDir = path.join(projectRoot, 'layout');
            projectAssemblyDir = path.join(projectRoot, 'assembly');
            projectFinalOutput = path.join(projectAssemblyDir, 'output.pptx');

            await fs.mkdir(inputDir, { recursive: true });
            await fs.mkdir(projectDnaDir, { recursive: true });
            await fs.mkdir(projectAssetsDir, { recursive: true });
            await fs.mkdir(projectLayoutDir, { recursive: true });
            await fs.mkdir(projectAssemblyDir, { recursive: true });
            await cleanupLegacyProjectArtifacts(projectRoot);
        }

        // Fetch Brief and Draft
        if (projectId) {
            const project = await getProjectById(projectId);
            if (project) {
                if (project.brief_json) {
                    await fs.writeFile(projectBriefPath, JSON.stringify(project.brief_json, null, 2), 'utf-8');
                }
                if (project.content_draft) {
                    await fs.writeFile(projectDraftPath, JSON.stringify(project.content_draft, null, 2), 'utf-8');
                }
                console.log(`[API] Synced project data for ${projectId}`);
            }
        }

        // --- COMMAND GENERATION ---
        let cmdToRun = '';
        let cmdEnv: NodeJS.ProcessEnv = currentEnv;

        if (step === 'dna') {
            const themePath = path.join(projectDnaDir, 'theme.css');
            cmdToRun = `"${ASSEMBLER_VENV}" "${DNA_SCRIPT}" "${projectBriefPath}" "${themePath}"`;

        } else if (step === 'assets') {
            const ASSETS_SCRIPT = path.join(SKILLS_DIR, 'generate_assets', 'scripts', 'generate_components.py');
            const themePath = path.join(projectDnaDir, 'theme.css');
            cmdToRun = `"${ASSEMBLER_VENV}" "${ASSETS_SCRIPT}" "${themePath}" "${projectAssetsDir}" --brief "${projectBriefPath}" --content "${projectDraftPath}"`;
            cmdEnv = { ...currentEnv, ANTHROPIC_API_KEY: currentEnv.ANTHROPIC_API_KEY || '' };

        } else if (step === 'layout') {
            const componentsPath = path.join(projectAssetsDir, 'components.html');
            cmdToRun = `"${ASSEMBLER_VENV}" "${BUILDER_SCRIPT}" --brief "${projectBriefPath}" --content "${projectDraftPath}" --dna_dir "${projectDnaDir}" --output "${projectLayoutDir}" --components "${componentsPath}"`;
            if (filterSlides && Array.isArray(filterSlides) && filterSlides.length > 0) {
                cmdToRun += ` --slides "${filterSlides.join(',')}"`;
            }
            if (fromLog) {
                cmdToRun += ` --from-log "${path.join(projectLayoutDir, 'debug_logs')}"`;
            }

        } else if (step === 'assembly') {
            cmdToRun = `node "${ASSEMBLER_SCRIPT}" "${projectLayoutDir}" "${projectFinalOutput}"`;
            if (filterSlides && Array.isArray(filterSlides) && filterSlides.length > 0) {
                cmdToRun += ` --slides "${filterSlides.join(',')}"`;
            }

        } else if (step === 'qc') {
            cmdToRun = `"${ASSEMBLER_VENV}" "${QC_SCRIPT}" "${projectFinalOutput}" "${projectBriefPath}"`;
        }

        if (step === 'metrics') {
            const htmlDirExists = await fs.stat(projectLayoutDir).catch(() => false);
            if (!htmlDirExists) {
                return NextResponse.json(
                    { success: false, error: 'No layout HTML found. Run Layout Architect first.' },
                    { status: 400 }
                );
            }

            const htmlFiles = (await fs.readdir(projectLayoutDir))
                .filter((file) => file.endsWith('.html') && file !== 'index.html')
                .sort();

            if (htmlFiles.length === 0) {
                return NextResponse.json(
                    { success: false, error: 'No slide HTML files found for linting.' },
                    { status: 400 }
                );
            }

            const outputs: string[] = [];
            const failedFiles: string[] = [];

            for (const fileName of htmlFiles) {
                const htmlPath = path.join(projectLayoutDir, fileName);
                outputs.push(`\n=== Linting ${fileName} ===\n`);
                try {
                    const lintOutput = await runCommand(`"${ASSEMBLER_VENV}" "${LINT_SCRIPT}" "${htmlPath}"`, currentEnv);
                    outputs.push(lintOutput);
                } catch (error: any) {
                    failedFiles.push(fileName);
                    outputs.push(error.message || String(error));
                }
            }

            const outputText = outputs.join('\n').trim();
            const success = failedFiles.length === 0;

            if (projectId) {
                await insertPipelineResult({
                    project_id: projectId,
                    step_name: step,
                    status: success ? 'success' : 'error',
                    message: success
                        ? `Lint passed for ${htmlFiles.length} slide(s).`
                        : `Lint failed for ${failedFiles.length} slide(s).`,
                    output: {
                        checked: htmlFiles,
                        failed: failedFiles,
                        log: outputText,
                    },
                });
            }

            if (!success) {
                return NextResponse.json(
                    {
                        success: false,
                        error: `Lint failed for: ${failedFiles.join(', ')}`,
                        output: outputText,
                        storageMode: getStorageMode(),
                    },
                    { status: 400 }
                );
            }

            return NextResponse.json({
                success: true,
                message: `Lint passed for ${htmlFiles.length} slide(s).`,
                output: outputText,
                storageMode: getStorageMode(),
            });
        }

        // --- EXECUTION BLOCK ---
        if (cmdToRun) {
            // Capture start time for versioning granularity (only archive files modified after this)
            // Use a slightly earlier buffer (e.g. 100ms) to ensure we don't miss files created immediately
            const startTime = Date.now() - 100;

            const syncCallback = async () => {
                if (projectId) {
                    await syncArtifacts(
                        step,
                        projectId,
                        projectDnaDir,
                        projectAssetsDir,
                        projectLayoutDir,
                        projectAssemblyDir,
                        startTime
                    );
                    if (projectRoot) {
                        await cleanupLegacyProjectArtifacts(projectRoot);
                    }
                }
            };

            if (useStream) {
                console.log(`[API] Streaming requested for step: ${step}`);
                // Pass syncCallback to be executed on success
                const stream = await spawnCommand(cmdToRun, cmdEnv, syncCallback);
                return new NextResponse(stream);
            } else {
                console.log(`[API] Executing Buffered Command: ${cmdToRun}`);
                output = await runCommand(cmdToRun, cmdEnv);
                // Manually call sync
                await syncCallback();
                return NextResponse.json({ success: true, message: 'Command success', output, storageMode: getStorageMode() });
            }
        }

        return NextResponse.json({ success: false, error: 'Step not handled' }, { status: 400 });

    } catch (error: unknown) {
        console.error("API Error:", error);
        return NextResponse.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, { status: 500 });
    }
}

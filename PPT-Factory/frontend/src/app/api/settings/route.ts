import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import util from 'util';

import { getEffectiveLlmSettings, getLocalSettings, getSuggestedProjectRoot, setProjectRoot, updateLlmSettings } from '@/lib/server/local-settings';
import { getStorageMode } from '@/lib/server/project-store';

const execFileAsync = util.promisify(execFile);

async function pickProjectRootFromSystemDialog() {
  if (process.platform !== 'darwin') {
    throw new Error('System folder picker is currently supported on macOS only.');
  }

  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Choose Project Save Folder")',
    ]);
    const selectedPath = stdout.trim();
    if (!selectedPath) {
      throw new Error('No folder selected.');
    }
    return selectedPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('-128')) {
      throw new Error('Folder selection was canceled.');
    }
    throw error;
  }
}

export async function GET() {
  try {
    const settings = await getLocalSettings();
    return NextResponse.json({
      success: true,
      storageMode: getStorageMode(),
      localSettings: settings,
      effectiveLlmSettings: await getEffectiveLlmSettings(),
      suggestedProjectRoot: getSuggestedProjectRoot(),
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    let projectRoot: string | null = null;
    if (body.action === 'pickProjectRoot') {
      const selectedPath = await pickProjectRootFromSystemDialog();
      projectRoot = await setProjectRoot(selectedPath);
    } else if (body.projectRoot !== undefined) {
      projectRoot = await setProjectRoot(body.projectRoot ?? '');
    }

    const llm = body.llm ? await updateLlmSettings(body.llm) : (await getLocalSettings()).llm;
    const localSettings = await getLocalSettings();

    return NextResponse.json({
      success: true,
      storageMode: getStorageMode(),
      localSettings: { ...localSettings, projectRoot: projectRoot ?? localSettings.projectRoot, llm },
      effectiveLlmSettings: await getEffectiveLlmSettings(),
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 400 }
    );
  }
}

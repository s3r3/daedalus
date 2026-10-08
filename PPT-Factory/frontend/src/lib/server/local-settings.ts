import 'server-only';

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const ROOT_DIR = path.resolve(process.cwd(), '..');
const CONFIG_DIR = path.join(ROOT_DIR, '.ppt-factory');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

export interface LocalSettings {
  projectRoot: string | null;
  llm: {
    provider: 'openai-compatible' | 'anthropic';
    apiKey: string;
    baseUrl: string;
    model: string;
    anthropicApiKey: string;
  };
}

const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  projectRoot: null,
  llm: {
    provider: 'openai-compatible',
    apiKey: '',
    baseUrl: '',
    model: 'gemini-3-flash-preview',
    anthropicApiKey: '',
  },
};

async function ensureConfigDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

async function writeSettings(settings: LocalSettings) {
  await ensureConfigDir();
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

export async function getLocalSettings(): Promise<LocalSettings> {
  try {
    const content = await fs.readFile(SETTINGS_PATH, 'utf-8');
    const parsed = JSON.parse(content) as Partial<LocalSettings>;
    return {
      projectRoot: typeof parsed.projectRoot === 'string' && parsed.projectRoot.trim() ? parsed.projectRoot : null,
      llm: {
        provider: parsed.llm?.provider === 'anthropic' ? 'anthropic' : 'openai-compatible',
        apiKey: typeof parsed.llm?.apiKey === 'string' ? parsed.llm.apiKey : '',
        baseUrl: typeof parsed.llm?.baseUrl === 'string' ? parsed.llm.baseUrl : '',
        model: typeof parsed.llm?.model === 'string' && parsed.llm.model.trim()
          ? parsed.llm.model
          : DEFAULT_LOCAL_SETTINGS.llm.model,
        anthropicApiKey: typeof parsed.llm?.anthropicApiKey === 'string' ? parsed.llm.anthropicApiKey : '',
      },
    };
  } catch {
    return DEFAULT_LOCAL_SETTINGS;
  }
}

export async function setProjectRoot(projectRoot: string) {
  const normalized = validateProjectRoot(projectRoot);
  await ensureWritableDirectory(normalized);
  const current = await getLocalSettings();
  await writeSettings({ ...current, projectRoot: normalized });
  return normalized;
}

export async function updateLlmSettings(input: Partial<LocalSettings['llm']>) {
  const current = await getLocalSettings();
  const next: LocalSettings = {
    ...current,
    llm: {
      ...current.llm,
      ...input,
      provider: input.provider === 'anthropic' ? 'anthropic' : (input.provider === 'openai-compatible' ? 'openai-compatible' : current.llm.provider),
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : current.llm.model,
      apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : current.llm.apiKey,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : current.llm.baseUrl,
      anthropicApiKey: typeof input.anthropicApiKey === 'string' ? input.anthropicApiKey.trim() : current.llm.anthropicApiKey,
    },
  };
  await writeSettings(next);
  return next.llm;
}

export function validateProjectRoot(projectRoot: string) {
  const trimmed = projectRoot.trim();
  if (!trimmed) {
    throw new Error('Project save folder is required.');
  }

  if (!path.isAbsolute(trimmed)) {
    throw new Error('Project save folder must be an absolute path.');
  }

  return path.normalize(trimmed);
}

export async function ensureWritableDirectory(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
  const testFile = path.join(dirPath, `.write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(testFile, 'ok', 'utf-8');
  await fs.unlink(testFile);
}

export async function requireProjectRoot() {
  const settings = await getLocalSettings();
  if (!settings.projectRoot) {
    throw new Error('Project save folder is not configured.');
  }
  return settings.projectRoot;
}

export function getSuggestedProjectRoot() {
  return path.join(os.homedir(), 'Documents', 'PPT-Factory');
}

export async function getEffectiveLlmSettings() {
  const settings = await getLocalSettings();
  return {
    provider: settings.llm.provider,
    apiKey: settings.llm.apiKey || process.env.OPENAI_API_KEY || '',
    baseUrl: settings.llm.baseUrl || process.env.OPENAI_BASE_URL || '',
    model: settings.llm.model || process.env.OPENAI_MODEL || DEFAULT_LOCAL_SETTINGS.llm.model,
    anthropicApiKey: settings.llm.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '',
  };
}

export async function requireLlmConfig() {
  const llm = await getEffectiveLlmSettings();
  if (!llm.model) {
    throw new Error('Model name is not configured.');
  }
  if (!llm.apiKey) {
    throw new Error('LLM API key is not configured.');
  }
  return llm;
}

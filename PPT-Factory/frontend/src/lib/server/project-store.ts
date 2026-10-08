import 'server-only';

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

import { requireProjectRoot } from '@/lib/server/local-settings';

export type StorageMode = 'local';

export interface ProjectRecord {
  id: string;
  created_at: string;
  updated_at: string;
  project_name: string;
  user_prompt?: string | null;
  brief_json?: unknown;
  content_draft?: unknown;
  model_used?: string | null;
  status: 'draft' | 'processing' | 'completed' | 'error' | string;
}

export interface PipelineResultRecord {
  id: string;
  project_id: string;
  step_name: string;
  status: string;
  message?: string | null;
  output?: unknown;
  created_at: string;
}

export interface GeneratedFileRecord {
  id: string;
  project_id: string;
  file_type: string;
  file_name: string;
  storage_path: string;
  file_size: number | null;
  version: number;
  is_current: boolean;
  created_at: string;
}

interface LocalStoreData {
  projects: ProjectRecord[];
  pipeline_results: PipelineResultRecord[];
  generated_files: GeneratedFileRecord[];
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureLocalStore() {
  const generatedProjectsDir = await requireProjectRoot();
  const localStoreDir = path.join(generatedProjectsDir, '.local-store');
  const localStorePath = path.join(localStoreDir, 'db.json');

  await fs.mkdir(localStoreDir, { recursive: true });
  try {
    await fs.access(localStorePath);
  } catch {
    const initialData: LocalStoreData = {
      projects: [],
      pipeline_results: [],
      generated_files: [],
    };
    await fs.writeFile(localStorePath, JSON.stringify(initialData, null, 2), 'utf-8');
  }
}

async function getLocalStorePath() {
  const generatedProjectsDir = await requireProjectRoot();
  return path.join(generatedProjectsDir, '.local-store', 'db.json');
}

export async function getGeneratedProjectsDir() {
  return requireProjectRoot();
}

async function syncLocalProjectInputs(project: ProjectRecord) {
  const generatedProjectsDir = await getGeneratedProjectsDir();
  const inputDir = path.join(generatedProjectsDir, project.id, 'input');
  await fs.mkdir(inputDir, { recursive: true });

  if (project.brief_json !== undefined) {
    await fs.writeFile(
      path.join(inputDir, 'brief.json'),
      JSON.stringify(project.brief_json ?? {}, null, 2),
      'utf-8'
    );
  }

  if (project.content_draft !== undefined) {
    await fs.writeFile(
      path.join(inputDir, 'draft.json'),
      JSON.stringify(project.content_draft ?? null, null, 2),
      'utf-8'
    );
  }
}

async function readLocalStore(): Promise<LocalStoreData> {
  await ensureLocalStore();
  const localStorePath = await getLocalStorePath();
  const content = await fs.readFile(localStorePath, 'utf-8');
  return JSON.parse(content) as LocalStoreData;
}

async function writeLocalStore(data: LocalStoreData) {
  await ensureLocalStore();
  const localStorePath = await getLocalStorePath();
  await fs.writeFile(localStorePath, JSON.stringify(data, null, 2), 'utf-8');
}

export function getStorageMode(): StorageMode {
  return 'local';
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const store = await readLocalStore();
  return [...store.projects].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  const store = await readLocalStore();
  return store.projects.find((project) => project.id === id) ?? null;
}

export async function upsertProject(input: Partial<ProjectRecord> & { project_name: string; id?: string | null }) {
  const store = await readLocalStore();
  const timestamp = nowIso();

  if (input.id) {
    const index = store.projects.findIndex((project) => project.id === input.id);
    if (index === -1) {
      throw new Error(`Project not found: ${input.id}`);
    }

    store.projects[index] = {
      ...store.projects[index],
      project_name: input.project_name,
      user_prompt: input.user_prompt,
      brief_json: input.brief_json ?? store.projects[index].brief_json ?? {},
      content_draft: input.content_draft ?? store.projects[index].content_draft ?? null,
      model_used: input.model_used ?? store.projects[index].model_used ?? null,
      status: input.status ?? store.projects[index].status ?? 'draft',
      updated_at: timestamp,
    };

    await writeLocalStore(store);
    await syncLocalProjectInputs(store.projects[index]);
    return store.projects[index];
  }

  const project: ProjectRecord = {
    id: randomUUID(),
    created_at: timestamp,
    updated_at: timestamp,
    project_name: input.project_name,
    user_prompt: input.user_prompt ?? null,
    brief_json: input.brief_json ?? {},
    content_draft: input.content_draft ?? null,
    model_used: input.model_used ?? null,
    status: input.status ?? 'draft',
  };

  store.projects.push(project);
  await writeLocalStore(store);
  await syncLocalProjectInputs(project);
  return project;
}

export async function patchProject(id: string, updates: Partial<ProjectRecord>) {
  const store = await readLocalStore();
  const index = store.projects.findIndex((project) => project.id === id);
  if (index === -1) {
    throw new Error(`Project not found: ${id}`);
  }

  store.projects[index] = {
    ...store.projects[index],
    ...updates,
    updated_at: nowIso(),
  };
  await writeLocalStore(store);
  await syncLocalProjectInputs(store.projects[index]);
  return store.projects[index];
}

export async function deleteProject(id: string) {
  const store = await readLocalStore();
  store.projects = store.projects.filter((project) => project.id !== id);
  store.pipeline_results = store.pipeline_results.filter((result) => result.project_id !== id);
  store.generated_files = store.generated_files.filter((file) => file.project_id !== id);
  await writeLocalStore(store);
  const generatedProjectsDir = await getGeneratedProjectsDir();
  await fs.rm(path.join(generatedProjectsDir, id), { recursive: true, force: true });
}

export async function listPipelineResults(projectId: string): Promise<PipelineResultRecord[]> {
  const store = await readLocalStore();
  return store.pipeline_results
    .filter((result) => result.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function insertPipelineResult(record: Omit<PipelineResultRecord, 'id' | 'created_at'>) {
  const store = await readLocalStore();
  store.pipeline_results.push({
    id: randomUUID(),
    created_at: nowIso(),
    ...record,
  });

  const projectIndex = store.projects.findIndex((project) => project.id === record.project_id);
  if (projectIndex !== -1) {
    store.projects[projectIndex].status = record.status as ProjectRecord['status'];
    store.projects[projectIndex].updated_at = nowIso();
  }

  await writeLocalStore(store);
}

export async function listGeneratedFiles(projectId: string): Promise<GeneratedFileRecord[]> {
  const store = await readLocalStore();
  return store.generated_files
    .filter((file) => file.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function recordGeneratedFile(input: Omit<GeneratedFileRecord, 'id' | 'created_at' | 'version' | 'is_current'>) {
  const store = await readLocalStore();
  const existingFiles = store.generated_files
    .filter((file) => file.project_id === input.project_id && file.file_name === input.file_name)
    .sort((a, b) => b.version - a.version);

  const newVersion = existingFiles.length > 0 ? existingFiles[0].version + 1 : 1;

  store.generated_files = store.generated_files.map((file) => {
    if (file.project_id === input.project_id && file.file_name === input.file_name) {
      return { ...file, is_current: false };
    }
    return file;
  });

  store.generated_files.push({
    id: randomUUID(),
    created_at: nowIso(),
    version: newVersion,
    is_current: true,
    ...input,
  });

  await writeLocalStore(store);
}

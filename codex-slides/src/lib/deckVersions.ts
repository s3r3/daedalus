// Immutable, project-local deck history. Each version owns its project snapshot
// and slide PNGs so preview, playback, restore, PDF, and PPTX never fall through
// to the mutable current deck.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProject, projectDir, saveProject } from "./store";
import type {
  Aspect,
  DeckVersionCaptureInput,
  DeckVersionDetail,
  DeckVersionPromptSource,
  DeckVersionSource,
  DeckVersionSummary,
  MaterialRecord,
  Project,
} from "./types";

const VERSION_ROOT = ".deck-versions";
const VERSION_MANIFEST = "manifest.json";
const VERSION_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_IMAGE_RE = /^[A-Za-z0-9._-]+$/;
const ASPECTS = new Set<Aspect>(["16:9", "4:3", "1:1", "9:16", "3:4"]);
const projectLocks = new Map<string, Promise<void>>();

interface DeckVersionEntry extends Omit<DeckVersionSummary, "current"> {
  signature: string;
  snapshotPath: string;
  groupId?: string;
}

interface DeckVersionManifest {
  schemaVersion: 1;
  entries: DeckVersionEntry[];
}

interface CaptureOptions extends DeckVersionCaptureInput {
  force?: boolean;
  restoreFromVersionId?: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertSafeProjectId(projectId: string): string {
  const id = String(projectId ?? "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id.includes("\0") || id === "." || id === "..") {
    throw new Error("invalid project id");
  }
  return id;
}

function assertSafeVersionId(versionId: string): string {
  const id = String(versionId ?? "").trim();
  if (!VERSION_ID_RE.test(id)) throw new Error("invalid version id");
  return id;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function normalizeGroupId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().slice(0, 180);
  return id && /^[A-Za-z0-9_.:-]+$/.test(id) ? id : undefined;
}

function versionRoot(projectId: string): string {
  return path.join(projectDir(assertSafeProjectId(projectId)), VERSION_ROOT);
}

function versionDir(projectId: string, versionId: string): string {
  return path.join(versionRoot(projectId), assertSafeVersionId(versionId));
}

function manifestPath(projectId: string): string {
  return path.join(versionRoot(projectId), VERSION_MANIFEST);
}

async function withProjectLock<T>(projectId: string, work: () => Promise<T> | T): Promise<T> {
  const key = path.resolve(projectDir(assertSafeProjectId(projectId)));
  const previous = projectLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.then(() => current, () => current);
  projectLocks.set(key, chained);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (projectLocks.get(key) === chained) projectLocks.delete(key);
  }
}

function normalizedSource(value: unknown): DeckVersionSource {
  return value === "manual" || value === "restore" ? value : "ai";
}

function normalizedPromptSource(value: unknown): DeckVersionPromptSource | undefined {
  return value === "message" || value === "project" || value === "manual" || value === "restore"
    ? value
    : undefined;
}

function normalizeEntry(raw: unknown): DeckVersionEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && VERSION_ID_RE.test(value.id) ? value.id : null;
  const version = Math.trunc(Number(value.version));
  if (!id || !Number.isInteger(version) || version < 1) return null;
  const aspect = ASPECTS.has(value.aspect as Aspect) ? value.aspect as Aspect : "16:9";
  const promptSource = normalizedPromptSource(value.promptSource);
  const restoreFromVersionId = typeof value.restoreFromVersionId === "string" && VERSION_ID_RE.test(value.restoreFromVersionId)
    ? value.restoreFromVersionId
    : undefined;
  const entry: DeckVersionEntry = {
    id,
    version,
    label: normalizeText(value.label) ?? `Version ${version}`,
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : Date.now(),
    source: normalizedSource(value.source),
    prompt: normalizeText(value.prompt),
    title: normalizeText(value.title) ?? "Untitled deck",
    aspect,
    slideCount: Math.max(0, Math.trunc(Number(value.slideCount) || 0)),
    renderedCount: Math.max(0, Math.trunc(Number(value.renderedCount) || 0)),
    signature: typeof value.signature === "string" ? value.signature : "",
    snapshotPath: typeof value.snapshotPath === "string" && VERSION_ID_RE.test(value.snapshotPath)
      ? value.snapshotPath
      : id,
  };
  if (promptSource) entry.promptSource = promptSource;
  if (restoreFromVersionId) entry.restoreFromVersionId = restoreFromVersionId;
  if (typeof value.coverImage === "string" && SAFE_IMAGE_RE.test(value.coverImage)) {
    entry.coverImage = value.coverImage;
  }
  const groupId = normalizeGroupId(value.groupId);
  if (groupId) entry.groupId = groupId;
  return entry;
}

function readManifest(projectId: string): DeckVersionEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(projectId), "utf8")) as Partial<DeckVersionManifest>;
    return (Array.isArray(parsed.entries) ? parsed.entries : [])
      .map(normalizeEntry)
      .filter((entry): entry is DeckVersionEntry => Boolean(entry))
      .sort((a, b) => a.version - b.version);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function writeManifest(projectId: string, entries: DeckVersionEntry[]): void {
  const root = versionRoot(projectId);
  fs.mkdirSync(root, { recursive: true });
  const target = manifestPath(projectId);
  const staged = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(staged, JSON.stringify({ schemaVersion: 1, entries }, null, 2), "utf8");
  try {
    fs.renameSync(staged, target);
  } catch {
    fs.rmSync(target, { force: true });
    fs.renameSync(staged, target);
  }
}

function publicVersion(entry: DeckVersionEntry, currentId: string | null): DeckVersionSummary {
  const version: DeckVersionSummary = {
    id: entry.id,
    version: entry.version,
    label: entry.label,
    createdAt: entry.createdAt,
    source: entry.source,
    prompt: entry.prompt,
    current: entry.id === currentId,
    title: entry.title,
    aspect: entry.aspect,
    slideCount: entry.slideCount,
    renderedCount: entry.renderedCount,
  };
  if (entry.promptSource) version.promptSource = entry.promptSource;
  if (entry.restoreFromVersionId) version.restoreFromVersionId = entry.restoreFromVersionId;
  if (entry.coverImage) version.coverImage = entry.coverImage;
  return version;
}

function snapshotProject(project: Project): Project {
  const workflow = project.workflow
    ? {
        stage: project.pages.some((page) => page.image) ? "deck" as const : project.workflow.stage,
        workspaceMode: project.workflow.workspaceMode,
        inspirationSkipped: project.workflow.inspirationSkipped,
      }
    : undefined;
  return clone({
    id: project.id,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    config: project.config,
    agent: project.agent,
    title: project.title,
    outline: project.outline,
    pages: project.pages,
    materials: project.materials,
    researchDoc: project.researchDoc,
    research: project.research,
    status: project.status,
    workflow,
  } satisfies Project);
}

export function currentDeckVersionSignature(project: Project): string {
  // Project/chat autosaves update `updatedAt` and workspace position without
  // changing the deck. Keep those fields outside the content signature so a
  // conversation-only turn never produces a phantom version.
  const state = {
    config: project.config,
    agent: project.agent,
    title: project.title,
    outline: project.outline,
    pages: project.pages,
    materials: project.materials,
    researchDoc: project.researchDoc,
    research: project.research,
    status: project.status,
  };
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function versionPromptForProject(project: Project): string | null {
  const messages = [
    ...(project.chat ?? []),
    ...(project.conversations ?? []).flatMap((conversation) => conversation.messages ?? []),
  ].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content?.trim()) return message.content.trim();
  }
  return normalizeText(project.config.requirement);
}

function writeSnapshot(project: Project, entry: DeckVersionEntry): void {
  const root = versionRoot(project.id);
  const target = versionDir(project.id, entry.id);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const staged = path.join(root, `.staging-${entry.id}-${token}`);
  const backup = path.join(root, `.backup-${entry.id}-${token}`);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(path.join(staged, "slides"), { recursive: true });

  const snapshot = snapshotProject(project);
  fs.writeFileSync(path.join(staged, "project.json"), JSON.stringify(snapshot, null, 2), "utf8");
  const copied = new Set<string>();
  for (const page of snapshot.pages) {
    if (!page.image || copied.has(page.image)) continue;
    if (!SAFE_IMAGE_RE.test(page.image)) throw new Error(`invalid slide image name: ${page.image}`);
    const source = path.join(projectDir(project.id), page.image);
    if (!fs.existsSync(source)) throw new Error(`slide image not found: ${page.image}`);
    fs.copyFileSync(source, path.join(staged, "slides", page.image));
    copied.add(page.image);
  }

  try {
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(staged, target);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
}

function captureUnlocked(project: Project, options: CaptureOptions): DeckVersionSummary | null {
  const renderedPages = project.pages.filter((page) => page.image);
  if (!renderedPages.length) return null;
  const entries = readManifest(project.id);
  const latest = entries.at(-1);
  const signature = currentDeckVersionSignature(project);
  if (!options.force && latest?.signature === signature) {
    return publicVersion(latest, latest.id);
  }

  const groupId = normalizeGroupId(options.groupId);
  const reuseLatest = Boolean(groupId && latest?.groupId === groupId && !options.restoreFromVersionId);
  const version = reuseLatest
    ? latest!.version
    : entries.reduce((max, entry) => Math.max(max, entry.version), 0) + 1;
  const id = reuseLatest ? latest!.id : randomUUID();
  const restoredFrom = options.restoreFromVersionId
    ? entries.find((entry) => entry.id === options.restoreFromVersionId)
    : undefined;
  const hasPrompt = Object.prototype.hasOwnProperty.call(options, "prompt");
  const fallbackPrompt = options.source === "manual"
    ? normalizeText(options.label)
    : versionPromptForProject(project);
  const prompt = hasPrompt ? normalizeText(options.prompt) : (reuseLatest ? latest!.prompt : fallbackPrompt);
  const source = options.source
    ?? (options.restoreFromVersionId || options.promptSource === "restore" ? "restore"
      : options.promptSource === "manual" ? "manual" : "ai");
  const entry: DeckVersionEntry = {
    id,
    version,
    label: normalizeText(options.label)
      ?? (restoredFrom ? `Version ${version} · restored from v${restoredFrom.version}` : `Version ${version}`),
    createdAt: reuseLatest ? latest!.createdAt : Date.now(),
    source,
    prompt,
    title: project.title,
    aspect: project.config.aspect,
    slideCount: project.pages.length,
    renderedCount: renderedPages.length,
    coverImage: renderedPages[0]?.image,
    signature,
    snapshotPath: id,
  };
  const promptSource = options.promptSource
    ?? (source === "manual" ? "manual" : source === "restore" ? "restore" : "message");
  if (promptSource) entry.promptSource = promptSource;
  if (groupId) entry.groupId = groupId;
  if (options.restoreFromVersionId) entry.restoreFromVersionId = options.restoreFromVersionId;

  writeSnapshot(project, entry);
  if (reuseLatest) entries[entries.length - 1] = entry;
  else entries.push(entry);
  writeManifest(project.id, entries);
  return publicVersion(entry, entry.id);
}

export async function captureDeckVersion(
  projectOrId: Project | string,
  options: CaptureOptions = {},
): Promise<DeckVersionSummary | null> {
  const project = typeof projectOrId === "string" ? loadProject(projectOrId) : projectOrId;
  if (!project) throw new Error("project not found");
  return withProjectLock(project.id, () => {
    const latest = loadProject(project.id) ?? project;
    return captureUnlocked(latest, options);
  });
}

export async function ensureCurrentDeckVersion(
  projectOrId: Project | string,
  options: DeckVersionCaptureInput = {},
): Promise<DeckVersionSummary | null> {
  return captureDeckVersion(projectOrId, { ...options, force: false });
}

export function listDeckVersions(projectId: string): DeckVersionSummary[] {
  const entries = readManifest(projectId);
  const currentId = entries.at(-1)?.id ?? null;
  return entries.map((entry) => publicVersion(entry, currentId));
}

function readVersionEntry(projectId: string, versionId: string): { entry: DeckVersionEntry; entries: DeckVersionEntry[] } {
  const safeId = assertSafeVersionId(versionId);
  const entries = readManifest(projectId);
  const entry = entries.find((candidate) => candidate.id === safeId);
  if (!entry) throw new Error("version not found");
  return { entry, entries };
}

export function readDeckVersion(projectId: string, versionId: string): DeckVersionDetail {
  const { entry, entries } = readVersionEntry(projectId, versionId);
  const snapshotFile = path.join(versionDir(projectId, entry.snapshotPath), "project.json");
  const project = JSON.parse(fs.readFileSync(snapshotFile, "utf8")) as Project;
  return {
    version: publicVersion(entry, entries.at(-1)?.id ?? null),
    project,
  };
}

export function readDeckVersionImage(projectId: string, versionId: string, imageName: string): Buffer | null {
  const safeName = String(imageName ?? "").trim();
  if (!SAFE_IMAGE_RE.test(safeName)) return null;
  const { entry } = readVersionEntry(projectId, versionId);
  const file = path.join(versionDir(projectId, entry.snapshotPath), "slides", safeName);
  try {
    return fs.readFileSync(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function mergedMaterials(current: MaterialRecord[] | undefined, restored: MaterialRecord[] | undefined): MaterialRecord[] | undefined {
  const items = [...(current ?? []), ...(restored ?? [])];
  if (!items.length) return undefined;
  const byId = new Map<string, MaterialRecord>();
  for (const item of items) byId.set(item.id, item);
  return Array.from(byId.values());
}

export async function restoreDeckVersion(
  projectId: string,
  versionId: string,
  prompt?: string | null,
): Promise<{ project: Project; version: DeckVersionSummary }> {
  return withProjectLock(projectId, () => {
    const current = loadProject(projectId);
    if (!current) throw new Error("project not found");
    if (current.activeRun) throw new Error("wait for the active project task to finish before restoring a version");
    const detail = readDeckVersion(projectId, versionId);
    const snapshot = detail.project;

    const currentImages = new Set(
      current.pages.map((page) => page.image).filter((name): name is string => Boolean(name && SAFE_IMAGE_RE.test(name))),
    );
    for (const name of currentImages) fs.rmSync(path.join(projectDir(projectId), name), { force: true });
    for (const page of snapshot.pages) {
      if (!page.image) continue;
      if (!SAFE_IMAGE_RE.test(page.image)) throw new Error(`invalid version slide image: ${page.image}`);
      const source = path.join(versionDir(projectId, detail.version.id), "slides", page.image);
      if (!fs.existsSync(source)) throw new Error(`version slide image not found: ${page.image}`);
      fs.copyFileSync(source, path.join(projectDir(projectId), page.image));
    }

    const now = Date.now();
    const restored: Project = {
      ...current,
      config: clone(snapshot.config),
      agent: snapshot.agent,
      title: snapshot.title,
      outline: clone(snapshot.outline),
      pages: clone(snapshot.pages).map((page, index) => (
        page.image ? { ...page, imageUpdatedAt: now + index } : page
      )),
      materials: mergedMaterials(current.materials, snapshot.materials),
      researchDoc: snapshot.researchDoc,
      research: snapshot.research,
      status: snapshot.status ?? "ready",
      workflow: {
        ...(current.workflow ?? { stage: "deck" as const }),
        stage: "deck",
      },
      activeRun: undefined,
    };
    saveProject(restored);
    const version = captureUnlocked(restored, {
      force: true,
      source: "restore",
      promptSource: "restore",
      prompt: normalizeText(prompt) ?? detail.version.prompt ?? `Restore version ${detail.version.version}`,
      restoreFromVersionId: detail.version.id,
    });
    if (!version) throw new Error("restored deck has no rendered slides");
    return { project: restored, version };
  });
}

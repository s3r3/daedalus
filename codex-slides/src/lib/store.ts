// On-disk project store: web/data/projects/<id>/{project.json, NN.png}
import fs from "node:fs";
import path from "node:path";
import { getCommunityTemplate } from "./community";
import { DATA_ROOT } from "./dataPaths";
import type { Project, SlidePage } from "./types";

export const DATA_DIR = path.join(DATA_ROOT, "projects");
const projectFileSyncSignatures = new Map<string, string>();

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function projectDir(id: string): string {
  return path.join(DATA_DIR, id);
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "deck"
  );
}

export function newProjectId(title: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${slugify(title)}-${rand}`;
}

export function saveProject(project: Project): void {
  const dir = projectDir(project.id);
  ensureDir(dir);
  // Long-running render/edit functions hold a project snapshot while model
  // calls are in flight. A manual stop can be persisted during that wait; the
  // stale worker must never write its older `running` state back over the
  // cancellation request when it saves page progress.
  const projectFile = path.join(dir, "project.json");
  if (project.activeRun?.status === "running" && fs.existsSync(projectFile)) {
    try {
      const persisted = JSON.parse(fs.readFileSync(projectFile, "utf8")) as Project;
      if (
        persisted.activeRun?.id === project.activeRun.id
        && persisted.activeRun.status === "stopping"
      ) {
        project.activeRun = persisted.activeRun;
      }
    } catch {
      // The normal write below remains the recovery path for malformed state.
    }
  }
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    projectFile,
    JSON.stringify(project, null, 2),
    "utf8",
  );
  syncProjectFiles(project);
}

function writeGeneratedFile(dir: string, name: string, content: string) {
  ensureDir(dir);
  const file = path.join(dir, name);
  try {
    if (fs.readFileSync(file, "utf8") === content) return;
  } catch {
    // A missing or unreadable generated file is repaired by the write below.
  }
  fs.writeFileSync(file, content, "utf8");
}

/** Keep agent-created inputs and intermediate decisions visible as ordinary files. */
export function syncProjectFiles(project: Project): void {
  const signature = JSON.stringify({
    title: project.title,
    config: project.config,
    outline: project.outline,
    chat: project.chat,
    researchDoc: project.researchDoc,
    research: project.research,
  });
  const dir = path.join(projectDir(project.id), "files", "generated");
  const expectedFiles = ["brief.md", "outline.md", "deck-config.json"];
  if (project.config.designSystem) expectedFiles.push("brand-design-system.json");
  if (project.researchDoc) expectedFiles.push("research.md");
  if (project.research) expectedFiles.push("research-process.json");
  if (project.chat?.length) expectedFiles.push("conversation.md");
  if (project.config.template || project.chat?.some((message) => message.inspiration)) {
    expectedFiles.push("inspiration.json");
  }
  if (
    projectFileSyncSignatures.get(project.id) === signature
    && expectedFiles.every((name) => fs.existsSync(path.join(dir, name)))
  ) return;
  const messages = project.chat ?? [];
  const outline = (project.outline ?? []).map((page, i) =>
    `## ${i + 1}. ${page.title}\n\n${page.points.map((point) => `- ${point}`).join("\n")}`,
  ).join("\n\n");
  const confirmedBrief = messages.find((message) => (
    message.role === "user" && /^(已确认|confirmed)[:：]/i.test(message.content.trim())
  ))?.content.trim();
  writeGeneratedFile(
    dir,
    "brief.md",
    `# ${project.title}\n\n${project.config.requirement || ""}${confirmedBrief ? `\n\n## 已确认输入 / Confirmed inputs\n\n${confirmedBrief}` : ""}\n`,
  );
  writeGeneratedFile(dir, "outline.md", `# Outline\n\n${outline}\n`);
  writeGeneratedFile(dir, "deck-config.json", `${JSON.stringify(project.config, null, 2)}\n`);
  if (project.config.designSystem) {
    writeGeneratedFile(
      dir,
      "brand-design-system.json",
      `${JSON.stringify(project.config.designSystem, null, 2)}\n`,
    );
  }
  if (project.researchDoc) writeGeneratedFile(dir, "research.md", project.researchDoc);
  if (project.research) {
    writeGeneratedFile(dir, "research-process.json", `${JSON.stringify(project.research, null, 2)}\n`);
  }
  if (messages.length) {
    writeGeneratedFile(dir, "conversation.md", messages.map((message) =>
      `## ${message.role === "user" ? "User" : "Agent"}\n\n${message.content || ""}`,
    ).join("\n\n"));
  }
  const inspirations = messages.flatMap((message) => message.inspiration ? [message.inspiration] : []);
  if (!inspirations.length && project.config.template) {
    inspirations.push({
      query: project.config.requirement || project.title,
      coverIds: [project.config.template],
      total: 1,
      chosen: project.config.template,
      resolved: true,
    });
  }
  if (inspirations.length) {
    const snapshots = inspirations.map((inspiration) => {
      const selected = getCommunityTemplate(inspiration.chosen);
      return selected ? {
        ...inspiration,
        selectedStyle: {
          id: selected.id,
          name: selected.name,
          group: selected.group,
          description: selected.description,
          cover: selected.cover,
          author: selected.author,
          sourceUrl: selected.sourceUrl,
          sourceIds: selected.sourceIds,
        },
      } : inspiration;
    });
    writeGeneratedFile(dir, "inspiration.json", `${JSON.stringify(snapshots, null, 2)}\n`);
  }
  projectFileSyncSignatures.set(project.id, signature);
}

export function loadProject(id: string): Project | null {
  const f = path.join(projectDir(id), "project.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Project;
  } catch {
    return null;
  }
}

export function listProjects(): Project[] {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .map((id) => loadProject(id))
    .filter((p): p is Project => Boolean(p))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function imageFileName(index: number): string {
  return `${String(index).padStart(2, "0")}.png`;
}

/** Persist a slide image; returns the file name stored on the page. */
export function saveSlideImage(id: string, index: number, bytes: Buffer): string {
  const dir = projectDir(id);
  ensureDir(dir);
  const name = imageFileName(index);
  fs.writeFileSync(path.join(dir, name), bytes);
  return name;
}

/**
 * Persist the exact annotated image that was sent to the mark editor.
 *
 * Unlike a rendered slide (`04.png`), mark snapshots deliberately use unique
 * filenames. Chat history can therefore keep showing the user's red marks even
 * after the canonical slide image is replaced by the generated result.
 */
export function saveMarkSnapshot(id: string, index: number, bytes: Buffer): string {
  const dir = projectDir(id);
  ensureDir(dir);
  const page = String(index).padStart(2, "0");
  const token = Math.random().toString(36).slice(2, 8);
  const name = `mark-${page}-${Date.now()}-${token}.png`;
  fs.writeFileSync(path.join(dir, name), bytes);
  return name;
}

export function readSlideImage(id: string, name: string): Buffer | null {
  return readSlideImageAsset(id, name)?.bytes ?? null;
}

export interface SlideImageAsset {
  bytes: Buffer;
  etag: string;
  lastModified: string;
  size: number;
}

/** Read metadata before bytes so conditional image requests can return 304
 * without allocating and copying a multi-megabyte PNG. */
export function readSlideImageAsset(id: string, name: string): SlideImageAsset | null {
  // guard against path traversal
  if (!/^[\w.-]+$/.test(name)) return null;
  const f = path.join(projectDir(id), name);
  if (!fs.existsSync(f)) return null;
  const stat = fs.statSync(f);
  return {
    get bytes() {
      return fs.readFileSync(f);
    },
    etag: `W/"slide-${stat.size}-${Math.trunc(stat.mtimeMs)}"`,
    lastModified: stat.mtime.toUTCString(),
    size: stat.size,
  };
}

/** Persist an ordered page array and compact both indexes and on-disk PNG names. */
export function replaceProjectPages(project: Project, pages: SlidePage[]): void {
  const dir = projectDir(project.id);
  ensureDir(dir);
  const snapshots = pages.map((page, position) => {
    const source = page.image && /^[\w.-]+$/.test(page.image) && fs.existsSync(path.join(dir, page.image))
      ? page.image
      : undefined;
    return {
      page: { ...page, points: [...page.points] } as SlidePage,
      source,
      target: imageFileName(position + 1),
      staged: undefined as string | undefined,
    };
  });

  // Structural edits used to read every 2K/4K PNG into memory, delete it, then
  // write it back synchronously. Adding one blank page could therefore stall
  // behind hundreds of MB of avoidable I/O. Stage only filenames that actually
  // move; unchanged pages stay in place, and duplication copies just its source.
  const bySource = new Map<string, typeof snapshots>();
  for (const snapshot of snapshots) {
    if (!snapshot.source) continue;
    const group = bySource.get(snapshot.source) ?? [];
    group.push(snapshot);
    bySource.set(snapshot.source, group);
  }

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let stagedIndex = 0;
  for (const [source, group] of bySource) {
    if (group.length === 1 && group[0].target === source) continue;
    const staged = `.slide-reindex-${token}-${stagedIndex++}.png`;
    fs.renameSync(path.join(dir, source), path.join(dir, staged));
    group[0].staged = staged;
    for (const snapshot of group.slice(1)) {
      const duplicate = `.slide-reindex-${token}-${stagedIndex++}.png`;
      fs.copyFileSync(path.join(dir, staged), path.join(dir, duplicate));
      snapshot.staged = duplicate;
    }
  }

  const unchanged = new Set(
    snapshots
      .filter((snapshot) => snapshot.source && !snapshot.staged && snapshot.source === snapshot.target)
      .map((snapshot) => snapshot.target),
  );
  for (const name of fs.readdirSync(dir)) {
    if (/^\d+\.png$/i.test(name) && !unchanged.has(name)) fs.unlinkSync(path.join(dir, name));
  }

  project.pages = snapshots.map(({ page, source, target, staged }, position) => {
    const next = { ...page, index: position + 1 };
    if (staged) {
      fs.renameSync(path.join(dir, staged), path.join(dir, target));
      next.image = target;
    } else if (source === target) {
      next.image = target;
    } else {
      next.image = undefined;
    }
    return next;
  });
  project.outline = project.pages.map((page) => ({ title: page.title, points: [...page.points] }));
  project.config.pages = project.pages.length;
  saveProject(project);
}

/** Delete a page and compact both page indexes and their on-disk PNG names. */
export function removeProjectPage(project: Project, index: number): void {
  const remaining = project.pages.filter((page) => page.index !== index);
  if (remaining.length === project.pages.length) throw new Error("page not found");
  replaceProjectPages(project, remaining);
}

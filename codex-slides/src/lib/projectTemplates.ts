import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./dataPaths";
import { loadProject, projectDir, slugify } from "./store";
import type {
  DeckDesignSystem,
  MaterialRecord,
  PptConfig,
  Project,
  ProjectTemplateSummary,
} from "./types";

const PROJECT_TEMPLATES_DIR = path.join(DATA_ROOT, "templates");
const TEMPLATE_ID_RE = /^[a-zA-Z0-9_-]{8,140}$/;
const MATERIAL_FILE_RE = /^[\w.-]+$/;

interface TemplateAsset {
  file: string;
  name: string;
  mimeType: string;
  sourceMaterialId?: string;
}

interface ProjectTemplateRecord extends ProjectTemplateSummary {
  version: 1;
  referenceSlides: TemplateAsset[];
  brandAssets: TemplateAsset[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ensureDir(value: string) {
  fs.mkdirSync(value, { recursive: true });
}

function templateDir(id: string): string | null {
  if (!TEMPLATE_ID_RE.test(id)) return null;
  const root = path.resolve(PROJECT_TEMPLATES_DIR);
  const resolved = path.resolve(root, id);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function templateFile(id: string): string | null {
  const dir = templateDir(id);
  return dir ? path.join(dir, "template.json") : null;
}

function newTemplateId(name: string) {
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${stamp}-${slugify(name)}-${rand}`;
}

function cleanDisplayName(value: unknown, fallback: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || fallback;
}

function cleanDescription(value: unknown) {
  return String(value ?? "").trim().slice(0, 500);
}

function mimeFor(name: string) {
  switch (path.extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

function summary(record: ProjectTemplateRecord): ProjectTemplateSummary {
  const {
    referenceSlides,
    brandAssets,
    version: _version,
    ...value
  } = record;
  return {
    ...clone(value),
    coverUrl: referenceSlides.length ? `/api/templates/${encodeURIComponent(record.id)}/cover` : undefined,
    referenceCount: referenceSlides.length,
    brandAssetCount: brandAssets.length,
  };
}

export function loadProjectTemplate(id: string): ProjectTemplateRecord | null {
  const file = templateFile(id);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectTemplateRecord;
    if (parsed.version !== 1 || parsed.id !== id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listProjectTemplates(): ProjectTemplateSummary[] {
  if (!fs.existsSync(PROJECT_TEMPLATES_DIR)) return [];
  return fs.readdirSync(PROJECT_TEMPLATES_DIR)
    .flatMap((id) => {
      const record = loadProjectTemplate(id);
      return record ? [summary(record)] : [];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Save the reusable visual system, not the source project's content. */
export function createProjectTemplate(
  projectId: string,
  input: { name?: unknown; description?: unknown } = {},
): ProjectTemplateSummary {
  const project = loadProject(projectId);
  if (!project) throw new Error("project not found");

  const name = cleanDisplayName(input.name, project.title);
  const id = newTemplateId(name);
  ensureDir(PROJECT_TEMPLATES_DIR);
  const finalDir = templateDir(id);
  if (!finalDir) throw new Error("invalid template id");
  const tempDir = `${finalDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  ensureDir(path.join(tempDir, "references"));
  ensureDir(path.join(tempDir, "brand-assets"));

  try {
    const referenceSlides: TemplateAsset[] = [];
    for (const page of project.pages.filter((item) => item.image).slice(0, 6)) {
      if (!page.image || !MATERIAL_FILE_RE.test(page.image)) continue;
      const source = path.join(projectDir(project.id), page.image);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const ext = path.extname(page.image).toLowerCase() || ".png";
      const file = `references/slide-${String(referenceSlides.length + 1).padStart(2, "0")}${ext}`;
      fs.copyFileSync(source, path.join(tempDir, file));
      referenceSlides.push({
        file,
        name: `${project.title} · slide ${page.index}${ext}`,
        mimeType: mimeFor(page.image),
      });
    }

    const brandAssets: TemplateAsset[] = [];
    const brandIds = new Set(project.config.designSystem?.brand.assetMaterialIds ?? []);
    for (const material of (project.materials ?? []).filter((item) => brandIds.has(item.id))) {
      if (!MATERIAL_FILE_RE.test(material.file)) continue;
      const source = path.join(projectDir(project.id), "materials", material.file);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const ext = path.extname(material.name || material.file).toLowerCase();
      const file = `brand-assets/asset-${String(brandAssets.length + 1).padStart(2, "0")}${ext || ".bin"}`;
      fs.copyFileSync(source, path.join(tempDir, file));
      brandAssets.push({
        file,
        name: material.name,
        mimeType: material.mimeType ?? mimeFor(material.name),
        sourceMaterialId: material.id,
      });
    }

    const now = new Date().toISOString();
    const record: ProjectTemplateRecord = {
      version: 1,
      id,
      name,
      description: cleanDescription(input.description),
      sourceProjectId: project.id,
      sourceProjectTitle: project.title,
      createdAt: now,
      updatedAt: now,
      aspect: project.config.aspect,
      resolution: project.config.resolution,
      style: project.config.style,
      baseTemplateId: project.config.template,
      designSystem: project.config.designSystem ? clone(project.config.designSystem) : undefined,
      referenceCount: referenceSlides.length,
      brandAssetCount: brandAssets.length,
      referenceSlides,
      brandAssets,
    };
    fs.writeFileSync(path.join(tempDir, "template.json"), JSON.stringify(record, null, 2), "utf8");
    fs.renameSync(tempDir, finalDir);
    return summary(record);
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export function deleteProjectTemplate(id: string): boolean {
  const dir = templateDir(id);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function readProjectTemplateCover(id: string): { bytes: Buffer; mimeType: string; name: string } | null {
  const record = loadProjectTemplate(id);
  const dir = templateDir(id);
  const cover = record?.referenceSlides[0];
  if (!record || !dir || !cover) return null;
  const file = path.resolve(dir, cover.file);
  if (!file.startsWith(`${dir}${path.sep}`) || !fs.existsSync(file)) return null;
  return { bytes: fs.readFileSync(file), mimeType: cover.mimeType, name: cover.name };
}

/** Merge project-template defaults before scenario and request overrides finish. */
export function projectTemplateDefaults(id: string | undefined): Partial<PptConfig> {
  if (!id) return {};
  const record = loadProjectTemplate(id);
  if (!record) return {};
  return {
    projectTemplateId: record.id,
    aspect: record.aspect,
    resolution: record.resolution,
    style: record.style,
    template: record.baseTemplateId,
    designSystem: record.designSystem ? clone(record.designSystem) : undefined,
  };
}

function safeTemplateAsset(record: ProjectTemplateRecord, asset: TemplateAsset) {
  const dir = templateDir(record.id);
  if (!dir) return null;
  const source = path.resolve(dir, asset.file);
  return source.startsWith(`${dir}${path.sep}`) && fs.existsSync(source) && fs.statSync(source).isFile()
    ? source
    : null;
}

/**
 * Copy visual references and brand assets into a concrete project. The ids are
 * deterministic, making the operation safe to retry after a server reload.
 */
export function applyProjectTemplateAssets(project: Project): Project {
  const record = loadProjectTemplate(project.config.projectTemplateId ?? "");
  if (!record) return project;

  const token = record.id.slice(-26).replace(/[^a-zA-Z0-9_-]/g, "");
  const materialsDir = path.join(projectDir(project.id), "materials");
  const visibleDir = path.join(projectDir(project.id), "files", "uploaded", "project-template", slugify(record.name));
  ensureDir(materialsDir);
  ensureDir(visibleDir);
  const materials = [...(project.materials ?? [])];
  const contexts = [...(project.config.materialContexts ?? [])];
  const existingIds = new Set(materials.map((item) => item.id));
  const brandIdMap = new Map<string, string>();

  const copyAsset = (
    asset: TemplateAsset,
    kind: "reference" | "brand",
    index: number,
  ): string | null => {
    const source = safeTemplateAsset(record, asset);
    if (!source) return null;
    const ext = path.extname(asset.name || asset.file).toLowerCase() || path.extname(asset.file) || ".bin";
    const id = `tpl-${token}-${kind}-${index + 1}${ext}`;
    const file = `mat-${id}`;
    const visibleName = `${kind}-${String(index + 1).padStart(2, "0")}${ext}`;
    const visible = path.join(visibleDir, visibleName);
    if (!fs.existsSync(path.join(materialsDir, file))) fs.copyFileSync(source, path.join(materialsDir, file));
    if (!fs.existsSync(visible)) fs.copyFileSync(source, visible);
    if (!existingIds.has(id)) {
      const material: MaterialRecord = {
        id,
        name: asset.name,
        file,
        designFilePath: path.relative(path.join(projectDir(project.id), "files"), visible).split(path.sep).join("/"),
        kind: asset.mimeType.startsWith("image/") ? "image" : "file",
        mimeType: asset.mimeType,
        size: fs.statSync(source).size,
        role: "template",
      };
      materials.push(material);
      existingIds.add(id);
    }
    if (!contexts.some((item) => item.id === id)) {
      contexts.push({
        id,
        name: asset.name,
        role: kind === "brand" ? "Project template brand asset" : "Project template visual reference",
      });
    }
    return id;
  };

  record.referenceSlides.forEach((asset, index) => copyAsset(asset, "reference", index));
  record.brandAssets.forEach((asset, index) => {
    const id = copyAsset(asset, "brand", index);
    if (id && asset.sourceMaterialId) brandIdMap.set(asset.sourceMaterialId, id);
  });

  project.materials = materials;
  project.config.materialIds = materials.map((item) => item.id);
  project.config.materialContexts = contexts.slice(0, 24);
  if (project.config.designSystem) {
    const designSystem: DeckDesignSystem = clone(project.config.designSystem);
    designSystem.brand.assetMaterialIds = designSystem.brand.assetMaterialIds.flatMap((id) => {
      const mapped = brandIdMap.get(id);
      if (mapped) return [mapped];
      return existingIds.has(id) ? [id] : [];
    });
    project.config.designSystem = designSystem;
  }
  return project;
}


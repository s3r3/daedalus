import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
// Dae Captain v2 Fase 7 — chat cards: decompose plans, approval UndoStore,
// and the v2 run timeline, surfaced through additive /captain/* routes.
// Deep imports (not the barrel) mirror server/src/research.ts style.
import { planTask, type TaskPlan, type SubTask } from "@daedalus/core/workflow/decompose.ts";
import { UndoStore, type Action as WorkflowAction } from "@daedalus/core/workflow/approval.ts";
import { getEvents, type AnyTimelineEvent } from "@daedalus/core/workflow/timeline.ts";
import { exportDocumentMarkdown } from "@daedalus/core/dokumen/export-md.ts";
import {
  EventBus,
  McpManager,
  PROVIDER_PRESETS,
  ProviderRegistryStore,
  TaskStore,
  TaskRunner,
  createLogger,
  createProviderForConfig,
  emitEvent,
  loadAgents,
  loadLspConfig,
  withDefaultLspServers,
  loadPins,
  loadProjectRules,
  loadMcpConfig,
  loadSettings,
  loadSkillConfig,
  loadSkillInventory,
  setSkillDisabled,
  parseModelStrategy,
  normalizeModelList,
  normalizeRoleModelConfig,
  redactSettings,
  resolveDaedalusHome,
  reviewDiff,
  savePins,
  seedProviderFromSettings,
  unstagedDiff,
  workspaceAgentsDir,
  ensureBundledSkillsInstalled,
  resolveSkillSearchDirs,
  resolveThinkingLevel,
  MAX_PPTX_TEMPLATE_BYTES,
  PptxTemplateError,
  applyPptxTemplateTheme,
  deckPaths,
  deletePptxTemplate,
  exportDeckToPptx,
  getBuiltinTemplate,
  getPptxTemplate,
  getSlideTemplate,
  builtinDeckTheme,
  listBuiltinTemplates,
  listPptxTemplates,
  listSlideTemplates,
  pourDeckIntoTemplate,
  readPptxTemplateAsset,
  readPptxTemplateBackground,
  savePptxTemplate,
  newSlideId,
  readDeck,
  readActiveDocument,
  writeDocument,
  documentPaths,
  readParsedBlocks,
  readAudit,
  appendAudit,
  sourceFilePath,
  ingestSourceFile,
  parseSourceFile,
  writeParsedBlocks,
  saveSchema,
  listSavedSchemas,
  archiveActiveDocument,
  createActiveDocument,
  exportData,
  exportDocumentDocx,
  exportDocumentPdf,
  inspectDocxStyles,
  proposeStyleOps,
  parseStyleInstruction,
  parseToolRules,
  applyStyleOps,
  validateRecord,
  isSupportedSource,
  type DokumenTaskParams,
  type DocumentState,
  type DomainModelSettings,
  validateDeck,
  writeDeck,
  readWorkbook,
  writeWorkbook,
  validateWorkbook,
  listWorkbookCheckpoints,
  restoreWorkbookCheckpoint,
  verifyWorkbook,
  workbookPaths,
  exportWorkbookToXlsx,
  exportWorkbookCsv,
  exportSheetToCsvText,
  importCsvToWorkbook,
  importXlsxToWorkbook,
  probeSheetSidecar,
  type WorkbookSpec,
  type DeckSpec,
  type Slide,
  type SlideTaskParams,
  type AgentMode,
  type ApprovalDecision,
  type Attachment,
  type Event,
  type FinalReport,
  type ModelStrategy,
  type PermissionKey,
  type Settings,
  type SkillOrigin,
  type TaskDomain,
  type ThinkingLevel,
  type ToolRules,
  type ArtifactRef,
  type ContentBlock,
  type LayerBResult,
  type LLMProvider,
  type Message,
  type ProviderConfig,
  type RunContext,
  type RunTurn,
  type WorkflowEngine,
  WORKFLOW_ENGINES,
  RULE_CONFIDENCE_THRESHOLD,
  WorkflowRunStore,
  appendTurn,
  buildLayerBPrompt,
  createWorkflowRun,
  formatResolvedForGoal,
  isConversationalMessage,
  isWorkflowEngine,
  lastTurn,
  parseLayerBResponse,
  resolveReferences,
  routeByRules,
  translateArtifacts,
  updateTurn,
} from "@daedalus/core";
import { collectRoots, listDirectory, listFilesFlat, listPlanDocuments, buildTree, resolveInside, MAX_FILE_BYTES, IMAGE_MEDIA_TYPES, MAX_IMAGE_FILE_BYTES } from "./workspace.ts";
import { classifyWebIntent, executeFastPath, resolveFastPathProvider } from "./fast-path.ts";
import { gitStatus, revertFileToHead } from "./git-status.ts";
import {
  ConversationStore,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  historyMessages,
  priorContextSection,
  recentTurns,
  taskSummaryText,
  type Conversation,
  type ConversationTurn,
} from "./conversations.ts";
import { TerminalError, TerminalManager } from "./terminals.ts";
import { UPLOAD_LIMITS, extractZipEntries, guessMimeType, parseMultipart, sanitizeRelativePath, type UploadPart } from "./uploads.ts";
import { SlidePreviewService, convertPptxToPdf, SofficeMissingError } from "./slide-preview.ts";
import { SheetPreviewService } from "./sheet-preview.ts";
import { DokumenPreviewService, type DocPreviewKind } from "./dokumen-preview.ts";
import {
  analysisProviderFromRequest,
  analysisVerifyIssues,
  peekStagedAnalysisPlan,
  resolveAnalysisHooks,
  stageAnalysisPlan,
  takeStagedAnalysisPlan,
  type AnalysisCoreHooks,
  type AnalysisDataset,
} from "./sheets-analyze.ts";
import {
  appendResearchProgress,
  defaultResearchDocHooks,
  finishResearchRun,
  getResearchProgress,
  getResearchReport,
  getResearchRunReportId,
  getResearchSourceContent,
  getResearchSourceDocument,
  isResearchRunInProgress,
  peekStagedResearchPlan,
  rememberResearchRunReport,
  researchProviderFromRequest,
  researchVerifyIssues,
  resolveResearchHooks,
  stageResearchPlan,
  storeResearchReport,
  takeStagedResearchPlan,
  tryStartResearchRun,
  type ResearchCoreHooks,
  type ResearchDocHooks,
} from "./research.ts";

/**
 * Dae Captain v2 Fase 7 — chat cards (additive state, server-process-local).
 *
 * - Staged task plans: planTask() (core/src/workflow/decompose.ts) splits a
 *   multi-engine goal; the plan waits for the card's [Jalankan] before any
 *   sub-task is dispatched. 30-minute TTL, same as staged research plans.
 * - Undo stores: one bounded UndoStore (core/src/workflow/approval.ts) per
 *   daedalus home. Route-level mutations (slide deck, dokumen sections)
 *   record the pre-change bytes; POST /captain/undo/apply restores them.
 */
type StagedTaskPlan = {
  plan: TaskPlan;
  runId: string;
  workspaceRoot: string;
  createdAt: number;
  execution?: CaptainPlanExecution;
};

/** Live state of one plan execution (polled by the chat card). */
type CaptainPlanExecution = {
  status: "executing" | "done" | "done_with_failures";
  startedAt: string;
  finishedAt?: string;
  subTasks: Array<{
    sub_id: string;
    engine: string;
    goal: string;
    dependsOn: string[];
    task_id: string | null;
    status: "waiting" | "running" | "done" | "failed" | "skipped";
    error?: string;
    /** Short producer note threaded into consumer sub-task goals. */
    resultNote?: string;
  }>;
};
const STAGED_TASK_PLAN_TTL_MS = 30 * 60 * 1000;
const stagedTaskPlans = new Map<string, StagedTaskPlan>();

function sweepStagedTaskPlans(now: number = Date.now()): void {
  for (const [id, staged] of stagedTaskPlans) {
    if (now - staged.createdAt >= STAGED_TASK_PLAN_TTL_MS) stagedTaskPlans.delete(id);
  }
}

const undoStores = new Map<string, UndoStore>();
function undoStoreFor(daedalusHome: string): UndoStore {
  let store = undoStores.get(daedalusHome);
  if (!store) {
    store = new UndoStore({ backupDir: join(daedalusHome, "undo") });
    undoStores.set(daedalusHome, store);
  }
  return store;
}

/**
 * Snapshot the pre-change bytes of a route-level mutation into the
 * approval UndoStore. Never throws: a failed snapshot is logged and the
 * mutation proceeds — undo is then honestly unavailable (404) rather
 * than half-recorded.
 */
function recordCaptainUndo(input: {
  ctx: AppContext;
  root: string;
  runId?: unknown;
  action: WorkflowAction;
  target: string;
  content: string | Uint8Array;
}): void {
  const home = resolveDaedalusHome(input.ctx.settings.daedalusHome, input.root);
  const runId =
    typeof input.runId === "string" && input.runId.trim() ? input.runId.trim() : "chat";
  try {
    undoStoreFor(home).record(runId, input.action, {
      target: input.target,
      content: input.content,
    });
  } catch (error) {
    input.ctx.log.warn("captain undo snapshot failed", {
      error: String(error),
      target: input.target,
    });
  }
}
/**
 * REST + WebSocket gateway (PLAN.md §3.0, §3.6). Commands and reads only —
 * no agent, tool, or LLM logic lives here; the core owns execution.
 */

export type SessionState = {
  mode: AgentMode;
  autoApprove: boolean;
  thinking: boolean;
  /**
   * Reasoning-effort tier (settings layer 2). The deprecated `thinking`
   * boolean is kept for backward compat: thinking=false maps to 'off'
   * when no explicit level was set (core resolveThinkingLevel semantics).
   */
  thinkingLevel: ThinkingLevel;
  providerId?: string;
  model?: string;
  workspaceRoot: string;
  /**
   * Engines the user switched off (Dae Captain "Agentic Systems" toggles).
   * The workflow router never auto-routes to a disabled engine; an explicit
   * override targeting one is rejected. Empty/undefined = all enabled.
   */
  disabledEngines?: WorkflowEngine[];
};

/** One skill in the inventory payload: the collision winner, or a shadowed copy marked with the winner's origin. */
export type ExtensionSkill = {
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Disabled for this workspace via .daedalus/skills.json (same config the CLI writes). */
  disabled: boolean;
  /** Origin of the winning copy with the same name, when this copy is shadowed. */
  shadowedBy?: SkillOrigin;
};

export type ExtensionStatus = {
  root: string;
  mcp: Array<{ name: string; connected: boolean; toolCount: number; error?: string }>;
  skills: ExtensionSkill[];
  agents: Array<{ name: string; description: string; model?: string; mode?: string; tools?: string[] }>;
  lsp: Array<{ name: string; extensions: string[]; configured: boolean; running?: boolean; error?: string; auto?: boolean }>;
  problems: string[];
};

export type AppContext = {
  bus: EventBus;
  store: TaskStore;
  log: ReturnType<typeof createLogger>;
  startedAt: number;
  cwd: string;
  activeRunners: Map<string, TaskRunner>;
  /**
   * Session-scoped remembered approvals (pattern key → decision), shared by
   * every runner this server creates. In-memory only: restarting the
   * server forgets every remembered grant.
   */
  approvalMemory: Map<string, ApprovalDecision>;
  /**
   * Interactive terminal sessions (user shells + per-workspace agent sink).
   * Server-process state: sessions survive page reloads, die with the server.
   */
  terminals: TerminalManager;
  settings: Settings;
  providerStore: ProviderRegistryStore;
  session: SessionState;
  workspaces: Set<string>;
  providersReady?: Promise<void>;
  /** Local daemon token for sensitive endpoints (approve/cancel). */
  daemonToken?: string;
  webDist?: string;
  extensionStatusCache?: Map<string, { expiresAt: number; value: ExtensionStatus }>;
  /** Memoized taskStores() result (see TASK_STORES_CACHE_MS). */
  taskStoresCache?: { expiresAt: number; stores: TaskStore[] };
  /** Per-task summary memo, keyed by a stat fingerprint of the task's files (see summarizeFrom). */
  taskSummaryCache?: Map<string, { fingerprint: string; summary: Record<string, unknown> }>;
  /** Pratinjau Asli renderer (raster preview of the exported deck; LibreOffice, or PowerPoint on Windows); tests inject a fake-backed service. */
  slidePreview?: SlidePreviewService;
  /** Pratinjau renderer (raster preview of the exported workbook; Excel on Windows, or LibreOffice); tests inject a fake-backed service. */
  sheetPreview?: SheetPreviewService;
  /** Dokumen Pratinjau renderer (raster preview of the composed/re-laid-out DOCX; Word on Windows, else LibreOffice); tests inject a fake-backed service. */
  dokumenPreview?: DokumenPreviewService;
  /**
   * Mode Analis (Agentic Spreadsheet): seam to the core analysis contract
   * (profileWorkbook / classifyAnalysisIntent / generateAnalysisPlan /
   * SpreadsheetEngine.runAnalysis). Production resolves lazy core imports;
   * tests inject fakes here.
   */
  analysisHooks?: AnalysisCoreHooks;
  /**
   * Agentic Research: seam to the core research contract
   * (planResearch / ResearchEngine.runResearch / searchWeb / fetchPage).
   * Production resolves lazy core imports; tests inject fakes here.
   */
  researchHooks?: ResearchCoreHooks;
  /**
   * Agentic Research: seam dokumen → PDF untuk preview ala pembaca PDF
   * (fetchBytes / officeToPdf / htmlToPdf). Production pakai tool asli
   * (fetch, LibreOffice, Chromium); tests inject fakes here.
   */
  researchDocHooks?: ResearchDocHooks;
};

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const settings = overrides.settings ?? loadSettings();
  const cwd = overrides.cwd ?? process.cwd();
  // The daemon launcher anchors the session to the directory `daedalus`
  // was invoked in (DAEDALUS_WORKSPACE); the server process cwd is only
  // the fallback. An explicit session override still wins.
  const anchoredWorkspace = process.env.DAEDALUS_WORKSPACE ? resolve(process.env.DAEDALUS_WORKSPACE) : cwd;
  const session: SessionState = overrides.session ?? {
    mode: "auto",
    autoApprove: false,
    thinking: settings.session?.thinking ?? true,
    // Boot default honors the env: an explicit DAEDALUS_THINKING_LEVEL
    // wins; legacy DAEDALUS_THINKING=false maps to 'off'; else 'medium'.
    thinkingLevel: resolveThinkingLevel({ thinking: settings.session?.thinking }, settings.session?.thinkingLevel ?? "medium"),
    workspaceRoot: anchoredWorkspace,
  };
  return {
    bus: overrides.bus ?? new EventBus(),
    store: overrides.store ?? new TaskStore(resolveDaedalusHome(settings.daedalusHome, anchoredWorkspace)),
    log: overrides.log ?? createLogger({ base: { service: "daedalus-server" } }),
    startedAt: overrides.startedAt ?? Date.now(),
    cwd,
    activeRunners: overrides.activeRunners ?? new Map<string, TaskRunner>(),
    approvalMemory: overrides.approvalMemory ?? new Map<string, ApprovalDecision>(),
    terminals: overrides.terminals ?? new TerminalManager(),
    settings,
    providerStore: overrides.providerStore ?? new ProviderRegistryStore(resolveDaedalusHome(settings.daedalusHome, anchoredWorkspace)),
    session,
    workspaces: overrides.workspaces ?? new Set<string>([resolve(cwd), resolve(session.workspaceRoot)]),
    webDist: overrides.webDist,
    extensionStatusCache: overrides.extensionStatusCache ?? new Map(),
    slidePreview: overrides.slidePreview,
    sheetPreview: overrides.sheetPreview,
    dokumenPreview: overrides.dokumenPreview,
    analysisHooks: overrides.analysisHooks,
    researchHooks: overrides.researchHooks,
    researchDocHooks: overrides.researchDocHooks,
  };
}

export async function ensureProvidersLoaded(ctx: AppContext): Promise<void> {
  ctx.providersReady ??= (async () => {
    await ctx.providerStore.load(seedProviderFromSettings(ctx.settings));
  })();
  await ctx.providersReady;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), ...CORS_HEADERS });
  res.end(data);
}

const WEB_API_PREFIXES = ["/health", "/settings", "/session", "/providers", "/models", "/tasks", "/workflow", "/workspace", "/slides", "/dokumen", "/sheets", "/uploads", "/upload", "/attachments", "/extensions", "/review", "/terminals"];

function webContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function webDistPath(ctx: AppContext): string | undefined {
  const candidates = [
    ctx.webDist ? resolve(ctx.webDist) : undefined,
    join(resolve(ctx.cwd), "daedalus-web", "dist"),
    fileURLToPath(new URL("../../daedalus-web/dist/", import.meta.url)),
    join(resolve(ctx.cwd), "dist"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      if (statSync(join(candidate, "index.html")).isFile()) return resolve(candidate);
    } catch { /* try next candidate */ }
  }
  return undefined;
}

function serveWebAsset(ctx: AppContext, res: ServerResponse, pathname: string, accept = ""): boolean {
  // API paths never serve the app shell — except a BARE prefix that is
  // also a domain page route ('/dokumen' the page vs '/dokumen/...' the
  // API): a browser navigation there (Accept: text/html) wants the SPA.
  const isApiPath = WEB_API_PREFIXES.some(
    (prefix) => pathname.startsWith(`${prefix}/`) || (pathname === prefix && !accept.includes("text/html")),
  );
  if (isApiPath) return false;
  const dist = webDistPath(ctx);
  if (!dist) return false;

  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return false;
  }
  if (!relative) relative = "index.html";

  let absolute = resolve(dist, relative);
  if (absolute !== dist && !absolute.startsWith(dist + sep)) return false;
  try {
    if (!statSync(absolute).isFile()) {
      if (extname(relative) || !accept.includes("text/html")) return false;
      absolute = join(dist, "index.html");
    }
  } catch {
    // SPA fallback: browser navigations to extensionless routes get the app shell.
    if (extname(relative) || !accept.includes("text/html")) return false;
    absolute = join(dist, "index.html");
  }

  try {
    const data = readFileSync(absolute);
    res.writeHead(200, { "content-type": webContentType(absolute), "content-length": data.length, "cache-control": "no-store", ...CORS_HEADERS });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolveBody(body));
    req.on("error", rejectBody);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse((await readBody(req)) || "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readRawBody(req: IncomingMessage, maxBytes = UPLOAD_LIMITS.maxTotalBytes): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`request body too large (limit ${maxBytes} bytes)`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

const AGENT_MODES: AgentMode[] = ["ask", "manual", "auto", "plan"];

function parseMode(value: unknown): AgentMode | undefined {
  // The retired `orchestrator` mode maps to auto so legacy clients keep
  // working; anything else unknown is left undefined for the caller.
  if (value === "orchestrator") return "auto";
  return typeof value === "string" && AGENT_MODES.includes(value as AgentMode) ? (value as AgentMode) : undefined;
}

function allowedRoots(ctx: AppContext): string[] {
  const roots = new Set<string>();
  roots.add(resolve(ctx.cwd));
  roots.add(resolve(ctx.session.workspaceRoot));
  for (const workspace of ctx.workspaces) roots.add(resolve(workspace));
  for (const recorded of recordedRoots(ctx)) roots.add(resolve(recorded));
  return [...roots];
}

function isInside(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}

function resolveAllowedRoot(ctx: AppContext, rootValue: unknown): string {
  const candidate = resolve(typeof rootValue === "string" && rootValue.length > 0 ? rootValue : ctx.session.workspaceRoot || ctx.cwd);
  if (allowedRoots(ctx).some((root) => isInside(root, candidate) || isInside(candidate, root) && candidate === root)) return candidate;
  // A created workspace is allowed because create routes record it in ctx.workspaces;
  // arbitrary filesystem roots are not exposed by this local gateway.
  throw new Error("workspace root is not allowed");
}

function recordWorkspace(ctx: AppContext, absolute: string): void {
  const resolved = resolve(absolute);
  ctx.workspaces.add(resolved);
  ctx.session.workspaceRoot = resolved;
}

function resolveTaskRepo(ctx: AppContext, repoValue: unknown): string {
  if (typeof repoValue !== "string" || repoValue.length === 0) return resolveAllowedRoot(ctx, ctx.session.workspaceRoot);
  const candidate = resolve(ctx.cwd, repoValue);
  if (isInside(ctx.cwd, candidate)) return candidate;
  if (allowedRoots(ctx).some((root) => candidate === root)) return candidate;
  throw new Error("repo_path is outside the allowed workspace roots");
}

function publicSession(ctx: AppContext): SessionState {
  return { ...ctx.session };
}

function attachmentFromStored(options: {
  taskId?: string;
  root: string;
  absolute: string;
  name: string;
  kind: Attachment["kind"];
  mimeType?: string;
  data: Buffer;
}): Attachment {
  return {
    id: crypto.randomUUID(),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    workspacePath: options.absolute.startsWith(resolve(options.root) + sep) ? options.absolute.slice(resolve(options.root).length + 1) : basename(options.absolute),
    name: options.name,
    kind: options.kind,
    mimeType: options.mimeType ?? guessMimeType(options.name),
    size: options.data.length,
    sha256: createHash("sha256").update(options.data).digest("hex"),
    createdAt: new Date().toISOString(),
    path: options.absolute,
  };
}

function emitAttachment(ctx: AppContext, attachment: Attachment): void {
  if (!attachment.taskId) return;
  emitEvent({ bus: ctx.bus, store: ctx.store }, attachment.taskId, undefined, "ATTACHMENT_ADDED", { attachment });
  void ctx.bus.drain();
}

function errorStatus(error: unknown): number {
  const message = errorMessage(error);
  if (/not allowed|outside the allowed|escapes workspace/.test(message)) return 403;
  if (/too large|too many|limit/.test(message)) return 413;
  if (/not found|no such file|ENOENT/.test(message)) return 404;
  return 400;
}

function nextMode(current: AgentMode): AgentMode {
  const index = AGENT_MODES.indexOf(current);
  return AGENT_MODES[(index + 1 + AGENT_MODES.length) % AGENT_MODES.length] as AgentMode;
}

/** Valid reasoning-effort tiers for `thinkingLevel` (mirrors core's THINKING_LEVELS). */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

function applySessionUpdate(ctx: AppContext, parsed: Record<string, unknown>): void {
  const mode = parseMode(parsed.mode);
  if (parsed.mode !== undefined && !mode) throw new Error(`invalid mode: ${String(parsed.mode)}`);
  if (mode) ctx.session.mode = mode;
  if (parsed.autoApprove !== undefined) {
    if (typeof parsed.autoApprove !== "boolean") throw new Error("autoApprove must be a boolean");
    ctx.session.autoApprove = parsed.autoApprove;
  }
  // Reasoning-effort tier (settings layer 2): an explicit level wins; the
  // deprecated `thinking` boolean stays accepted and maps false → 'off'
  // only when no level was given (core resolveThinkingLevel semantics).
  const levelRaw = parsed.thinkingLevel ?? parsed.thinking_level;
  let thinkingLevel: ThinkingLevel | undefined;
  if (levelRaw !== undefined) {
    if (typeof levelRaw !== "string" || !(THINKING_LEVELS as readonly string[]).includes(levelRaw)) {
      throw new Error("invalid_thinking_level");
    }
    thinkingLevel = levelRaw as ThinkingLevel;
  }
  if (parsed.thinking !== undefined) {
    if (typeof parsed.thinking !== "boolean") throw new Error("thinking must be a boolean");
    ctx.session.thinking = parsed.thinking;
    if (ctx.settings.session) ctx.settings.session.thinking = parsed.thinking;
    else (ctx.settings as { session?: { thinking: boolean } }).session = { thinking: parsed.thinking };
    if (thinkingLevel === undefined && !parsed.thinking) thinkingLevel = "off";
  }
  if (thinkingLevel !== undefined) {
    ctx.session.thinkingLevel = thinkingLevel;
    if (ctx.settings.session) ctx.settings.session.thinkingLevel = thinkingLevel;
  }
  if (typeof parsed.providerId === "string") ctx.session.providerId = parsed.providerId;
  if (typeof parsed.provider_id === "string") ctx.session.providerId = parsed.provider_id;
  if (typeof parsed.model === "string") ctx.session.model = parsed.model;
  // Dae Captain "Agentic Systems" toggles: engines the router must skip.
  // Additive and validated — unknown engine names are rejected, never ignored.
  const disabledRaw = parsed.disabledEngines ?? parsed.disabled_engines;
  if (disabledRaw !== undefined) {
    if (!Array.isArray(disabledRaw) || !disabledRaw.every(isWorkflowEngine)) {
      throw new Error("disabledEngines must be an array of engine names");
    }
    ctx.session.disabledEngines = [...disabledRaw] as WorkflowEngine[];
  }
  if (typeof parsed.workspaceRoot === "string") recordWorkspace(ctx, resolveAllowedRoot(ctx, parsed.workspaceRoot));
  if (typeof parsed.workspace_root === "string") recordWorkspace(ctx, resolveAllowedRoot(ctx, parsed.workspace_root));
}

function applySettingsUpdate(ctx: AppContext, parsed: Record<string, unknown>): void {
  applySessionUpdate(ctx, parsed);
  const session = typeof parsed.session === "object" && parsed.session !== null ? (parsed.session as Record<string, unknown>) : undefined;
  if (session) applySessionUpdate(ctx, session);
  // Tailor-suite toggles (review gate / routing / escalation): process-local
  // like the session thinking flag; env vars set the boot defaults.
  const tailor = typeof parsed.tailor === "object" && parsed.tailor !== null ? (parsed.tailor as Record<string, unknown>) : undefined;
  if (tailor) {
    if (typeof tailor.reviewGate === "boolean") ctx.settings.tailor.reviewGate = tailor.reviewGate;
    if (typeof tailor.review_gate === "boolean") ctx.settings.tailor.reviewGate = tailor.review_gate;
    if (typeof tailor.modelRouting === "boolean") ctx.settings.tailor.modelRouting = tailor.modelRouting;
    if (typeof tailor.qualityEscalation === "boolean") ctx.settings.tailor.qualityEscalation = tailor.qualityEscalation;
    if (typeof tailor.earlyEscalation === "boolean") ctx.settings.tailor.earlyEscalation = tailor.earlyEscalation;
    if (typeof tailor.early_escalation === "boolean") ctx.settings.tailor.earlyEscalation = tailor.early_escalation;
  }
  // Command-output compression (core RTK-style filters): process-local
  // like the tailor toggles; DAEDALUS_OUTPUT_COMPRESSION sets the default.
  if (typeof parsed.outputCompression === "boolean") ctx.settings.outputCompression = parsed.outputCompression;
  if (typeof parsed.output_compression === "boolean") ctx.settings.outputCompression = parsed.output_compression;
  // Global LLM preferences (settings layer 1). Everything below is
  // process-local like the tailor toggles above: env vars
  // (LLM_TEMPERATURE, DAEDALUS_PROMPT_CACHING, LLM_MODELS,
  // LLM_MODEL_STRATEGY, DAEDALUS_DOMAIN_<DOMAIN>_*) set the boot
  // defaults; these updates only change the running process.
  const llm = typeof parsed.llm === "object" && parsed.llm !== null ? (parsed.llm as Record<string, unknown>) : undefined;
  if (llm) {
    if (typeof llm.baseUrl === "string") ctx.settings.llm.baseUrl = llm.baseUrl;
    if (typeof llm.base_url === "string") ctx.settings.llm.baseUrl = llm.base_url;
    if (typeof llm.model === "string") {
      ctx.settings.llm.model = llm.model;
      ctx.session.model = llm.model;
    }
    if (llm.temperature !== undefined) ctx.settings.llm.temperature = parseLlmTemperature(llm.temperature);
    const llmPromptCaching = llm.promptCaching ?? llm.prompt_caching;
    if (typeof llmPromptCaching === "boolean") ctx.settings.llm.promptCaching = llmPromptCaching;
    if (llm.models !== undefined) ctx.settings.llm.models = parseLlmModels(llm.models);
    const llmStrategy = llm.modelStrategy ?? llm.model_strategy;
    if (llmStrategy !== undefined) ctx.settings.llm.modelStrategy = parseLlmModelStrategy(llmStrategy);
  }
  // Flat snake_case aliases for the nested llm.* keys (the Web settings
  // form sends these); nested keys apply first, flat keys win on conflict.
  if (parsed.llm_temperature !== undefined) ctx.settings.llm.temperature = parseLlmTemperature(parsed.llm_temperature);
  if (typeof parsed.llm_prompt_caching === "boolean") ctx.settings.llm.promptCaching = parsed.llm_prompt_caching;
  if (parsed.llm_models !== undefined) ctx.settings.llm.models = parseLlmModels(parsed.llm_models);
  if (parsed.llm_model_strategy !== undefined) ctx.settings.llm.modelStrategy = parseLlmModelStrategy(parsed.llm_model_strategy);
  // Per-domain model overrides (settings layer 1): every field unset =
  // follow the global setting; merged per domain, never wholesale-replaced.
  const domainsRaw = parsed.domains ?? parsed.domain_settings;
  if (domainsRaw !== undefined) applyDomainSettingsUpdate(ctx, domainsRaw);
  // Global default max iterations (settings layer 1): a positive int sets
  // it, explicit null clears back to the built-in 25, anything else 400s.
  // Precedence per run: per-task > domain override > this global > 25.
  const maxIterationsRaw = parsed.maxIterations !== undefined ? parsed.maxIterations : parsed.max_iterations;
  if (maxIterationsRaw !== undefined) {
    if (maxIterationsRaw === null) delete ctx.settings.maxIterations;
    else if (typeof maxIterationsRaw !== "number" || !Number.isInteger(maxIterationsRaw) || maxIterationsRaw < 1 || maxIterationsRaw > 100) {
      throw new Error("invalid_max_iterations");
    } else ctx.settings.maxIterations = maxIterationsRaw;
  }
  // Model per peran — 2 tier (Dae Captain v2, Fase 5): additive; string kosong
  // = unset (ikut default). Non-object 400s.
  const modelRolesRaw = parsed.modelRoles !== undefined ? parsed.modelRoles : parsed.model_roles;
  if (modelRolesRaw !== undefined) {
    ctx.settings.modelRoles = parseModelRoles(modelRolesRaw);
  }
  if (typeof parsed.model === "string") ctx.session.model = parsed.model;
  if (typeof parsed.providerId === "string") ctx.session.providerId = parsed.providerId;
  if (typeof parsed.provider_id === "string") ctx.session.providerId = parsed.provider_id;
}

/**
 * `modelRoles` / `model_roles`: object `{ default?, strong?, light? }` dengan
 * string model ID; string kosong = unset. Non-object → named 400.
 */
function parseModelRoles(value: unknown): { default: string; strong?: string; light?: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_model_roles");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "default" && key !== "strong" && key !== "light") throw new Error("invalid_model_roles");
    if (record[key] !== undefined && typeof record[key] !== "string") throw new Error("invalid_model_roles");
  }
  return normalizeRoleModelConfig(record);
}

/** `llm.temperature`: a finite number in 0..2, else a named 400. */
function parseLlmTemperature(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new Error("invalid_temperature");
  }
  return value;
}

/** `llm.models`: comma-separated string or string[] → normalized non-empty list, else a named 400. */
function parseLlmModels(value: unknown): string[] {
  const list = typeof value === "string" ? value : Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
  const models = list === undefined ? [] : normalizeModelList(list);
  if (models.length === 0) throw new Error("invalid_llm_models");
  return models;
}

/**
 * `llm.modelStrategy`: only 'failover' exists; core's parseModelStrategy
 * coerces legacy 'round-robin' to 'failover' (migration, no error);
 * anything else is a named 400.
 */
function parseLlmModelStrategy(value: unknown): ModelStrategy {
  if (typeof value !== "string") throw new Error("invalid_model_strategy");
  try {
    return parseModelStrategy(value, "llm_model_strategy");
  } catch {
    throw new Error("invalid_model_strategy");
  }
}

/** Valid per-domain override keys (core TaskDomain). */
const DOMAIN_SETTINGS_KEYS: readonly TaskDomain[] = ["coding", "slide", "spreadsheet", "dokumen"];

/**
 * `domains` / `domain_settings`: per-domain `{ model?, temperature?,
 * maxIterations? }` overrides merged into `ctx.settings.domains`.
 * An empty-string model OR explicit null unsets the override
 * (follow-global); null likewise clears temperature/maxIterations.
 * Unknown domain keys, non-object values, and out-of-range numbers are
 * named 400s.
 */
function applyDomainSettingsUpdate(ctx: AppContext, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_domain_settings");
  // Partial test fixtures may omit the domains store; loadSettings always provides it.
  const store = ctx.settings.domains ?? (ctx.settings.domains = {} as Record<TaskDomain, DomainModelSettings>);
  for (const [key, domainValue] of Object.entries(value)) {
    if (!(DOMAIN_SETTINGS_KEYS as readonly string[]).includes(key)) throw new Error("invalid_domain_settings");
    if (typeof domainValue !== "object" || domainValue === null || Array.isArray(domainValue)) {
      throw new Error("invalid_domain_settings");
    }
    const domain = key as TaskDomain;
    const record = domainValue as Record<string, unknown>;
    const next: DomainModelSettings = { ...(store[domain] ?? {}) };
    if (record.model !== undefined) {
      if (record.model !== null && typeof record.model !== "string") throw new Error("invalid_domain_settings");
      const model = record.model === null ? "" : (record.model as string).trim();
      if (model) next.model = model;
      else delete next.model;
    }
    if (record.temperature !== undefined) {
      const temperature = record.temperature;
      if (temperature === null) delete next.temperature;
      else {
        if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
          throw new Error("invalid_domain_temperature");
        }
        next.temperature = temperature;
      }
    }
    const maxIterationsRaw = record.maxIterations !== undefined ? record.maxIterations : record.max_iterations;
    if (maxIterationsRaw !== undefined) {
      if (maxIterationsRaw === null) delete next.maxIterations;
      else {
        if (typeof maxIterationsRaw !== "number" || !Number.isInteger(maxIterationsRaw) || maxIterationsRaw < 1 || maxIterationsRaw > 100) {
          throw new Error("invalid_domain_max_iterations");
        }
        next.maxIterations = maxIterationsRaw;
      }
    }
    store[domain] = next;
  }
}

/**
 * Interactive terminal sessions (docs/terminal.md). User shells are the
 * human's own processes; the per-workspace agent session is a read-only
 * sink the harness' COMMAND_* events are mirrored into — input, signals,
 * and kills against it are refused so nothing here can touch the agent's
 * processes, and the agent never gets a path into user sessions.
 */
async function handleTerminals(ctx: AppContext, req: IncomingMessage, res: ServerResponse, url: URL, method: string, requestId: string): Promise<void> {
  try {
    if (method === "GET" && url.pathname === "/terminals") {
      const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || undefined);
      sendJson(res, 200, { terminals: ctx.terminals.list(root), root, request_id: requestId });
      return;
    }

    if (method === "POST" && url.pathname === "/terminals") {
      const parsed = await readJson(req);
      if (!parsed) {
        sendJson(res, 400, { error: "invalid_json", request_id: requestId });
        return;
      }
      const root = resolveAllowedRoot(ctx, typeof parsed.root === "string" ? parsed.root : undefined);
      const kind = parsed.kind === "agent" ? "agent" : "user";
      const terminal = ctx.terminals.create({ root, kind, ...(typeof parsed.title === "string" ? { title: parsed.title } : {}) });
      sendJson(res, 201, { terminal, request_id: requestId });
      return;
    }

    const inputMatch = /^\/terminals\/([^/]+)\/input$/.exec(url.pathname);
    if (method === "POST" && inputMatch?.[1]) {
      const parsed = await readJson(req);
      if (!parsed || typeof parsed.data !== "string") {
        sendJson(res, 400, { error: "data_string_required", request_id: requestId });
        return;
      }
      const terminal = ctx.terminals.writeInput(decodeURIComponent(inputMatch[1]), parsed.data);
      sendJson(res, 200, { terminal, request_id: requestId });
      return;
    }

    const signalMatch = /^\/terminals\/([^/]+)\/signal$/.exec(url.pathname);
    if (method === "POST" && signalMatch?.[1]) {
      const parsed = await readJson(req);
      const signal = parsed?.signal;
      if (signal !== "SIGINT" && signal !== "SIGTERM") {
        sendJson(res, 400, { error: "signal_must_be_SIGINT_or_SIGTERM", request_id: requestId });
        return;
      }
      const terminal = ctx.terminals.signal(decodeURIComponent(signalMatch[1]), signal);
      sendJson(res, 200, { terminal, request_id: requestId });
      return;
    }

    const sessionMatch = /^\/terminals\/([^/]+)$/.exec(url.pathname);
    if (sessionMatch?.[1]) {
      const id = decodeURIComponent(sessionMatch[1]);
      if (method === "GET") {
        const terminal = ctx.terminals.get(id);
        if (!terminal) {
          sendJson(res, 404, { error: "terminal_not_found", request_id: requestId });
          return;
        }
        sendJson(res, 200, { terminal, output: ctx.terminals.output(id) ?? "", request_id: requestId });
        return;
      }
      if (method === "DELETE") {
        const terminal = ctx.terminals.kill(id);
        sendJson(res, 200, { killed: true, terminal, request_id: requestId });
        return;
      }
    }

    sendJson(res, 404, { error: "not_found", request_id: requestId });
  } catch (error) {
    const status = error instanceof TerminalError ? error.status : errorStatus(error);
    sendJson(res, status, { error: errorMessage(error), request_id: requestId });
  }
}

async function handleProviders(ctx: AppContext, req: IncomingMessage, res: ServerResponse, url: URL, method: string, requestId: string): Promise<void> {
  try {
    await ensureProvidersLoaded(ctx);
    const registry = ctx.providerStore.registry;

    if (method === "GET" && url.pathname === "/providers") {
      // `home` tells companions WHERE this registry lives: the store is
      // anchored to the session workspace, so providers added under a
      // different workspace (or ~/.daedalus directly) legitimately show
      // up as an empty list here — never silently merged, never guessed.
      sendJson(res, 200, { providers: registry.list(), presets: PROVIDER_PRESETS, home: ctx.providerStore.filePath });
      return;
    }

    if (method === "POST" && url.pathname === "/providers") {
      const parsed = await readJson(req);
      if (!parsed) {
        sendJson(res, 400, { error: "invalid_json", request_id: requestId });
        return;
      }
      const provider = registry.upsert(providerInput(mergeProviderInput(registry, parsed)) as never);
      await ctx.providerStore.save();
      sendJson(res, 201, { provider });
      return;
    }

    const testMatch = /^\/providers\/([^/]+)\/test$/.exec(url.pathname);
    if (method === "POST" && testMatch?.[1]) {
      const result = await registry.testConnection(decodeURIComponent(testMatch[1]));
      if (result.ok) await ctx.providerStore.save();
      sendJson(res, result.ok ? 200 : 502, result);
      return;
    }

    const enabledMatch = /^\/providers\/([^/]+)\/enabled$/.exec(url.pathname);
    if ((method === "POST" || method === "PUT" || method === "PATCH") && enabledMatch?.[1]) {
      const parsed = await readJson(req);
      if (!parsed || typeof parsed.enabled !== "boolean") {
        sendJson(res, 400, { error: "enabled_boolean_required", request_id: requestId });
        return;
      }
      const provider = registry.setEnabled(decodeURIComponent(enabledMatch[1]), parsed.enabled);
      if (!provider) {
        sendJson(res, 404, { error: "provider_not_found", request_id: requestId });
        return;
      }
      await ctx.providerStore.save();
      sendJson(res, 200, { provider });
      return;
    }

    const providerMatch = /^\/providers\/([^/]+)$/.exec(url.pathname);
    if (providerMatch?.[1]) {
      const id = decodeURIComponent(providerMatch[1]);
      if (method === "GET") {
        const provider = registry.getPublic(id);
        if (!provider) sendJson(res, 404, { error: "provider_not_found", request_id: requestId });
        else sendJson(res, 200, { provider });
        return;
      }
      if (method === "PUT" || method === "PATCH" || method === "POST") {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        const provider = registry.upsert(providerInput(mergeProviderInput(registry, { ...parsed, id })) as never);
        await ctx.providerStore.save();
        sendJson(res, 200, { provider });
        return;
      }
      if (method === "DELETE") {
        const removed = registry.remove(id);
        if (!removed) {
          sendJson(res, 404, { error: "provider_not_found", request_id: requestId });
          return;
        }
        await ctx.providerStore.save();
        sendJson(res, 200, { removed: true, id });
        return;
      }
    }

    sendJson(res, 404, { error: "not_found", request_id: requestId });
  } catch (error) {
    sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
  }
}

/**
 * Merge a provider write over the stored record: fields the client omits
 * are preserved instead of wiped. Without this, a key rotation
 * (`PUT /providers/:id {apiKey}`) would silently erase the provider's
 * baseUrl, models, and name. Explicit values (including explicit empty
 * arrays) still win; an explicitly empty apiKey keeps the stored key.
 */
function mergeProviderInput(
  registry: { get(id: string): ProviderConfig | undefined },
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const rawId = parsed.id;
  const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : undefined;
  if (!id) return parsed;
  const prev = registry.get(id);
  if (!prev) return parsed;
  return { ...prev, ...parsed, id };
}

function providerInput(parsed: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...parsed };
  if (typeof input.base_url === "string" && typeof input.baseUrl !== "string") input.baseUrl = input.base_url;
  if (typeof input.api_key === "string" && typeof input.apiKey !== "string") input.apiKey = input.api_key;
  if (input.apiKey === "") delete input.apiKey;
  // Per-model context windows in tokens (settings layer 1, shown in the
  // Web model picker). Validated here with a named 400; the normalized
  // map rides the upsert input into the stored config. NOTE: core's
  // ProviderConfig/sanitizeProviderInput must carry `contextWindows`
  // for the value to persist and appear in the public provider view —
  // until then the field validates here but is dropped downstream.
  const contextWindowsRaw = input.contextWindows ?? input.context_windows;
  if (contextWindowsRaw !== undefined) input.contextWindows = parseContextWindows(contextWindowsRaw);
  delete input.apiKeyMasked;
  delete input.api_key;
  delete input.base_url;
  delete input.context_windows;
  delete input.hasApiKey;
  return input;
}

/**
 * `contextWindows`: Record<model id, positive-int token count>. Garbage in
 * (non-object, non-integer or non-positive values) is a named 400.
 */
function parseContextWindows(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_context_windows");
  const windows: Record<string, number> = {};
  for (const [model, tokens] of Object.entries(value)) {
    const name = model.trim();
    if (!name) continue;
    if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0) {
      throw new Error("invalid_context_windows");
    }
    windows[name] = tokens;
  }
  return windows;
}

function parseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set(["file", "folder", "image", "zip"]);
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const workspacePath = typeof record.workspacePath === "string" ? record.workspacePath : typeof record.workspace_path === "string" ? record.workspace_path : undefined;
    const name = typeof record.name === "string" ? record.name : workspacePath ? basename(workspacePath) : undefined;
    if (!workspacePath || !name) return [];
    return [{
      id: typeof record.id === "string" ? record.id : crypto.randomUUID(),
      ...(typeof record.taskId === "string" ? { taskId: record.taskId } : typeof record.task_id === "string" ? { taskId: record.task_id } : {}),
      workspacePath,
      name,
      kind: typeof record.kind === "string" && kinds.has(record.kind) ? (record.kind as Attachment["kind"]) : "file",
      ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : typeof record.mime_type === "string" ? { mimeType: record.mime_type } : {}),
      size: typeof record.size === "number" ? record.size : 0,
      ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
      ...(typeof record.path === "string" ? { path: record.path } : {}),
    }];
  });
}

type IncomingUploadFile = { name: string; path: string; mimeType?: string; data: Buffer };

async function handleUpload(ctx: AppContext, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  try {
    const body = await readRawBody(req);
    const contentType = req.headers["content-type"] ?? "";
    const fields = new Map<string, string>();
    const files: IncomingUploadFile[] = [];

    if (contentType.includes("multipart/form-data")) {
      const parts = parseMultipart(body, contentType);
      for (const part of parts) {
        if (part.filename !== undefined && part.filename.length > 0) {
          files.push({ name: basename(part.filename), path: part.filename, mimeType: part.contentType, data: part.data });
        } else {
          fields.set(part.name, part.data.toString("utf8"));
        }
      }
    } else {
      const parsed = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (key !== "files" && typeof value === "string") fields.set(key, value);
        if (key !== "files" && typeof value === "boolean") fields.set(key, String(value));
      }
      const rawFiles = Array.isArray(parsed.files) ? parsed.files : [];
      for (const raw of rawFiles) {
        if (typeof raw !== "object" || raw === null) continue;
        const record = raw as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "upload.bin";
        const relativePath = typeof record.path === "string" ? record.path : name;
        const base64 = typeof record.contentBase64 === "string" ? record.contentBase64 : typeof record.content_base64 === "string" ? record.content_base64 : "";
        files.push({ name, path: relativePath, mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined, data: Buffer.from(base64, "base64") });
      }
      if (typeof parsed.task_id === "string") fields.set("task_id", parsed.task_id);
      if (typeof parsed.taskId === "string") fields.set("task_id", parsed.taskId);
      if (typeof parsed.root === "string") fields.set("root", parsed.root);
      if (typeof parsed.destination === "string") fields.set("destination", parsed.destination);
      if (typeof parsed.kind === "string") fields.set("kind", parsed.kind);
    }

    if (!files.length) {
      sendJson(res, 400, { error: "file_required", request_id: requestId });
      return;
    }
    if (files.length > UPLOAD_LIMITS.maxFiles) {
      sendJson(res, 413, { error: `too many files (limit ${UPLOAD_LIMITS.maxFiles})`, request_id: requestId });
      return;
    }

    const root = resolveAllowedRoot(ctx, fields.get("root"));
    const taskIdRaw = fields.get("task_id") ?? fields.get("taskId");
    const taskId = taskIdRaw && /^[a-zA-Z0-9_-]+$/.test(taskIdRaw) ? taskIdRaw : undefined;
    const requestedKind = fields.get("kind");
    const destination = sanitizeRelativePath(fields.get("destination") ?? (taskId ? `.daedalus/attachments/${taskId}` : ".daedalus/attachments/uploads"));
    const destinationAbs = resolveInside(root, destination);
    await mkdir(destinationAbs, { recursive: true });

    const attachments: Attachment[] = [];
    const storedFiles: Array<{ path: string; size: number }> = [];
    let total = 0;

    for (const file of files) {
      total += file.data.length;
      if (file.data.length > UPLOAD_LIMITS.maxFileBytes) throw new Error(`file too large: ${file.name} (limit ${UPLOAD_LIMITS.maxFileBytes} bytes)`);
      if (total > UPLOAD_LIMITS.maxTotalBytes) throw new Error(`upload too large (limit ${UPLOAD_LIMITS.maxTotalBytes} bytes)`);
      const relativePath = sanitizeRelativePath(file.path || file.name);
      const isZip = requestedKind === "zip" || relativePath.toLowerCase().endsWith(".zip") || file.mimeType === "application/zip";
      if (isZip) {
        const zipAbs = resolveInside(root, join(destination, relativePath));
        await mkdir(join(zipAbs, ".."), { recursive: true });
        await writeFile(zipAbs, file.data);
        const zipAttachment = attachmentFromStored({ taskId, root, absolute: zipAbs, name: basename(relativePath), kind: "zip", mimeType: "application/zip", data: file.data });
        attachments.push(zipAttachment);
        emitAttachment(ctx, zipAttachment);
        storedFiles.push({ path: relativeToRoot(root, zipAbs), size: file.data.length });
        const extractDirName = basename(relativePath).replace(/\.zip$/i, "") || "archive";
        const extractAbs = resolveInside(root, join(destination, extractDirName));
        await mkdir(extractAbs, { recursive: true });
        for (const entry of extractZipEntries(file.data)) {
          const entryAbs = resolveInside(extractAbs, entry.path);
          await mkdir(join(entryAbs, ".."), { recursive: true });
          await writeFile(entryAbs, entry.data);
          storedFiles.push({ path: relativeToRoot(root, entryAbs), size: entry.data.length });
        }
        continue;
      }

      const absolute = resolveInside(root, join(destination, relativePath));
      await mkdir(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, file.data);
      const mimeType = file.mimeType ?? guessMimeType(relativePath);
      const kind: Attachment["kind"] = requestedKind === "folder" ? "file" : mimeType.startsWith("image/") || requestedKind === "image" ? "image" : "file";
      const attachment = attachmentFromStored({ taskId, root, absolute, name: basename(relativePath), kind, mimeType, data: file.data });
      attachments.push(attachment);
      emitAttachment(ctx, attachment);
      storedFiles.push({ path: relativeToRoot(root, absolute), size: file.data.length });
    }

    if (requestedKind === "folder" && storedFiles.length) {
      const folderAttachment: Attachment = {
        id: crypto.randomUUID(),
        ...(taskId ? { taskId } : {}),
        workspacePath: destination,
        name: basename(destination) || destination,
        kind: "folder",
        size: storedFiles.reduce((sum, file) => sum + file.size, 0),
        createdAt: new Date().toISOString(),
        path: destinationAbs,
      };
      attachments.push(folderAttachment);
      emitAttachment(ctx, folderAttachment);
    }

    sendJson(res, 201, { attachments, files: storedFiles, limits: UPLOAD_LIMITS, destination });
  } catch (error) {
    sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
  }
}

function relativeToRoot(root: string, absolute: string): string {
  const resolvedRoot = resolve(root);
  return absolute.startsWith(resolvedRoot + sep) ? absolute.slice(resolvedRoot.length + 1) : basename(absolute);
}

type TaskLookup = { store: TaskStore; state: Record<string, unknown> };

/**
 * Stores the gateway may read for monitoring. The primary store is always
 * included; in addition, every allowed workspace root contributes its local
 * `<workspace>/.daedalus` store. That is what lets the Web monitor a task the
 * CLI started in the same shared workspace (CLI and server resolve the same
 * home for that root) without exposing arbitrary directories.
 */
/** Conversation store for one workspace root (same home resolution as its task store). */
function conversationStoreFor(ctx: AppContext, root: string): ConversationStore {
  return new ConversationStore(resolveDaedalusHome(ctx.settings.daedalusHome, root));
}

/**
 * How long the task-store list may be reused. Building it scans every
 * recorded task state (recordedRoots → allowedRoots), which is O(task
 * history): at ~200 tasks that scan alone cost ~600ms when GET /tasks
 * rebuilt the list once per task (quadratic per poll). Only the LIST
 * is memoized — task data itself is always read live — so a store
 * that appears (new workspace, CLI task next door) is picked up
 * within a second.
 */
const TASK_STORES_CACHE_MS = 1_000;

function taskStores(ctx: AppContext): TaskStore[] {
  const cached = ctx.taskStoresCache;
  if (cached && cached.expiresAt > Date.now()) return cached.stores;
  const stores: TaskStore[] = [];
  const seen = new Set<string>();
  const add = (store: TaskStore) => {
    const key = resolve(store.root);
    if (seen.has(key)) return;
    seen.add(key);
    stores.push(store);
  };
  add(ctx.store);
  for (const root of allowedRoots(ctx)) add(new TaskStore(resolveDaedalusHome(ctx.settings.daedalusHome, root)));
  ctx.taskStoresCache = { expiresAt: Date.now() + TASK_STORES_CACHE_MS, stores };
  return stores;
}

export function findTask(ctx: AppContext, taskId: string): TaskLookup | undefined {
  for (const store of taskStores(ctx)) {
    const state = store.loadState<Record<string, unknown>>(taskId);
    if (state !== undefined) return { store, state };
    if (store.hasEvents(taskId)) return { store, state: {} };
  }
  return undefined;
}

export function allTaskIds(ctx: AppContext): string[] {
  const ids = new Set<string>();
  for (const store of taskStores(ctx)) {
    for (const id of store.listTasks()) ids.add(id);
  }
  return [...ids];
}

/**
 * The task that produced `.daedalus/plans/<slug>/`: the one whose event
 * log most recently recorded a FILE_CHANGED inside that folder. Resolved
 * from the store (never from goal text), so a plan execution launched
 * long after the planning session still carries its plan identity.
 */
function planProducerTaskId(ctx: AppContext, slug: string): string | null {
  const prefix = `.daedalus/plans/${slug}/`;
  let producer: string | null = null;
  let latest = "";
  for (const store of taskStores(ctx)) {
    for (const taskId of store.listTasks()) {
      for (const event of store.replay(taskId)) {
        if (event.type !== "FILE_CHANGED") continue;
        const path = (event.payload as { path?: unknown }).path;
        if (typeof path !== "string" || !path.replace(/\\/g, "/").startsWith(prefix)) continue;
        if (producer === null || event.ts >= latest) {
          producer = taskId;
          latest = event.ts;
        }
      }
    }
  }
  return producer;
}

/** Stat fingerprint (size@mtime per file, "x" when absent) of everything a task summary reads. */
function taskFileFingerprint(store: TaskStore, taskId: string): string {
  const dir = store.taskDir(taskId);
  const part = (name: string): string => {
    try {
      const stat = statSync(join(dir, name));
      return `${stat.size}@${Math.round(stat.mtimeMs)}`;
    } catch {
      return "x";
    }
  };
  return `${part("state.json")}|${part("report.json")}|${part("events.jsonl")}`;
}

function summarizeFrom(ctx: AppContext, lookup: TaskLookup, taskId: string): Record<string, unknown> {
  const { store, state } = lookup;
  // GET /tasks builds one summary per historical task on EVERY poll.
  // The summary derives only from the task's three files, so memoize
  // it behind their stat fingerprint: an unchanged history costs a few
  // stats per poll instead of re-reading every event log (the scan
  // that made polls take seconds at ~200 tasks). The `running` flag's
  // live half (activeRunners) is overlaid after the memo, never cached.
  ctx.taskSummaryCache ??= new Map();
  const cacheKey = `${resolve(store.root)}:${taskId}`;
  const fingerprint = taskFileFingerprint(store, taskId);
  const cached = ctx.taskSummaryCache.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) {
    return { ...cached.summary, running: ctx.activeRunners.has(taskId) || cached.summary.running === true };
  }
  const spec = (state.spec && typeof state.spec === "object" ? state.spec : state) as Record<string, unknown>;
  // Cheap first/last-line stats, NOT a full replay: replay()
  // JSON-parses every event ever recorded.
  const stats = store.eventStats(taskId);
  const report = store.loadReport<{ outcome?: string }>(taskId);
  const stateStatus = typeof state.status === "string" ? state.status : "unknown";
  const outcome = typeof report?.outcome === "string" ? report.outcome : stateStatus === "unknown" ? undefined : stateStatus;
  const activeStatus = ["created", "pending", "active", "running"].includes(stateStatus);
  const summary: Record<string, unknown> = {
    id: taskId,
    goal: typeof spec.goal === "string" ? spec.goal : undefined,
    title: typeof state.title === "string" ? state.title : typeof spec.title === "string" ? spec.title : undefined,
    repo_path: typeof spec.repo_path === "string" ? spec.repo_path : typeof state.repo_path === "string" ? state.repo_path : undefined,
    status: report?.outcome ?? stateStatus,
    ...(outcome ? { outcome } : {}),
    mode: typeof state.mode === "string" ? state.mode : typeof spec.mode === "string" ? spec.mode : undefined,
    ...(typeof state.conversation_id === "string" ? { conversation_id: state.conversation_id } : {}),
    thinking: typeof state.thinking === "boolean" ? state.thinking : typeof spec.thinking === "boolean" ? spec.thinking : undefined,
    created_at: typeof spec.created_at === "string" ? spec.created_at : typeof state.created_at === "string" ? state.created_at : stats.firstTs,
    event_count: stats.count,
    last_seq: stats.lastSeq,
    last_event: stats.lastType,
    updated_at: stats.lastTs ?? (typeof spec.created_at === "string" ? spec.created_at : null),
    running: activeStatus && !report,
    store_root: store.root,
  };
  ctx.taskSummaryCache.set(cacheKey, { fingerprint, summary });
  return { ...summary, running: ctx.activeRunners.has(taskId) || summary.running === true };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolvePromise, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const EXTENSION_STATUS_CACHE_MS = 5_000;
const MCP_STATUS_TIMEOUT_MS = 2_000;

async function extensionStatus(ctx: AppContext, rootValue: unknown): Promise<ExtensionStatus> {
  const root = resolveAllowedRoot(ctx, rootValue);
  ctx.extensionStatusCache ??= new Map();
  const cached = ctx.extensionStatusCache.get(root);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [mcpConfig, skillInventory, agentRegistry, lspConfig] = await Promise.all([
    loadMcpConfig(root),
    (async () => {
      // The same inventory the loader builds for a task: collision
      // winners plus shadowed copies, with the workspace's disabled set
      // (shared .daedalus/skills.json) already applied per entry.
      const skillConfig = await loadSkillConfig(root);
      return loadSkillInventory(resolveSkillSearchDirs(root), { disabledNames: skillConfig.disabled });
    })(),
    loadAgents([workspaceAgentsDir(root)]),
    loadLspConfig(root),
  ]);
  // Report the EFFECTIVE servers the harness will actually use — the
  // configured list plus core's automatic TypeScript server for TS
  // workspaces. Reading lsp.json alone made the panel claim "none
  // configured" while diagnostics were already wired.
  const configuredLspNames = new Set(lspConfig.servers.map((server) => server.name));
  const effectiveLsp = await withDefaultLspServers(root, lspConfig.servers);

  let mcp: ExtensionStatus["mcp"] = mcpConfig.servers.map((server) => ({ name: server.name, connected: false, toolCount: 0 }));
  if (mcpConfig.servers.length > 0) {
    const capped = mcpConfig.servers.map((server) => ({ ...server, timeoutMs: Math.min(server.timeoutMs ?? MCP_STATUS_TIMEOUT_MS, MCP_STATUS_TIMEOUT_MS) }));
    const manager = new McpManager(capped);
    try {
      const statuses = await withTimeout(manager.connectAll(), MCP_STATUS_TIMEOUT_MS + 500, "MCP status check");
      // McpManager.closeAll() flips its live status objects to disconnected;
      // snapshot the probe result before cleanup so the endpoint reports the
      // connection that actually happened.
      mcp = statuses.map((status) => ({ ...status }));
    } catch (error) {
      const message = errorMessage(error);
      mcp = capped.map((server) => ({ name: server.name, connected: false, toolCount: 0, error: message }));
    } finally {
      await manager.closeAll().catch(() => undefined);
    }
  }

  const value: ExtensionStatus = {
    root,
    mcp,
    skills: skillInventory.map((skill): ExtensionSkill => ({
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
      disabled: skill.disabled,
      ...(skill.shadowedBy ? { shadowedBy: skill.shadowedBy } : {}),
    })),
    agents: agentRegistry.list().map((agent) => ({
      name: agent.name,
      description: agent.description,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.mode ? { mode: agent.mode } : {}),
      ...(agent.tools ? { tools: agent.tools } : {}),
    })),
    lsp: effectiveLsp.map((server) => ({
      name: server.name,
      extensions: [...server.extensions],
      configured: configuredLspNames.has(server.name),
      running: false,
      ...(configuredLspNames.has(server.name) ? {} : { auto: true }),
    })),
    problems: [...mcpConfig.problems, ...lspConfig.problems],
  };
  ctx.extensionStatusCache.set(root, { expiresAt: Date.now() + EXTENSION_STATUS_CACHE_MS, value });
  return value;
}

/**
 * Startup reconciliation: tasks whose event log and state say "still
 * running" but that no runner in this process will ever finish. When the
 * previous daemon died mid-task (crash, kill, power loss), no final
 * report was written, so `summarizeFrom` would compute
 * `running: activeStatus && !report` from the persisted files forever —
 * a dead task displayed as running. Before serving anything, settle
 * exactly those tasks (active-looking state, no report, no live runner)
 * to a truthful `interrupted`: the reconciled report makes list view,
 * task detail, and the report endpoint agree, and the closing
 * TASK_COMPLETED event keeps the replayed event log consistent with
 * them. Events, state, and backups are otherwise preserved as recorded;
 * tasks with a report or an already-terminal state are never touched.
 * Runs inside createApp — every server embedding boots through it, and
 * at that moment no runner of this process can exist yet.
 */
export function reconcileInterruptedTasks(ctx: AppContext): string[] {
  const ACTIVE_STATUSES = ["created", "pending", "active", "running"];
  const reconciled: string[] = [];
  for (const store of taskStores(ctx)) {
    for (const taskId of store.listTasks()) {
      if (ctx.activeRunners.has(taskId)) continue;
      if (store.loadReport(taskId)) continue;
      const state = store.loadState<Record<string, unknown>>(taskId);
      const status = typeof state?.status === "string" ? state.status : undefined;
      if (!status || !ACTIVE_STATUSES.includes(status)) continue;
      const report: FinalReport = {
        task_id: taskId,
        outcome: "interrupted",
        diff: "",
        evidence: [
          "The Daedalus daemon stopped while this task was still running, so no final report was written. When the server restarted, the task was reconciled as interrupted; its recorded events and file changes are preserved.",
        ],
        metrics: {},
      };
      store.saveReport(taskId, report);
      emitEvent({ bus: ctx.bus, store }, taskId, undefined, "TASK_COMPLETED", {
        outcome: "interrupted",
        reason: "interrupted",
        summary: "the Daedalus daemon stopped before this task finished; reconciled as interrupted when the server restarted",
      });
      reconciled.push(taskId);
    }
  }
  if (reconciled.length > 0) {
    ctx.log.info("reconciled interrupted tasks at startup", { count: reconciled.length, tasks: reconciled });
  }
  return reconciled;
}

/**
 * Shared task-creation core behind POST /tasks and POST /workflow/chat
 * (Dae Captain). Behavior-identical to the original inline route body:
 * validates the payload, saves state, and starts the runner or fast
 * path, then reports { status, body } so each route sends the HTTP
 * response itself. taskId is returned on 201 for dispatch bookkeeping.
 */
async function createTaskCore(
  ctx: AppContext,
  parsed: Record<string, unknown>,
  requestId: string,
): Promise<{ taskId?: string; status: number; body: unknown }> {
  try {
    const goal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
    if (goal === "") {
      return { status: 400, body: { error: "goal_required", request_id: requestId } };
    }
    if (parsed.mode !== undefined && !parseMode(parsed.mode)) {
      return { status: 400, body: { error: "invalid_mode", modes: AGENT_MODES, request_id: requestId } };
    }
    if (parsed.isolation !== undefined && parsed.isolation !== "worktree") {
      return { status: 400, body: { error: "invalid_isolation", request_id: requestId } };
    }
    const isolation = parsed.isolation === "worktree" ? ("worktree" as const) : undefined;
    if (parsed.domain !== undefined && parsed.domain !== "coding" && parsed.domain !== "slide" && parsed.domain !== "dokumen" && parsed.domain !== "spreadsheet") {
      return { status: 400, body: { error: "invalid_domain", request_id: requestId } };
    }
    const domain = parsed.domain === "slide" || parsed.domain === "coding" || parsed.domain === "dokumen" || parsed.domain === "spreadsheet" ? parsed.domain : undefined;

    // Dokumen composer parameters: Ekstrak|Susun sub-mode, source
    // files to ingest, DOCX to re-layout. Only meaningful in the
    // dokumen domain; validated here so the composer gets a named
    // 400 instead of a silently wrong run.
    let dokumen: DokumenTaskParams | undefined;
    if (domain === "dokumen") {
      const raw = parsed.dokumen && typeof parsed.dokumen === "object" ? (parsed.dokumen as Record<string, unknown>) : {};
      const subModeRaw = raw.sub_mode ?? raw.subMode;
      if (subModeRaw !== undefined && subModeRaw !== "ekstrak" && subModeRaw !== "susun") {
        return { status: 400, body: { error: "invalid_dokumen_submode", request_id: requestId } };
      }
      const sourcesRaw = raw.sources;
      const sources = Array.isArray(sourcesRaw) ? sourcesRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
      const docxRaw = raw.docx_path ?? raw.docxPath;
      const docxPath = typeof docxRaw === "string" && docxRaw.trim() ? docxRaw.trim() : undefined;
      dokumen = {
        subMode: subModeRaw === "susun" ? "susun" : "ekstrak",
        ...(sources.length > 0 ? { sources } : {}),
        ...(docxPath ? { docxPath } : {}),
      };
    }
    // Slide composer parameters (Agentic Slide v2): generation flow,
    // target slide count, content language, pre-picked template. The
    // Web sends snake_case; camelCase is accepted too. They only take
    // effect in the slide domain (core renders them into the slide
    // contract); an unknown template or out-of-range count is a 400,
    // never a silent ignore.
    let slide: SlideTaskParams | undefined;
    if (domain === "slide" && parsed.slide && typeof parsed.slide === "object") {
      const raw = parsed.slide as Record<string, unknown>;
      const generation = raw.generation;
      if (generation !== undefined && generation !== "smart" && generation !== "standard") {
        return { status: 400, body: { error: "invalid_slide_generation", request_id: requestId } };
      }
      const countRaw = raw.slide_count ?? raw.slideCount;
      const slideCount = typeof countRaw === "number" && Number.isFinite(countRaw) ? Math.floor(countRaw) : undefined;
      if (countRaw !== undefined && (slideCount === undefined || slideCount < 1 || slideCount > 40)) {
        return { status: 400, body: { error: "invalid_slide_count", request_id: requestId } };
      }
      const language = typeof raw.language === "string" && raw.language.trim() ? raw.language.trim().slice(0, 40) : undefined;
      const templateRaw = raw.template_id ?? raw.templateId;
      const templateId = typeof templateRaw === "string" && templateRaw.trim() ? templateRaw.trim() : undefined;
      if (templateId && !getSlideTemplate(templateId)) {
        return { status: 400, body: { error: "unknown_slide_template", request_id: requestId } };
      }
      const designRaw = raw.design_id ?? raw.designId;
      const designId = typeof designRaw === "string" && designRaw.trim() ? designRaw.trim() : undefined;
      if (designId && !getBuiltinTemplate(designId)) {
        return { status: 400, body: { error: "unknown_slide_design", request_id: requestId } };
      }
      const customRaw = raw.custom_template_id ?? raw.customTemplateId;
      const customTemplateId = typeof customRaw === "string" && customRaw.trim() ? customRaw.trim() : undefined;
      if (templateId && customTemplateId) {
        // One design source per deck: bundled Warna & Font skin OR
        // an imported PPT template (whose pages carry the design).
        return { status: 400, body: { error: "slide_template_conflict", request_id: requestId } };
      }
      if (designId && customTemplateId) {
        // A built-in design template and an imported PPT template
        // are both full design sources — never both on one deck.
        // (A Warna & Font skin may still layer over a design.)
        return { status: 400, body: { error: "slide_template_conflict", request_id: requestId } };
      }
      const parsed2: SlideTaskParams = {
        ...(generation ? { generation } : {}),
        ...(slideCount ? { slideCount } : {}),
        ...(language ? { language } : {}),
        ...(templateId ? { templateId } : {}),
        ...(designId ? { designId } : {}),
        ...(customTemplateId ? { customTemplateId } : {}),
      };
      slide = Object.keys(parsed2).length > 0 ? parsed2 : undefined;
    }

    await ensureProvidersLoaded(ctx);
    const taskId = crypto.randomUUID();
    const repoPath = resolveTaskRepo(ctx, parsed.repo_path ?? parsed.repoPath);
    if (slide?.customTemplateId) {
      // The imported-template pick must name a template stored in
      // THIS workspace — a stale panel selection gets a named 400
      // here, not a failed task after the model already ran.
      const stored = await getPptxTemplate(repoPath, slide.customTemplateId).catch(() => undefined);
      if (!stored) {
        return { status: 400, body: { error: "unknown_ppt_template", request_id: requestId } };
      }
    }
    const constraints = stringList(parsed.constraints);
    const doneCriteria = stringList(parsed.done_criteria ?? parsed.doneCriteria);
    const mode = parseMode(parsed.mode) ?? ctx.session.mode;
    const autoApprove = typeof parsed.auto_approve === "boolean" ? parsed.auto_approve : typeof parsed.autoApprove === "boolean" ? parsed.autoApprove : ctx.session.autoApprove;
    // Per-task max iterations: explicit values only. When the payload
    // omits it, the runner resolves per-task > domain override >
    // global settings.maxIterations > 25 (core runtime) — so a
    // hardcoded 25 here must NOT shadow the domain/global settings.
    const maxIterationsRaw = parsed.max_iterations !== undefined ? parsed.max_iterations : parsed.maxIterations;
    if (maxIterationsRaw !== undefined && maxIterationsRaw !== null && (typeof maxIterationsRaw !== "number" || !Number.isInteger(maxIterationsRaw) || maxIterationsRaw < 1)) {
      return { status: 400, body: { error: "invalid_max_iterations", request_id: requestId } };
    }
    const maxIterations = typeof maxIterationsRaw === "number" ? maxIterationsRaw : undefined;
    const providerId = typeof parsed.provider_id === "string" ? parsed.provider_id : typeof parsed.providerId === "string" ? parsed.providerId : ctx.session.providerId;
    const model = typeof parsed.model === "string" ? parsed.model : ctx.session.model;
    const thinking = typeof parsed.thinking === "boolean" ? parsed.thinking : ctx.session.thinking;
    // Per-run settings layer 2: hard token budget (positive int,
    // metered on provider-reported total_tokens) and tool permission
    // overrides. Both flow into the runner's RunOptions below;
    // invalid values are named 400s, never silent drops.
    const tokenBudgetRaw = parsed.token_budget ?? parsed.tokenBudget;
    let tokenBudget: number | undefined;
    if (tokenBudgetRaw !== undefined) {
      if (typeof tokenBudgetRaw !== "number" || !Number.isInteger(tokenBudgetRaw) || tokenBudgetRaw <= 0) {
        return { status: 400, body: { error: "invalid_token_budget", request_id: requestId } };
      }
      tokenBudget = tokenBudgetRaw;
    }
    const toolRulesRaw = parsed.tool_rules ?? parsed.toolRules;
    let toolRules: ToolRules | undefined;
    if (toolRulesRaw !== undefined) {
      const parsedRules = parseToolRules(toolRulesRaw);
      if (!parsedRules) {
        return { status: 400, body: { error: "invalid_tool_rules", request_id: requestId } };
      }
      toolRules = parsedRules;
    }
    // Model pool (Web settings → task payload): core's TaskRunner already
    // routes across models[] with a strategy; until now only the CLI/env
    // could supply one. parseModelStrategy rejects unknown strategies.
    const poolModels = stringList(parsed.models).map((entry) => entry.trim()).filter(Boolean);
    const strategyInput = typeof parsed.model_strategy === "string" ? parsed.model_strategy : typeof parsed.modelStrategy === "string" ? parsed.modelStrategy : undefined;
    const modelStrategy: ModelStrategy | undefined = poolModels.length > 1 ? parseModelStrategy(strategyInput, "model_strategy") : undefined;
    const attachments = parseAttachments(parsed.attachments);
    const taskStore = new TaskStore(resolveDaedalusHome(ctx.settings.daedalusHome, repoPath));

    // Chat conversation: this submission is one turn of a continuing
    // session. The turns BEFORE this prompt become the prompt's
    // memory (fast-path history / task prior-context); this prompt is
    // appended as a user turn now, the reply appended when it lands.
    const conversationId =
      typeof parsed.conversation_id === "string" && parsed.conversation_id.trim()
        ? parsed.conversation_id.trim()
        : typeof parsed.conversationId === "string" && parsed.conversationId.trim()
          ? parsed.conversationId.trim()
          : undefined;
    const conversationStore = conversationId ? conversationStoreFor(ctx, repoPath) : undefined;
    const priorTurns: ConversationTurn[] =
      conversationStore && conversationId ? (conversationStore.load(conversationId)?.turns ?? []) : [];
    if (conversationStore && conversationId) {
      conversationStore.append(repoPath, conversationId, {
        role: "user",
        text: goal,
        task_id: taskId,
        mode,
        ts: new Date().toISOString(),
      });
    }
    const appendAssistantTurn = (text: string): void => {
      if (!conversationStore || !conversationId) return;
      try {
        conversationStore.append(repoPath, conversationId, {
          role: "assistant",
          text,
          task_id: taskId,
          mode,
          ts: new Date().toISOString(),
        });
      } catch (error) {
        ctx.log.error("conversation append failed", { task_id: taskId, error: String(error) });
      }
    };

    // Explicit skill invocations (composer `/skill <name>`): the
    // named skills must exist and be enabled for this workspace —
    // validated here, against the same core config the run reads,
    // so the composer gets a named 400 instead of a silently
    // un-skilled task. A valid invocation always takes the task
    // path (the fast answer paths have no skill context).
    const skillNames = stringList(parsed.skills).map((name) => name.trim()).filter(Boolean);
    if ((domain === "slide" || domain === "dokumen") && skillNames.length > 0) {
      // Slide mode is a locked surface (deck tools + ask_user); a
      // /skill invocation there gets a named refusal, not a silent drop.
      return { status: 400, body: { error: domain === "dokumen" ? "skills_not_in_dokumen_domain" : "skills_not_in_slide_domain", request_id: requestId } };
    }
    if (domain === "spreadsheet" && skillNames.length > 0) {
      // Spreadsheet is likewise locked (sheet ops + ask_user).
      return { status: 400, body: { error: "skills_not_in_spreadsheet_domain", request_id: requestId } };
    }
    if (skillNames.length > 0) {
      const skillConfig = await loadSkillConfig(repoPath);
      const inventory = await loadSkillInventory(resolveSkillSearchDirs(repoPath), { disabledNames: skillConfig.disabled });
      const enabled = new Set(inventory.filter((skill) => !skill.shadowedBy && !skill.disabled).map((skill) => skill.name));
      const problems: string[] = [];
      for (const name of skillNames) {
        if (!enabled.has(name)) {
          problems.push(
            skillConfig.disabled.includes(name)
              ? `skill "${name}" is disabled for this workspace (.daedalus/skills.json) — re-enable it (Settings → Extensions, or \`daedalus skills enable ${name}\`) to invoke it`
              : `unknown skill "${name}" — no skill with that name was found in this workspace or the global skill directories`,
          );
        }
      }
      if (problems.length > 0) {
        return { status: 400, body: { error: problems.join("; "), request_id: requestId } };
      }
    }

    // Direct answers (the Crush/Cline message pattern): casual
    // conversation and pure questions go straight to the model and the
    // reply is the result — no manufactured plan, no tool loop, no
    // validation. Modes still govern everything classified as a task;
    // attachments/worktrees always take the task path. Slide-domain
    // submits also always take the full task path: the fast answer
    // paths have no tool loop, so they could never touch the deck.
    const intent = attachments.length || isolation || skillNames.length || domain === "slide" || domain === "dokumen" || domain === "spreadsheet" ? "task" : classifyWebIntent(goal);
              if (intent !== "task") {
      const task = {
        id: taskId,
        goal,
        repo_path: repoPath,
        constraints,
        done_criteria: doneCriteria,
        mode,
        auto_approve: autoApprove,
        thinking,
        intent,
        ...(providerId ? { provider_id: providerId } : {}),
        ...(model ? { model } : {}),
        ...(poolModels.length ? { models: poolModels } : {}),
        ...(modelStrategy ? { model_strategy: modelStrategy } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(domain ? { domain } : {}),
        attachments,
        created_at: new Date().toISOString(),
      };
      taskStore.saveState(taskId, {
        ...task,
        plan: { id: `${taskId}-plan`, task_id: taskId, steps: [], version: 0, status: "draft" },
        steps: [],
        status: "running",
      });
      emitEvent({ bus: ctx.bus, store: taskStore }, taskId, undefined, "TASK_STARTED", {
        spec: { id: taskId, goal, mode, repo_path: repoPath, created_at: task.created_at },
        intent,
      });
      ctx.log.info("fast path task created", { task_id: taskId, request_id: requestId, repo_path: repoPath, mode, intent });
      executeFastPath({
        ctx,
        store: taskStore,
        taskId,
        goal,
        mode,
        repoPath,
        intent,
        thinking,
        selection: { providerId, model, poolModels },
        ...(priorTurns.length > 0 ? { history: historyMessages(priorTurns) } : {}),
        onReply: (text) => appendAssistantTurn(text),
      });
      return { taskId, status: 201, body: task };
    }

    const runner = new TaskRunner({
      workspaceRoot: repoPath,
      approvalPolicy: autoApprove ? "auto" : "ask",
      approvalMemory: ctx.approvalMemory,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      bus: ctx.bus,
      store: taskStore,
      settings: ctx.settings,
      providerRegistry: ctx.providerStore.registry,
      mode,
      autoApprove,
      thinking,
      streamText: true,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {}),
      ...(poolModels.length ? { models: poolModels } : {}),
      ...(modelStrategy ? { modelStrategy } : {}),
    });
    ctx.activeRunners.set(taskId, runner);
    if (domain === "slide") {
      // A new slide prompt supersedes an outline still staged in
      // this workspace: settle the waiting run honestly
      // (staged_superseded) instead of leaving it parked.
      for (const [otherId, other] of ctx.activeRunners) {
        if (otherId !== taskId) other.abandonStagedDeck(repoPath);
      }
    }
    if (domain === "dokumen") {
      // Same doctrine: a new dokumen prompt supersedes a staged
      // schema/outline/style gate still waiting in this workspace.
      for (const [otherId, other] of ctx.activeRunners) {
        if (otherId !== taskId) other.abandonDokumenGate(repoPath);
      }
    }
    if (domain === "spreadsheet") {
      // Same staging discipline for blueprints.
      for (const [otherId, other] of ctx.activeRunners) {
        if (otherId !== taskId) other.abandonStagedWorkbook(repoPath);
      }
    }

    const task = {
      id: taskId,
      goal,
      repo_path: repoPath,
      constraints,
      done_criteria: doneCriteria,
      mode,
      auto_approve: autoApprove,
      thinking,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(model ? { model } : {}),
      ...(poolModels.length ? { models: poolModels } : {}),
      ...(modelStrategy ? { model_strategy: modelStrategy } : {}),
      ...(tokenBudget !== undefined ? { token_budget: tokenBudget } : {}),
      ...(toolRules ? { tool_rules: toolRules } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(domain ? { domain } : {}),
      attachments,
      ...(skillNames.length ? { skills: skillNames } : {}),
      ...(isolation ? { isolation } : {}),
      created_at: new Date().toISOString(),
    };
    taskStore.saveState(taskId, {
      ...task,
      plan: { id: `${taskId}-plan`, task_id: taskId, steps: [], version: 0, status: "draft" },
      steps: [],
      status: "created",
    });
    ctx.log.info("task created", { task_id: taskId, request_id: requestId, repo_path: repoPath, mode });

    const goalText = [goal, ...constraints.map((constraint) => `constraint: ${constraint}`), ...doneCriteria.map((criterion) => `done: ${criterion}`)].join("\n");
    const priorContext = priorContextSection(priorTurns);
    runner
      .run({
        goal: goalText,
        taskId,
        mode,
        autoApprove,
        thinking,
        attachments,
        ...(skillNames.length ? { skills: skillNames } : {}),
        ...(isolation ? { isolation } : {}),
        ...(providerId ? { providerId } : {}),
        ...(model ? { model } : {}),
        ...(poolModels.length ? { models: poolModels } : {}),
        ...(modelStrategy ? { modelStrategy } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(toolRules ? { toolRules } : {}),
        ...(typeof parsed.plan_task_id === "string" && parsed.plan_task_id ? { planTaskId: parsed.plan_task_id } : {}),
        ...(priorContext ? { priorContext } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(domain ? { domain } : {}),
        ...(slide ? { slide } : {}),
        ...(dokumen ? { dokumen } : {}),
      })
      .then((result) => {
        ctx.log.info("task finished", { task_id: taskId, outcome: result.outcome });
        appendAssistantTurn(taskSummaryText({ outcome: result.outcome, goal, evidence: result.report?.evidence }));
      })
      .catch((error: unknown) => {
        ctx.log.error("task run error", { task_id: taskId, error: String(error) });
        appendAssistantTurn(taskSummaryText({ outcome: "failed", goal, evidence: [String(error)] }));
      })
      .finally(() => ctx.activeRunners.delete(taskId));

    return { taskId, status: 201, body: task };
  } catch (error) {
    return { status: errorStatus(error), body: { error: errorMessage(error), request_id: requestId } };
  }
}


/**
 * Shared research-plan staging behind POST /research/plan and
 * POST /workflow/chat (Dae Captain). Behavior-identical to the original
 * inline route body; reports { status, body } and the planId on 200 so
 * each route can send the HTTP response itself.
 */
async function stageResearchPlanCore(
  ctx: AppContext,
  input: { question: string; root?: unknown; provider_id?: string; model?: string; depth?: string },
  requestId: string,
): Promise<{ planId?: string; status: number; body: unknown }> {
  try {
    const question = input.question.trim();
    if (!question) {
      return { status: 400, body: { error: "question_required", request_id: requestId } };
    }
    const root = resolveAllowedRoot(ctx, (input.root ?? undefined) as string | undefined);
    const hooks = await resolveResearchHooks(ctx);
    await ensureProvidersLoaded(ctx);
    const provider = researchProviderFromRequest(ctx, {
      ...(input.provider_id ? { provider_id: input.provider_id } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    if (!provider) {
      return { status: 400, body: { error: "no_provider_configured", request_id: requestId } };
    }
    const plan = await hooks.planResearch({ question, provider });
    // Dae Captain v2 Fase 7 — kedalaman riset [Cepat][Standar][Mendalam]:
    // honest resource-budget lever on the staged plan. Cepat caps the
    // query/source budget down; Mendalam raises the floor; Standar keeps
    // the planner's own budget.
    const depth = input.depth === "cepat" || input.depth === "mendalam" ? input.depth : "standar";
    if (depth === "cepat") {
      plan.budget = {
        maxQueries: Math.min(plan.budget.maxQueries, 4),
        maxSources: Math.min(plan.budget.maxSources, 5),
      };
    } else if (depth === "mendalam") {
      plan.budget = {
        maxQueries: Math.max(plan.budget.maxQueries, 10),
        maxSources: Math.max(plan.budget.maxSources, 12),
      };
    }
    const staged = stageResearchPlan({ question, workspaceRoot: root, plan, depth });
    return {
      planId: staged.planId,
      status: 200,
      body: { planId: staged.planId, plan, depth, request_id: requestId },
    };
  } catch (error) {
    return { status: errorStatus(error), body: { error: errorMessage(error), request_id: requestId } };
  }
}


/**
 * Run a staged research plan (shared core behind POST /research/run and
 * the Dae Captain task-plan executor). Returns { status, body }; callers
 * send it as the HTTP response. Behavior-identical to the original inline
 * route body: the staged plan is single-use, a verify failure inside the
 * engine answers 422, and a report is NEVER returned with unverified
 * claims. Progress events stream to GET /research/progress/:planId.
 */
async function runStagedResearchPlanCore(
  ctx: AppContext,
  parsed: Record<string, unknown>,
  requestId: string,
): Promise<{ status: number; body: unknown }> {
  const planId = typeof parsed.planId === "string" ? parsed.planId : "";
  // Peek dulu (jangan consume): plan baru dihapus saat run selesai.
  // Request kedua untuk plan yang masih berjalan -> 409, bukan 410.
  const staged = planId ? peekStagedResearchPlan(planId) : undefined;
  if (!staged) {
    return { status: 410, body: { error: "plan_expired", message: "rencana kedaluwarsa, buat ulang", request_id: requestId } };
  }
  if (!tryStartResearchRun(planId)) {
    return { status: 409, body: { error: "already_running", message: "riset untuk rencana ini sudah berjalan", request_id: requestId } };
  }
  const hooks = await resolveResearchHooks(ctx);
  await ensureProvidersLoaded(ctx);
  const provider = researchProviderFromRequest(ctx, parsed);
  if (!provider) {
    finishResearchRun(planId);
    return { status: 400, body: { error: "no_provider_configured", request_id: requestId } };
  }
  const engine = await hooks.createEngine({
    provider,
    fetch: { searchWeb: hooks.searchWeb, fetchPage: hooks.fetchPage },
    elsevierApiKey: process.env.ELSEVIER_API_KEY || undefined,
    onProgress: (stage, detail) => appendResearchProgress(planId, stage, detail),
    // Cooperative pause (Dae Captain pill ⏸): POST /tasks/:planId/pause
    // suspends the pipeline at the next stage boundary.
    waitWhilePaused: () => ctx.store.waitWhilePaused(planId),
  });
  let result;
  try {
    result = await engine.runResearch(staged.plan);
  } catch (error) {
    const issues = researchVerifyIssues(error);
    if (issues) {
      return { status: 422, body: { error: "verify_failed", issues, request_id: requestId } };
    }
    throw error;
  } finally {
    // Single-use gate: plan dikonsumsi saat run selesai (sukses/gagal).
    takeStagedResearchPlan(planId);
    finishResearchRun(planId);
  }
  storeResearchReport(result.report);
  rememberResearchRunReport(planId, result.report.reportId);
  return {
    status: 200,
    body: {
      report: result.report,
      request_id: requestId,
    },
  };
}

/**
 * Dae Captain workflow helpers (PR1). The router never calls engine
 * classes directly: dispatch reuses createTaskCore (same boundary as
 * POST /tasks) and stageResearchPlanCore (same boundary as
 * POST /research/plan), so the engine-separation rule holds.
 */

/** Poll a dispatched task until it leaves the active states. */
async function waitForCaptainTask(
  tasks: TaskStore,
  taskId: string,
  timeoutMs = 90 * 60 * 1000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const state = tasks.loadState<{ status?: string }>(taskId);
    const status = typeof state?.status === "string" ? state.status : "";
    if (status === "done" || status === "failed" || status === "cancelled") return status;
    if (Date.now() - start > timeoutMs) return "timeout";
    await new Promise((r) => setTimeout(r, 2000));
  }
}

type CaptainSubTaskState = NonNullable<CaptainPlanExecution["subTasks"]>[number];

/** Dispatch + await one plan sub-task, then record its outcome. */
async function runCaptainSubTask(
  ctx: AppContext,
  staged: StagedTaskPlan,
  sub: CaptainSubTaskState,
  requestId: string,
): Promise<void> {
  const exec = staged.execution;
  if (!exec) return;
  const home = resolveDaedalusHome(ctx.settings.daedalusHome, staged.workspaceRoot);
  const tasks = new TaskStore(home);
  sub.status = "running";
  try {
    // Consumer-after-producer: thread the producers' short notes into the
    // consumer's goal so the engine sees "dari hasil ..." context.
    let goal = sub.goal;
    const notes = sub.dependsOn
      .map((d) => exec.subTasks.find((x) => x.sub_id === d)?.resultNote)
      .filter((n): n is string => !!n);
    if (notes.length > 0) goal += "\n\nKonteks dari sub-task sebelumnya:\n" + notes.join("\n");

    if (sub.engine === "research") {
      const stagedPlan = await stageResearchPlanCore(
        ctx,
        { question: goal, root: staged.workspaceRoot },
        requestId,
      );
      if (stagedPlan.status !== 200 || !stagedPlan.planId) {
        throw new Error("gagal menyiapkan rencana riset");
      }
      sub.task_id = stagedPlan.planId;
      appendPlanSubTaskTurn(ctx, staged, sub);
      const runOut = await runStagedResearchPlanCore(ctx, { planId: stagedPlan.planId }, requestId);
      if (runOut.status !== 200) {
        const body = runOut.body as { error?: string; issues?: unknown };
        throw new Error(
          body?.error === "verify_failed"
            ? "riset gagal verifikasi"
            : `riset gagal (${body?.error ?? runOut.status})`,
        );
      }
      const report = (runOut.body as { report?: { reportId?: string; summary?: string } })?.report;
      sub.resultNote = `Riset selesai (report ${report?.reportId ?? "-"}): ${(report?.summary ?? "").slice(0, 400)}`;
    } else {
      const created = await createTaskCore(
        ctx,
        {
          goal,
          repo_path: staged.workspaceRoot,
          ...(sub.engine === "coding" ? {} : { domain: sub.engine }),
        },
        requestId,
      );
      if (created.status !== 201 || !created.taskId) {
        throw new Error(`dispatch gagal (${created.status})`);
      }
      sub.task_id = created.taskId;
      appendPlanSubTaskTurn(ctx, staged, sub);
      const finalStatus = await waitForCaptainTask(tasks, created.taskId);
      if (finalStatus !== "done") throw new Error(`sub-task ${finalStatus}`);
      const report = tasks.loadReport<{ summary?: string; title?: string }>(created.taskId);
      const note = report?.summary ?? report?.title ?? "";
      if (note) sub.resultNote = `Sub-task ${sub.sub_id} selesai: ${String(note).slice(0, 400)}`;
    }
    sub.status = "done";
  } catch (error) {
    sub.status = "failed";
    sub.error = errorMessage(error).slice(0, 300);
  }
}

/** Record a plan sub-task as a run turn so Antrean/chat can follow it. */
function appendPlanSubTaskTurn(
  ctx: AppContext,
  staged: StagedTaskPlan,
  sub: CaptainSubTaskState,
): void {
  try {
    const runs = new WorkflowRunStore(
      resolveDaedalusHome(ctx.settings.daedalusHome, staged.workspaceRoot),
    );
    const run = runs.loadRun(staged.runId);
    if (!run) return;
    appendTurn(run, {
      engine: sub.engine as WorkflowEngine,
      task_id: sub.task_id ?? sub.sub_id,
      goal: sub.goal,
      status: "running",
      note: `rencana ${staged.plan.id} · ${sub.sub_id}`,
    });
    runs.saveRun(run);
  } catch {
    /* monitoring nicety — never fails the sub-task */
  }
}

/**
 * Background plan executor: Kahn waves over dependsOn, max 3 parallel per
 * wave (the decompose design's ceiling). A failed sub-task skips its
 * dependents but never stops the others. Mutates staged.execution in
 * place; the chat card polls GET /captain/plans/:id.
 */
async function runCaptainPlanExecution(
  ctx: AppContext,
  staged: StagedTaskPlan,
  requestId: string,
): Promise<void> {
  const exec = staged.execution;
  if (!exec) return;
  const remaining = new Set(exec.subTasks.map((s) => s.sub_id));
  const doneOk = new Set<string>();
  const failed = new Set<string>();
  const isDone = (id: string) => doneOk.has(id);
  const isFailed = (id: string) => failed.has(id);
  while (remaining.size > 0) {
    // Dependents of failed sub-tasks can never run: skip them now so the
    // wave below never deadlocks waiting on an impossible dependency.
    for (const s of exec.subTasks) {
      if (remaining.has(s.sub_id) && s.status === "waiting" && s.dependsOn.some(isFailed)) {
        s.status = "skipped";
        s.error = "dependensi gagal";
        remaining.delete(s.sub_id);
        failed.add(s.sub_id);
      }
    }
    const ready = exec.subTasks.filter(
      (s) => remaining.has(s.sub_id) && s.status === "waiting" && s.dependsOn.every(isDone),
    );
    if (ready.length === 0) {
      // Nothing dispatchable left (dependency cycle): skip honestly.
      for (const s of exec.subTasks) {
        if (remaining.has(s.sub_id)) {
          s.status = "skipped";
          s.error = s.error ?? "dependensi tidak terpenuhi";
          remaining.delete(s.sub_id);
        }
      }
      break;
    }
    const batch = ready.slice(0, 3);
    await Promise.all(batch.map((s) => runCaptainSubTask(ctx, staged, s, requestId)));
    for (const s of batch) {
      if (s.status === "done") doneOk.add(s.sub_id);
      else if (s.status === "failed" || s.status === "skipped") failed.add(s.sub_id);
    }
  }
  exec.status = exec.subTasks.some((s) => s.status === "failed") ? "done_with_failures" : "done";
  exec.finishedAt = new Date().toISOString();
}

/**
 * The provider + model the companion actually picked in Settings — chat
 * and Layer-B routing honor it, instead of always using the first enabled
 * registry entry (which made the whole Model AI section a dead control).
 * Returns { error } (never a throw) when the pick names something missing,
 * disabled, or URL-less, so callers can say exactly what is wrong instead
 * of failing downstream in a confusing way.
 */
function resolveChatProvider(ctx: AppContext): { provider: LLMProvider } | { error: string } | { missing: true } {
  const selection = { providerId: ctx.session.providerId, model: ctx.session.model, poolModels: [] as string[] };
  if (selection.providerId) {
    const picked = ctx.providerStore.registry.get(selection.providerId);
    if (!picked) {
      return { error: `Provider pilihan ("${selection.providerId}") tidak ditemukan. Pilih ulang di Pengaturan.` };
    }
    if (picked.enabled === false) {
      return { error: `Provider "${selection.providerId}" dinonaktifkan. Aktifkan dulu di Pengaturan.` };
    }
    if (!picked.baseUrl) {
      return { error: `Provider "${selection.providerId}" belum punya base URL. Lengkapi di Pengaturan.` };
    }
  }
  const provider = resolveFastPathProvider(ctx, selection);
  if (!provider) return { missing: true };
  return { provider };
}

/** Layer B: one cheap model call, only for ambiguous messages. */
async function runWorkflowLayerB(
  ctx: AppContext,
  message: string,
): Promise<LayerBResult | undefined> {
  const resolved = resolveChatProvider(ctx);
  if (!("provider" in resolved)) return undefined;
  const provider = resolved.provider;
  const prompt = buildLayerBPrompt(message);
  try {
    const response = await provider.chat([
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ]);
    const content = response.message.content;
    return parseLayerBResponse(
      typeof content === "string" ? content : "",
    );
  } catch (error) {
    ctx.log.error("workflow layer-B router failed", {
      error: String(error),
    });
    return undefined;
  }
}

/**
 * Dae Captain chat-kind turns: memory, attachments, regenerate, streaming.
 *
 * Chat exchanges live in the workspace ConversationStore keyed by the
 * workflow run id — one file per session, next to the run file. Follow-ups
 * ride the recent turns (plus prior dispatched-task goals) back into the
 * prompt, so "jelaskan lebih dalam" continues instead of starting cold. A
 * new run id (/clear, fresh boot) trivially starts cold: nothing is
 * inherited, nothing is deleted (old sessions stay on disk for /history).
 */
const CHAT_SYSTEM_PROMPT =
  "Kamu Dae Captain, asisten AI yang ramah dan membantu. " +
  "Balas dengan singkat dan natural dalam bahasa Indonesia. " +
  "Kamu bisa membantu membuat kode, slide presentasi, dokumen, spreadsheet, dan riset — " +
  "tapi untuk obrolan biasa cukup ngobrol saja, jangan tanya mau pakai engine apa.";

/** No provider configured and the model cannot answer at all. */
const CHAT_FALLBACK = "Halo! Ada yang bisa dibantu?";

export type ChatAttachmentIn = {
  name: string;
  mime: string;
  /** data: URL — validated images only. */
  data_url?: string;
  /** Inline excerpt — validated text files only. */
  text?: string;
};

/** Mirrors the companion's CHAT_ATTACH_LIMITS (logic.js) — enforced here, never trusted. */
const CHAT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const CHAT_TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json",
  "text/html", "text/css", "text/javascript", "application/javascript",
  "text/x-python", "application/x-python", "text/yaml", "application/yaml",
  "application/toml", "text/xml", "application/xml", "text/x-sh",
]);
const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CHAT_TEXT_MAX_CHARS = 20_000;
const CHAT_MAX_ATTACHMENTS = 4;

function approxDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Math.floor(b64.replace(/[^A-Za-z0-9+/=]/g, "").length * 3 / 4);
}

/** Validate client-supplied chat attachments. Throws a named 400 on abuse. */
function parseChatAttachments(raw: unknown): ChatAttachmentIn[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CHAT_MAX_ATTACHMENTS) {
    throw new Error("invalid_attachment");
  }
  return raw.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("invalid_attachment");
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const mime = typeof record.mime === "string" ? record.mime.toLowerCase() : "";
    if (!name || name.length > 120 || name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new Error("invalid_attachment");
    }
    if (CHAT_IMAGE_MIMES.has(mime)) {
      const dataUrl = typeof record.data_url === "string" ? record.data_url : "";
      if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
        throw new Error("invalid_attachment");
      }
      if (approxDataUrlBytes(dataUrl) > CHAT_IMAGE_MAX_BYTES) throw new Error("attachment_too_large");
      return { name, mime, data_url: dataUrl };
    }
    if (CHAT_TEXT_MIMES.has(mime)) {
      const text = typeof record.text === "string" ? record.text : "";
      if (!text.trim() || text.length > CHAT_TEXT_MAX_CHARS) throw new Error("invalid_attachment");
      return { name, mime, text };
    }
    throw new Error("unsupported_attachment");
  });
}

/** Persist chat images under the workspace (record + regenerate can re-read them). */
function persistChatImages(root: string, runId: string, attachments: ChatAttachmentIn[]): Map<number, string> {
  const saved = new Map<number, string>();
  attachments.forEach((attachment, index) => {
    if (!attachment.data_url) return;
    try {
      const safe = attachment.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "image";
      const dir = join(root, ".daedalus", "attachments", "chat");
      mkdirSync(dir, { recursive: true });
      const absolute = join(dir, `${runId.slice(0, 8)}-${index}-${safe}`);
      writeFileSync(absolute, Buffer.from(attachment.data_url.slice(attachment.data_url.indexOf(",") + 1), "base64"));
      saved.set(index, absolute);
    } catch {
      /* marker falls back to the bare name below */
    }
  });
  return saved;
}

function chatRecordText(message: string, attachments: ChatAttachmentIn[], saved: Map<number, string>): string {
  if (attachments.length === 0) return message;
  const markers = attachments.map((attachment, index) => {
    const where = saved.get(index);
    return attachment.data_url
      ? `[lampiran gambar: ${attachment.name}${where ? ` @ ${where}` : ""}]`
      : `[lampiran teks ${attachment.name}:]\n${attachment.text}`;
  });
  return `${message}\n${markers.join("\n")}`;
}

/** Prior dispatched-task goals as context, so "jelaskan lebih dalam" can refer to them. */
function dispatchedGoalsNote(run: RunContext): string | undefined {
  if (run.turns.length === 0) return undefined;
  const lines = run.turns.slice(-5).map((turn) => `- ${turn.goal} (${turn.engine}, ${turn.status})`);
  return ["Tugas sebelumnya di sesi ini (acuan, jangan diulang):", ...lines].join("\n");
}

function buildChatMessages(input: {
  history: ConversationTurn[];
  goalsNote?: string;
  message: string;
  attachments: ChatAttachmentIn[];
}): Message[] {
  const imageBlocks: ContentBlock[] = [];
  const notes: string[] = [];
  for (const attachment of input.attachments) {
    if (attachment.data_url) {
      imageBlocks.push({ type: "image_url", image_url: { url: attachment.data_url } });
      notes.push(`[gambar: ${attachment.name}]`);
    } else {
      notes.push(`[teks terlampir ${attachment.name}:]\n${attachment.text}`);
    }
  }
  const userText = notes.length > 0 ? `${input.message}\n${notes.join("\n")}` : input.message;
  const messages: Message[] = [
    {
      role: "system",
      content: CHAT_SYSTEM_PROMPT + (input.goalsNote ? `\n\n${input.goalsNote}` : ""),
    },
    ...historyMessages(input.history),
  ];
  messages.push(
    imageBlocks.length > 0
      ? { role: "user", content: [{ type: "text", text: userText }, ...imageBlocks] }
      : { role: "user", content: userText },
  );
  return messages;
}

function isoNow(): string {
  return new Date().toISOString();
}

function messageContentText(message: { content: unknown }): string | undefined {
  const content = message.content;
  if (typeof content === "string") return content.trim() ? content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
      .map((block) => block.text)
      .join("");
    return text.trim() ? text : undefined;
  }
  return undefined;
}

/**
 * Shared preparation for chat replies (plain + streaming + regenerate):
 * history baseline, persisted images, and the model-ready messages.
 * Persisting is idempotent (same filename per run/index/name).
 */
/**
 * True when the model's history window drops older context — mirroring the
 * caps recentTurns enforces, so the UI can say so instead of silently
 * forgetting. Evaluated on the exact baseline the prompt is built from.
 */
function isHistoryClipped(history: ConversationTurn[]): boolean {
  let used = 0;
  let kept = 0;
  for (let index = history.length - 1; index >= 0 && kept < MAX_HISTORY_TURNS; index--) {
    const cost = Math.min(history[index]!.text.length, 1200);
    if (kept > 0 && used + cost > MAX_HISTORY_CHARS) return true;
    used += cost;
    kept++;
  }
  if (kept < history.length) return true;
  return history.some((turn) => turn.text.length > 1200);
}

function prepareChatTurn(
  ctx: AppContext,
  root: string,
  run: RunContext,
  input: { message: string; attachments: ChatAttachmentIn[]; regenerate: boolean },
): { store: ConversationStore; history: ConversationTurn[]; messages: Message[]; recordText: string; clipped: boolean } {
  const store = conversationStoreFor(ctx, root);
  const ensured = store.ensure(root, run.run_id);
  let history = ensured.turns;
  if (input.regenerate && history.length > 0 && history[history.length - 1]?.role === "assistant") {
    // Persist the drop: the previous answer is replaced, not stacked.
    history = history.slice(0, -1);
    store.replaceTurns(root, run.run_id, history);
  }
  const clipped = isHistoryClipped(history);
  const saved = persistChatImages(root, run.run_id, input.attachments);
  const recordText = chatRecordText(input.message, input.attachments, saved);
  const messages = buildChatMessages({
    history,
    goalsNote: dispatchedGoalsNote(run),
    message: input.message,
    attachments: input.attachments,
  });
  return { store, history, messages, recordText, clipped };
}

/**
 * Non-streaming chat reply with memory: the recent turns of THIS run ride
 * along, then the exchange is appended. Returns undefined only when no
 * provider is configured (the caller falls back to the greeting).
 */
async function runChatReply(
  ctx: AppContext,
  root: string,
  run: RunContext,
  runs: WorkflowRunStore,
  input: { message: string; attachments: ChatAttachmentIn[]; regenerate: boolean },
): Promise<{ text: string; clipped: boolean; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | undefined> {
  const prep = prepareChatTurn(ctx, root, run, input);
  const resolved = resolveChatProvider(ctx);
  if ("error" in resolved) throw new Error(`misconfigured:${resolved.error}`);
  if (!("provider" in resolved)) return undefined;
  const provider = resolved.provider;
  try {
    const response = await provider.chat(prep.messages);
    const text = messageContentText(response.message);
    if (!text) return undefined;
    if (!input.regenerate) {
      prep.store.append(root, run.run_id, { role: "user", text: prep.recordText, ts: isoNow() });
    }
    prep.store.append(root, run.run_id, { role: "assistant", text, ts: isoNow() });
    runs.saveRun(run); // touch: active chats sort newest-first in /history
    return { text, clipped: prep.clipped, ...(response.usage ? { usage: response.usage } : {}) };
  } catch (error) {
    ctx.log.error("workflow chat reply failed", { error: String(error) });
    throw new Error("model_unavailable");
  }
}

type ChatRoute =
  | { kind: "chat" }
  | { kind: "dispatch"; engine: WorkflowEngine; confidence: number; matchedRule: string; routerLayer: string };

/**
 * Route a chat message, shared by POST /workflow/chat and its streaming
 * sibling: override > conversational-first > rules > layer B > chat.
 * A question ABOUT work is never permission to execute it.
 */
async function routeChatMessage(
  ctx: AppContext,
  message: string,
  run: RunContext,
  overrideRaw: unknown,
): Promise<ChatRoute> {
  if (!overrideRaw && isConversationalMessage(message)) return { kind: "chat" };
  const previousEngine = lastTurn(run)?.engine;
  let routed = routeByRules(message, {
    ...(overrideRaw ? { engineOverride: overrideRaw as WorkflowEngine } : {}),
    ...(previousEngine ? { previousEngine } : {}),
  });
  let routerLayer = "rules";
  if (!overrideRaw && routed.confidence < RULE_CONFIDENCE_THRESHOLD) {
    const lb = await runWorkflowLayerB(ctx, message);
    if (lb && !lb.needs_clarify && lb.confidence >= RULE_CONFIDENCE_THRESHOLD) {
      routed = { engine: lb.engine, confidence: lb.confidence, matchedRule: "llm_fallback" };
      routerLayer = "llm";
    } else {
      // Chat-first: the router cannot confidently dispatch — reply
      // conversationally instead of asking "which engine?".
      return { kind: "chat" };
    }
  }
  return { kind: "dispatch", engine: routed.engine, confidence: routed.confidence, matchedRule: routed.matchedRule, routerLayer };
}

/** Load an existing run or start a fresh one (a fresh id = cold context). */
function loadOrCreateChatRun(
  runs: WorkflowRunStore,
  root: string,
  runIdRaw: string | undefined,
): { run: RunContext } | { missing: true } {
  const run = runIdRaw ? runs.loadRun(runIdRaw) : undefined;
  if (runIdRaw && !run) return { missing: true };
  if (run) return { run };
  const fresh = createWorkflowRun(root);
  runs.saveRun(fresh);
  return { run: fresh };
}

/**
 * The dispatch half of POST /workflow/chat, shared with the stream route
 * (which returns this identical JSON when the message turns out to be
 * work). Returns { status, body } — the caller sends the HTTP response.
 */
async function dispatchChatTurn(
  ctx: AppContext,
  input: {
    root: string;
    run: RunContext;
    runs: WorkflowRunStore;
    engine: WorkflowEngine;
    confidence: number;
    matchedRule: string;
    routerLayer: string;
    message: string;
    overrideRaw: unknown;
    explicitWorkspace: string;
    providerId?: string;
    model?: string;
    requestId: string;
  },
): Promise<{ status: number; body: unknown }> {
  const { root, run, runs, engine, confidence, matchedRule, routerLayer, message, overrideRaw, explicitWorkspace, providerId, model, requestId } = input;

  // Disabled engines (Dae Captain "Agentic Systems" toggles) are
  // never dispatched to. An explicit override is a client error;
  // an auto-route becomes an honest message over enabled engines.
  const disabledEngines = ctx.session.disabledEngines ?? [];
  if (disabledEngines.includes(engine)) {
    if (overrideRaw) {
      return { status: 400, body: { error: "engine_disabled", engine, request_id: requestId } };
    }
    const enabled = WORKFLOW_ENGINES.filter((e) => !disabledEngines.includes(e));
    return {
      status: 200,
      body: {
        run_id: run.run_id,
        kind: "chat",
        text: `Engine ${engine} sedang nonaktif. Aktifkan dulu di Pengaturan, atau pilih salah satu yang aktif: ${enabled.join(", ")}.`,
        request_id: requestId,
      },
    };
  }

  // Workspace on-demand: work commands need an explicit workspace.
  // Chat replies don't. If the client hasn't picked one (and the
  // session doesn't remember one), ask instead of silently using cwd.
  if (!explicitWorkspace && !ctx.session.workspaceRoot) {
    return {
      status: 200,
      body: {
        run_id: run.run_id,
        kind: "need_workspace",
        message: "Pilih folder workspace dulu — file yang dibuat akan ditulis di sana.",
        request_id: requestId,
      },
    };
  }

  const resolved = resolveReferences(message, run);
  const goal = message + formatResolvedForGoal(resolved);
  const routerInfo = { layer: routerLayer, confidence, rule: matchedRule };

  // Dae Captain v2 Fase 7 — multi-engine goals decompose into a plan card
  // (core/src/workflow/decompose.ts planTask, staged like research plans)
  // instead of a single-engine task. An explicit engine override always
  // wins; single-engine goals keep the exact old path below.
  // NOTE: planTask sees the RAW message, not the resolved goal — the
  // appended "Konteks" block's bullet lines would otherwise split into
  // phantom fragments and turn every continuation ("dari X tadi …")
  // into a spurious multi-engine plan. planTask resolves "tadi" itself
  // from the run timeline for contextRefs.
  if (!overrideRaw) {
    const taskPlan = planTask(message, run);
    if (taskPlan.showPlanCard) {
      sweepStagedTaskPlans();
      stagedTaskPlans.set(taskPlan.id, {
        plan: taskPlan,
        runId: run.run_id,
        workspaceRoot: root,
        createdAt: Date.now(),
      });
      const turn = appendTurn(run, {
        engine,
        task_id: taskPlan.id,
        goal: message,
        status: "running",
        note: "rencana multi-engine staged — menunggu 'Jalankan'",
      });
      runs.saveRun(run);
      return {
        status: 200,
        body: {
          run_id: run.run_id, turn_id: turn.turn_id, engine,
          plan_id: taskPlan.id, plan: taskPlan, staged: true,
          resolved_artifacts: resolved, router: routerInfo, request_id: requestId,
        },
      };
    }
  }

  if (engine === "research") {
    const staged = await stageResearchPlanCore(
      ctx,
      { question: goal, root, ...(providerId ? { provider_id: providerId } : {}), ...(model ? { model } : {}) },
      requestId,
    );
    if (staged.status !== 200 || !staged.planId) return { status: staged.status, body: staged.body };
    const turn = appendTurn(run, {
      engine: "research",
      task_id: staged.planId,
      goal: message,
      status: "running",
      note: "rencana riset staged — menunggu 'Jalankan riset'",
    });
    runs.saveRun(run);
    return {
      status: 200,
      body: {
        run_id: run.run_id, turn_id: turn.turn_id, engine: "research",
        plan_id: staged.planId, staged: true, resolved_artifacts: resolved,
        router: routerInfo, request_id: requestId,
      },
    };
  }

  const created = await createTaskCore(
    ctx,
    {
      goal,
      repo_path: root,
      ...(engine === "coding" ? {} : { domain: engine }),
      ...(providerId ? { provider_id: providerId } : {}),
      ...(model ? { model } : {}),
    },
    requestId,
  );
  if (created.status !== 201 || !created.taskId) return { status: created.status, body: created.body };
  const turn = appendTurn(run, { engine, task_id: created.taskId, goal: message, status: "running" });
  runs.saveRun(run);
  return {
    status: 201,
    body: {
      run_id: run.run_id, turn_id: turn.turn_id, engine,
      task_id: created.taskId, resolved_artifacts: resolved,
      router: routerInfo, request_id: requestId,
    },
  };
}

/**
 * Reconcile a run's running turns against the live runners and persisted
 * task state. Mutates the run; returns true when anything changed (caller
 * saves). Research turns resolve via the plan→report mapping.
 */
function reconcileWorkflowRun(ctx: AppContext, run: RunContext): boolean {
  const home = resolveDaedalusHome(ctx.settings.daedalusHome, run.workspace_root);
  const tasks = new TaskStore(home);
  let changed = false;
  for (const turn of run.turns) {
    if (turn.status !== "running") continue;
    if (turn.engine === "research") {
      const reportId = getResearchRunReportId(turn.task_id);
      if (reportId) {
        const report = getResearchReport(reportId) as
          | { title?: string }
          | undefined;
        updateTurn(run, turn.turn_id, {
          status: "done",
          artifacts: translateArtifacts({
            engine: "research",
            goal: turn.goal,
            workspaceRoot: run.workspace_root,
            researchReport: {
              reportId,
              ...(report?.title ? { title: report.title } : {}),
            },
          }),
        });
        changed = true;
      } else if (!peekStagedResearchPlan(turn.task_id)) {
        updateTurn(run, turn.turn_id, {
          status: "failed",
          note: "rencana riset tidak ditemukan (kedaluwarsa?)",
        });
        changed = true;
      }
      continue;
    }
    if (ctx.activeRunners.has(turn.task_id)) continue;
    const state = tasks.loadState<{ status?: string; last_error?: unknown }>(turn.task_id);
    if (state?.status === "done") {
      const report = tasks.loadReport<FinalReport>(turn.task_id);
      updateTurn(run, turn.turn_id, {
        status: "done",
        artifacts: translateArtifacts({
          engine: turn.engine,
          goal: turn.goal,
          workspaceRoot: run.workspace_root,
          report: report
            ? {
                diff: report.diff,
                evidence: report.evidence,
                target_dir: report.target_dir,
                title: report.title,
              }
            : null,
        }),
      });
      changed = true;
    } else if (state?.status === "failed") {
      // Surface the task's own error on the turn so the companion can
      // show WHY it failed instead of a bare "Failed" badge.
      const err =
        typeof state.last_error === "string" && state.last_error.trim()
          ? state.last_error.trim().slice(0, 300)
          : undefined;
      updateTurn(run, turn.turn_id, {
        status: "failed",
        ...(err ? { note: err } : {}),
      });
      changed = true;
    } else if (!state) {
      // No runner and no persisted state: the task is gone (e.g. the
      // server restarted mid-run). Fail honestly instead of spinning.
      updateTurn(run, turn.turn_id, {
        status: "failed",
        note: "task tidak ditemukan (server mungkin restart)",
      });
      changed = true;
    }
    // 'created'/'pending'/'active' without a runner: left running — the
    // runner registers before its first event; boot sweeps the rest.
  }
  return changed;
}

/** Live detail for one turn, for the companion. */
function presentWorkflowTurn(
  ctx: AppContext,
  tasks: TaskStore,
  turn: RunTurn,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    turn_id: turn.turn_id,
    engine: turn.engine,
    task_id: turn.task_id,
    goal: turn.goal,
    status: turn.status,
    artifacts: turn.artifacts,
    ...(turn.note ? { note: turn.note } : {}),
    created_at: turn.created_at,
    updated_at: turn.updated_at,
  };
  if (turn.status !== "running") return base;
  // Cooperative pause (Dae Captain pill ⏸): the marker survives even
  // without a live runner, so the pill can show "paused" honestly.
  const paused = tasks.isPauseRequested(turn.task_id);
  if (turn.engine === "research") {
    return {
      ...base,
      live: peekStagedResearchPlan(turn.task_id)
        ? "staged_awaiting_gate"
        : "running",
      ...(paused ? { paused: true } : {}),
    };
  }
  const runner = ctx.activeRunners.get(turn.task_id);
  if (!runner) {
    // No live runner: either queued (task created/pending, not picked up
    // yet) or orphaned (reconcile() will settle it). The pill shows
    // "queued" only for the former — never for a dead task.
    const taskState = tasks.loadState<{ status?: string }>(turn.task_id);
    const taskStatus = typeof taskState?.status === "string" ? taskState.status : "";
    const queued = taskStatus === "created" || taskStatus === "pending" || taskStatus === "";
    return {
      ...base,
      ...(paused ? { paused: true } : {}),
      ...(queued ? { queued: true } : {}),
    };
  }
  const stats = tasks.eventStats(turn.task_id);
  const lastText = tasks.lastEventText(turn.task_id);
  return {
    ...base,
    live: "running",
    ...(stats.lastType ? { last_event: stats.lastType } : {}),
    ...(stats.lastTs ? { last_event_ts: stats.lastTs } : {}),
    // Engine's own latest narration ("Mengisi slide 8/12…") — the pill's
    // phase line and progress ring read this, never a fabricated number.
    ...(lastText ? { last_event_text: lastText } : {}),
    ...(paused ? { paused: true } : {}),
    // Consecutive validation failures → the pill's "Memperbaiki (n/2)".
    // Only meaningful while the engine is still retrying (last event
    // is the failure itself); otherwise the field is omitted.
    ...(stats.lastType === "VALIDATION_FAILED"
      ? { validation_failures: tasks.countEventType(turn.task_id, "VALIDATION_FAILED") }
      : {}),
    pending_approvals: runner.approvals.pending().map((entry) => ({
      // `id` first: the companion resolves approvals by id
      // (`POST /tasks/:id/approvals/:approvalId`), which searches every
      // active runner. The key-addressed route needs the task's own runner
      // and 404s `runner_not_found` once the server restarted mid-run.
      id: entry.info.id,
      key: entry.key,
      tool: entry.info.tool,
      policy: entry.policy,
    })),
    // Full card data: the companion renders the question text plus its
    // 2-4 option buttons (and free text when allowed) — an id alone left
    // the user guessing what to type.
    pending_questions: runner.questions.pending().map((entry) => ({
      id: entry.info.id,
      task_id: turn.task_id,
      question: entry.info.question,
      options: entry.info.options,
      allow_free_text: entry.info.allowFreeText,
    })),
  };
}

/** Chat exchanges of one run (bounded, oldest first) for /history + /resume. */
function chatExcerpt(
  ctx: AppContext,
  run: RunContext,
): { count: number; messages: Array<{ role: string; text: string; ts: string }> } {
  try {
    const turns = conversationStoreFor(ctx, run.workspace_root).load(run.run_id)?.turns ?? [];
    return {
      count: turns.length,
      messages: recentTurns(turns).map((turn) => ({ role: turn.role, text: turn.text, ts: turn.ts })),
    };
  } catch {
    return { count: 0, messages: [] };
  }
}

function presentWorkflowRun(
  ctx: AppContext,
  run: RunContext,
): Record<string, unknown> {
  const home = resolveDaedalusHome(ctx.settings.daedalusHome, run.workspace_root);
  const tasks = new TaskStore(home);
  const chat = chatExcerpt(ctx, run);
  return {
    run_id: run.run_id,
    workspace_root: run.workspace_root,
    created_at: run.created_at,
    updated_at: run.updated_at,
    turns: run.turns.map((turn) => presentWorkflowTurn(ctx, tasks, turn)),
    // Chat-kind exchanges (not engine turns): count for /history labels,
    // messages so /resume restores the visible conversation.
    chat_turns: chat.count,
    chat: chat.messages,
  };
}
/**
 * Local daemon token (FASE 4 security). Generated once, stored in
 * ~/.daedalus/daemon.json. Sensitive endpoints (approve/cancel) require it
 * via `Authorization: Bearer <token>`. The Tauri app reads the same file
 * from disk — no network fetch, no exposure.
 */
export function ensureDaemonToken(daedalusHome: string): string {
  const path = join(daedalusHome, "daemon.json");
  let previous: Record<string, unknown> = {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") previous = parsed;
    if (typeof parsed.token === "string" && parsed.token.length >= 32) {
      return parsed.token;
    }
  } catch {
    /* missing or invalid — generate below */
  }
  const token = randomBytes(32).toString("hex");
  try {
    mkdirSync(daedalusHome, { recursive: true });
    // Preserve sidecar fields (pid/host/port/started_at/...) when present:
    // overwriting daemon.json with only {token} breaks `daedalus status`.
    writeFileSync(path, JSON.stringify({ ...previous, token }, null, 2) + "\n");
  } catch {
    /* best effort — token still returned for this process */
  }
  return token;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1];
}


export function createApp(ctx: AppContext) {
  reconcileInterruptedTasks(ctx);
  // Local daemon token for sensitive endpoints (approve/cancel). Anchored to
  // the session workspace so DAEDALUS_WORKSPACE sidecars, the Tauri
  // `daemon_token(workspace)` command, and the CLI read the same file —
  // the old cwd-anchored path broke approvals whenever cwd != workspace.
  if (!ctx.daemonToken) {
    ctx.daemonToken = ensureDaemonToken(
      resolveDaedalusHome(ctx.settings.daedalusHome, ctx.session.workspaceRoot || ctx.cwd),
    );
  }
  // Permanent bundled skills: make sure the starter set is installed in the
  // Daedalus-global skills dir at startup, so the Web inventory (Settings →
  // Extensions) shows them even before the first task runs. Idempotent and
  // never overwrites existing copies; failures must not take the server down.
  void ensureBundledSkillsInstalled().catch(() => undefined);
  const slidePreview = ctx.slidePreview ?? new SlidePreviewService();
  const previewPageUrl = (root: string, key: string, page: number): string =>
    `/slides/deck/preview/page?root=${encodeURIComponent(root)}&key=${key}&page=${page}`;
  const sheetPreview = ctx.sheetPreview ?? new SheetPreviewService();
  const sheetPreviewPageUrl = (root: string, key: string, page: number): string =>
    `/sheets/workbook/preview/page?root=${encodeURIComponent(root)}&key=${key}&page=${page}`;
  const dokumenPreview = ctx.dokumenPreview ?? new DokumenPreviewService();
  const dokumenPreviewPageUrl = (root: string, key: string, page: number): string =>
    `/dokumen/preview/page?root=${encodeURIComponent(root)}&key=${key}&page=${page}`;  // Mirror the harness' command lifecycle into the per-workspace agent
  // terminal sink (the root is resolved from the owning task's state —
  // event payloads do not carry it).
  ctx.terminals.attach(ctx.bus, (taskId) => {
    const lookup = findTask(ctx, taskId);
    const state = (lookup?.state ?? {}) as { repo_path?: unknown; spec?: { repo_path?: unknown } };
    const repoPath = typeof state.repo_path === "string" ? state.repo_path : typeof state.spec?.repo_path === "string" ? state.spec.repo_path : undefined;
    return repoPath ? resolve(repoPath) : undefined;
  });
  return createServer((req, res) => {
    const requestId = crypto.randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "daedalus-server",
        uptime_ms: Date.now() - ctx.startedAt,
        active_tasks: ctx.activeRunners.size,
        workspace_root: ctx.session.workspaceRoot,
        request_id: requestId,
      });
      return;
    }

    if (method === "GET" && serveWebAsset(ctx, res, url.pathname, req.headers.accept ?? "")) {
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      sendJson(res, 200, {
        service: "daedalus-server",
        status: "ok",
        health: "/health",
        web: "Run the Daedalus Web UI and point it at this server URL.",
        session: publicSession(ctx),
        request_id: requestId,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/settings") {
      void (async () => {
        await ensureProvidersLoaded(ctx);
        sendJson(res, 200, { settings: redactSettings(ctx.settings), session: publicSession(ctx), providers: ctx.providerStore.registry.list() });
      })();
      return;
    }

    if ((method === "PUT" || method === "PATCH" || method === "POST") && url.pathname === "/settings") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          applySettingsUpdate(ctx, parsed);
          sendJson(res, 200, { settings: redactSettings(ctx.settings), session: publicSession(ctx) });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/session") {
      sendJson(res, 200, { session: publicSession(ctx) });
      return;
    }

    if ((method === "PUT" || method === "PATCH" || method === "POST") && url.pathname === "/session") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          applySessionUpdate(ctx, parsed);
          sendJson(res, 200, { session: publicSession(ctx) });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/session/mode") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        const mode = parsed.cycle === true ? nextMode(ctx.session.mode) : parseMode(parsed.mode);
        if (!mode) {
          sendJson(res, 400, { error: "invalid_mode", modes: AGENT_MODES, request_id: requestId });
          return;
        }
        ctx.session.mode = mode;
        sendJson(res, 200, { session: publicSession(ctx) });
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/session/auto-approve") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed || typeof parsed.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled_boolean_required", request_id: requestId });
          return;
        }
        ctx.session.autoApprove = parsed.enabled;
        sendJson(res, 200, { session: publicSession(ctx) });
      })();
      return;
    }

    if (url.pathname === "/terminals" || url.pathname.startsWith("/terminals/")) {
      void handleTerminals(ctx, req, res, url, method, requestId);
      return;
    }

    if (url.pathname === "/providers" || url.pathname.startsWith("/providers/")) {
      void handleProviders(ctx, req, res, url, method, requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/models") {
      void (async () => {
        await ensureProvidersLoaded(ctx);
        const providerId = url.searchParams.get("provider_id") ?? url.searchParams.get("providerId") ?? undefined;
        const models = await ctx.providerStore.registry.listModels(providerId);
        sendJson(res, 200, { models, session: publicSession(ctx), count: models.length });
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/extensions/status") {
      void (async () => {
        try {
          const status = await extensionStatus(ctx, url.searchParams.get("root") || ctx.session.workspaceRoot || ctx.cwd);
          sendJson(res, 200, status);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Per-workspace skill toggle: writes the same .daedalus/skills.json
    // the core loader and the CLI read, so Web, CLI, and task runs agree
    // on which skill names this workspace disables. Disabling is
    // name-based: every origin copy of the name is excluded.
    if (method === "POST" && url.pathname === "/extensions/skills/toggle") {
      void (async () => {
        try {
          const parsed = await readJson(req);
          if (!parsed) {
            sendJson(res, 400, { error: "invalid_json", request_id: requestId });
            return;
          }
          const root = resolveAllowedRoot(ctx, parsed.root ?? ctx.session.workspaceRoot ?? ctx.cwd);
          const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
          if (!name) {
            sendJson(res, 400, { error: "skill_name_required", request_id: requestId });
            return;
          }
          if (typeof parsed.disabled !== "boolean") {
            sendJson(res, 400, { error: "disabled_boolean_required", request_id: requestId });
            return;
          }
          const config = await setSkillDisabled(root, name, parsed.disabled);
          // The write changes what /extensions/status reports: drop the
          // cached snapshot for this root so the next read is fresh.
          ctx.extensionStatusCache?.delete(root);
          sendJson(res, 200, { root, name, disabled: parsed.disabled, disabledSkills: config.disabled, request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Chat conversations: one continuing session per workspace, persisted
    // under its .daedalus home. Tasks and fast-path answers append turns;
    // the Web renders the whole session and prompts carry its memory.
    if (method === "POST" && url.pathname === "/conversations") {
      void (async () => {
        try {
          const parsed = (await readJson(req)) ?? {};
          const root = resolveAllowedRoot(ctx, parsed.root ?? url.searchParams.get("root") ?? ctx.session.workspaceRoot);
          const conversation = conversationStoreFor(ctx, root).create(root);
          sendJson(res, 201, { conversation });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/conversations") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.session.workspaceRoot);
        const conversations = conversationStoreFor(ctx, root).list();
        sendJson(res, 200, { conversations, count: conversations.length, root });
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
      }
      return;
    }

    const conversationMatch = /^\/conversations\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && conversationMatch?.[1] !== undefined) {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.session.workspaceRoot);
        const conversation = conversationStoreFor(ctx, root).load(conversationMatch[1]);
        if (!conversation) {
          sendJson(res, 404, { error: "conversation_not_found", request_id: requestId });
          return;
        }
        sendJson(res, 200, { conversation });
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/tasks") {
      const tasks = allTaskIds(ctx).flatMap((id) => {
        const lookup = findTask(ctx, id);
        return lookup ? [summarizeFrom(ctx, lookup, id)] : [];
      });
      sendJson(res, 200, { tasks, count: tasks.length });
      return;
    }

    if (method === "POST" && url.pathname === "/tasks") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }


        const created = await createTaskCore(ctx, parsed, requestId);
        sendJson(res, created.status, created.body);
      })();
      return;
    }

    // ---- Dae Captain workflow routes (PR1) ----
    // One chat routing to all five engines. Dispatch reuses the exact
    // boundaries above (createTaskCore / stageResearchPlanCore); no engine
    // class is ever touched directly here.
    if (method === "POST" && url.pathname === "/workflow/chat") {
      void (async () => {
        try {
          const parsed = await readJson(req);
          if (!parsed) {
            sendJson(res, 400, { error: "invalid_json", request_id: requestId });
            return;
          }
          const message =
            typeof parsed.message === "string" ? parsed.message.trim() : "";
          if (!message) {
            sendJson(res, 400, { error: "message_required", request_id: requestId });
            return;
          }
          const overrideRaw = parsed.engine_override ?? parsed.engineOverride;
          if (overrideRaw !== undefined && !isWorkflowEngine(overrideRaw)) {
            sendJson(res, 400, {
              error: "invalid_engine",
              engines: WORKFLOW_ENGINES,
              request_id: requestId,
            });
            return;
          }
          const root = resolveAllowedRoot(
            ctx,
            parsed.workspace_root ?? parsed.workspaceRoot,
          );
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const runIdRaw =
            typeof parsed.run_id === "string" && parsed.run_id
              ? parsed.run_id
              : undefined;
          const loaded = loadOrCreateChatRun(runs, root, runIdRaw);
          if ("missing" in loaded) {
            sendJson(res, 404, { error: "run_not_found", request_id: requestId });
            return;
          }
          const run = loaded.run;
          const attachments = parseChatAttachments(parsed.attachments);
          const regenerate = parsed.regenerate === true;
          const explicitWorkspace =
            (typeof parsed.workspace_root === "string" &&
              parsed.workspace_root.length > 0 &&
              parsed.workspace_root) ||
            (typeof parsed.workspaceRoot === "string" &&
              parsed.workspaceRoot.length > 0 &&
              parsed.workspaceRoot) ||
            "";
          const providerId =
            typeof parsed.provider_id === "string" ? parsed.provider_id : undefined;
          const model =
            typeof parsed.model === "string" ? parsed.model : undefined;

          const route = await routeChatMessage(ctx, message, run, overrideRaw);
          if (route.kind === "chat") {
            try {
              const reply = await runChatReply(ctx, root, run, runs, { message, attachments, regenerate });
              sendJson(res, 200, {
                run_id: run.run_id,
                kind: "chat",
                text: reply?.text ?? CHAT_FALLBACK,
                clipped: reply?.clipped === true,
                ...(reply?.usage ? { usage: reply.usage } : {}),
                request_id: requestId,
              });
            } catch (error) {
              if (errorMessage(error).startsWith("misconfigured:")) {
                sendJson(res, 200, {
                  run_id: run.run_id,
                  kind: "chat",
                  text: errorMessage(error).slice("misconfigured:".length),
                  request_id: requestId,
                });
                return;
              }
              if (errorMessage(error) === "model_unavailable") {
                sendJson(res, 200, {
                  run_id: run.run_id,
                  kind: "chat",
                  text: "Maaf, model sedang tidak bisa menjawab. Coba lagi sebentar lagi atau ganti model di Pengaturan.",
                  request_id: requestId,
                });
                return;
              }
              throw error;
            }
            return;
          }
          const out = await dispatchChatTurn(ctx, {
            root, run, runs,
            engine: route.engine,
            confidence: route.confidence,
            matchedRule: route.matchedRule,
            routerLayer: route.routerLayer,
            message, overrideRaw, explicitWorkspace,
            ...(providerId ? { providerId } : {}),
            ...(model ? { model } : {}),
            requestId,
          });
          sendJson(res, out.status, out.body);
        } catch (error) {
          sendJson(res, errorStatus(error), {
            error: errorMessage(error),
            request_id: requestId,
          });
        }
      })();
      return;
    }

    // ---- Dae Captain streaming chat (true token streaming over SSE) ----
    // Same routing as POST /workflow/chat: when the message turns out to be
    // work, this returns the identical JSON dispatch shape (the client
    // handles it as usual). Only chat-kind turns stream — and every delta
    // comes from provider.stream(), never synthesized locally.
    if (method === "POST" && url.pathname === "/workflow/chat/stream") {
      void (async () => {
        try {
          const parsed = await readJson(req);
          if (!parsed) {
            sendJson(res, 400, { error: "invalid_json", request_id: requestId });
            return;
          }
          const message =
            typeof parsed.message === "string" ? parsed.message.trim() : "";
          if (!message) {
            sendJson(res, 400, { error: "message_required", request_id: requestId });
            return;
          }
          const overrideRaw = parsed.engine_override ?? parsed.engineOverride;
          if (overrideRaw !== undefined && !isWorkflowEngine(overrideRaw)) {
            sendJson(res, 400, {
              error: "invalid_engine",
              engines: WORKFLOW_ENGINES,
              request_id: requestId,
            });
            return;
          }
          const root = resolveAllowedRoot(
            ctx,
            parsed.workspace_root ?? parsed.workspaceRoot,
          );
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const runIdRaw =
            typeof parsed.run_id === "string" && parsed.run_id
              ? parsed.run_id
              : undefined;
          const loaded = loadOrCreateChatRun(runs, root, runIdRaw);
          if ("missing" in loaded) {
            sendJson(res, 404, { error: "run_not_found", request_id: requestId });
            return;
          }
          const run = loaded.run;
          const attachments = parseChatAttachments(parsed.attachments);
          const regenerate = parsed.regenerate === true;
          const explicitWorkspace =
            (typeof parsed.workspace_root === "string" &&
              parsed.workspace_root.length > 0 &&
              parsed.workspace_root) ||
            (typeof parsed.workspaceRoot === "string" &&
              parsed.workspaceRoot.length > 0 &&
              parsed.workspaceRoot) ||
            "";
          const providerId =
            typeof parsed.provider_id === "string" ? parsed.provider_id : undefined;
          const model =
            typeof parsed.model === "string" ? parsed.model : undefined;

          const route = await routeChatMessage(ctx, message, run, overrideRaw);
          if (route.kind === "dispatch") {
            const out = await dispatchChatTurn(ctx, {
              root, run, runs,
              engine: route.engine,
              confidence: route.confidence,
              matchedRule: route.matchedRule,
              routerLayer: route.routerLayer,
              message, overrideRaw, explicitWorkspace,
              ...(providerId ? { providerId } : {}),
              ...(model ? { model } : {}),
              requestId,
            });
            sendJson(res, out.status, out.body);
            return;
          }

          const prep = prepareChatTurn(ctx, root, run, { message, attachments, regenerate });
          if (!regenerate) {
            prep.store.append(root, run.run_id, { role: "user", text: prep.recordText, ts: isoNow() });
          }
          const resolved = resolveChatProvider(ctx);
          if ("error" in resolved) {
            sendJson(res, 200, {
              run_id: run.run_id,
              kind: "chat",
              text: resolved.error,
              request_id: requestId,
            });
            return;
          }
          const provider = "provider" in resolved ? resolved.provider : undefined;
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...CORS_HEADERS,
          });
          const send = (obj: unknown): boolean => {
            try {
              res.write(`data: ${JSON.stringify(obj)}\n\n`);
              return true;
            } catch {
              return false;
            }
          };
          if (!provider) {
            prep.store.append(root, run.run_id, { role: "assistant", text: CHAT_FALLBACK, ts: isoNow() });
            runs.saveRun(run);
            send({ delta: CHAT_FALLBACK });
            send({ done: true, run_id: run.run_id, text: CHAT_FALLBACK });
            res.end();
            return;
          }
          // Client disconnect (/stop, closing the app) aborts the model call.
          const controller = new AbortController();
          const onClose = (): void => {
            try {
              controller.abort();
            } catch {
              /* already settled */
            }
          };
          req.on("close", onClose);
          let text = "";
          let failed = false;
          let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
          try {
            for await (const chunk of provider.stream(prep.messages, undefined, { signal: controller.signal })) {
              if (chunk.type === "delta" && chunk.content) {
                text += chunk.content;
                if (!send({ delta: chunk.content })) break;
              } else if (chunk.type === "usage" && chunk.usage) {
                usage = chunk.usage;
              }
            }
          } catch (error) {
            ctx.log.error("workflow chat stream failed", { error: String(error) });
            failed = true;
          } finally {
            req.removeListener("close", onClose);
          }
          if (failed || !text.trim()) {
            // What-you-see-is-what-history-gets: a partial answer is still
            // recorded (the client shows it with an error note), but an
            // empty stream is reported honestly instead of as blank success.
            if (text) prep.store.append(root, run.run_id, { role: "assistant", text, ts: isoNow() });
            runs.saveRun(run);
            send({ error: "model_unavailable", ...(text ? { partial: text } : {}) });
            res.end();
            return;
          }
          prep.store.append(root, run.run_id, { role: "assistant", text, ts: isoNow() });
          runs.saveRun(run);
          send({ done: true, run_id: run.run_id, text, clipped: prep.clipped, ...(usage ? { usage } : {}) });
          res.end();
        } catch (error) {
          try {
            if (!res.headersSent) {
              sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
            } else {
              res.end();
            }
          } catch {
            /* socket already gone */
          }
        }
      })();
      return;
    }

    // ---- Dae Captain export: one session → one Markdown file ----
    // Rendered server-side from the run record plus its stored chat
    // exchanges (the full history, not the client's 30-message window),
    // written under the workspace so Open/Reveal work on a real path.
    if (method === "POST" && url.pathname === "/workflow/export") {
      void (async () => {
        try {
          const parsed = await readJson(req);
          if (!parsed) {
            sendJson(res, 400, { error: "invalid_json", request_id: requestId });
            return;
          }
          const root = resolveAllowedRoot(ctx, parsed.workspace_root ?? parsed.workspaceRoot);
          const runId = typeof parsed.run_id === "string" ? parsed.run_id : "";
          if (!runId) {
            sendJson(res, 400, { error: "run_id_required", request_id: requestId });
            return;
          }
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const run = runs.loadRun(runId);
          if (!run) {
            sendJson(res, 404, { error: "run_not_found", request_id: requestId });
            return;
          }
          if (reconcileWorkflowRun(ctx, run)) runs.saveRun(run);
          const present = presentWorkflowRun(ctx, run);
          const chat = (present.chat ?? []) as Array<{ role?: unknown; text?: unknown }>;
          const lines = [
            "# Percakapan Dae Captain",
            "",
            `- Sesi: \`${run.run_id}\``,
            `- Workspace: \`${run.workspace_root}\``,
            `- Dibuat: ${run.created_at} · Diperbarui: ${run.updated_at}`,
            "",
          ];
          if (run.turns.length > 0) {
            lines.push("## Tugas", "");
            run.turns.forEach((turn, index) => {
              lines.push(`### ${index + 1}. [${turn.engine}] ${turn.goal} (${turn.status})`);
              if (turn.note) lines.push(`> ${turn.note}`);
              lines.push("");
            });
          }
          if (chat.length > 0) {
            lines.push("## Obrolan", "");
            for (const message of chat) {
              const who = message.role === "user" ? "User" : "Dae Captain";
              lines.push(`**${who}:** ${typeof message.text === "string" ? message.text : ""}`, "");
            }
          }
          if (run.turns.length === 0 && chat.length === 0) {
            lines.push("_Sesi kosong._", "");
          }
          const dir = join(root, ".daedalus", "exports");
          mkdirSync(dir, { recursive: true });
          const file = `chat-${run.run_id}.md`;
          writeFileSync(join(dir, file), lines.join("\n"));
          const rel = join(".daedalus", "exports", file);
          sendJson(res, 200, { path: rel, absolute_path: join(root, rel), request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/workflow/runs") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(
            ctx,
            url.searchParams.get("workspace_root") ??
              url.searchParams.get("root") ??
              ctx.session.workspaceRoot,
          );
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const list = runs.listRuns().map((run) => {
            if (reconcileWorkflowRun(ctx, run)) runs.saveRun(run);
            return presentWorkflowRun(ctx, run);
          });
          sendJson(res, 200, { runs: list, request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), {
            error: errorMessage(error),
            request_id: requestId,
          });
        }
      })();
      return;
    }

    // ---- Dae Captain v2 Fase 7: chat cards (/captain/*, additive) ----
    // Structured action cards are rendered from server data, never from
    // hardcoded HTML. Every card button calls one of these (or a
    // pre-existing engine) endpoints.

    // Stage a task plan via core/src/workflow/decompose.ts planTask().
    // Body: { goal, workspace_root?, run_id? }.
    if (method === "POST" && url.pathname === "/captain/plans") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const goal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
          if (!goal) {
            sendJson(res, 400, { error: "goal_required", request_id: requestId });
            return;
          }
          const root = resolveAllowedRoot(ctx, parsed.workspace_root ?? parsed.workspaceRoot);
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const runIdRaw =
            typeof parsed.run_id === "string" && parsed.run_id ? parsed.run_id : undefined;
          const loaded = loadOrCreateChatRun(runs, root, runIdRaw);
          if ("missing" in loaded) {
            sendJson(res, 404, { error: "run_not_found", request_id: requestId });
            return;
          }
          const plan = planTask(goal, loaded.run);
          sweepStagedTaskPlans();
          stagedTaskPlans.set(plan.id, {
            plan,
            runId: loaded.run.run_id,
            workspaceRoot: root,
            createdAt: Date.now(),
          });
          sendJson(res, 200, {
            plan_id: plan.id,
            plan,
            run_id: loaded.run.run_id,
            request_id: requestId,
          });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Read one staged plan + its live execution state (the card polls this).
    const captainPlanMatch = /^\/captain\/plans\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && captainPlanMatch?.[1] !== undefined) {
      sweepStagedTaskPlans();
      const staged = stagedTaskPlans.get(captainPlanMatch[1] ?? "");
      if (!staged) {
        sendJson(res, 404, { error: "plan_not_found", request_id: requestId });
        return;
      }
      sendJson(res, 200, {
        plan_id: staged.plan.id,
        plan: staged.plan,
        execution: staged.execution ?? null,
        request_id: requestId,
      });
      return;
    }

    // Execute a staged plan: 202 immediately, Kahn waves in the background
    // (max 3 parallel), polled via GET /captain/plans/:id.
    const captainPlanExecMatch = /^\/captain\/plans\/([^/]+)\/execute$/.exec(url.pathname);
    if (method === "POST" && captainPlanExecMatch?.[1] !== undefined) {
      void (async () => {
        try {
          sweepStagedTaskPlans();
          const staged = stagedTaskPlans.get(captainPlanExecMatch[1] ?? "");
          if (!staged) {
            sendJson(res, 404, { error: "plan_not_found", request_id: requestId });
            return;
          }
          if (staged.execution?.status === "executing") {
            sendJson(res, 409, { error: "already_executing", request_id: requestId });
            return;
          }
          staged.execution = {
            status: "executing",
            startedAt: new Date().toISOString(),
            subTasks: staged.plan.tasks.map((t: SubTask) => ({
              sub_id: t.id,
              engine: t.engine,
              goal: t.goal,
              dependsOn: [...(t.dependsOn ?? [])],
              task_id: null,
              status: "waiting" as const,
            })),
          };
          sendJson(res, 202, {
            plan_id: staged.plan.id,
            status: "executing",
            sub_tasks: staged.execution.subTasks,
            request_id: requestId,
          });
          void runCaptainPlanExecution(ctx, staged, requestId).catch((error) =>
            ctx.log.error("captain plan execution failed", {
              error: String(error),
              plan_id: staged.plan.id,
            }),
          );
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Approval UndoStore: list snapshots for a run (the [📋 Versi] card and
    // the [↩️ Undo] button read this). Query: ?run_id=&workspace_root=.
    if (method === "GET" && url.pathname === "/captain/undo") {
      const runId = url.searchParams.get("run_id") ?? "";
      const root = resolveAllowedRoot(
        ctx,
        url.searchParams.get("workspace_root") ?? url.searchParams.get("root") ?? ctx.session.workspaceRoot,
      );
      const home = resolveDaedalusHome(ctx.settings.daedalusHome, root);
      const entries = undoStoreFor(home)
        .list()
        .filter((e) => !runId || e.runId === runId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((e) => ({
          undo_id: e.undoId,
          run_id: e.runId,
          engine: e.engine,
          action_type: e.actionType,
          summary: e.summary,
          target: e.snapshot.target,
          bytes: e.snapshot.bytes,
          created_at: e.createdAt,
        }));
      sendJson(res, 200, { entries, request_id: requestId });
      return;
    }

    // Approval UndoStore: apply the latest snapshot for (run_id, target?),
    // or one specific snapshot via undo_id (the [📋 Versi] card).
    // Body: { run_id?, target?, undo_id?, workspace_root? }. One-shot: the
    // entry is discarded after a successful apply (standard undo-stack
    // behavior).
    if (method === "POST" && url.pathname === "/captain/undo/apply") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.workspace_root ?? parsed.root);
          const home = resolveDaedalusHome(ctx.settings.daedalusHome, root);
          const store = undoStoreFor(home);
          const undoId = typeof parsed.undo_id === "string" ? parsed.undo_id : "";
          let entry = undoId ? store.get(undoId) : undefined;
          if (!entry && !undoId) {
            const runId = typeof parsed.run_id === "string" ? parsed.run_id : "";
            const target = typeof parsed.target === "string" ? parsed.target : "";
            const candidates = store
              .list()
              .filter((e) => (!runId || e.runId === runId) && (!target || e.snapshot.target === target))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            entry = candidates[0];
          }
          if (!entry) {
            sendJson(res, 404, {
              error: "nothing_to_undo",
              message: "Tidak ada aksi yang bisa di-undo untuk konteks ini.",
              request_id: requestId,
            });
            return;
          }
          const snap = entry.snapshot;
          const bytes =
            snap.kind === "content" ? Buffer.from(snap.content, "utf8") : await readFile(snap.backupPath);
          // The snapshot target must stay inside the workspace — a stale
          // absolute path never escapes the root.
          const abs = resolve(root, snap.target);
          if (abs !== resolve(root) && !abs.startsWith(resolve(root) + sep)) {
            sendJson(res, 400, { error: "undo_target_outside_workspace", request_id: requestId });
            return;
          }
          await mkdir(join(abs, ".."), { recursive: true });
          await writeFile(abs, bytes);
          store.discard(entry.undoId);
          sendJson(res, 200, {
            undone: true,
            undo_id: entry.undoId,
            summary: entry.summary,
            target: snap.target,
            request_id: requestId,
          });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // v2 run timeline (Fase 1): the chat polls this for verify/agent
    // events. ?after=<event id> returns only newer events (bounded 100).
    // Raw file bytes for the chat's [📥 Download] button (any workspace
    // file: docx, xlsx, csv, md, bib...). ?root=&path= (workspace-relative).
    if (method === "GET" && url.pathname === "/captain/download") {
      const targetRel = url.searchParams.get("path") || "";
      if (!targetRel) {
        sendJson(res, 400, { error: "path_required", request_id: requestId });
        return;
      }
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const absolute = resolveInside(root, targetRel);
        const st = statSync(absolute);
        if (st.isDirectory()) {
          sendJson(res, 400, { error: "path_is_directory", request_id: requestId });
          return;
        }
        if (st.size > MAX_FILE_BYTES) {
          sendJson(res, 413, { error: "file_too_large", size: st.size, limit: MAX_FILE_BYTES, request_id: requestId });
          return;
        }
        const data = readFileSync(absolute);
        const name = basename(absolute);
        res.writeHead(200, {
          "content-type": guessMimeType(name),
          "content-disposition": `attachment; filename="${name}"`,
          "content-length": data.length,
        });
        res.end(data);
      } catch (error) {
        sendJson(res, errorMessage(error).includes("escapes workspace") ? 404 : errorStatus(error), {
          error: errorMessage(error),
          request_id: requestId,
        });
      }
      return;
    }

    const captainTimelineMatch = /^\/captain\/runs\/([^/]+)\/timeline$/.exec(url.pathname);
    if (method === "GET" && captainTimelineMatch?.[1] !== undefined) {
      void (async () => {
        try {
          const root = resolveAllowedRoot(
            ctx,
            url.searchParams.get("workspace_root") ?? url.searchParams.get("root") ?? ctx.session.workspaceRoot,
          );
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const run = runs.loadRun(captainTimelineMatch[1] ?? "");
          if (!run) {
            sendJson(res, 404, { error: "run_not_found", request_id: requestId });
            return;
          }
          const events: AnyTimelineEvent[] = getEvents(run);
          const after = url.searchParams.get("after") ?? "";
          let slice = events;
          if (after) {
            const idx = events.findIndex((e) => e.id === after);
            if (idx >= 0) slice = events.slice(idx + 1);
          }
          sendJson(res, 200, {
            run_id: run.run_id,
            events: slice.slice(-100),
            request_id: requestId,
          });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    const workflowRunMatch = /^\/workflow\/runs\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && workflowRunMatch?.[1] !== undefined) {
      void (async () => {
        try {
          const root = resolveAllowedRoot(
            ctx,
            url.searchParams.get("workspace_root") ??
              url.searchParams.get("root") ??
              ctx.session.workspaceRoot,
          );
          const runs = new WorkflowRunStore(
            resolveDaedalusHome(ctx.settings.daedalusHome, root),
          );
          const run = runs.loadRun(workflowRunMatch[1] ?? "");
          if (!run) {
            sendJson(res, 404, { error: "run_not_found", request_id: requestId });
            return;
          }
          if (reconcileWorkflowRun(ctx, run)) runs.saveRun(run);
          sendJson(res, 200, { run: presentWorkflowRun(ctx, run), request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), {
            error: errorMessage(error),
            request_id: requestId,
          });
        }
      })();
      return;
    }
    if (method === "POST" && url.pathname === "/review") {
      void (async () => {
        try {
          const parsed = await readJson(req);
          if (!parsed) {
            sendJson(res, 400, { error: "invalid_json", request_id: requestId });
            return;
          }
          await ensureProvidersLoaded(ctx);
          const workspaceRoot = resolveAllowedRoot(ctx, parsed.root ?? parsed.workspaceRoot ?? parsed.repo_path);
          const taskId = typeof parsed.task_id === "string" ? parsed.task_id : typeof parsed.taskId === "string" ? parsed.taskId : undefined;
          let diffText = "";
          let source: "task-diff" | "unstaged" | "provided" = "unstaged";
          if (typeof parsed.diff === "string" && parsed.diff.trim().length > 0) {
            diffText = parsed.diff;
            source = "provided";
          }
          if (!diffText && taskId) {
            const lookup = findTask(ctx, taskId);
            const report = lookup?.store.loadReport<FinalReport>(taskId);
            if (report?.diff && report.diff.trim().length > 0) {
              diffText = report.diff;
              source = "task-diff";
            }
          }
          if (!diffText) diffText = await unstagedDiff(workspaceRoot);
          if (!diffText.trim()) {
            sendJson(res, 200, { findings: [], raw: "No diff to review.", source, truncated: false, request_id: requestId });
            return;
          }
          const registry = ctx.providerStore.registry;
          const providerId = typeof parsed.provider_id === "string" ? parsed.provider_id : typeof parsed.providerId === "string" ? parsed.providerId : ctx.session.providerId;
          const config = (providerId ? registry.get(providerId) : undefined) ?? registry.listInternal().find((provider) => provider.enabled);
          const model = typeof parsed.model === "string" ? parsed.model : ctx.session.model ?? config?.defaultModel ?? config?.models[0] ?? ctx.settings.llm.model;
          if (!config && !ctx.settings.llm.baseUrl) {
            sendJson(res, 400, { error: "no_provider_configured", request_id: requestId });
            return;
          }
          const providerOptions = { defaultTimeoutMs: ctx.settings.llm.timeoutMs ?? undefined };
          const provider = config
            ? createProviderForConfig(config, model, providerOptions)
            : createProviderForConfig({ baseUrl: ctx.settings.llm.baseUrl, apiKey: ctx.settings.llm.apiKey }, model, providerOptions);
          const rules = await loadProjectRules(workspaceRoot, { globalHome: resolveDaedalusHome(ctx.settings.daedalusHome, workspaceRoot) });
          const result = await reviewDiff({ provider, diff: diffText, rulesText: rules.text ? rules.text : undefined, source });
          sendJson(res, 200, { ...result, request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    const approveMatch = /^\/tasks\/([^/]+)\/approve$/.exec(url.pathname);
    if (method === "POST" && approveMatch?.[1] !== undefined) {
      void (async () => {
        // Sensitive: require the local daemon token.
        if (ctx.daemonToken && bearerToken(req) !== ctx.daemonToken) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const taskId = approveMatch[1] as string;
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
        const decision = parsed.decision === "grant" ? "grant" : "deny";
        const remember = parsed.remember === true;
        const runner = ctx.activeRunners.get(taskId);
        if (!runner) {
          sendJson(res, 404, { error: "runner_not_found" });
          return;
        }
        const key = parsed.key as PermissionKey | undefined;
        if (key) {
          const success = runner.approvals.decide(key, decision, remember);
          sendJson(res, 200, { success, decision, remember, key });
          return;
        }
        const pending = runner.approvals.pending(taskId)[0];
        if (!pending) {
          sendJson(res, 200, { success: false, reason: "no_pending_approval" });
          return;
        }
        const success = runner.approvals.decide(pending.key, decision, remember);
        sendJson(res, 200, { success, decision, remember, key: pending.key });
      })();
      return;
    }

    // Id-addressed approval decision (the Web chat card): allow once,
    // allow & remember the shown pattern, or decline — optionally with the
    // user's redirect text and, for commands, edited arguments.
    const decideMatch = /^\/tasks\/([^/]+)\/approvals\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && decideMatch?.[1] !== undefined && decideMatch[2] !== undefined) {
      void (async () => {
        const taskId = decideMatch[1] as string;
        const approvalId = decideMatch[2] as string;
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
        const decision = parsed.decision === "allow" || parsed.decision === "allow_remember" ? "grant" : "deny";
        const remember = parsed.decision === "allow_remember";
        const note = typeof parsed.note === "string" && parsed.note.length > 0 ? parsed.note : undefined;
        const editedArgs =
          parsed.editedArgs && typeof parsed.editedArgs === "object" && !Array.isArray(parsed.editedArgs)
            ? (parsed.editedArgs as Record<string, unknown>)
            : undefined;
        // The URL names the task the user is looking at (often the
        // orchestrator parent); the pending request may live on any active
        // runner, so fall back to whichever broker actually holds it.
        const candidates = new Set<TaskRunner>([...(ctx.activeRunners.get(taskId) ? [ctx.activeRunners.get(taskId)!] : []), ...ctx.activeRunners.values()]);
        let success = false;
        for (const runner of candidates) {
          if (runner.approvals.decideById(approvalId, { decision, remember, ...(note ? { note } : {}), ...(editedArgs ? { editedArgs } : {}) })) {
            success = true;
            break;
          }
        }
        sendJson(res, success ? 200 : 404, { success, decision, approval_id: approvalId, ...(success ? {} : { error: "approval_not_pending" }) });
      })();
      return;
    }

    // Id-addressed question answer (the Web chat question card): the body
    // carries the user's answer verbatim — a chosen option's label or their
    // own free text. Unknown question ids 404, like approvals.
    const questionMatch = /^\/tasks\/([^/]+)\/questions\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && questionMatch?.[1] !== undefined && questionMatch[2] !== undefined) {
      void (async () => {
        const taskId = questionMatch[1] as string;
        const questionId = questionMatch[2] as string;
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json" });
          return;
        }
        const answer = typeof parsed.answer === "string" ? parsed.answer : "";
        if (answer.trim().length === 0) {
          sendJson(res, 400, { error: "answer_required" });
          return;
        }
        // The URL names the task the user is looking at (often the
        // orchestrator parent); the pending question may live on any
        // active runner, so fall back to whichever broker actually holds it.
        const candidates = new Set<TaskRunner>([...(ctx.activeRunners.get(taskId) ? [ctx.activeRunners.get(taskId)!] : []), ...ctx.activeRunners.values()]);
        let success = false;
        for (const runner of candidates) {
          if (runner.questions.answer(questionId, answer)) {
            success = true;
            break;
          }
        }
        if (success) {
          sendJson(res, 200, { success, question_id: questionId });
          return;
        }
        // No live broker holds the question: the task may simply have
        // ended (the card outlived the run that asked it). Distinguish
        // that stale card from a genuinely unknown id and say it in
        // words — the runner is already gone from activeRunners here,
        // so a bare question_not_pending reads as a broken button.
        const lookup = findTask(ctx, taskId);
        const ended = lookup !== undefined
          && ((typeof lookup.state.status === "string" && ["done", "failed"].includes(lookup.state.status))
            || lookup.store.replay(taskId).some((event) => event.type === "TASK_COMPLETED"));
        if (ended) {
          sendJson(res, 410, {
            success: false,
            question_id: questionId,
            error: "question_not_pending",
            message: "This task already ended — this question can no longer be answered.",
          });
          return;
        }
        sendJson(res, 404, { success: false, question_id: questionId, error: "question_not_pending" });
      })();
      return;
    }

    const cancelMatch = /^\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancelMatch?.[1] !== undefined) {
      // Sensitive: require the local daemon token.
      if (ctx.daemonToken && bearerToken(req) !== ctx.daemonToken) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const taskId = cancelMatch[1] as string;
      const runner = ctx.activeRunners.get(taskId);
      const lookup = findTask(ctx, taskId);
      (lookup?.store ?? ctx.store).requestCancel(taskId);
      runner?.cancel(taskId);
      // `cancel_requested` is the honest half of this response: the marker is
      // always recorded and any polling loop (this process or a CLI one)
      // stops at its next checkpoint. `cancelled` only claims an in-process
      // runner was signalled directly.
      sendJson(res, 200, { cancelled: runner !== undefined, cancel_requested: true, task_id: taskId });
      return;
    }

    // Dae Captain pill ⏸ — cooperative pause. The marker is always recorded;
    // every engine suspends at its next safe checkpoint (loop-top / stage
    // boundary) and resumes from the same checkpoint on /resume. Unlike
    // cancel, no state is lost. Sensitive: same daemon token as cancel.
    const pauseMatch = /^\/tasks\/([^/]+)\/pause$/.exec(url.pathname);
    if (method === "POST" && pauseMatch?.[1] !== undefined) {
      if (ctx.daemonToken && bearerToken(req) !== ctx.daemonToken) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const taskId = pauseMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      (lookup?.store ?? ctx.store).requestPause(taskId);
      const runner = ctx.activeRunners.get(taskId);
      // `pause_requested` is the honest half: the marker is recorded and any
      // engine polls it. `live` says whether a runner is currently attached.
      sendJson(res, 200, { paused: true, pause_requested: true, live: runner !== undefined, task_id: taskId });
      return;
    }

    const resumeMatch = /^\/tasks\/([^/]+)\/resume$/.exec(url.pathname);
    if (method === "POST" && resumeMatch?.[1] !== undefined) {
      if (ctx.daemonToken && bearerToken(req) !== ctx.daemonToken) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      const taskId = resumeMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      (lookup?.store ?? ctx.store).clearPause(taskId);
      sendJson(res, 200, { paused: false, task_id: taskId });
      return;
    }

    const eventsMatch = /^\/tasks\/([^/]+)\/events$/.exec(url.pathname);
    if (method === "GET" && eventsMatch?.[1] !== undefined) {
      const taskId = eventsMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      if (!lookup) {
        sendJson(res, 404, { error: "not_found", request_id: requestId });
        return;
      }
      const events = lookup.store.replay(taskId);
      sendJson(res, 200, { events, count: events.length, task: summarizeFrom(ctx, lookup, taskId) });
      return;
    }

    const reportMatch = /^\/tasks\/([^/]+)\/report$/.exec(url.pathname);
    if (method === "GET" && reportMatch?.[1] !== undefined) {
      const taskId = reportMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      const report = lookup?.store.loadReport<FinalReport>(taskId);
      if (!report) {
        sendJson(res, 404, { error: "report_not_found" });
        return;
      }
      sendJson(res, 200, { report });
      return;
    }

    const changesMatch = /^\/tasks\/([^/]+)\/changes$/.exec(url.pathname);
    if (method === "GET" && changesMatch?.[1] !== undefined) {
      const taskId = changesMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      const changes = (lookup?.store.replay(taskId) ?? [])
        .filter((event) => event.type === "FILE_CHANGED")
        .map((event) => event.payload);
      sendJson(res, 200, { changes, count: changes.length });
      return;
    }

    const attachmentsMatch = /^\/tasks\/([^/]+)\/attachments$/.exec(url.pathname);
    if (method === "GET" && attachmentsMatch?.[1] !== undefined) {
      const taskId = attachmentsMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      const attachments = (lookup?.store.replay(taskId) ?? [])
        .filter((event) => event.type === "ATTACHMENT_ADDED")
        .map((event) => (event.payload as { attachment?: Attachment }).attachment)
        .filter((attachment): attachment is Attachment => Boolean(attachment));
      sendJson(res, 200, { attachments, count: attachments.length });
      return;
    }

    const checkpointsMatch = /^\/tasks\/([^/]+)\/checkpoints$/.exec(url.pathname);
    const restoreMatch = /^\/tasks\/([^/]+)\/restore$/.exec(url.pathname);
    if (method === "GET" && checkpointsMatch?.[1] !== undefined) {
      const taskId = checkpointsMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      if (!lookup) {
        sendJson(res, 404, { error: "not_found", request_id: requestId });
        return;
      }
      const checkpoints = lookup.store.listBackups(taskId);
      sendJson(res, 200, { checkpoints, count: checkpoints.length, request_id: requestId });
      return;
    }

    if (method === "POST" && restoreMatch?.[1] !== undefined) {
      const taskId = restoreMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      if (!lookup) {
        sendJson(res, 404, { error: "not_found", request_id: requestId });
        return;
      }
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          // The root the restore is allowed to touch: an explicit root from
          // the caller (confined to the gateway's allowed workspaces), else
          // the repo the task itself recorded. Both stay inside a workspace
          // root — restoreTask refuses escaping targets before writing.
          const root = typeof parsed.root === "string" && parsed.root.length > 0 ? resolveAllowedRoot(ctx, parsed.root) : undefined;
          const { restored, deleted } = lookup.store.restoreTask(taskId, root);
          sendJson(res, 200, { restored, deleted, request_id: requestId });
        } catch (error) {
          sendJson(res, 400, { error: "restore_failed", message: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && taskMatch?.[1] !== undefined) {
      const taskId = taskMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      if (!lookup) {
        sendJson(res, 404, { error: "not_found", request_id: requestId });
        return;
      }
      const summary = summarizeFrom(ctx, lookup, taskId);
      sendJson(res, 200, {
        state: lookup.state,
        events: lookup.store.replay(taskId),
        report: lookup.store.loadReport<FinalReport>(taskId) ?? null,
        running: ctx.activeRunners.has(taskId) || summary.running === true,
        task: summary,
      });
      return;
    }

    if (method === "POST" && url.pathname === "/workspace/create") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const target = typeof parsed.path === "string" ? parsed.path : typeof parsed.name === "string" ? parsed.name : "";
          if (!target) throw new Error("workspace path or name is required");
          const absolute = resolveInside(root, sanitizeRelativePath(target));
          await mkdir(absolute, { recursive: true });
          recordWorkspace(ctx, absolute);
          sendJson(res, 201, { path: absolute, name: basename(absolute), root, session: publicSession(ctx) });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && (url.pathname === "/workspace/folders" || url.pathname === "/workspace/folder" || url.pathname === "/workspace/directories")) {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const target = typeof parsed.path === "string" ? parsed.path : "";
          const absolute = resolveInside(root, sanitizeRelativePath(target));
          await mkdir(absolute, { recursive: true });
          sendJson(res, 201, { path: target, absolute, root });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && (url.pathname === "/workspace/files" || url.pathname === "/workspace/file/create")) {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const target = typeof parsed.path === "string" ? parsed.path : "";
          const absolute = resolveInside(root, sanitizeRelativePath(target));
          const existing = await stat(absolute).catch(() => undefined);
          if (existing && parsed.overwrite !== true) {
            sendJson(res, 409, { error: "file_exists", request_id: requestId });
            return;
          }
          await mkdir(join(absolute, ".."), { recursive: true });
          await writeFile(absolute, typeof parsed.content === "string" ? parsed.content : "", "utf8");
          sendJson(res, 201, { path: target, absolute, root, size: Buffer.byteLength(typeof parsed.content === "string" ? parsed.content : "") });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/workspace/rename") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const from = typeof parsed.from === "string" ? parsed.from : typeof parsed.path === "string" ? parsed.path : "";
          const to = typeof parsed.to === "string" ? parsed.to : typeof parsed.name === "string" ? parsed.name : "";
          const fromAbs = resolveInside(root, sanitizeRelativePath(from));
          const toAbs = resolveInside(root, sanitizeRelativePath(to));
          await mkdir(join(toAbs, ".."), { recursive: true });
          await rename(fromAbs, toAbs);
          if (resolve(ctx.session.workspaceRoot) === fromAbs) recordWorkspace(ctx, toAbs);
          sendJson(res, 200, { from, to, root });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "PUT" && url.pathname === "/workspace/file") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const target = typeof parsed.path === "string" ? parsed.path : "";
          const absolute = resolveInside(root, sanitizeRelativePath(target));
          await mkdir(join(absolute, ".."), { recursive: true });
          await writeFile(absolute, typeof parsed.content === "string" ? parsed.content : "", "utf8");
          sendJson(res, 200, { path: target, absolute, root });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Agentic Slide deck endpoints (v2): the canvas reads/edits the deck
    // through core — validateDeck gates every write — instead of treating
    // deck.json as a raw text file. Mutations return the fresh deck so the
    // Web can repaint without a second read.
    if (method === "GET" && url.pathname === "/slides/templates") {
      sendJson(res, 200, { templates: listSlideTemplates() });
      return;
    }

    // Built-in design templates ("Template bawaan"): Daedalus-born
    // design sets (layout pools, furniture, typography, base skin) from
    // core's registry. The gallery renders its card previews from the
    // same data the canvas and exporter resolve.
    if (method === "GET" && url.pathname === "/slides/builtin-templates") {
      sendJson(res, 200, { templates: listBuiltinTemplates() });
      return;
    }

    // Imported PPT templates ("Template dari PPT"): designs extracted
    // from uploaded .pptx files, stored per workspace under
    // .daedalus/slide-templates/ by core. The bundled templates above
    // stay the default; these are user-imported additions.
    if (method === "GET" && url.pathname === "/slides/ppt-templates") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const templates = await listPptxTemplates(root);
          sendJson(res, 200, { root, templates });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // The extracted master-background image of one imported template
    // (panel thumbnail). Template-scoped like the deck asset route.
    if (method === "GET" && url.pathname === "/slides/ppt-templates/background") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const id = url.searchParams.get("id") || "";
          const background = await readPptxTemplateBackground(root, id);
          if (!background) {
            sendJson(res, 404, { error: "ppt_template_background_not_found", request_id: requestId });
            return;
          }
          res.writeHead(200, {
            "content-type": guessMimeType(background.fileName),
            "content-length": background.bytes.length,
            ...CORS_HEADERS,
          });
          res.end(background.bytes);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // One stored asset of an imported template (v2 page backgrounds and
    // slot pictures), served so the canvas can draw template slides.
    // Core only serves file names the template actually references.
    if (method === "GET" && url.pathname === "/slides/ppt-templates/asset") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const id = url.searchParams.get("id") || "";
          const file = url.searchParams.get("file") || "";
          const asset = await readPptxTemplateAsset(root, id, file);
          if (!asset) {
            sendJson(res, 404, { error: "ppt_template_asset_not_found", request_id: requestId });
            return;
          }
          res.writeHead(200, {
            "content-type": guessMimeType(asset.fileName),
            "content-length": asset.bytes.length,
            ...CORS_HEADERS,
          });
          res.end(asset.bytes);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/slides/ppt-templates") {
      void (async () => {
        try {
          const contentType = req.headers["content-type"] ?? "";
          if (!contentType.includes("multipart/form-data")) {
            sendJson(res, 400, { error: "multipart_required", request_id: requestId });
            return;
          }
          // Room for the file cap plus multipart framing. A body past
          // that allowance means the template itself is over the cap —
          // answer with the template-specific 413, not the generic
          // raw-body error text.
          let body: Buffer;
          try {
            body = await readRawBody(req, MAX_PPTX_TEMPLATE_BYTES + 1024 * 1024);
          } catch (bodyError) {
            if (errorMessage(bodyError).startsWith("request body too large")) {
              sendJson(res, 413, { error: "pptx_too_large", message: `Template PPTX terlalu besar (maks ${Math.round(MAX_PPTX_TEMPLATE_BYTES / (1024 * 1024))} MB)`, request_id: requestId });
              return;
            }
            throw bodyError;
          }
          const parts = parseMultipart(body, contentType);
          const filePart = parts.find((part) => part.filename !== undefined && part.filename.length > 0);
          if (!filePart) {
            sendJson(res, 400, { error: "file_required", request_id: requestId });
            return;
          }
          const rootField = parts.find((part) => part.name === "root" && part.filename === undefined)?.data.toString("utf8");
          const root = resolveAllowedRoot(ctx, rootField || url.searchParams.get("root") || ctx.cwd);
          if (filePart.data.length > MAX_PPTX_TEMPLATE_BYTES) {
            sendJson(res, 413, { error: "pptx_too_large", message: `Template PPTX terlalu besar (maks ${Math.round(MAX_PPTX_TEMPLATE_BYTES / (1024 * 1024))} MB)`, request_id: requestId });
            return;
          }
          const template = await savePptxTemplate(root, { fileName: filePart.filename ?? "template.pptx", bytes: filePart.data });
          sendJson(res, 201, { root, template });
        } catch (error) {
          if (error instanceof PptxTemplateError) {
            const status = error.code === "pptx_too_large" ? 413 : 400;
            sendJson(res, status, { error: error.code, message: error.message, request_id: requestId });
            return;
          }
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/slides/ppt-templates/delete") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const id = typeof parsed.id === "string" ? parsed.id : "";
          const deleted = await deletePptxTemplate(root, id);
          if (!deleted) {
            sendJson(res, 404, { error: "ppt_template_not_found", request_id: requestId });
            return;
          }
          sendJson(res, 200, { root, id, deleted: true });
        } catch (error) {
          if (error instanceof PptxTemplateError) {
            sendJson(res, 400, { error: error.code, message: error.message, request_id: requestId });
            return;
          }
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/slides/deck") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const deck = await readDeck(root);
          if (!deck) {
            sendJson(res, 404, { error: "deck_not_found", request_id: requestId });
            return;
          }
          sendJson(res, 200, { root, deck });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Pratinjau Asli status: is a render (LibreOffice, or PowerPoint
    // on Windows) of the CURRENT deck state cached, rendering, stale,
    // or impossible on this machine? Always 200 with an honest state
    // (deck missing is 404, as everywhere else here).
    if (method === "GET" && url.pathname === "/slides/deck/preview") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const deck = await readDeck(root);
          if (!deck) {
            sendJson(res, 404, { error: "deck_not_found", request_id: requestId });
            return;
          }
          const status = await slidePreview.status(root, deck, (key, page) => previewPageUrl(root, key, page));
          sendJson(res, 200, { root, ...status });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // One cached Pratinjau Asli page image. The key is a content hash
    // (64 hex chars); anything else never reaches the filesystem.
    if (method === "GET" && url.pathname === "/slides/deck/preview/page") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const key = url.searchParams.get("key") || "";
        const page = Number(url.searchParams.get("page") || "");
        if (!key || !Number.isInteger(page) || page < 1) {
          sendJson(res, 400, { error: "invalid_preview_page", request_id: requestId });
          return;
        }
        const data = slidePreview.readPageBytes(root, key, page);
        if (!data) {
          sendJson(res, 404, { error: "preview_page_not_found", request_id: requestId });
          return;
        }
        res.writeHead(200, { "content-type": "image/png", "content-length": data.length, ...CORS_HEADERS });
        res.end(data);
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
      }
      return;
    }

    // Queue a Pratinjau Asli render of the current deck state (serial,
    // deduped per state hash). Returns the status immediately; the web
    // polls GET /slides/deck/preview until ready/error.
    if (method === "POST" && url.pathname === "/slides/deck/preview") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const deck = await readDeck(root);
          if (!deck) {
            sendJson(res, 404, { error: "deck_not_found", request_id: requestId });
            return;
          }
          const status = await slidePreview.render(root, deck, (key, page) => previewPageUrl(root, key, page));
          sendJson(res, 200, { root, ...status });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/slides/deck/download") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const rel = url.searchParams.get("path") || "";
          // Only exported decks are downloadable: a deck/*.pptx or
          // deck/*.pdf path that cannot escape the workspace.
          if (!rel.startsWith("deck/") || !rel.toLowerCase().match(/\.(pptx|pdf)$/) || rel.includes("..")) {
            sendJson(res, 400, { error: "invalid_download_path", request_id: requestId });
            return;
          }
          const absolute = resolveInside(root, rel);
          const data = readFileSync(absolute);
          res.writeHead(200, {
            "content-type": rel.toLowerCase().endsWith(".pdf")
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "content-length": data.length,
            "content-disposition": `attachment; filename="${basename(rel)}"`,
            ...CORS_HEADERS,
          });
          res.end(data);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Deck asset download for the canvas: <root>/deck/assets/<name>,
    // the same directory the PPTX exporter embeds from. Deck-scoped on
    // purpose — the web renderer only ever asks for asset basenames.
    if (method === "GET" && url.pathname === "/slides/deck/asset") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const name = url.searchParams.get("name") || "";
        if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
          sendJson(res, 400, { error: "invalid_asset_name", request_id: requestId });
          return;
        }
        const absolute = join(deckPaths(root).assetsDir, name);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          sendJson(res, 404, { error: "asset_not_found", request_id: requestId });
          return;
        }
        const data = readFileSync(absolute);
        res.writeHead(200, {
          "content-type": guessMimeType(name),
          "content-length": data.length,
          ...CORS_HEADERS,
        });
        res.end(data);
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
      }
      return;
    }

    // Deck asset upload (clickable image placeholders): the file lands
    // under <root>/deck/assets/, the only directory the PPTX exporter
    // resolves slide images from; the client then points the slide's
    // content at the returned name through the ordinary slide-update
    // endpoint (validateDeck-gated). Non-images and oversize files are
    // refused honestly; existing assets are never overwritten
    // (collision suffixes -2, -3, ...).
    if (method === "POST" && url.pathname === "/slides/deck/asset") {
      void (async () => {
        try {
          const contentType = req.headers["content-type"] ?? "";
          if (!contentType.includes("multipart/form-data")) {
            sendJson(res, 400, { error: "multipart_required", request_id: requestId });
            return;
          }
          const body = await readRawBody(req);
          const parts = parseMultipart(body, contentType);
          const filePart = parts.find((part) => part.filename !== undefined && part.filename.length > 0);
          if (!filePart) {
            sendJson(res, 400, { error: "file_required", request_id: requestId });
            return;
          }
          const rootField = parts.find((part) => part.name === "root" && part.filename === undefined)?.data.toString("utf8");
          const root = resolveAllowedRoot(ctx, rootField || url.searchParams.get("root") || ctx.cwd);
          const rawName = basename((filePart.filename ?? "image").replace(/\\+/g, "/"));
          const dot = rawName.lastIndexOf(".");
          const ext = dot > 0 ? rawName.slice(dot).toLowerCase() : "";
          const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
          if (!imageExtensions.has(ext) || !(filePart.contentType ?? "").startsWith("image/")) {
            sendJson(res, 400, { error: "unsupported_image_type", message: "Hanya berkas gambar (PNG, JPG, GIF, WebP) yang bisa diunggah ke placeholder.", request_id: requestId });
            return;
          }
          if (filePart.data.length > UPLOAD_LIMITS.maxFileBytes) {
            sendJson(res, 413, { error: "image_too_large", message: `Berkas gambar melebihi batas ${Math.round(UPLOAD_LIMITS.maxFileBytes / (1024 * 1024))} MB.`, request_id: requestId });
            return;
          }
          const stem = (dot > 0 ? rawName.slice(0, dot) : rawName).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^\.+/, "") || "image";
          const assetsDir = deckPaths(root).assetsDir;
          await mkdir(assetsDir, { recursive: true });
          let name = `${stem}${ext}`;
          for (let suffix = 2; existsSync(join(assetsDir, name)); suffix += 1) {
            name = `${stem}-${suffix}${ext}`;
          }
          await writeFile(join(assetsDir, name), filePart.data);
          sendJson(res, 200, { root, name, path: `deck/assets/${name}`, size: filePart.data.length });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Outline-first generate (the Outline panel's Buat button): release
    // the staged Standard run for this workspace so the original task
    // fills/validates/exports through its own run; when no run is alive
    // (partial task ended, server restarted) fill the staged skeleton
    // directly. Nothing staged anywhere is an honest 404/409, never a
    // silent success.
    if (method === "POST" && url.pathname === "/slides/deck/generate") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const templateRaw = parsed.template_id ?? parsed.templateId;
          const templateId = typeof templateRaw === "string" && templateRaw.trim() ? templateRaw.trim() : undefined;
          if (templateId && !getSlideTemplate(templateId)) {
            sendJson(res, 400, { error: "unknown_slide_template", request_id: requestId });
            return;
          }
          const designRaw = parsed.design_id ?? parsed.designId;
          const designId = typeof designRaw === "string" && designRaw.trim() ? designRaw.trim() : undefined;
          if (designId && !getBuiltinTemplate(designId)) {
            sendJson(res, 400, { error: "unknown_slide_design", request_id: requestId });
            return;
          }
          await ensureProvidersLoaded(ctx);
          const input = {
            ...(templateId ? { templateId } : {}),
            ...(designId ? { designId } : {}),
            ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
            ...(typeof parsed.provider_id === "string" ? { providerId: parsed.provider_id } : {}),
          };
          // The staged run completes through its own task: release it
          // and answer with that task's own verdict.
          for (const runner of ctx.activeRunners.values()) {
            const released = await runner.releaseStagedDeck(root, input);
            if (released) {
              sendJson(res, 200, { root, task_id: released.taskId, outcome: released.outcome, summary: released.summary, exported: released.exported ?? null });
              return;
            }
          }
          // A live (non-staged) slide run owns this deck right now.
          for (const runner of ctx.activeRunners.values()) {
            if (runner.hasSlideEngineFor(root)) {
              sendJson(res, 409, { error: "slide_run_in_progress", message: "Tugas slide sedang berjalan di workspace ini — tunggu selesai sebelum menekan Buat.", request_id: requestId });
              return;
            }
          }
          const deck = await readDeck(root).catch(() => null);
          if (!deck) {
            sendJson(res, 404, { error: "deck_not_found", request_id: requestId });
            return;
          }
          if (!deck.slides.some((slide) => slide.status === "skeleton")) {
            sendJson(res, 409, { error: "no_staged_outline", message: "Tidak ada outline yang menunggu dibuat di workspace ini — deck sudah terisi penuh.", request_id: requestId });
            return;
          }
          const runner = new TaskRunner({
            workspaceRoot: root,
            bus: ctx.bus,
            store: ctx.store,
            settings: ctx.settings,
            providerRegistry: ctx.providerStore.registry,
          });
          const fill = await runner.fillStagedDeck(root, input);
          if (!fill) {
            sendJson(res, 409, { error: "no_staged_outline", message: "Tidak ada outline yang menunggu dibuat di workspace ini.", request_id: requestId });
            return;
          }
          const exported = fill.exported ?? null;
          const outcome = exported ? "success" : fill.exportError ? "failed" : "partial";
          const summary = exported
            ? `done: ${exported.slides} slide selesai dan ter-export ke ${exported.path} (${Math.max(1, Math.round(exported.bytes / 1024))} KB).`
            : fill.exportError
              ? `Deck valid tapi export gagal: ${fill.exportError}. Deck tersimpan di deck/deck.json.`
              : `Sebagian deck belum selesai (${fill.deck.slides.length - fill.failures.length}/${fill.deck.slides.length} slide terisi) dan belum ter-export — tekan Buat lagi untuk melanjutkan pengisian.`;
          sendJson(res, 200, { root, outcome, summary, exported, failures: fill.failures });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Slide new-chat reset (Farid: "pas tekan new chat ke reset semua"):
    // archive the current deck aside — never delete it — so the next
    // prompt starts from an empty deck instead of being treated as edit
    // operations on the previous deck. A staged Standard run waiting on
    // this workspace is settled honestly (staged_superseded) through the
    // same runtime seam a newer prompt uses; a run actively filling is
    // a 409 — files are never yanked mid-write. No deck is an honest
    // no-op success, not an error.
    if (method === "POST" && url.pathname === "/slides/deck/reset") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          let stagedAbandoned = false;
          for (const runner of ctx.activeRunners.values()) {
            if (!runner.hasSlideEngineFor(root)) continue;
            if (runner.abandonStagedDeck(root)) {
              stagedAbandoned = true;
              continue;
            }
            sendJson(res, 409, { error: "slide_run_in_progress", message: "Tugas slide sedang berjalan di workspace ini — tunggu selesai sebelum memulai chat baru.", request_id: requestId });
            return;
          }
          const deckDir = join(root, "deck");
          const deckStat = await stat(deckDir).catch(() => null);
          if (!deckStat?.isDirectory()) {
            sendJson(res, 200, { root, archived: null, staged_abandoned: stagedAbandoned });
            return;
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const archiveParent = join(root, ".daedalus", "deck-archive");
          await mkdir(archiveParent, { recursive: true });
          let name = stamp;
          for (let suffix = 2; await stat(join(archiveParent, name)).then(() => true, () => false); suffix += 1) {
            name = `${stamp}-${suffix}`;
          }
          await rename(deckDir, join(archiveParent, name));
          sendJson(res, 200, { root, archived: `.daedalus/deck-archive/${name}`, staged_abandoned: stagedAbandoned });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Deck archive browser: new-chat resets archive the deck aside under
    // <root>/.daedalus/deck-archive/<timestamp>/ (write-only until now).
    // This lists what is there and restores an entry back to deck/ —
    // restoring never deletes: a current deck is archived aside first,
    // with the same timestamp(+suffix) naming as the reset route.
    if (method === "GET" && url.pathname === "/slides/deck/archive") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const archiveParent = join(root, ".daedalus", "deck-archive");
          const names = await readdir(archiveParent).catch(() => [] as string[]);
          const archives: Array<{ name: string; title: string; slides: number; archivedAt: string }> = [];
          for (const name of names) {
            const entryDir = join(archiveParent, name);
            const entryStat = await stat(entryDir).catch(() => null);
            if (!entryStat?.isDirectory()) continue;
            const raw = await readFile(join(entryDir, "deck.json"), "utf8").catch(() => null);
            let parsed: unknown = null;
            try {
              parsed = raw ? (JSON.parse(raw) as unknown) : null;
            } catch {
              parsed = null;
            }
            // Tolerate unreadable entries: omit them, never crash the list.
            if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) continue;
            const deck = parsed as { title?: unknown; slides?: unknown };
            archives.push({
              name,
              title: typeof deck.title === "string" && deck.title.length > 0 ? deck.title : name,
              slides: Array.isArray(deck.slides) ? deck.slides.length : 0,
              archivedAt: entryStat.mtime.toISOString(),
            });
          }
          archives.sort((a, b) => (a.name < b.name ? 1 : b.name < a.name ? -1 : 0));
          sendJson(res, 200, { root, archives });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/slides/deck/archive/restore") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const name = typeof parsed.name === "string" ? parsed.name : "";
          // Plain basename only: no separators, no "..", no empty names —
          // the entry must live directly under deck-archive/.
          if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || basename(name) !== name) {
            sendJson(res, 400, { error: "invalid_archive_name", message: "nama arsip tidak valid", request_id: requestId });
            return;
          }
          const archiveParent = join(root, ".daedalus", "deck-archive");
          const entryDir = join(archiveParent, name);
          const entryStat = await stat(entryDir).catch(() => null);
          if (!entryStat?.isDirectory()) {
            sendJson(res, 404, { error: "archive_not_found", message: `arsip "${name}" tidak ditemukan`, request_id: requestId });
            return;
          }
          // Validate the archived deck BEFORE touching the current one —
          // assets resolve against the archive dir itself. A broken
          // archive is an honest 422 and the workspace is untouched.
          const raw = await readFile(join(entryDir, "deck.json"), "utf8").catch(() => null);
          let archived: unknown = null;
          try {
            archived = raw ? (JSON.parse(raw) as unknown) : null;
          } catch {
            archived = null;
          }
          if (!archived || typeof archived !== "object") {
            sendJson(res, 422, { error: "archive_invalid", message: `arsip "${name}" tidak berisi deck yang valid`, request_id: requestId });
            return;
          }
          const archivedErrors = validateDeck(archived as DeckSpec, { root: entryDir }).filter((issue) => issue.severity === "error");
          if (archivedErrors.length > 0) {
            sendJson(res, 422, { error: "archive_invalid", issues: archivedErrors, request_id: requestId });
            return;
          }
          // Non-destructive: archive the current deck first, same
          // timestamp(+suffix) naming as the reset route.
          const deckDir = join(root, "deck");
          const deckStat = await stat(deckDir).catch(() => null);
          if (deckStat?.isDirectory()) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            await mkdir(archiveParent, { recursive: true });
            let archiveName = stamp;
            for (let suffix = 2; await stat(join(archiveParent, archiveName)).then(() => true, () => false); suffix += 1) {
              archiveName = `${stamp}-${suffix}`;
            }
            await rename(deckDir, join(archiveParent, archiveName));
          }
          // COPY, never rename: the archive entry stays restorable.
          await cp(entryDir, deckDir, { recursive: true });
          const deck = await readDeck(root);
          if (!deck) {
            sendJson(res, 422, { error: "restored_deck_invalid", message: "deck hasil restore tidak bisa dibaca kembali", request_id: requestId });
            return;
          }
          sendJson(res, 200, { root, deck });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }


    /* ---------------------------------------------------------- Dokumen
     * The Dokumen domain's panel API (Slide-deck-route doctrine): the
     * panels read/write document.json through core, the staged gates
     * are released by panel buttons (never chat cards), and exports run
     * through core's verification gate. document.json is the truth;
     * these routes never render native files themselves. */

    if (method === "GET" && url.pathname === "/dokumen/document") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const document = await readActiveDocument(root);
          sendJson(res, 200, { root, document });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/dokumen/schema-templates") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const templates = await listSavedSchemas(root);
          sendJson(res, 200, { root, templates });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/dokumen/blocks") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const sourceId = url.searchParams.get("sourceId") ?? "";
          const document = await readActiveDocument(root);
          if (!document) {
            sendJson(res, 404, { error: "document_not_found", request_id: requestId });
            return;
          }
          const parsed = await readParsedBlocks(root, document.id, sourceId);
          if (!parsed) {
            sendJson(res, 404, { error: "blocks_not_found", request_id: requestId });
            return;
          }
          sendJson(res, 200, { root, sourceId, pages: parsed.pages, pageSizes: parsed.pageSizes, blocks: parsed.blocks });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/dokumen/source-file") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const sourceId = url.searchParams.get("sourceId") ?? "";
          const document = await readActiveDocument(root);
          const source = document?.sources.find((s) => s.id === sourceId);
          if (!document || !source) {
            sendJson(res, 404, { error: "source_not_found", request_id: requestId });
            return;
          }
          const bytes = await readFile(sourceFilePath(root, document.id, source.filename));
          const type = source.filename.toLowerCase().endsWith(".pdf")
            ? "application/pdf"
            : source.filename.toLowerCase().endsWith(".docx")
              ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              : source.filename.toLowerCase().endsWith(".eml")
                ? "message/rfc822"
                : "text/plain; charset=utf-8";
          res.writeHead(200, { "content-type": type, "content-length": bytes.length, ...CORS_HEADERS });
          res.end(bytes);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Pratinjau status: is a render (Word on Windows, else
    // LibreOffice) of the composed DOCX (Susun) or the Tata ulang
    // result cached, rendering, stale, or impossible on this machine?
    // Always 200 with an honest state (document missing is 404, as
    // everywhere else here).
    if (method === "GET" && url.pathname === "/dokumen/preview") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const rawKind = url.searchParams.get("kind");
          if (rawKind !== null && rawKind !== "compose" && rawKind !== "style") {
            sendJson(res, 400, { error: "invalid_preview_kind", request_id: requestId });
            return;
          }
          const kind: DocPreviewKind = rawKind === "style" ? "style" : "compose";
          const document = await readActiveDocument(root);
          if (!document) {
            sendJson(res, 404, { error: "document_not_found", request_id: requestId });
            return;
          }
          const status = await dokumenPreview.status(root, document, kind, (key, page) => dokumenPreviewPageUrl(root, key, page));
          sendJson(res, 200, { root, ...status });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // One cached Pratinjau page image. The key is a content hash
    // (64 hex chars); anything else never reaches the filesystem.
    if (method === "GET" && url.pathname === "/dokumen/preview/page") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const key = url.searchParams.get("key") || "";
        const page = Number(url.searchParams.get("page") || "");
        if (!key || !Number.isInteger(page) || page < 1) {
          sendJson(res, 400, { error: "invalid_preview_page", request_id: requestId });
          return;
        }
        const data = dokumenPreview.readPageBytes(root, key, page);
        if (!data) {
          sendJson(res, 404, { error: "preview_page_not_found", request_id: requestId });
          return;
        }
        res.writeHead(200, { "content-type": "image/png", "content-length": data.length, ...CORS_HEADERS });
        res.end(data);
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
      }
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/dokumen/")) {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const needDocument = async (): Promise<DocumentState | null> => {
            const document = await readActiveDocument(root);
            if (!document) sendJson(res, 404, { error: "document_not_found", request_id: requestId });
            return document;
          };

          if (url.pathname === "/dokumen/sources") {
            // Panel attach: bytes are copied + hash-deduped and parsed
            // natively right away (no model) so Panel Sumber shows real
            // page counts; extraction itself stays a task.
            let document = await readActiveDocument(root);
            if (!document) document = await createActiveDocument(root, "extract", "Dokumen");
            const paths = Array.isArray(parsed.paths) ? parsed.paths.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
            for (const rel of paths) {
              if (!isSupportedSource(rel)) {
                sendJson(res, 400, { error: "unsupported_source", message: `Berkas ${rel} tidak didukung — Dokumen v1 membaca PDF, DOCX, EML, TXT, MD.`, request_id: requestId });
                return;
              }
              const { source } = await ingestSourceFile(root, document, resolve(root, rel), rel);
              if (source.status !== "parsed") {
                try {
                  const parsedSource = await parseSourceFile(sourceFilePath(root, document.id, source.filename));
                  await writeParsedBlocks(root, document.id, source.id, parsedSource);
                  source.pages = parsedSource.pages;
                  source.status = "parsed";
                } catch (error) {
                  source.status = "failed";
                  source.error = error instanceof Error ? error.message : String(error);
                }
              }
            }
            await writeDocument(root, document);
            sendJson(res, 200, { root, document });
            return;
          }

          if (url.pathname === "/dokumen/schema") {
            const document = await needDocument();
            if (!document) return;
            const raw = parsed.schema && typeof parsed.schema === "object" ? (parsed.schema as Record<string, unknown>) : {};
            const rawFields = Array.isArray(raw.fields) ? raw.fields : null;
            const types = ["string", "number", "money", "date", "email", "boolean"];
            if (!rawFields || rawFields.length === 0) {
              sendJson(res, 400, { error: "invalid_schema", message: "Skema butuh minimal satu field.", request_id: requestId });
              return;
            }
            const fields: DocumentState["schema"] extends { fields: infer F } | undefined ? F : never = [];
            const seen = new Set<string>();
            for (const entry of rawFields) {
              const f = entry as Record<string, unknown>;
              const name = typeof f.name === "string" ? f.name.trim() : "";
              if (!name || seen.has(name)) {
                sendJson(res, 400, { error: "invalid_schema", message: `Nama field kosong atau ganda: "${name}"`, request_id: requestId });
                return;
              }
              seen.add(name);
              fields.push({
                name,
                type: typeof f.type === "string" && types.includes(f.type) ? (f.type as (typeof fields)[number]["type"]) : "string",
                ...(f.required === true ? { required: true } : {}),
                ...(typeof f.description === "string" ? { description: f.description } : {}),
              });
            }
            const target = raw.extraction_target ?? raw.extractionTarget;
            document.schema = {
              version: 1,
              fields,
              extractionTarget: target === "per_page" || target === "per_row" || target === "per_doc" ? target : (document.schema?.extractionTarget ?? "per_doc"),
              ...(typeof raw.autoClearMin === "number" ? { autoClearMin: raw.autoClearMin } : {}),
              ...(typeof raw.escalateBelow === "number" ? { escalateBelow: raw.escalateBelow } : {}),
              approved: document.schema?.approved ?? false,
            };
            await writeDocument(root, document);
            await appendAudit(root, document.id, { actor: "web", action: "schema_edited", detail: `${fields.length} field disimpan dari Panel Skema` });
            if (parsed.save_template === true) {
              const docType = typeof parsed.doc_type === "string" && parsed.doc_type.trim() ? parsed.doc_type.trim() : document.sources[0]?.docType;
              if (docType) await saveSchema(root, docType, document.schema);
            }
            sendJson(res, 200, { root, document });
            return;
          }

          if (url.pathname === "/dokumen/release") {
            // The panel release buttons (Ekstrak / Susun / Terapkan):
            // settle the waiting engine gate; the task itself continues
            // and reports through its own task.
            for (const runner of ctx.activeRunners.values()) {
              if (runner.releaseDokumenGate(root)) {
                sendJson(res, 200, { root, released: true });
                return;
              }
            }
            // No live gate (server restarted / run ended): apply what
            // can honestly be applied from disk — schema approval is a
            // state change; drafting/extraction still needs a task.
            const document = await readActiveDocument(root);
            if (!document) {
              sendJson(res, 404, { error: "document_not_found", request_id: requestId });
              return;
            }
            if (document.schema && !document.schema.approved) {
              document.schema = { ...document.schema, approved: true };
              await writeDocument(root, document);
              await appendAudit(root, document.id, { actor: "web", action: "schema_approved_offline", detail: "skema disetujui tanpa run aktif; ekstraksi berjalan pada tugas berikutnya" });
              sendJson(res, 200, { root, released: false, applied: "schema-approved", document });
              return;
            }
            const pendingOps = document.styleOps.filter((op) => !op.applied);
            if (pendingOps.length > 0 && document.styleTarget) {
              const result = await applyStyleOps(root, document, resolve(root, document.styleTarget), document.styleOps);
              await writeDocument(root, document);
              await appendAudit(root, document.id, { actor: "web", action: "style_applied_offline", detail: `${result.path} dibuat; asli tidak ditimpa` });
              sendJson(res, 200, { root, released: false, applied: "style", path: result.path, document });
              return;
            }
            sendJson(res, 409, { error: "no_staged_gate", message: "Tidak ada skema/kerangka/perubahan gaya yang menunggu persetujuan di workspace ini.", request_id: requestId });
            return;
          }

          if (url.pathname === "/dokumen/field") {
            const document = await needDocument();
            if (!document) return;
            if (!document.schema) {
              sendJson(res, 409, { error: "no_schema", request_id: requestId });
              return;
            }
            const record = document.records.find((r) => r.id === parsed.record_id);
            const fieldName = typeof parsed.field === "string" ? parsed.field : "";
            if (!record || !record.fields[fieldName]) {
              sendJson(res, 404, { error: "field_not_found", request_id: requestId });
              return;
            }
            const before = record.fields[fieldName]!;
            record.fields[fieldName] = {
              value: (parsed.value ?? null) as string | number | boolean | null,
              confidence: 1,
              status: "corrected",
              originalValue: before.value,
              note: "dikoreksi pengguna di kanvas",
              ...(before.provenance ? { provenance: before.provenance } : {}),
            };
            validateRecord(record, document.schema);
            await writeDocument(root, document);
            await appendAudit(root, document.id, { actor: "web", action: "field_corrected", recordId: record.id, field: fieldName, detail: `${JSON.stringify(before.value)} -> ${JSON.stringify(record.fields[fieldName]!.value)}; keputusan kini ${record.decision}` });
            sendJson(res, 200, { root, document, record });
            return;
          }

          if (url.pathname === "/dokumen/outline") {
            const document = await needDocument();
            if (!document) return;
            const list = Array.isArray(parsed.sections) ? parsed.sections : [];
            const byId = new Map(document.sections.map((s) => [s.id, s]));
            const before = JSON.stringify(document);
            document.sections = list.map((entry) => {
              const raw = entry as Record<string, unknown>;
              const id = typeof raw.id === "string" ? raw.id : "";
              const existing = byId.get(id);
              return {
                id: existing?.id ?? `sec-${Math.random().toString(36).slice(2, 10)}`,
                title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : (existing?.title ?? "Tanpa judul"),
                thesisPoints: Array.isArray(raw.thesisPoints) ? raw.thesisPoints.filter((x): x is string => typeof x === "string") : (existing?.thesisPoints ?? []),
                citations: existing?.citations ?? [],
                prose: existing?.prose ?? "",
                status: existing?.status ?? "staged",
              };
            });
            await writeDocument(root, document);
            await appendAudit(root, document.id, { actor: "web", action: "outline_edited", detail: `${document.sections.length} bab disimpan dari panel` });
            recordCaptainUndo({
              ctx,
              root,
              runId: parsed.run_id,
              action: { type: "edit_document", engine: "dokumen", summary: "edit kerangka dokumen", target: documentPaths(root, document.id).file },
              target: documentPaths(root, document.id).file,
              content: before,
            });
            sendJson(res, 200, { root, document });
            return;
          }

          if (url.pathname === "/dokumen/section") {
            const document = await needDocument();
            if (!document) return;
            const section = document.sections.find((x) => x.id === parsed.id);
            if (!section) {
              sendJson(res, 404, { error: "section_not_found", request_id: requestId });
              return;
            }
            const before = JSON.stringify(document);
            if (typeof parsed.prose === "string") section.prose = parsed.prose;
            await writeDocument(root, document);
            await appendAudit(root, document.id, { actor: "web", action: "section_edited", detail: `prosa bab "${section.title}" disunting pengguna` });
            recordCaptainUndo({
              ctx,
              root,
              runId: parsed.run_id,
              action: { type: "edit_document", engine: "dokumen", summary: `edit bab "${section.title}"`, target: documentPaths(root, document.id).file },
              target: documentPaths(root, document.id).file,
              content: before,
            });
            sendJson(res, 200, { root, document, section });
            return;
          }

          if (url.pathname === "/dokumen/export-data") {
            const document = await needDocument();
            if (!document) return;
            const format = parsed.format === "csv" || parsed.format === "xlsx" ? parsed.format : "json";
            const result = await exportData(root, document, format);
            await writeDocument(root, document);
            await appendAudit(root, document.id, { actor: "web", action: "export_data", detail: `${format}: ${result.recordCount} record keluar, ${result.heldBack} tertahan` });
            sendJson(res, 200, { root, result, document });
            return;
          }

          if (url.pathname === "/dokumen/export-document") {
            const document = await needDocument();
            if (!document) return;
            // Dae Captain v2 Fase 7: the kerangka card offers [DOCX][PDF][MD].
            const format = parsed.format === "pdf" ? "pdf" : parsed.format === "md" ? "md" : "docx";
            const result = format === "pdf"
              ? await exportDocumentPdf(root, document)
              : format === "md"
                ? await exportDocumentMarkdown(root, document)
                : await exportDocumentDocx(root, document);
            await writeDocument(root, document);
            await appendAudit(root, document.id, { actor: "web", action: "export_document", detail: `${result.format}: ${result.path}` });
            sendJson(res, 200, { root, result, document });
            return;
          }

          if (url.pathname === "/dokumen/style-inspect") {
            const rel = typeof parsed.path === "string" ? parsed.path : "";
            if (!rel.toLowerCase().endsWith(".docx")) {
              sendJson(res, 400, { error: "not_docx", message: "Tata ulang hanya untuk berkas .docx.", request_id: requestId });
              return;
            }
            const state = await inspectDocxStyles(resolve(root, rel));
            const instruction = typeof parsed.instruction === "string" ? parsed.instruction : "";
            const target = instruction ? parseStyleInstruction(instruction) : null;
            const ops = target ? proposeStyleOps(state, target) : [];
            sendJson(res, 200, { root, state, ops });
            return;
          }

          if (url.pathname === "/dokumen/preview") {
            // Queue a Pratinjau render of the composed DOCX (or the
            // Tata ulang result) — serial, deduped per state hash.
            // Returns the status immediately; the web polls
            // GET /dokumen/preview until ready/error.
            if (parsed.kind !== undefined && parsed.kind !== "compose" && parsed.kind !== "style") {
              sendJson(res, 400, { error: "invalid_preview_kind", request_id: requestId });
              return;
            }
            const document = await needDocument();
            if (!document) return;
            const kind: DocPreviewKind = parsed.kind === "style" ? "style" : "compose";
            const status = await dokumenPreview.render(root, document, kind, (key, page) => dokumenPreviewPageUrl(root, key, page));
            sendJson(res, 200, { root, ...status });
            return;
          }

          if (url.pathname === "/dokumen/reset") {
            // New chat in Dokumen = full reset (Slide doctrine): settle a
            // staged gate honestly, refuse while a run is mid-flight,
            // then archive the active document — never delete it.
            let stagedAbandoned = false;
            for (const runner of ctx.activeRunners.values()) {
              if (!runner.hasDokumenEngineFor(root)) continue;
              if (runner.abandonDokumenGate(root)) {
                stagedAbandoned = true;
                continue;
              }
              sendJson(res, 409, { error: "dokumen_run_in_progress", message: "Tugas dokumen sedang berjalan di workspace ini — tunggu selesai sebelum memulai chat baru.", request_id: requestId });
              return;
            }
            const archived = await archiveActiveDocument(root);
            sendJson(res, 200, { root, archived: archived ? archived.archivedTo.slice(root.length + 1) : null, staged_abandoned: stagedAbandoned });
            return;
          }

          sendJson(res, 404, { error: "not_found", request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/slides/deck")) {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const deck = await readDeck(root);
          if (!deck) {
            sendJson(res, 404, { error: "deck_not_found", request_id: requestId });
            return;
          }
          const badDeck = (status: number, error: string, extra: Record<string, unknown> = {}) => sendJson(res, status, { error, request_id: requestId, ...extra });
          // Validates the candidate deck; on errors responds 422 and
          // writes nothing, otherwise persists and returns the deck.
          // The pre-change deck is snapshotted into the approval
          // UndoStore (Dae Captain [↩️ Undo]) — failures never block
          // the write itself.
          const commit = async (next: DeckSpec, undoSummary?: string) => {
            const errors = validateDeck(next, { root }).filter((issue) => issue.severity === "error");
            if (errors.length > 0) {
              badDeck(422, "deck_invalid", { issues: errors });
              return;
            }
            if (undoSummary) {
              recordCaptainUndo({
                ctx,
                root,
                runId: parsed.run_id,
                action: { type: "edit_deck", engine: "slide", summary: undoSummary, target: deckPaths(root).file },
                target: deckPaths(root).file,
                content: JSON.stringify(deck),
              });
            }
            await writeDeck(root, next);
            sendJson(res, 200, { root, deck: next });
          };

          if (url.pathname === "/slides/deck/theme") {
            // Imported PPT template: core resolves the stored tokens (and
            // copies the extracted background into deck/assets/), then the
            // ordinary validate-and-commit path persists them. Stamping the
            // extracted theme wholesale is what makes the last applied pick
            // win over a bundled template, and vice versa.
            const customTemplateId = typeof parsed.custom_template_id === "string" ? parsed.custom_template_id : typeof parsed.customTemplateId === "string" ? parsed.customTemplateId : undefined;
            // Built-in design template ("Template bawaan"): stamps its
            // tokens + designId; a Warna & Font skin in the same call (or a
            // later skin-only call) re-skins over it without clearing the
            // design — the two layers are how the panel separates
            // "desain" from "warna & font".
            const designId = typeof parsed.design_id === "string" ? parsed.design_id : typeof parsed.designId === "string" ? parsed.designId : undefined;
            const design = designId !== undefined ? getBuiltinTemplate(designId) : undefined;
            if (designId !== undefined && !design) {
              badDeck(400, "unknown_slide_design");
              return;
            }
            if (customTemplateId !== undefined) {
              if (parsed.template_id !== undefined || parsed.templateId !== undefined || designId !== undefined) {
                badDeck(400, "conflicting_template");
                return;
              }
              try {
                const applied = await applyPptxTemplateTheme(root, customTemplateId);
                await commit({ ...deck, theme: applied.theme }, "ganti template (impor)");
              } catch (error) {
                if (error instanceof PptxTemplateError) {
                  badDeck(error.code === "ppt_template_not_found" ? 404 : 400, error.code, { message: error.message });
                  return;
                }
                throw error;
              }
              return;
            }
            const template = getSlideTemplate(typeof parsed.template_id === "string" ? parsed.template_id : typeof parsed.templateId === "string" ? parsed.templateId : undefined);
            if ((parsed.template_id !== undefined || parsed.templateId !== undefined) && !template) {
              badDeck(400, "unknown_slide_template");
              return;
            }
            const accent = parsed.accent;
            if (accent !== undefined && (typeof accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(accent))) {
              badDeck(400, "invalid_accent");
              return;
            }
            if (parsed.dark !== undefined && typeof parsed.dark !== "boolean") {
              badDeck(400, "invalid_dark");
              return;
            }
            if (!template && !design && accent === undefined && parsed.dark === undefined) {
              badDeck(400, "nothing_to_apply");
              return;
            }
            // Layer order: design tokens first, then the skin pick (whose
            // colors/fonts win while the design survives), or — a skin-only
            // call on a designed deck — the same story for this deck.
            const base = design
              ? builtinDeckTheme(design)
              : template
                ? { ...template.theme, templateId: template.id, ...(deck.theme.designId ? { designId: deck.theme.designId } : {}) }
                : deck.theme;
            const layered = design && template
              ? { ...template.theme, templateId: template.id, designId: design.id }
              : base;
            const next: DeckSpec = { ...deck, theme: { ...layered } };
            if (typeof accent === "string") next.theme = { ...next.theme, accent };
            if (typeof parsed.dark === "boolean") next.theme = { ...next.theme, dark: parsed.dark };
            await commit(next, "ganti tema/template");
            return;
          }

          if (url.pathname === "/slides/deck/export") {
            // Same contract as the agent's export_deck tool: never export
            // a deck core validation rejects, and never report success
            // for an empty deck (the exporter also refuses those).
            const exportErrors = validateDeck(deck, { root }).filter((issue) => issue.severity === "error");
            if (deck.slides.length === 0 || exportErrors.length > 0) {
              badDeck(422, "deck_invalid", {
                issues: deck.slides.length === 0
                  ? [{ code: "empty-deck", message: "deck has no slides yet — add slides before exporting", severity: "error" }, ...exportErrors]
                  : exportErrors,
              });
              return;
            }
            // Export picker (stage menu): export wearing a DIFFERENT
            // design than the deck was made with. The deck on disk never
            // changes; the output file carries the design's suffix.
            // Built-in: re-dress (skin + furniture + typography over the
            // deck's own layouts/words). Imported with pages: the deck's
            // words are poured into the template's page designs and
            // exported through the clone path; skin-only imports re-skin.
            const exportDesignId = typeof parsed.design_id === "string" ? parsed.design_id : typeof parsed.designId === "string" ? parsed.designId : undefined;
            const exportCustomId = typeof parsed.custom_template_id === "string" ? parsed.custom_template_id : typeof parsed.customTemplateId === "string" ? parsed.customTemplateId : undefined;
            if (exportDesignId !== undefined && exportCustomId !== undefined) {
              badDeck(400, "conflicting_template");
              return;
            }
            const sendExport = (result: { relativePath: string; bytes: number; slideCount: number; note?: string }, extraNote?: string): void => {
              const note = [result.note, extraNote].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
              sendJson(res, 200, { root, path: result.relativePath, bytes: result.bytes, slides: result.slideCount, ...(note ? { note } : {}) });
            };
            if (exportDesignId !== undefined) {
              const design = getBuiltinTemplate(exportDesignId);
              if (!design) {
                badDeck(400, "unknown_slide_design");
                return;
              }
              const result = await exportDeckToPptx(deck, root, { themeOverride: builtinDeckTheme(design), fileSuffix: design.id });
              sendExport(result, `Diekspor dengan template bawaan "${design.name}": warna, font, dan ornamen desainnya memakai deck ini apa adanya (layout & isi tidak berubah); deck di disk tidak diubah.`);
              return;
            }
            if (exportCustomId !== undefined) {
              const template = await getPptxTemplate(root, exportCustomId).catch(() => undefined);
              if (!template) {
                badDeck(404, "ppt_template_not_found", { message: `template PPT "${exportCustomId}" tidak ditemukan di workspace ini` });
                return;
              }
              if (template.pages && template.pages.length > 0) {
                try {
                  const poured = pourDeckIntoTemplate(deck, template);
                  const result = await exportDeckToPptx(poured.deck, root, { fileSuffix: template.id });
                  const pourNotes = [
                    poured.truncatedSlots > 0 ? `${poured.truncatedSlots} kotak teks dipotong agar muat di kotak template.` : "",
                    poured.droppedLines > 0 ? `${poured.droppedLines} baris teks tidak mendapat kotak di template.` : "",
                  ].filter((part) => part.length > 0).join(" ");
                  sendExport(result, `Kata-kata deck dituangkan ke desain halaman template "${template.name}" untuk ekspor ini; deck di disk tidak diubah.${pourNotes ? ` ${pourNotes}` : ""}`);
                } catch (error) {
                  badDeck(422, "export_failed", { message: error instanceof Error ? error.message : String(error) });
                }
                return;
              }
              try {
                const applied = await applyPptxTemplateTheme(root, exportCustomId);
                const result = await exportDeckToPptx(deck, root, { themeOverride: applied.theme, fileSuffix: template.id });
                sendExport(result, `Diekspor dengan kulit template impor "${template.name}" (palet & font-nya; template ini tidak menyimpan desain halaman); deck di disk tidak diubah.`);
              } catch (error) {
                if (error instanceof PptxTemplateError) {
                  badDeck(error.code === "ppt_template_not_found" ? 404 : 400, error.code, { message: error.message });
                  return;
                }
                throw error;
              }
              return;
            }
            const result = await exportDeckToPptx(deck, root);
            sendExport(result);
            return;
          }

          if (url.pathname === "/slides/deck/export-pdf") {
            // Same contract as the .pptx export: never export a deck core
            // validation rejects, and never report success for an empty
            // deck — the same deck_invalid codes the pptx export answers.
            const exportErrors = validateDeck(deck, { root }).filter((issue) => issue.severity === "error");
            if (deck.slides.length === 0 || exportErrors.length > 0) {
              badDeck(422, "deck_invalid", {
                issues: deck.slides.length === 0
                  ? [{ code: "empty-deck", message: "deck has no slides yet — add slides before exporting", severity: "error" }, ...exportErrors]
                  : exportErrors,
              });
              return;
            }
            // Export through the .pptx exporter first, then convert with
            // LibreOffice headless (the preview engine's own pass); the
            // PDF lands next to the .pptx in deck/ with the same basename.
            const pptx = await exportDeckToPptx(deck, root);
            let pdfPath: string;
            try {
              pdfPath = await convertPptxToPdf(join(root, pptx.relativePath), join(root, "deck"));
            } catch (error) {
              if (error instanceof SofficeMissingError) {
                badDeck(503, "pdf_unavailable", { message: "LibreOffice (soffice) tidak ditemukan di server ini — instal LibreOffice untuk ekspor PDF." });
                return;
              }
              throw error;
            }
            const pdfStat = await stat(pdfPath).catch(() => null);
            if (!pdfStat) {
              badDeck(502, "pdf_export_failed", { message: "LibreOffice tidak menghasilkan PDF dari deck ini." });
              return;
            }
            sendJson(res, 200, { root, path: `deck/${basename(pdfPath)}`, bytes: pdfStat.size, slides: deck.slides.length });
            return;
          }

          const slideId = typeof parsed.slide_id === "string" ? parsed.slide_id : typeof parsed.slideId === "string" ? parsed.slideId : undefined;
          const index = deck.slides.findIndex((slide) => slide.id === slideId);

          if (url.pathname === "/slides/deck/regenerate") {
            // Slide engine seam, not a task: regenerate this one slide
            // with fresh content in place. The deck on disk changes only
            // when the new content validates; failure keeps the old
            // slide and the error says why.
            if (!slideId || index < 0) {
              badDeck(404, "slide_not_found");
              return;
            }
            await ensureProvidersLoaded(ctx);
            const runner = new TaskRunner({
              workspaceRoot: root,
              bus: ctx.bus,
              store: ctx.store,
              settings: ctx.settings,
              providerRegistry: ctx.providerStore.registry,
            });
            const regenerated = await runner.regenerateSlide(root, slideId, {
              ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
              ...(typeof parsed.provider_id === "string" ? { providerId: parsed.provider_id } : {}),
            });
            sendJson(res, 200, { root, deck: regenerated.deck, slide_id: slideId });
            return;
          }

          if (url.pathname === "/slides/deck/slide/add") {
            const layout = typeof parsed.layout === "string" ? parsed.layout : "";
            if (!layout) {
              badDeck(400, "layout_required");
              return;
            }
            if (deck.slides.length >= 40) {
              badDeck(400, "deck_full");
              return;
            }
            const content = parsed.content && typeof parsed.content === "object" && !Array.isArray(parsed.content) ? (parsed.content as Record<string, unknown>) : {};
            const at = typeof parsed.index === "number" && Number.isFinite(parsed.index) ? Math.max(0, Math.min(deck.slides.length, Math.floor(parsed.index))) : deck.slides.length;
            const slide = { id: newSlideId(), layout, content };
            const next: DeckSpec = { ...deck, slides: [...deck.slides.slice(0, at), slide, ...deck.slides.slice(at)] };
            const errors = validateDeck(next, { root }).filter((issue) => issue.severity === "error");
            if (errors.length > 0) {
              badDeck(422, "deck_invalid", { issues: errors });
              return;
            }
            recordCaptainUndo({
              ctx,
              root,
              runId: parsed.run_id,
              action: { type: "edit_deck", engine: "slide", summary: "tambah slide", target: deckPaths(root).file },
              target: deckPaths(root).file,
              content: JSON.stringify(deck),
            });
            await writeDeck(root, next);
            sendJson(res, 200, { root, deck: next, slide_id: slide.id });
            return;
          }

          if (!slideId || index < 0) {
            badDeck(404, "slide_not_found");
            return;
          }

          if (url.pathname === "/slides/deck/slide/update") {
            // `positions` (the canvas editor's drag placements) may ride
            // along without content; commit() validates them via
            // validateDeck, so garbage coordinates are a 422, never a
            // silent write. positions: null clears all placements.
            // `notes` (speaker notes) likewise: a string sets them, null
            // or "" clears them. A non-string is rejected by the
            // invalid_notes guard above — never a silent write.
            const hasPositions = "positions" in parsed;
            const hasNotes = "notes" in parsed;
            const content = parsed.content;
            if (!hasPositions && !hasNotes && (!content || typeof content !== "object" || Array.isArray(content))) {
              badDeck(400, "content_required");
              return;
            }
            // validateDeck does not type-check notes itself (only
            // readDeck's shape gate does), so reject a non-string here:
            // garbage notes are a 400, never a silent write.
            if (hasNotes && parsed.notes !== null && parsed.notes !== "" && typeof parsed.notes !== "string") {
              badDeck(400, "invalid_notes");
              return;
            }
            const current = deck.slides[index]!;
            const layout = typeof parsed.layout === "string" && parsed.layout ? parsed.layout : current.layout;
            const slides = deck.slides.map((slide, i) => {
              if (i !== index) return slide;
              // Shallow merge, exactly like the agent's update_slide.
              const next: Slide = {
                ...slide,
                layout,
                ...(content && typeof content === "object" && !Array.isArray(content)
                  ? { content: { ...slide.content, ...(content as Record<string, unknown>) } }
                  : {}),
              };
              if (hasPositions) {
                if (parsed.positions === null) delete next.positions;
                else next.positions = parsed.positions as Slide["positions"];
              }
              if (hasNotes) {
                if (parsed.notes === null || parsed.notes === "") delete next.notes;
                else next.notes = parsed.notes as Slide["notes"];
              }
              return next;
            });
            await commit({ ...deck, slides }, `edit slide ${index + 1}`);
            return;
          }

          if (url.pathname === "/slides/deck/slide/delete") {
            await commit({ ...deck, slides: deck.slides.filter((_, i) => i !== index) }, `hapus slide ${index + 1}`);
            return;
          }

          if (url.pathname === "/slides/deck/slide/move") {
            const toRaw = parsed.to_index ?? parsed.toIndex;
            if (typeof toRaw !== "number" || !Number.isFinite(toRaw)) {
              badDeck(400, "to_index_required");
              return;
            }
            const to = Math.max(0, Math.min(deck.slides.length - 1, Math.floor(toRaw)));
            const slides = [...deck.slides];
            const [moved] = slides.splice(index, 1);
            slides.splice(to, 0, moved!);
            await commit({ ...deck, slides }, `pindah slide ${index + 1} ke ${to + 1}`);
            return;
          }

          badDeck(404, "unknown_slides_route");
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Agentic Spreadsheet routes — the workbook analog of the deck
    // routes above. workbook/workbook.json is the source of truth; the
    // engine (core) owns its content, these routes only read, persist
    // validated canvas saves, release the staged blueprint (Buat),
    // archive on new-chat reset, import source files, and serve
    // on-demand exports.
    if (method === "GET" && url.pathname === "/sheets/workbook") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const workbook = await readWorkbook(root);
          if (!workbook) {
            sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
            return;
          }
          sendJson(res, 200, { root, workbook });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/sheets/workbook/sidecar") {
      void (async () => {
        try {
          const probe = await probeSheetSidecar();
          sendJson(res, 200, { available: probe.available, version: probe.version, path: probe.path });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/sheets/workbook/download") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const rel = url.searchParams.get("path") || "";
          // Only exports inside workbook/ are downloadable.
          if (!rel.startsWith("workbook/") || !/\.(xlsx|csv)$/i.test(rel) || rel.includes("..")) {
            sendJson(res, 400, { error: "invalid_download_path", request_id: requestId });
            return;
          }
          const absolute = resolveInside(root, rel);
          const data = readFileSync(absolute);
          const isXlsx = rel.toLowerCase().endsWith(".xlsx");
          res.writeHead(200, {
            "content-type": isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8",
            "content-length": data.length,
            "content-disposition": `attachment; filename="${basename(rel)}"`,
            ...CORS_HEADERS,
          });
          res.end(data);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/sheets/workbook") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const candidate = parsed.workbook as WorkbookSpec | undefined;
          if (!candidate || typeof candidate !== "object") {
            sendJson(res, 400, { error: "workbook_required", request_id: requestId });
            return;
          }
          // Canvas/editor saves are validated exactly like engine
          // writes: structural errors respond 422 and nothing lands.
          const errors = validateWorkbook(candidate).filter((issue) => issue.severity === "error");
          if (errors.length > 0) {
            sendJson(res, 422, { error: "invalid_workbook", issues: errors, request_id: requestId });
            return;
          }
          await writeWorkbook(root, candidate);
          sendJson(res, 200, { root, workbook: candidate });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/sheets/workbook/generate") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          await ensureProvidersLoaded(ctx);
          const input = {
            ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
            ...(typeof parsed.provider_id === "string" ? { providerId: parsed.provider_id } : {}),
          };
          // The staged run completes through its own task: release it
          // and answer with that task's own verdict.
          for (const runner of ctx.activeRunners.values()) {
            const released = await runner.releaseStagedWorkbook(root);
            if (released) {
              sendJson(res, 200, { root, task_id: released.taskId, outcome: released.outcome, summary: released.summary, exported: released.exported ?? null });
              return;
            }
          }
          for (const runner of ctx.activeRunners.values()) {
            if (runner.hasSpreadsheetEngineFor(root)) {
              sendJson(res, 409, { error: "sheet_run_in_progress", message: "Tugas spreadsheet sedang berjalan di workspace ini — tunggu selesai sebelum menekan Buat.", request_id: requestId });
              return;
            }
          }
          const workbook = await readWorkbook(root).catch(() => null);
          if (!workbook) {
            sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
            return;
          }
          if (workbook.stage !== "blueprint" || !workbook.blueprint) {
            sendJson(res, 409, { error: "no_staged_blueprint", message: "Tidak ada blueprint yang menunggu dibangun di workspace ini.", request_id: requestId });
            return;
          }
          const runner = new TaskRunner({
            workspaceRoot: root,
            bus: ctx.bus,
            store: ctx.store,
            settings: ctx.settings,
            providerRegistry: ctx.providerStore.registry,
          });
          const built = await runner.buildStagedWorkbook(root, input);
          if (!built) {
            sendJson(res, 409, { error: "no_staged_blueprint", message: "Tidak ada blueprint yang menunggu dibangun di workspace ini.", request_id: requestId });
            return;
          }
          sendJson(res, 200, { root, outcome: built.outcome, summary: built.summary, exported: null });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/sheets/workbook/reset") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          let stagedAbandoned = false;
          for (const runner of ctx.activeRunners.values()) {
            if (!runner.hasSpreadsheetEngineFor(root)) continue;
            if (runner.abandonStagedWorkbook(root)) {
              stagedAbandoned = true;
              continue;
            }
            sendJson(res, 409, { error: "sheet_run_in_progress", message: "Tugas spreadsheet sedang berjalan di workspace ini — tunggu selesai sebelum memulai chat baru.", request_id: requestId });
            return;
          }
          const workbookDir = workbookPaths(root).dir;
          const dirStat = await stat(workbookDir).catch(() => null);
          if (!dirStat?.isDirectory()) {
            sendJson(res, 200, { root, archived: null, staged_abandoned: stagedAbandoned });
            return;
          }
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const archiveParent = join(root, ".daedalus", "workbook-archive");
          await mkdir(archiveParent, { recursive: true });
          let name = stamp;
          for (let suffix = 2; await stat(join(archiveParent, name)).then(() => true, () => false); suffix += 1) {
            name = `${stamp}-${suffix}`;
          }
          await rename(workbookDir, join(archiveParent, name));
          sendJson(res, 200, { root, archived: `.daedalus/workbook-archive/${name}`, staged_abandoned: stagedAbandoned });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/sheets/workbook/open") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const rel = typeof parsed.path === "string" ? parsed.path : "";
          if (!rel || rel.includes("..") || !/\.(csv|xlsx)$/i.test(rel)) {
            sendJson(res, 400, { error: "invalid_open_path", message: "path harus file .csv/.xlsx di dalam workspace", request_id: requestId });
            return;
          }
          const absolute = resolveInside(root, rel);
          const title = basename(rel).replace(/\.(csv|xlsx)$/i, "");
          let workbook: WorkbookSpec;
          if (rel.toLowerCase().endsWith(".csv")) {
            const text = await readFile(absolute, "utf8");
            workbook = importCsvToWorkbook(title, text, { createdBy: "daedalus-web-open" });
          } else {
            const buffer = await readFile(absolute);
            workbook = await importXlsxToWorkbook(title, buffer, { createdBy: "daedalus-web-open" });
          }
          // Opening a file makes it the editable workbook: fully built
          // (stage ready) with an auto-derived blueprint describing
          // its structure, so chat tasks can audit/edit it directly.
          workbook.stage = "ready";
          await writeWorkbook(root, workbook);
          sendJson(res, 200, { root, workbook });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/sheets/workbook/export") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const workbook = await readWorkbook(root);
          if (!workbook) {
            sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
            return;
          }
          const format = parsed.format === "csv" ? "csv" : "xlsx";
          const sheetName = typeof parsed.sheet === "string" ? parsed.sheet : undefined;
          if (format === "csv") {
            if (sheetName) {
              const single = exportSheetToCsvText(workbook, sheetName);
              if (!single.ok) {
                sendJson(res, 400, { error: "export_failed", issues: single.issues, request_id: requestId });
                return;
              }
            }
            const records = await exportWorkbookCsv(workbook, root, sheetName);
            workbook.exports = [...records, ...(workbook.exports ?? [])].slice(0, 10);
            await writeWorkbook(root, workbook);
            sendJson(res, 200, { root, records });
            return;
          }
          const record = await exportWorkbookToXlsx(workbook, root);
          workbook.exports = [record, ...(workbook.exports ?? [])].slice(0, 10);
          await writeWorkbook(root, workbook);
          sendJson(res, 200, { root, records: [record] });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Verify on demand (the SheetStage toolbar's Verify button): the
    // deterministic gate — export to .xlsx, run the core evaluator
    // plus the LibreOffice recalc arm when present — persisted onto
    // workbook.verify exactly like the engine's own gate, no model
    // call involved.
    if (method === "POST" && url.pathname === "/sheets/workbook/verify") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const workbook = await readWorkbook(root);
          if (!workbook) {
            sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
            return;
          }
          const record = await exportWorkbookToXlsx(workbook, root);
          const verify = await verifyWorkbook(workbook, { exportPath: record.path });
          workbook.verify = verify;
          workbook.exports = [record, ...(workbook.exports ?? [])].slice(0, 10);
          await writeWorkbook(root, workbook);
          sendJson(res, 200, { root, verify, record, request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Workbook checkpoints: previous states of workbook.json kept
    // under .daedalus/workbook-history (snapshotted on every
    // writeWorkbook). Restore is never destructive — the current
    // state is snapshotted first, so it stays in history.
    if (method === "GET" && url.pathname === "/sheets/workbook/checkpoints") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const checkpoints = await listWorkbookCheckpoints(root);
          sendJson(res, 200, { checkpoints, count: checkpoints.length, request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/sheets/workbook/restore") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const name = typeof parsed.name === "string" ? parsed.name : "";
          const restored = await restoreWorkbookCheckpoint(root, name);
          sendJson(res, 200, { root, name, workbook: restored, request_id: requestId });
        } catch (error) {
          const message = errorMessage(error);
          const status =
            message === "nama checkpoint tidak valid"
              ? 400
              : message === "checkpoint tidak ditemukan"
                ? 404
                : message === "checkpoint bukan workbook yang valid" || message === "checkpoint rusak (bukan JSON valid)"
                  ? 422
                  : errorStatus(error);
          sendJson(res, status, { error: message, request_id: requestId });
        }
      })();
      return;
    }

    // Pratinjau status: is a render (Excel on Windows, or LibreOffice)
    // of the CURRENT workbook state cached, rendering, stale, or
    // impossible on this machine? Always 200 with an honest state
    // (workbook missing is 404, as everywhere else here).
    if (method === "GET" && url.pathname === "/sheets/workbook/preview") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          const workbook = await readWorkbook(root);
          if (!workbook) {
            sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
            return;
          }
          const status = await sheetPreview.status(root, workbook, (key, page) => sheetPreviewPageUrl(root, key, page));
          sendJson(res, 200, { root, ...status });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // One cached Pratinjau page image. The key is a content hash
    // (64 hex chars); anything else never reaches the filesystem.
    if (method === "GET" && url.pathname === "/sheets/workbook/preview/page") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const key = url.searchParams.get("key") || "";
        const page = Number(url.searchParams.get("page") || "");
        if (!key || !Number.isInteger(page) || page < 1) {
          sendJson(res, 400, { error: "invalid_preview_page", request_id: requestId });
          return;
        }
        const data = sheetPreview.readPageBytes(root, key, page);
        if (!data) {
          sendJson(res, 404, { error: "preview_page_not_found", request_id: requestId });
          return;
        }
        res.writeHead(200, { "content-type": "image/png", "content-length": data.length, ...CORS_HEADERS });
        res.end(data);
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
      }
      return;
    }

    // Queue a Pratinjau render of the current workbook state (serial,
    // deduped per state hash). Returns the status immediately; the web
    // polls GET /sheets/workbook/preview until ready/error.
    if (method === "POST" && url.pathname === "/sheets/workbook/preview") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const workbook = await readWorkbook(root);
          if (!workbook) {
            sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
            return;
          }
          const status = await sheetPreview.render(root, workbook, (key, page) => sheetPreviewPageUrl(root, key, page));
          sendJson(res, 200, { root, ...status });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Mode Analis (Agentic Spreadsheet): stage an analysis plan.
    // Body: { question, dataset: { kind: 'csv', text, name? } |
    // { kind: 'xlsx', base64, name? } | { kind: 'workbook', key },
    // root?, model?, provider_id? }. The dataset is ingested to a
    // WorkbookSpec, profiled deterministically by the core, then the
    // two-call planner (intent routing + plan) runs against the LLM
    // provider — the same provider resolution as /diff/review. The
    // returned planId is the SINGLE confirmation gate: the client shows
    // the staged plan for review and the user pressing "Jalankan
    // analisis" calls POST /sheets/analyze/run. Staged plans expire
    // after 30 minutes (swept every 5).
    if (method === "POST" && url.pathname === "/sheets/analyze/plan") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const question = typeof parsed.question === "string" ? parsed.question.trim() : "";
          if (!question) {
            sendJson(res, 400, { error: "question_required", request_id: requestId });
            return;
          }
          const rawDataset = (parsed.dataset ?? {}) as Record<string, unknown>;
          const kind = rawDataset.kind;
          if (kind !== "csv" && kind !== "xlsx" && kind !== "workbook") {
            sendJson(res, 400, { error: "invalid_dataset", message: "dataset.kind harus 'csv', 'xlsx', atau 'workbook'", request_id: requestId });
            return;
          }
          const root = resolveAllowedRoot(
            ctx,
            parsed.root ?? (kind === "workbook" && typeof rawDataset.key === "string" ? rawDataset.key : undefined),
          );
          const hooks = await resolveAnalysisHooks(ctx);
          let workbook: WorkbookSpec;
          let dataset: AnalysisDataset;
          if (kind === "csv") {
            const text = typeof rawDataset.text === "string" ? rawDataset.text : "";
            if (!text) {
              sendJson(res, 400, { error: "dataset_text_required", request_id: requestId });
              return;
            }
            const name = typeof rawDataset.name === "string" && rawDataset.name ? rawDataset.name : "dataset";
            workbook = await hooks.importCsv(name, text, { createdBy: "sheets-analyze" });
            dataset = { kind: "csv", text, name };
          } else if (kind === "xlsx") {
            const base64 = typeof rawDataset.base64 === "string" ? rawDataset.base64 : "";
            if (!base64) {
              sendJson(res, 400, { error: "dataset_base64_required", request_id: requestId });
              return;
            }
            const name = typeof rawDataset.name === "string" && rawDataset.name ? rawDataset.name : "dataset";
            workbook = await hooks.importXlsx(name, Buffer.from(base64, "base64"), { createdBy: "sheets-analyze" });
            dataset = { kind: "xlsx", base64, name };
          } else {
            const existing = await readWorkbook(root);
            if (!existing) {
              sendJson(res, 404, { error: "workbook_not_found", request_id: requestId });
              return;
            }
            workbook = existing;
            dataset = { kind: "workbook", key: root };
          }
          const profiles = await hooks.profileWorkbook(workbook);
          await ensureProvidersLoaded(ctx);
          const provider = analysisProviderFromRequest(ctx, parsed);
          if (!provider) {
            sendJson(res, 400, { error: "no_provider_configured", request_id: requestId });
            return;
          }
          const intent = await hooks.classifyIntent({ question, profiles, provider });
          const plan = await hooks.generatePlan({ question, profiles, intent, provider });
          const staged = stageAnalysisPlan({
            question,
            workspaceRoot: root,
            dataset,
            workbook,
            plan,
            profiles,
            complexity: intent.complexity,
          });
          sendJson(res, 200, {
            planId: staged.planId,
            plan,
            profiles,
            complexity: staged.complexity,
            request_id: requestId,
          });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Mode Analis: run a staged plan (the "Jalankan analisis" gate).
    // Body: { planId, model?, provider_id? }. The staged plan is
    // single-use: it is consumed by the run whether the run succeeds
    // or fails the Verify gate. A verify failure inside the engine
    // throws → 422 with the issues; a report is NEVER returned with
    // unverified numbers.
    if (method === "POST" && url.pathname === "/sheets/analyze/run") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const planId = typeof parsed.planId === "string" ? parsed.planId : "";
          const staged = planId ? takeStagedAnalysisPlan(planId) : undefined;
          if (!staged) {
            sendJson(res, 410, { error: "plan_expired", message: "rencana kedaluwarsa, buat ulang", request_id: requestId });
            return;
          }
          const hooks = await resolveAnalysisHooks(ctx);
          await ensureProvidersLoaded(ctx);
          const provider = analysisProviderFromRequest(ctx, parsed);
          if (!provider) {
            sendJson(res, 400, { error: "no_provider_configured", request_id: requestId });
            return;
          }
          const engine = await hooks.createEngine({
            provider,
            bus: ctx.bus,
            store: ctx.store,
            workspaceRoot: staged.workspaceRoot,
          });
          let result;
          try {
            result = await engine.runAnalysis({
              question: staged.question,
              dataset: staged.workbook,
              plan: staged.plan,
              provider,
            });
          } catch (error) {
            const issues = analysisVerifyIssues(error);
            if (issues) {
              sendJson(res, 422, { error: "verify_failed", issues, request_id: requestId });
              return;
            }
            throw error;
          }
          sendJson(res, 200, {
            verify: result.verify,
            report: result.report,
            ...(result.exported ? { exported: result.exported } : {}),
            request_id: requestId,
          });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Mode Analis: read back a staged plan (review surface for the
    // single confirmation gate). 404 when unknown or expired.
    const analyzePlanMatch = /^\/sheets\/analyze\/plan\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && analyzePlanMatch) {
      const staged = peekStagedAnalysisPlan(analyzePlanMatch[1] ?? "");
      if (!staged) {
        sendJson(res, 404, { error: "plan_not_found", request_id: requestId });
        return;
      }
      sendJson(res, 200, {
        planId: staged.planId,
        plan: staged.plan,
        profiles: staged.profiles,
        question: staged.question,
        request_id: requestId,
      });
      return;
    }

    // Agentic Research: stage a research plan (the single confirmation
    // gate). Body: { question, model?, provider_id? }. The plan is
    // staged for review in the left panel; the user pressing "Jalankan
    // riset" calls POST /research/run. Staged plans expire after 30
    // minutes (swept every 5).
    if (method === "POST" && url.pathname === "/research/plan") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        const staged = await stageResearchPlanCore(
          ctx,
          {
            question: typeof parsed.question === "string" ? parsed.question : "",
            ...(parsed.root !== undefined ? { root: parsed.root } : {}),
            ...(typeof parsed.provider_id === "string" ? { provider_id: parsed.provider_id } : {}),
            ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
            ...(typeof parsed.depth === "string" ? { depth: parsed.depth } : {}),
          },
          requestId,
        );
        sendJson(res, staged.status, staged.body);
      })();
      return;
    }

    // Agentic Research: run a staged plan (the "Jalankan riset" gate).
    // Body: { planId, model?, provider_id? }. Shared core above; the
    // route only parses and sends.
    if (method === "POST" && url.pathname === "/research/run") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const out = await runStagedResearchPlanCore(
            ctx,
            parsed as Record<string, unknown>,
            requestId,
          );
          sendJson(res, out.status, out.body);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Agentic Research: status run per planId — untuk recovery client yang
    // request-nya putus (timeout/proxy) saat run masih/sudah berjalan.
    // 200 { status: 'running' } | { status: 'done', reportId } | { status: 'idle' }.
    const researchRunStatusMatch = /^\/research\/run-status\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && researchRunStatusMatch) {
      const statusPlanId = researchRunStatusMatch[1] ?? "";
      if (isResearchRunInProgress(statusPlanId)) {
        sendJson(res, 200, { status: "running", request_id: requestId });
        return;
      }
      const reportId = getResearchRunReportId(statusPlanId);
      if (reportId) {
        sendJson(res, 200, { status: "done", reportId, request_id: requestId });
        return;
      }
      sendJson(res, 200, { status: "idle", request_id: requestId });
      return;
    }

    // Agentic Research: read back a staged plan (review surface for the
    // single confirmation gate). 404 when unknown or expired.
    const researchPlanMatch = /^\/research\/plan\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && researchPlanMatch) {
      const staged = peekStagedResearchPlan(researchPlanMatch[1] ?? "");
      if (!staged) {
        sendJson(res, 404, { error: "plan_not_found", request_id: requestId });
        return;
      }
      sendJson(res, 200, {
        planId: staged.planId,
        plan: staged.plan,
        question: staged.question,
        ...(staged.depth ? { depth: staged.depth } : {}),
        request_id: requestId,
      });
      return;
    }

    // Agentic Research: fetch a completed report by id. 404 when unknown
    // or expired (reports live 24h).
    const researchReportMatch = /^\/research\/report\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && researchReportMatch) {
      const report = getResearchReport(researchReportMatch[1] ?? "");
      if (!report) {
        sendJson(res, 404, { error: "report_not_found", request_id: requestId });
        return;
      }
      sendJson(res, 200, { report, request_id: requestId });
      return;
    }

    // Dae Captain v2 Fase 7 — research-report card [DOCX] button.
    // ?format=docx only (PDF goes through the preview overlay's print;
    // BibTeX is generated client-side from the report JSON).
    const captainReportExportMatch = /^\/captain\/research\/report\/([^/]+)\/export$/.exec(url.pathname);
    if (method === "GET" && captainReportExportMatch?.[1] !== undefined) {
      void (async () => {
        try {
          const format = url.searchParams.get("format") ?? "docx";
          if (format !== "docx") {
            sendJson(res, 400, { error: "unsupported_format", formats: ["docx"], request_id: requestId });
            return;
          }
          const report = getResearchReport(captainReportExportMatch[1] ?? "");
          if (!report) {
            sendJson(res, 404, { error: "report_not_found", request_id: requestId });
            return;
          }
          const { buildResearchReportDocx } = await import("./captain.ts");
          const bytes = await buildResearchReportDocx(report);
          const name = `laporan-riset-${report.reportId.slice(0, 8)}.docx`;
          res.writeHead(200, {
            "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "content-disposition": `attachment; filename="${name}"`,
            "content-length": bytes.length,
          });
          res.end(bytes);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Agentic Research: konten satu sumber untuk preview inline di panel
    // tengah (klik [sN] di laporan). 404 bila laporan/sumber tak dikenal,
    // 502 bila halaman tak bisa diambil.
    const researchSourceMatch = /^\/research\/report\/([^/]+)\/source\/([^/]+)\/content$/.exec(url.pathname);
    if (method === "GET" && researchSourceMatch) {
      void (async () => {
        try {
          const hooks = await resolveResearchHooks(ctx);
          const content = await getResearchSourceContent(
            researchSourceMatch[1] ?? "",
            researchSourceMatch[2] ?? "",
            hooks,
          );
          if (content === "report_not_found") {
            sendJson(res, 404, { error: "report_not_found", request_id: requestId });
            return;
          }
          if (content === "source_not_found") {
            sendJson(res, 404, { error: "source_not_found", request_id: requestId });
            return;
          }
          if (!content) {
            sendJson(res, 502, { error: "source_unavailable", request_id: requestId });
            return;
          }
          sendJson(res, 200, { content, request_id: requestId });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Agentic Research: satu sumber sebagai PDF untuk preview ala pembaca PDF
    // (PDF langsung, Office via LibreOffice, HTML via Chromium print-to-PDF).
    // 404 laporan/sumber tak dikenal, 415 tipe tak didukung, 502 gagal konversi.
    const researchDocMatch = /^\/research\/report\/([^/]+)\/source\/([^/]+)\/document$/.exec(url.pathname);
    if (method === "GET" && researchDocMatch) {
      void (async () => {
        try {
          const doc = await getResearchSourceDocument(
            researchDocMatch[1] ?? "",
            researchDocMatch[2] ?? "",
            ctx.researchDocHooks ?? defaultResearchDocHooks(),
          );
          if (doc === "report_not_found") {
            sendJson(res, 404, { error: "report_not_found", request_id: requestId });
            return;
          }
          if (doc === "source_not_found") {
            sendJson(res, 404, { error: "source_not_found", request_id: requestId });
            return;
          }
          if (doc === "unsupported") {
            sendJson(res, 415, { error: "unsupported_document", request_id: requestId });
            return;
          }
          if (!doc) {
            sendJson(res, 502, { error: "document_unavailable", request_id: requestId });
            return;
          }
          const safeName = (doc.title || "sumber").replace(/[^\w\-. ]+/g, "").trim().slice(0, 60) || "sumber";
          res.writeHead(200, {
            "content-type": "application/pdf",
            "content-length": doc.pdf.length,
            "content-disposition": `inline; filename="${safeName}.pdf"`,
            "cache-control": "private, max-age=3600",
            ...CORS_HEADERS,
          });
          res.end(doc.pdf);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    // Agentic Research: live progress events for a run (polled by the
    // left panel while "Jalankan riset" is running). Keyed by planId.
    const researchProgressMatch = /^\/research\/progress\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && researchProgressMatch) {
      const key = researchProgressMatch[1] ?? "";
      sendJson(res, 200, { events: getResearchProgress(key), request_id: requestId });
      return;
    }

    if (method === "POST" && (url.pathname === "/uploads" || url.pathname === "/upload" || url.pathname === "/attachments")) {
      void handleUpload(ctx, req, res, requestId);
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/pins") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.session.workspaceRoot || ctx.cwd);
          const pins = await loadPins(resolveDaedalusHome(ctx.settings.daedalusHome, root));
          sendJson(res, 200, { root, pins });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if ((method === "PUT" || method === "POST") && url.pathname === "/workspace/pins") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const pins = await savePins(resolveDaedalusHome(ctx.settings.daedalusHome, root), parsed.pins);
          sendJson(res, 200, { root, pins });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/roots") {
      sendJson(res, 200, { roots: collectRoots(ctx.cwd, [...recordedRoots(ctx), ...ctx.workspaces]), cwd: ctx.cwd, session: publicSession(ctx) });
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/plans") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        // Resolve each plan's producing task from the event log (the task
        // whose FILE_CHANGED events wrote the slug's documents, latest
        // write wins) so a chip execution can carry plan_task_id even when
        // the producing task is not on screen. Without it the follow-up
        // arrives as a bare creation-shaped goal and the pre-build
        // question gate mistakes an approved spec for a fresh brief.
        const plans = listPlanDocuments(root).map((plan) => ({ ...plan, taskId: planProducerTaskId(ctx, plan.slug) }));
        sendJson(res, 200, { root, plans });
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/tree") {
      const depth = clampDepth(url.searchParams.get("depth"));
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const path = url.searchParams.get("path") || ".";
        sendJson(res, 200, buildTree(root, path, depth));
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/files") {
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const { files, truncated } = listFilesFlat(root);
        sendJson(res, 200, { root, files, truncated });
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/list") {
      const path = url.searchParams.get("path") || ".";
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        sendJson(res, 200, { path, items: listDirectory(root, path) });
      } catch (error) {
        sendJson(res, errorStatus(error), { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/file") {
      const targetRel = url.searchParams.get("path") || "";
      if (!targetRel) {
        sendJson(res, 400, { error: "path_required" });
        return;
      }
      try {
        const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
        const absolute = resolveInside(root, targetRel);
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
          sendJson(res, 400, { error: "path_is_directory" });
          return;
        }
        const mediaType = IMAGE_MEDIA_TYPES[extname(absolute).toLowerCase()];
        const limit = mediaType ? MAX_IMAGE_FILE_BYTES : MAX_FILE_BYTES;
        if (stat.size > limit) {
          sendJson(res, 413, { error: "file_too_large", size: stat.size, limit });
          return;
        }
        if (mediaType) {
          sendJson(res, 200, {
            path: targetRel,
            size: stat.size,
            kind: "image",
            mediaType,
            src: `data:${mediaType};base64,${readFileSync(absolute).toString("base64")}`,
          });
          return;
        }
        sendJson(res, 200, { path: targetRel, kind: "text", content: readFileSync(absolute, "utf8"), size: stat.size });
      } catch (error) {
        sendJson(res, errorMessage(error).includes("escapes workspace") ? 404 : errorStatus(error), { error: errorMessage(error) });
      }
      return;
    }

    if (method === "GET" && url.pathname === "/workspace/git-status") {
      void (async () => {
        try {
          const root = resolveAllowedRoot(ctx, url.searchParams.get("root") || ctx.cwd);
          sendJson(res, 200, await gitStatus(root));
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    if (method === "POST" && url.pathname === "/workspace/git-revert") {
      void (async () => {
        const parsed = await readJson(req);
        if (!parsed) {
          sendJson(res, 400, { error: "invalid_json", request_id: requestId });
          return;
        }
        try {
          const root = resolveAllowedRoot(ctx, parsed.root);
          const target = sanitizeRelativePath(typeof parsed.path === "string" ? parsed.path : "");
          if (!target) {
            sendJson(res, 400, { error: "path_required", request_id: requestId });
            return;
          }
          const outcome = await revertFileToHead(root, target);
          if (!outcome.ok) {
            const statusCode = outcome.reason === "untracked" ? 400 : 409;
            sendJson(res, statusCode, { error: outcome.reason, request_id: requestId });
            return;
          }
          sendJson(res, 200, { reverted: target, root });
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
      return;
    }

    sendJson(res, 404, { error: "not_found", request_id: requestId });
  });
}

function recordedRoots(ctx: AppContext): string[] {
  return ctx.store
    .listTasks()
    .map((id) => {
      const state = ctx.store.loadState<Record<string, unknown>>(id);
      const direct = state?.repo_path;
      const nested = (state?.spec as { repo_path?: string } | undefined)?.repo_path;
      return typeof direct === "string" ? direct : typeof nested === "string" ? nested : undefined;
    })
    .filter((value): value is string => typeof value === "string");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clampDepth(value: string | null): number {
  const parsed = Number.parseInt(value ?? "2", 10);
  if (Number.isNaN(parsed)) return 2;
  return Math.min(4, Math.max(1, parsed));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { attachWebSocket } from "./events.ts";
export type { Event } from "@daedalus/core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  redactSettings,
  resolveDaedalusHome,
  reviewDiff,
  savePins,
  seedProviderFromSettings,
  unstagedDiff,
  workspaceAgentsDir,
  resolveSkillSearchDirs,
  exportDeckToPptx,
  getSlideTemplate,
  listSlideTemplates,
  newSlideId,
  readDeck,
  validateDeck,
  writeDeck,
  type DeckSpec,
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
} from "@daedalus/core";
import { collectRoots, listDirectory, listFilesFlat, listPlanDocuments, buildTree, resolveInside, MAX_FILE_BYTES, IMAGE_MEDIA_TYPES, MAX_IMAGE_FILE_BYTES } from "./workspace.ts";
import { classifyWebIntent, executeFastPath } from "./fast-path.ts";
import { gitStatus, revertFileToHead } from "./git-status.ts";
import {
  ConversationStore,
  historyMessages,
  priorContextSection,
  taskSummaryText,
  type Conversation,
  type ConversationTurn,
} from "./conversations.ts";
import { TerminalError, TerminalManager } from "./terminals.ts";
import { UPLOAD_LIMITS, extractZipEntries, guessMimeType, parseMultipart, sanitizeRelativePath, type UploadPart } from "./uploads.ts";

/**
 * REST + WebSocket gateway (PLAN.md §3.0, §3.6). Commands and reads only —
 * no agent, tool, or LLM logic lives here; the core owns execution.
 */

export type SessionState = {
  mode: AgentMode;
  autoApprove: boolean;
  thinking: boolean;
  providerId?: string;
  model?: string;
  workspaceRoot: string;
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
  webDist?: string;
  extensionStatusCache?: Map<string, { expiresAt: number; value: ExtensionStatus }>;
};

export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const settings = overrides.settings ?? loadSettings();
  const cwd = overrides.cwd ?? process.cwd();
  // The daemon launcher anchors the session to the directory `daedalus`
  // was invoked in (DAEDALUS_WORKSPACE); the server process cwd is only
  // the fallback. An explicit session override still wins.
  const anchoredWorkspace = process.env.DAEDALUS_WORKSPACE ? resolve(process.env.DAEDALUS_WORKSPACE) : cwd;
  const session = overrides.session ?? { mode: "auto", autoApprove: false, thinking: settings.session?.thinking ?? true, workspaceRoot: anchoredWorkspace };
  return {
    bus: overrides.bus ?? new EventBus(),
    store: overrides.store ?? new TaskStore(resolveDaedalusHome(settings.daedalusHome, cwd)),
    log: overrides.log ?? createLogger({ base: { service: "daedalus-server" } }),
    startedAt: overrides.startedAt ?? Date.now(),
    cwd,
    activeRunners: overrides.activeRunners ?? new Map<string, TaskRunner>(),
    approvalMemory: overrides.approvalMemory ?? new Map<string, ApprovalDecision>(),
    terminals: overrides.terminals ?? new TerminalManager(),
    settings,
    providerStore: overrides.providerStore ?? new ProviderRegistryStore(resolveDaedalusHome(settings.daedalusHome, cwd)),
    session,
    workspaces: overrides.workspaces ?? new Set<string>([resolve(cwd), resolve(session.workspaceRoot)]),
    webDist: overrides.webDist,
    extensionStatusCache: overrides.extensionStatusCache ?? new Map(),
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

const WEB_API_PREFIXES = ["/health", "/settings", "/session", "/providers", "/models", "/tasks", "/workspace", "/slides", "/uploads", "/upload", "/attachments", "/extensions", "/review", "/terminals"];

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
  if (WEB_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return false;
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

function applySessionUpdate(ctx: AppContext, parsed: Record<string, unknown>): void {
  const mode = parseMode(parsed.mode);
  if (parsed.mode !== undefined && !mode) throw new Error(`invalid mode: ${String(parsed.mode)}`);
  if (mode) ctx.session.mode = mode;
  if (parsed.autoApprove !== undefined) {
    if (typeof parsed.autoApprove !== "boolean") throw new Error("autoApprove must be a boolean");
    ctx.session.autoApprove = parsed.autoApprove;
  }
  if (parsed.thinking !== undefined) {
    if (typeof parsed.thinking !== "boolean") throw new Error("thinking must be a boolean");
    ctx.session.thinking = parsed.thinking;
    if (ctx.settings.session) ctx.settings.session.thinking = parsed.thinking;
    else (ctx.settings as { session?: { thinking: boolean } }).session = { thinking: parsed.thinking };
  }
  if (typeof parsed.providerId === "string") ctx.session.providerId = parsed.providerId;
  if (typeof parsed.provider_id === "string") ctx.session.providerId = parsed.provider_id;
  if (typeof parsed.model === "string") ctx.session.model = parsed.model;
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
  const llm = typeof parsed.llm === "object" && parsed.llm !== null ? (parsed.llm as Record<string, unknown>) : undefined;
  if (llm) {
    if (typeof llm.baseUrl === "string") ctx.settings.llm.baseUrl = llm.baseUrl;
    if (typeof llm.base_url === "string") ctx.settings.llm.baseUrl = llm.base_url;
    if (typeof llm.model === "string") {
      ctx.settings.llm.model = llm.model;
      ctx.session.model = llm.model;
    }
  }
  if (typeof parsed.model === "string") ctx.session.model = parsed.model;
  if (typeof parsed.providerId === "string") ctx.session.providerId = parsed.providerId;
  if (typeof parsed.provider_id === "string") ctx.session.providerId = parsed.provider_id;
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
      sendJson(res, 200, { providers: registry.list(), presets: PROVIDER_PRESETS });
      return;
    }

    if (method === "POST" && url.pathname === "/providers") {
      const parsed = await readJson(req);
      if (!parsed) {
        sendJson(res, 400, { error: "invalid_json", request_id: requestId });
        return;
      }
      const provider = registry.upsert(providerInput(parsed) as never);
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
        const provider = registry.upsert(providerInput({ ...parsed, id }) as never);
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

function providerInput(parsed: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...parsed };
  if (typeof input.base_url === "string" && typeof input.baseUrl !== "string") input.baseUrl = input.base_url;
  if (typeof input.api_key === "string" && typeof input.apiKey !== "string") input.apiKey = input.api_key;
  if (input.apiKey === "") delete input.apiKey;
  delete input.apiKeyMasked;
  delete input.api_key;
  delete input.base_url;
  delete input.hasApiKey;
  return input;
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

function taskStores(ctx: AppContext): TaskStore[] {
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
  return stores;
}

function findTask(ctx: AppContext, taskId: string): TaskLookup | undefined {
  for (const store of taskStores(ctx)) {
    const state = store.loadState<Record<string, unknown>>(taskId);
    if (state !== undefined) return { store, state };
    if (store.replay(taskId).length > 0) return { store, state: {} };
  }
  return undefined;
}

function allTaskIds(ctx: AppContext): string[] {
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

function summarizeFrom(ctx: AppContext, lookup: TaskLookup, taskId: string): Record<string, unknown> {
  const { store, state } = lookup;
  const spec = (state.spec && typeof state.spec === "object" ? state.spec : state) as Record<string, unknown>;
  const events = store.replay(taskId);
  const report = store.loadReport<{ outcome?: string }>(taskId);
  const last = events.at(-1);
  const stateStatus = typeof state.status === "string" ? state.status : "unknown";
  const outcome = typeof report?.outcome === "string" ? report.outcome : stateStatus === "unknown" ? undefined : stateStatus;
  const activeStatus = ["created", "pending", "active", "running"].includes(stateStatus);
  return {
    id: taskId,
    goal: typeof spec.goal === "string" ? spec.goal : undefined,
    title: typeof state.title === "string" ? state.title : typeof spec.title === "string" ? spec.title : undefined,
    repo_path: typeof spec.repo_path === "string" ? spec.repo_path : typeof state.repo_path === "string" ? state.repo_path : undefined,
    status: report?.outcome ?? stateStatus,
    ...(outcome ? { outcome } : {}),
    mode: typeof state.mode === "string" ? state.mode : typeof spec.mode === "string" ? spec.mode : undefined,
    ...(typeof state.conversation_id === "string" ? { conversation_id: state.conversation_id } : {}),
    thinking: typeof state.thinking === "boolean" ? state.thinking : typeof spec.thinking === "boolean" ? spec.thinking : undefined,
    created_at: typeof spec.created_at === "string" ? spec.created_at : typeof state.created_at === "string" ? state.created_at : events[0]?.ts ?? null,
    event_count: events.length,
    last_seq: last?.seq ?? 0,
    last_event: last?.type ?? null,
    updated_at: last?.ts ?? (typeof spec.created_at === "string" ? spec.created_at : null),
    running: ctx.activeRunners.has(taskId) || (activeStatus && !report),
    store_root: store.root,
  };
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

export function createApp(ctx: AppContext) {
  // Mirror the harness' command lifecycle into the per-workspace agent
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
        try {
          const parsed = await readJson(req);
          if (!parsed) {
            sendJson(res, 400, { error: "invalid_json", request_id: requestId });
            return;
          }
          const goal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
          if (goal === "") {
            sendJson(res, 400, { error: "goal_required", request_id: requestId });
            return;
          }
          if (parsed.mode !== undefined && !parseMode(parsed.mode)) {
            sendJson(res, 400, { error: "invalid_mode", modes: AGENT_MODES, request_id: requestId });
            return;
          }
          if (parsed.isolation !== undefined && parsed.isolation !== "worktree") {
            sendJson(res, 400, { error: "invalid_isolation", request_id: requestId });
            return;
          }
          const isolation = parsed.isolation === "worktree" ? ("worktree" as const) : undefined;
          if (parsed.domain !== undefined && parsed.domain !== "coding" && parsed.domain !== "slide") {
            sendJson(res, 400, { error: "invalid_domain", request_id: requestId });
            return;
          }
          const domain = parsed.domain === "slide" || parsed.domain === "coding" ? parsed.domain : undefined;

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
              sendJson(res, 400, { error: "invalid_slide_generation", request_id: requestId });
              return;
            }
            const countRaw = raw.slide_count ?? raw.slideCount;
            const slideCount = typeof countRaw === "number" && Number.isFinite(countRaw) ? Math.floor(countRaw) : undefined;
            if (countRaw !== undefined && (slideCount === undefined || slideCount < 1 || slideCount > 40)) {
              sendJson(res, 400, { error: "invalid_slide_count", request_id: requestId });
              return;
            }
            const language = typeof raw.language === "string" && raw.language.trim() ? raw.language.trim().slice(0, 40) : undefined;
            const templateRaw = raw.template_id ?? raw.templateId;
            const templateId = typeof templateRaw === "string" && templateRaw.trim() ? templateRaw.trim() : undefined;
            if (templateId && !getSlideTemplate(templateId)) {
              sendJson(res, 400, { error: "unknown_slide_template", request_id: requestId });
              return;
            }
            const parsed2: SlideTaskParams = {
              ...(generation ? { generation } : {}),
              ...(slideCount ? { slideCount } : {}),
              ...(language ? { language } : {}),
              ...(templateId ? { templateId } : {}),
            };
            slide = Object.keys(parsed2).length > 0 ? parsed2 : undefined;
          }

          await ensureProvidersLoaded(ctx);
          const taskId = crypto.randomUUID();
          const repoPath = resolveTaskRepo(ctx, parsed.repo_path ?? parsed.repoPath);
          const constraints = stringList(parsed.constraints);
          const doneCriteria = stringList(parsed.done_criteria ?? parsed.doneCriteria);
          const mode = parseMode(parsed.mode) ?? ctx.session.mode;
          const autoApprove = typeof parsed.auto_approve === "boolean" ? parsed.auto_approve : typeof parsed.autoApprove === "boolean" ? parsed.autoApprove : ctx.session.autoApprove;
          const maxIterations = typeof parsed.max_iterations === "number" ? parsed.max_iterations : typeof parsed.maxIterations === "number" ? parsed.maxIterations : 25;
          const providerId = typeof parsed.provider_id === "string" ? parsed.provider_id : typeof parsed.providerId === "string" ? parsed.providerId : ctx.session.providerId;
          const model = typeof parsed.model === "string" ? parsed.model : ctx.session.model;
          const thinking = typeof parsed.thinking === "boolean" ? parsed.thinking : ctx.session.thinking;
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
              sendJson(res, 400, { error: problems.join("; "), request_id: requestId });
              return;
            }
          }

          // Direct answers (the Crush/Cline message pattern): casual
          // conversation and pure questions go straight to the model and the
          // reply is the result — no manufactured plan, no tool loop, no
          // validation. Modes still govern everything classified as a task;
          // attachments/worktrees always take the task path. Slide-domain
          // submits also always take the full task path: the fast answer
          // paths have no tool loop, so they could never touch the deck.
          const intent = attachments.length || isolation || skillNames.length || domain === "slide" ? "task" : classifyWebIntent(goal);
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
            sendJson(res, 201, task);
            return;
          }

          const runner = new TaskRunner({
            workspaceRoot: repoPath,
            approvalPolicy: autoApprove ? "auto" : "ask",
            approvalMemory: ctx.approvalMemory,
            maxIterations,
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
              ...(typeof parsed.plan_task_id === "string" && parsed.plan_task_id ? { planTaskId: parsed.plan_task_id } : {}),
              ...(priorContext ? { priorContext } : {}),
              ...(conversationId ? { conversationId } : {}),
              ...(domain ? { domain } : {}),
              ...(slide ? { slide } : {}),
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

          sendJson(res, 201, task);
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
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

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && taskMatch?.[1] !== undefined) {
      const taskId = taskMatch[1] as string;
      const lookup = findTask(ctx, taskId);
      if (!lookup) {
        sendJson(res, 404, { error: "not_found", request_id: requestId });
        return;
      }
      sendJson(res, 200, {
        state: lookup.state,
        events: lookup.store.replay(taskId),
        report: lookup.store.loadReport<FinalReport>(taskId) ?? null,
        running: ctx.activeRunners.has(taskId) || summarizeFrom(ctx, lookup, taskId).running === true,
        task: summarizeFrom(ctx, lookup, taskId),
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
          const commit = async (next: DeckSpec) => {
            const errors = validateDeck(next, { root }).filter((issue) => issue.severity === "error");
            if (errors.length > 0) {
              badDeck(422, "deck_invalid", { issues: errors });
              return;
            }
            await writeDeck(root, next);
            sendJson(res, 200, { root, deck: next });
          };

          if (url.pathname === "/slides/deck/theme") {
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
            if (!template && accent === undefined && parsed.dark === undefined) {
              badDeck(400, "nothing_to_apply");
              return;
            }
            const next: DeckSpec = { ...deck, theme: { ...(template ? { ...template.theme, templateId: template.id } : deck.theme) } };
            if (typeof accent === "string") next.theme = { ...next.theme, accent };
            if (typeof parsed.dark === "boolean") next.theme = { ...next.theme, dark: parsed.dark };
            await commit(next);
            return;
          }

          if (url.pathname === "/slides/deck/export") {
            const result = await exportDeckToPptx(deck, root);
            sendJson(res, 200, { root, path: result.relativePath, bytes: result.bytes, slides: result.slideCount });
            return;
          }

          const slideId = typeof parsed.slide_id === "string" ? parsed.slide_id : typeof parsed.slideId === "string" ? parsed.slideId : undefined;
          const index = deck.slides.findIndex((slide) => slide.id === slideId);

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
            await writeDeck(root, next);
            sendJson(res, 200, { root, deck: next, slide_id: slide.id });
            return;
          }

          if (!slideId || index < 0) {
            badDeck(404, "slide_not_found");
            return;
          }

          if (url.pathname === "/slides/deck/slide/update") {
            const content = parsed.content;
            if (!content || typeof content !== "object" || Array.isArray(content)) {
              badDeck(400, "content_required");
              return;
            }
            const current = deck.slides[index]!;
            const layout = typeof parsed.layout === "string" && parsed.layout ? parsed.layout : current.layout;
            // Shallow merge, exactly like the agent's update_slide.
            const slides = deck.slides.map((slide, i) => (i === index ? { ...slide, layout, content: { ...slide.content, ...(content as Record<string, unknown>) } } : slide));
            await commit({ ...deck, slides });
            return;
          }

          if (url.pathname === "/slides/deck/slide/delete") {
            await commit({ ...deck, slides: deck.slides.filter((_, i) => i !== index) });
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
            await commit({ ...deck, slides });
            return;
          }

          badDeck(404, "unknown_slides_route");
        } catch (error) {
          sendJson(res, errorStatus(error), { error: errorMessage(error), request_id: requestId });
        }
      })();
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
#!/usr/bin/env node

// Portable Agent Skill CLI for Codex Slides. It intentionally uses only Node
// built-ins and the app's HTTP API, so the skill works with or without MCP.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.CODEX_SLIDES_URL || "http://127.0.0.1:4311").replace(/\/$/, "");
const LOG_PATH = process.env.CODEX_SLIDES_LOG || join(tmpdir(), "codex-slides-server.log");

const COMMANDS = [
  "capabilities", "open", "start-project", "onboard", "research", "create", "outline",
  "revise-outline", "inspiration", "render", "list", "get", "templates",
  "project-templates",
  "edit", "restyle", "slide", "regenerate", "upload-material",
  "upload-slide", "mark-edit", "export", "scenarios", "design-files",
  "read-design-file", "write-design-file", "upload-design-file",
  "get-brand-system", "set-brand-system",
  "speaker-notes",
  "run-start", "run-status", "run-wait", "run-cancel",
];

const CAPABILITIES = [
  ["Open the full workspace", "open", "Browser"],
  ["Start a durable guided project before generation", "start-project", "script + Browser"],
  ["Start a navigation-independent project job", "run-start", "script + Browser"],
  ["Read durable project-job state", "run-status", "script + Browser"],
  ["Wait for a project job without hiding the Browser", "run-wait", "script + Browser"],
  ["Cancel a project job after navigation or reconnect", "run-cancel", "script + Browser"],
  ["Generate tailored onboarding questions", "onboard", "script"],
  ["Run source-backed deep research", "research", "script"],
  ["Create and render a complete deck", "create", "script + Browser"],
  ["Create a draft outline", "outline", "script + Browser"],
  ["Revise or replace an outline", "revise-outline", "script"],
  ["Rank visual inspiration", "inspiration", "script"],
  ["Render a confirmed draft", "render", "script + Browser"],
  ["List and inspect projects", "list / get", "script"],
  ["Read per-slide speaker notes", "speaker-notes --action get", "script + Browser"],
  ["Write or clear per-slide speaker notes", "speaker-notes --action set", "script + Browser"],
  ["Generate a slide or full-deck talk track", "speaker-notes --action generate", "script + Browser"],
  ["Search curated templates and attributed community styles", "templates", "script"],
  ["List, save, or delete reusable project templates", "project-templates", "script + Browser"],
  ["Discover 24 scenario workflows and required source slots", "scenarios", "script + Browser"],
  ["List project Design Files", "design-files", "script + Browser"],
  ["Read or edit an existing text Design File", "read-design-file / write-design-file", "script + Browser"],
  ["Upload a file into the project Design Files workspace", "upload-design-file", "script + Browser"],
  ["Attach Design Files to outline and deck agent turns", "revise-outline / edit", "script + Browser"],
  ["Inspect the always-on brand design system", "get-brand-system", "script + Browser"],
  ["Merge brand, color, type, spacing, asset, and style rules", "set-brand-system", "script + Browser"],
  ["Execute natural-language edits", "edit", "script + Browser"],
  ["Restyle a whole deck", "restyle", "script + Browser"],
  ["Add, duplicate, delete, or transition slides", "slide", "script"],
  ["Generate or regenerate one slide", "regenerate", "script"],
  ["Upload a reference image or document", "upload-material", "script"],
  ["Replace a slide with a local PNG", "upload-slide", "script"],
  ["Apply an annotated-PNG edit", "mark-edit", "script + Browser"],
  ["Export PDF or PPTX", "export", "script + Browser"],
  ["Play, navigate, and mark visually", "open", "Browser UI"],
  ["Inspect structured agent tool activity and reopen referenced files", "open", "Browser UI"],
];

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function browserUrl(projectId, {
  view,
  filePath,
  scenarioId,
  slideIndex,
  panel,
  versionId,
  mode,
  checkpoint,
  conversationId,
  runId,
} = {}) {
  const url = new URL(projectId ? `${BASE}/project/${encodeURIComponent(projectId)}` : BASE);
  if (view && view !== "workspace") url.searchParams.set("view", view);
  if (filePath) url.searchParams.set("file", filePath);
  if (scenarioId) url.searchParams.set("scenario", scenarioId);
  if (Number.isInteger(slideIndex) && slideIndex > 0) url.searchParams.set("slide", String(slideIndex));
  if (panel) url.searchParams.set("panel", panel);
  if (versionId) url.searchParams.set("version", versionId);
  if (mode) url.searchParams.set("mode", mode);
  if (checkpoint) url.searchParams.set("checkpoint", checkpoint);
  if (conversationId) url.searchParams.set("conversation", conversationId);
  if (runId) url.searchParams.set("run", runId);
  return url.toString();
}

function withBrowserHandoff(result) {
  const url = result.browserUrl || result.previewUrl || result.url;
  if (!url) return result;
  const parsed = new URL(url, BASE);
  const slideIndex = Number(parsed.searchParams.get("slide"));
  const focus = {
    ...(Number.isInteger(slideIndex) && slideIndex > 0 ? { slideIndex } : {}),
    ...(parsed.searchParams.get("panel") ? { panel: parsed.searchParams.get("panel") } : {}),
    ...(parsed.searchParams.get("file") ? { filePath: parsed.searchParams.get("file") } : {}),
    ...(parsed.searchParams.get("version") ? { versionId: parsed.searchParams.get("version") } : {}),
    ...(parsed.searchParams.get("mode") ? { mode: parsed.searchParams.get("mode") } : {}),
    ...(parsed.searchParams.get("conversation") ? { conversationId: parsed.searchParams.get("conversation") } : {}),
    ...(parsed.searchParams.get("run") ? { runId: parsed.searchParams.get("run") } : {}),
  };
  return {
    ...result,
    browserHandoff: {
      required: true,
      url: parsed.toString(),
      preferredMode: "codex-internal-browser",
      browserAction: "navigate",
      projectId: result.projectId || result.project?.id || null,
      stage: result.workflowStage || parsed.searchParams.get("checkpoint") || undefined,
      focus,
    },
  };
}

function interactiveProjectUrl(projectId) {
  const url = new URL(BASE);
  url.searchParams.set("resume", projectId);
  return url.toString();
}

function projectFileApiPath(projectId, filePath = "") {
  const encoded = String(filePath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/projects/${encodeURIComponent(projectId)}/files${encoded ? `/${encoded}` : ""}`;
}

function usableAppRoot(candidate) {
  try {
    const root = realpathSync(resolve(candidate));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.name === "codex-slides-web" && existsSync(join(root, "src", "app")) ? root : null;
  } catch {
    return null;
  }
}

function findAppRoot() {
  const candidates = [
    process.env.CODEX_SLIDES_HOME,
    join(homedir(), "plugins", "codex-slides"),
    resolve(SCRIPT_DIR, "../../.."),
    process.cwd(),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const root = usableAppRoot(candidate);
    if (root) return root;
  }
  throw new Error("Codex Slides source was not found. Set CODEX_SLIDES_HOME or install it at ~/plugins/codex-slides.");
}

async function reachable() {
  try {
    const response = await fetch(`${BASE}/api/agents`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

function runChecked(command, args, cwd, label) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status})\n${result.stderr || result.stdout || ""}`);
  }
}

async function ensureServer() {
  if (await reachable()) return;
  const appRoot = findAppRoot();
  if (!existsSync(join(appRoot, "node_modules", "next"))) {
    runChecked("npm", ["install", "--no-audit", "--no-fund"], appRoot, "npm install");
  }
  if (!existsSync(join(appRoot, ".next", "BUILD_ID"))) {
    runChecked("npm", ["run", "build"], appRoot, "npm run build");
  }
  const logFd = openSync(LOG_PATH, "a");
  try {
    const child = spawn("npm", ["run", "start"], {
      cwd: appRoot,
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await reachable()) return;
  }
  throw new Error(`Codex Slides did not start at ${BASE}. See ${LOG_PATH}.`);
}

async function apiFetch(path, init = {}) {
  await ensureServer();
  return fetch(`${BASE}${path}`, init);
}

async function apiJson(path, init = {}) {
  const response = await apiFetch(path, init);
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }
  if (!response.ok) throw new Error(data.error || data.raw || `HTTP ${response.status}`);
  return data;
}

async function postJson(path, body) {
  return apiJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function consumeSse(response, onEvent) {
  if (!response.ok || !response.body) {
    throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = block.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("\n");
      if (!payload) continue;
      try {
        const event = JSON.parse(payload);
        if (event.type === "error") streamError = String(event.error || "stream failed");
        onEvent(event);
      } catch {
        // Ignore malformed progress frames and keep consuming the stream.
      }
    }
  }
  if (streamError) throw new Error(streamError);
}

async function postSse(path, body, onEvent) {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await consumeSse(response, onEvent);
}

function runApiPath(projectId, runId) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/runs`;
  return runId ? `${path}?runId=${encodeURIComponent(runId)}` : path;
}

async function waitForProjectRun(projectId, runId, timeoutSeconds = 120, pollIntervalMs = 750) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const snapshot = await apiJson(runApiPath(projectId, runId));
    if (!snapshot.run) throw new Error(`Project run not found: ${runId}`);
    if (["complete", "error", "cancelled"].includes(snapshot.run.status)) return snapshot;
    if (Date.now() >= deadline) return { ...snapshot, timedOut: true };
    await sleep(pollIntervalMs);
  }
}

async function projectRunInput(input) {
  if (input.kind === "render") {
    return { kind: "render", conversationId: input.conversationId, locale: input.locale };
  }
  if (!input.instruction) throw new Error(`${input.kind || "run"} requires instruction.`);
  const project = await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}`);
  const contextPage = input.slideIndex
    ? project.pages?.find((page) => page.index === input.slideIndex)
    : undefined;
  const materialById = new Map((project.materials || []).map((item) => [item.id, item]));
  const attachments = (input.materialIds || []).flatMap((id) => {
    const item = materialById.get(id);
    if (!item) return [];
    return [{
      id,
      name: item.name,
      url: `/api/projects/${encodeURIComponent(input.projectId)}/materials/${encodeURIComponent(item.file)}`,
      kind: item.kind === "image" ? "image" : "file",
      mimeType: item.mimeType || "application/octet-stream",
      size: item.size || 0,
    }];
  });
  return {
    kind: input.kind,
    conversationId: input.conversationId,
    locale: input.locale,
    request: {
      message: input.instruction,
      context: contextPage ? { slideIndex: input.slideIndex, title: contextPage.title } : undefined,
      attachments,
      designFiles: (input.designFilePaths || []).map((filePath) => ({
        path: filePath,
        relativePath: filePath,
        name: basename(filePath),
        kind: "other",
      })),
    },
  };
}

function mimeFor(path) {
  return {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf",
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
    ".json": "application/json",
  }[extname(path).toLowerCase()] || "application/octet-stream";
}

async function fileForm(filePath, field = "file", maxBytes = 30 * 1024 * 1024) {
  const absolute = resolve(filePath);
  const bytes = await readFile(absolute);
  if (bytes.length > maxBytes) throw new Error(`File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const form = new FormData();
  form.append(field, new Blob([bytes], { type: mimeFor(absolute) }), basename(absolute));
  return { form, absolute, bytes };
}

function slideSummary(page) {
  return {
    index: page.index,
    title: page.title,
    status: page.status,
    image: page.image,
    transition: page.transition || "none",
    speakerNotes: page.speakerNotes || "",
    error: page.error,
  };
}

function deckConfig(input, researchDoc) {
  const hasPreset = Boolean(input.scenarioId || input.projectTemplateId);
  return {
    requirement: input.topic,
    pages: input.pages ?? (input.scenarioId ? undefined : 6),
    aspect: input.aspect ?? (hasPreset ? undefined : "16:9"),
    language: input.language ?? "auto",
    style: input.style ?? (hasPreset ? undefined : ""),
    template: input.template,
    projectTemplateId: input.projectTemplateId,
    resolution: input.resolution ?? (input.projectTemplateId ? undefined : "2K"),
    materialIds: input.materialIds ?? [],
    materialContexts: input.materialContexts ?? [],
    scenarioId: input.scenarioId,
    designSystem: input.designSystem,
    engine: "codex",
    ...(input.fast ? { fast: true } : {}),
    ...(input.research || researchDoc ? { mode: "research", researchDoc: researchDoc || undefined } : {}),
  };
}

async function parseInput(args) {
  const jsonIndex = args.findIndex((arg) => arg === "--json" || arg === "--input");
  if (jsonIndex >= 0) {
    const raw = args[jsonIndex + 1];
    if (!raw) throw new Error("--json requires a JSON object or '-'.");
    return JSON.parse(raw === "-" ? readFileSync(0, "utf8") : raw);
  }
  const fileIndex = args.findIndex((arg) => arg === "--input-file");
  if (fileIndex >= 0) return JSON.parse(await readFile(resolve(args[fileIndex + 1]), "utf8"));
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    index += 1;
    try {
      result[key] = JSON.parse(next);
    } catch {
      result[key] = next;
    }
  }
  return result;
}

async function run(command, input) {
  if (command === "help") {
    return { commands: COMMANDS, usage: "codex-slides.mjs <command> --json '<object>'" };
  }
  if (command === "capabilities") {
    return { baseUrl: BASE, commands: COMMANDS, capabilities: CAPABILITIES.map(([capability, action, surface]) => ({ capability, action, surface })) };
  }
  if (command === "open") {
    const view = input.view || "workspace";
    if (["design-files", "brand-system"].includes(view) && !input.projectId) {
      throw new Error(`${view} requires projectId.`);
    }
    await ensureServer();
    const targetProjectId = view === "scenarios" ? undefined : input.projectId;
    return {
      url: browserUrl(targetProjectId, {
        view,
        filePath: input.filePath,
        scenarioId: input.scenarioId,
        slideIndex: input.slideIndex,
        panel: input.panel,
        versionId: input.versionId,
        mode: input.mode,
        checkpoint: input.checkpoint,
        conversationId: input.conversationId,
        runId: input.runId,
      }),
      projectId: targetProjectId || null,
      view,
      browserAction: "navigate",
    };
  }
  if (command === "start-project") {
    if (!input.topic) throw new Error("topic is required.");
    const project = await postJson("/api/projects", {
      title: input.title,
      config: deckConfig(input, input.researchDoc),
    });
    return {
      projectId: project.id,
      title: project.title,
      workflowStage: project.workflow?.stage || "clarify",
      url: interactiveProjectUrl(project.id),
      browserAction: "navigate",
      interactionMode: "browser-guided",
    };
  }
  if (command === "run-start") {
    if (!input.projectId || !["chat", "outline", "render"].includes(input.kind)) {
      throw new Error("projectId and kind (chat, outline, or render) are required.");
    }
    const data = await postJson(runApiPath(input.projectId), await projectRunInput(input));
    const runId = data.queued ? null : (data.run?.id || data.activeRun?.id || null);
    return {
      projectId: input.projectId,
      runId,
      run: data.run || data.activeRun || null,
      queued: Boolean(data.queued),
      queuedRequestId: data.queuedRequestId || null,
      queue: data.queue || [],
      browserUrl: browserUrl(input.projectId, {
        slideIndex: input.slideIndex,
        conversationId: input.conversationId,
        runId,
        checkpoint: input.kind === "outline" ? "outline" : input.kind === "render" ? "render" : "deck",
      }),
    };
  }
  if (command === "run-status") {
    if (!input.projectId) throw new Error("projectId is required.");
    const data = await apiJson(runApiPath(input.projectId, input.runId));
    if (input.runId && !data.run) throw new Error(`Project run not found: ${input.runId}`);
    return {
      projectId: input.projectId,
      run: data.run || null,
      activeRun: data.activeRun || null,
      browserUrl: browserUrl(input.projectId, {
        slideIndex: data.run?.targetSlide,
        runId: data.run?.id || input.runId,
      }),
    };
  }
  if (command === "run-wait") {
    if (!input.projectId || !input.runId) throw new Error("projectId and runId are required.");
    const data = await waitForProjectRun(
      input.projectId,
      input.runId,
      Math.max(1, Math.min(300, Number(input.timeoutSeconds) || 120)),
      Math.max(250, Math.min(5000, Number(input.pollIntervalMs) || 750)),
    );
    return {
      projectId: input.projectId,
      run: data.run,
      timedOut: Boolean(data.timedOut),
      browserUrl: browserUrl(input.projectId, {
        slideIndex: data.run?.targetSlide,
        runId: input.runId,
      }),
    };
  }
  if (command === "run-cancel") {
    if (!input.projectId) throw new Error("projectId is required.");
    const data = await apiJson(runApiPath(input.projectId, input.runId), { method: "DELETE" });
    return {
      projectId: input.projectId,
      run: data.run || data.activeRun || null,
      activeRun: data.activeRun || null,
      browserUrl: browserUrl(input.projectId, { runId: data.run?.id || input.runId }),
    };
  }
  if (command === "onboard") {
    if (!input.topic) throw new Error("topic is required.");
    return postJson("/api/onboard", {
      requirement: input.topic,
      scenarioId: input.scenarioId,
      uiLocale: input.uiLocale,
    });
  }
  if (command === "research") {
    if (!input.topic) throw new Error("topic is required.");
    let markdown = "";
    const queries = [];
    await postSse("/api/research", {
      requirement: input.topic,
      rounds: input.rounds ?? 2,
      scenarioId: input.scenarioId,
    }, (event) => {
      if (event.type === "doc") markdown = event.markdown || "";
      if (event.type === "search" && event.query) queries.push(event.query);
    });
    return { topic: input.topic, rounds: input.rounds ?? 2, queries, markdown };
  }
  if (command === "create") {
    if (!input.topic) throw new Error("topic is required.");
    let researchDoc = input.researchDoc;
    if (input.research && !researchDoc?.trim()) {
      await postSse("/api/research", {
        requirement: input.topic,
        rounds: input.rounds ?? 2,
        scenarioId: input.scenarioId,
      }, (event) => {
        if (event.type === "doc") researchDoc = event.markdown;
      });
    }
    let projectId = "";
    let title = "";
    let rendered = 0;
    let errored = 0;
    await postSse("/api/generate", deckConfig(input, researchDoc), (event) => {
      if (event.type === "project") projectId = event.id;
      if (event.type === "outline") title = event.title;
      if (event.type === "page_rendered") rendered += 1;
      if (event.type === "page_error") errored += 1;
    });
    if (!projectId) throw new Error("Generation finished without creating a project.");
    return { projectId, title, rendered, errored, previewUrl: browserUrl(projectId, { checkpoint: "deck" }) };
  }
  if (command === "outline") {
    if (!input.topic) throw new Error("topic is required.");
    let projectId = "";
    let title = "";
    let outline = [];
    let researchDoc = input.researchDoc || "";
    const config = deckConfig(input, researchDoc);
    if (input.research && !researchDoc) config.mode = "research";
    await postSse("/api/outline", config, (event) => {
      if (event.type === "project") projectId = event.id;
      if (event.type === "outline") {
        title = event.title;
        outline = event.outline || [];
      }
      if (event.type === "research" && event.markdown) researchDoc = event.markdown;
    });
    if (!projectId) throw new Error("Outline generation finished without creating a draft.");
    return { projectId, title, outline, researchDoc, previewUrl: browserUrl(projectId, { checkpoint: "outline" }) };
  }
  if (command === "revise-outline") {
    if (!input.projectId) throw new Error("projectId is required.");
    if (!input.instruction && !input.pages?.length) throw new Error("instruction or pages is required.");
    const path = `/api/projects/${encodeURIComponent(input.projectId)}/outline`;
    return input.pages?.length
      ? apiJson(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pages: input.pages }) })
      : postJson(path, { message: input.instruction, designFilePaths: input.designFilePaths || [] });
  }
  if (command === "inspiration") {
    if (!input.topic && !input.outlineTitles?.length) throw new Error("topic or outlineTitles is required.");
    return postJson("/api/inspire", { requirement: input.topic || "", outlineTitles: input.outlineTitles || [] });
  }
  if (command === "render") {
    if (!input.projectId) throw new Error("projectId is required.");
    let rendered = 0;
    let errored = 0;
    await postSse(`/api/projects/${encodeURIComponent(input.projectId)}/render`, {}, (event) => {
      if (event.type === "page_rendered") rendered += 1;
      if (event.type === "page_error") errored += 1;
    });
    return { projectId: input.projectId, rendered, errored, previewUrl: browserUrl(input.projectId, { checkpoint: "render" }) };
  }
  if (command === "list") {
    const data = await apiJson("/api/projects");
    return { projects: (data.projects || []).map((project) => ({ ...project, previewUrl: browserUrl(project.id) })) };
  }
  if (command === "get") {
    if (!input.projectId) throw new Error("projectId is required.");
    const project = await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}`);
    if (!input.includeChat) delete project.chat;
    return { project: { ...project, previewUrl: browserUrl(input.projectId) } };
  }
  if (command === "speaker-notes") {
    if (!input.projectId) throw new Error("projectId is required.");
    const action = input.action || "get";
    const path = `/api/projects/${encodeURIComponent(input.projectId)}/speaker-notes`;
    if (action === "get") {
      const data = await apiJson(`${path}${input.index ? `?index=${input.index}` : ""}`);
      return { ...data, projectId: input.projectId, previewUrl: browserUrl(input.projectId, { slideIndex: input.index, panel: "speaker-notes" }) };
    }
    if (action === "set") {
      if (!(input.index && typeof input.note === "string") && !input.notes?.length) {
        throw new Error("set requires index + note or a notes array.");
      }
      const data = await apiJson(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: input.index, note: input.note, notes: input.notes }),
      });
      return { ...data, projectId: input.projectId, previewUrl: browserUrl(input.projectId, { slideIndex: input.index, panel: "speaker-notes" }) };
    }
    if (action === "generate") {
      const data = await postJson(path, {
        index: input.index,
        overwrite: input.overwrite === true,
        instruction: input.instruction,
      });
      return { ...data, projectId: input.projectId, previewUrl: browserUrl(input.projectId, { slideIndex: input.index, panel: "speaker-notes" }) };
    }
    throw new Error("speaker-notes action must be get, set, or generate.");
  }
  if (command === "templates") {
    const data = await apiJson("/api/templates");
    const query = String(input.query || "").trim().toLowerCase();
    const matches = (item) => !query || [item.name, item.description, item.categoryId, item.group, ...(item.tags || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
    return {
      categories: data.categories,
      templates: (input.categoryId ? data.templates.filter((template) => template.categoryId === input.categoryId) : data.templates).filter(matches),
      communityGroups: data.communityGroups || [],
      communityStyles: (data.communityStyles || [])
        .filter((style) => !input.communityGroup || style.group === input.communityGroup)
        .filter(matches),
      communitySources: data.communitySources || [],
      projectTemplates: data.projectTemplates || [],
    };
  }
  if (command === "project-templates") {
    const action = input.action || "list";
    if (action === "list") {
      const data = await apiJson("/api/templates");
      return { projectTemplates: data.projectTemplates || [] };
    }
    if (action === "save") {
      if (!input.projectId) throw new Error("save requires projectId.");
      const data = await postJson("/api/templates", {
        projectId: input.projectId,
        name: input.name,
        description: input.description,
      });
      return { template: data.template, previewUrl: browserUrl(input.projectId) };
    }
    if (action === "delete") {
      if (!input.templateId) throw new Error("delete requires templateId.");
      await apiJson(`/api/templates/${encodeURIComponent(input.templateId)}`, { method: "DELETE" });
      return { templateId: input.templateId, deleted: true };
    }
    throw new Error("project-templates action must be list, save, or delete.");
  }
  if (command === "scenarios") {
    const data = await apiJson("/api/scenarios");
    const query = String(input.query || "").trim().toLocaleLowerCase();
    const featured = new Set(data.featuredIds || []);
    const scenarios = (data.scenarios || []).filter((scenario) => {
      if (input.group && scenario.group !== input.group) return false;
      if (input.featured === true && !featured.has(scenario.id)) return false;
      if (!query) return true;
      return JSON.stringify(scenario).toLocaleLowerCase().includes(query);
    });
    return {
      groups: data.groups,
      scenarios,
      featuredIds: data.featuredIds,
      browserUrl: browserUrl(undefined, { view: "scenarios", scenarioId: input.scenarioId }),
    };
  }
  if (command === "design-files") {
    if (!input.projectId) throw new Error("projectId is required.");
    const data = await apiJson(projectFileApiPath(input.projectId));
    return {
      projectId: input.projectId,
      files: (data.files || []).map((file) => ({
        ...file,
        downloadUrl: `${BASE}${projectFileApiPath(input.projectId, file.path)}?download=1`,
      })),
      browserUrl: browserUrl(input.projectId, { view: "design-files", filePath: input.filePath }),
    };
  }
  if (command === "read-design-file") {
    if (!input.projectId || !input.filePath) throw new Error("projectId and filePath are required.");
    const listing = await apiJson(projectFileApiPath(input.projectId));
    const file = (listing.files || []).find((item) => item.path === input.filePath);
    if (!file) throw new Error(`Design File not found: ${input.filePath}`);
    const url = browserUrl(input.projectId, { view: "design-files", filePath: input.filePath });
    if (!file.editable) return { projectId: input.projectId, file, content: null, browserUrl: url };
    const response = await apiFetch(projectFileApiPath(input.projectId, input.filePath));
    if (!response.ok) throw new Error((await response.text().catch(() => "")) || `HTTP ${response.status}`);
    return { projectId: input.projectId, file, content: await response.text(), browserUrl: url };
  }
  if (command === "write-design-file") {
    if (!input.projectId || !input.filePath || typeof input.content !== "string") {
      throw new Error("projectId, filePath, and string content are required.");
    }
    await apiJson(projectFileApiPath(input.projectId, input.filePath), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: input.content }),
    });
    return {
      projectId: input.projectId,
      filePath: input.filePath,
      bytes: Buffer.byteLength(input.content),
      browserUrl: browserUrl(input.projectId, { view: "design-files", filePath: input.filePath }),
    };
  }
  if (command === "upload-design-file") {
    if (!input.projectId || !input.filePath) throw new Error("projectId and filePath are required.");
    const { form, absolute } = await fileForm(input.filePath, "files", 20 * 1024 * 1024);
    const response = await apiFetch(projectFileApiPath(input.projectId), { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const uploaded = (data.files || []).find((file) => file.source === "uploaded" && file.name === basename(absolute));
    return {
      projectId: input.projectId,
      file: uploaded || null,
      files: data.files || [],
      sourcePath: absolute,
      browserUrl: browserUrl(input.projectId, { view: "design-files", filePath: uploaded?.path }),
    };
  }
  if (command === "get-brand-system") {
    if (!input.projectId) throw new Error("projectId is required.");
    const data = await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}/design-system`);
    return {
      projectId: input.projectId,
      ...data,
      browserUrl: browserUrl(input.projectId, { view: "brand-system" }),
    };
  }
  if (command === "set-brand-system") {
    if (!input.projectId) throw new Error("projectId is required.");
    if (input.clear !== true && !input.designSystem && !input.template && !input.style && !input.materialIds?.length && input.brandAssetMaterialIds === undefined) {
      throw new Error("Provide designSystem, template, style, materialIds, brandAssetMaterialIds, or clear:true.");
    }
    const versionGroupId = globalThis.crypto.randomUUID();
    const versionPrompt = input.style || input.designSystem?.style?.direction || "Update the brand design system";
    const data = await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}/design-system`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        designSystem: input.designSystem,
        template: input.template,
        style: input.style,
        materialIds: input.materialIds || [],
        brandAssetMaterialIds: input.brandAssetMaterialIds,
        clear: input.clear === true,
        versionPrompt,
        versionGroupId,
      }),
    });
    const changed = [];
    if (input.redraw === true && !input.clear) {
      for (const page of data.project?.pages || []) {
        try {
          const generated = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/regenerate`, {
            index: page.index,
            versionPrompt,
            versionGroupId,
          });
          changed.push(slideSummary(generated.page));
        } catch (error) {
          changed.push({ index: page.index, status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    delete data.project;
    return {
      projectId: input.projectId,
      ...data,
      changed,
      browserUrl: browserUrl(input.projectId, { view: "brand-system" }),
    };
  }
  if (command === "edit") {
    if (!input.projectId || !input.instruction) throw new Error("projectId and instruction are required.");
    const project = await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}`);
    const contextPage = input.slideIndex ? project.pages?.find((page) => page.index === input.slideIndex) : undefined;
    const { plan } = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/chat`, {
      message: input.instruction,
      context: contextPage ? { slideIndex: input.slideIndex, title: contextPage.title } : undefined,
      attachmentIds: input.materialIds || [],
      designFilePaths: input.designFilePaths || [],
    });
    const changed = [];
    const versionGroupId = globalThis.crypto.randomUUID();
    if (plan.action === "add") {
      const afterIndex = Number.isInteger(plan.afterIndex) ? plan.afterIndex : project.pages.length;
      const added = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/slides`, {
        action: "add",
        afterIndex,
        title: plan.title,
        versionPrompt: input.instruction,
        versionGroupId,
      });
      const index = Math.min(Math.max(afterIndex + 1, 1), added.pages.length);
      const generated = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/regenerate`, {
        index,
        instruction: plan.instruction || input.instruction,
        title: plan.title,
        versionPrompt: input.instruction,
        versionGroupId,
      });
      changed.push(slideSummary(generated.page));
    } else if (plan.action === "edit") {
      for (const index of plan.targets || []) {
        const generated = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/regenerate`, {
          index,
          instruction: plan.instruction || input.instruction,
          title: plan.targets?.length === 1 ? plan.title : undefined,
          versionPrompt: input.instruction,
          versionGroupId,
        });
        changed.push(slideSummary(generated.page));
      }
    }
    return { projectId: input.projectId, plan, changed, previewUrl: browserUrl(input.projectId, { slideIndex: changed[0]?.index }) };
  }
  if (command === "restyle") {
    if (!input.projectId) throw new Error("projectId is required.");
    const versionGroupId = globalThis.crypto.randomUUID();
    const versionPrompt = input.style || `Apply template ${input.template || "default"}`;
    const updated = await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template: input.template,
        style: input.style,
        materialIds: input.materialIds || [],
        versionPrompt,
        versionGroupId,
      }),
    });
    const changed = [];
    if (input.redraw !== false) {
      for (const page of updated.pages || []) {
        try {
          const generated = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/regenerate`, {
            index: page.index,
            versionPrompt,
            versionGroupId,
          });
          changed.push(slideSummary(generated.page));
        } catch (error) {
          changed.push({ index: page.index, status: "error", error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return { projectId: input.projectId, template: updated.config?.template, style: updated.config?.style, changed, previewUrl: browserUrl(input.projectId, { slideIndex: changed[0]?.index }) };
  }
  if (command === "slide") {
    if (!input.projectId || !input.action) throw new Error("projectId and action are required.");
    if (!["add", "duplicate", "delete", "move", "transition"].includes(input.action)) throw new Error("Unsupported slide action.");
    const path = `/api/projects/${encodeURIComponent(input.projectId)}/slides`;
    const data = input.action === "delete"
      ? await apiJson(path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: input.index }) })
      : await postJson(path, { action: input.action, index: input.index, toIndex: input.toIndex, afterIndex: input.afterIndex, transition: input.transition });
    const focusIndex = input.action === "move"
      ? input.toIndex
      : input.action === "add"
        ? Math.max(1, (input.afterIndex ?? data.pages?.length ?? 1) + 1)
        : input.index;
    return { projectId: input.projectId, action: input.action, pages: (data.pages || []).map(slideSummary), previewUrl: browserUrl(input.projectId, { slideIndex: focusIndex }) };
  }
  if (command === "regenerate") {
    if (!input.projectId || !input.index) throw new Error("projectId and index are required.");
    const data = await postJson(`/api/projects/${encodeURIComponent(input.projectId)}/regenerate`, { index: input.index, instruction: input.instruction });
    return { projectId: input.projectId, page: slideSummary(data.page), previewUrl: browserUrl(input.projectId, { slideIndex: input.index }) };
  }
  if (command === "upload-material") {
    if (!input.filePath) throw new Error("filePath is required.");
    const { form, absolute } = await fileForm(input.filePath, "file", 20 * 1024 * 1024);
    const response = await apiFetch("/api/materials", { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { material: data, filePath: absolute };
  }
  if (command === "upload-slide") {
    if (!input.projectId || !input.index || !input.imagePath) throw new Error("projectId, index, and imagePath are required.");
    const { form, absolute, bytes } = await fileForm(input.imagePath, "image");
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("upload-slide requires a valid PNG.");
    form.set("image", new Blob([bytes], { type: "image/png" }), basename(absolute));
    if (input.title) form.append("title", input.title);
    const response = await apiFetch(`/api/projects/${encodeURIComponent(input.projectId)}/slides/${input.index}/image`, { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return { projectId: input.projectId, page: slideSummary(data.page), previewUrl: browserUrl(input.projectId, { slideIndex: input.index }) };
  }
  if (command === "mark-edit") {
    if (!input.projectId || !input.index || !input.annotatedImagePath) throw new Error("projectId, index, and annotatedImagePath are required.");
    const { form, absolute, bytes } = await fileForm(input.annotatedImagePath, "image");
    if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("mark-edit requires a valid annotated PNG.");
    form.set("image", new Blob([bytes], { type: "image/png" }), basename(absolute));
    form.append("index", String(input.index));
    const sourceResponse = await apiFetch(`/api/projects/${encodeURIComponent(input.projectId)}/mark/source`, { method: "POST", body: form });
    const source = await sourceResponse.json().catch(() => ({}));
    if (!sourceResponse.ok) throw new Error(source.error || `HTTP ${sourceResponse.status}`);
    const editForm = new FormData();
    editForm.append("index", String(input.index));
    editForm.append("source", source.image);
    editForm.append("note", input.note || "");
    const editResponse = await apiFetch(`/api/projects/${encodeURIComponent(input.projectId)}/mark`, { method: "POST", body: editForm });
    const edited = await editResponse.json().catch(() => ({}));
    if (!editResponse.ok) throw new Error(edited.error || `HTTP ${editResponse.status}`);
    return { projectId: input.projectId, markedSource: source.image, page: slideSummary(edited.page), previewUrl: browserUrl(input.projectId, { slideIndex: input.index }) };
  }
  if (command === "export") {
    if (!input.projectId) throw new Error("projectId is required.");
    await apiJson(`/api/projects/${encodeURIComponent(input.projectId)}`);
    const format = input.format === "pptx" ? "pptx" : "pdf";
    return {
      projectId: input.projectId,
      format,
      downloadUrl: `${BASE}/api/projects/${encodeURIComponent(input.projectId)}/export?format=${format}`,
      browserUrl: browserUrl(input.projectId, { panel: "export" }),
    };
  }
  throw new Error(`Unknown command '${command}'. Run 'help' for the command list.`);
}

const command = process.argv[2] || "help";
try {
  const input = await parseInput(process.argv.slice(3));
  const result = await run(command, input);
  writeJson({ ok: true, command, ...withBrowserHandoff(result) });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeJson({ ok: false, command, error: message });
  process.exitCode = 1;
}

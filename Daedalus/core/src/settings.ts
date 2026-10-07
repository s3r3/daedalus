import { resolve } from "node:path";
import type { EditFormat, ModelTier, PromptFamilySetting } from "./contracts.ts";
import { normalizeModelList, normalizeModelTiers, parseModelStrategy, parseModelTiers, type ModelStrategy } from "./providers/llm/model-pool.ts";
import { parsePromptFamilySetting } from "./agent/prompt-dialects.ts";
import { parseToolProtocol, type ToolProtocol } from "./providers/llm/text-protocol.ts";
import { TOOL_OUTPUT_MAX_CHARS, TOOL_OUTPUT_MAX_LINES, type ToolOutputLimits } from "./agent/tool-output.ts";

export type { ToolProtocol };

export type Settings = {
  llm: { baseUrl: string; apiKey: string; model: string; models: string[]; modelStrategy: ModelStrategy; timeoutMs: number | null; helperModel: string; toolProtocol: ToolProtocol; modelTiers: Record<string, ModelTier>; promptFamily: PromptFamilySetting; editFormat: EditFormat };
  server: { host: string; port: number };
  session: { thinking: boolean };
  /**
   * Tailor suite: harness features that make weaker routed models perform
   * above their weight. Routing/escalation default on (they are no-ops
   * without a tiered multi-model pool); the review gate defaults off.
   */
  tailor: { modelRouting: boolean; qualityEscalation: boolean; reviewGate: boolean; earlyEscalation: boolean };
  /** Run the post-edit syntax/LSP guard on files the agent writes (DAEDALUS_EDIT_GUARD). */
  editGuard: boolean;
  /** Run project hooks from .daedalus/hooks.json around tool calls (DAEDALUS_HOOKS). */
  hooks?: boolean;
  /** Context-window budgeting: token limit estimate + automatic condensing (DAEDALUS_CONTEXT_LIMIT / DAEDALUS_CONDENSE). */
  context: { limitTokens: number; condense: boolean; inputTokenBudget: number };
  /**
   * Hard tool-output caps + spill files: over-cap results enter the model
   * context head+tail with the full text saved under the task store
   * (DAEDALUS_TOOL_OUTPUT_MAX_CHARS / DAEDALUS_TOOL_OUTPUT_MAX_LINES /
   * DAEDALUS_TOOL_SPILL=off disables the spill file; caps still apply).
   */
  toolOutput: ToolOutputLimits;
  /**
   * RTK-style semantic compression of `run_command` output before it
   * enters the model context (agent/output-compression.ts): per-family
   * filters keep failures + the exit signal verbatim and summarize the
   * rest, raw text spilled to the task store. Default on;
   * DAEDALUS_OUTPUT_COMPRESSION=off disables (the hard caps + spill in
   * `toolOutput` still apply either way).
   */
  outputCompression: boolean;
  daedalusHome: string;
};

export type Env = Record<string, string | undefined>;

/**
 * Typed settings loader. Secrets come from environment only and are never logged
 * (PLAN.md §10). Missing values fall back to safe defaults where possible.
 */
export function loadSettings(env: Env = process.env): Settings {
  const port = Number(env.DAEDALUS_PORT ?? "3080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DAEDALUS_PORT: ${String(env.DAEDALUS_PORT)}`);
  }
  const model = env.LLM_MODEL ?? "";
  const models = normalizeModelList(env.LLM_MODELS ?? model);
  return {
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "https://llm.ayid.cc.cd/v1",
      apiKey: env.LLM_API_KEY ?? "",
      model,
      models,
      modelStrategy: parseModelStrategy(env.LLM_MODEL_STRATEGY),
      timeoutMs: positiveInt(env.LLM_TIMEOUT_MS),
      helperModel: (env.DAEDALUS_HELPER_MODEL ?? "").trim(),
      toolProtocol: parseToolProtocol(env.LLM_TOOL_PROTOCOL),
      modelTiers: parseModelTiers(env.LLM_MODEL_TIERS),
      promptFamily: parsePromptFamilySetting(env.LLM_PROMPT_FAMILY),
      editFormat: parseEditFormat(env.LLM_EDIT_FORMAT),
    },
    tailor: {
      modelRouting: parseBoolean(env.DAEDALUS_MODEL_ROUTING, true, "DAEDALUS_MODEL_ROUTING"),
      qualityEscalation: parseBoolean(env.DAEDALUS_QUALITY_ESCALATION, true, "DAEDALUS_QUALITY_ESCALATION"),
      reviewGate: parseBoolean(env.DAEDALUS_REVIEW_GATE, false, "DAEDALUS_REVIEW_GATE"),
      earlyEscalation: parseBoolean(env.DAEDALUS_TAILOR_EARLY_ESCALATION, true, "DAEDALUS_TAILOR_EARLY_ESCALATION"),
    },
    server: {
      host: env.DAEDALUS_HOST ?? "127.0.0.1",
      port,
    },
    session: {
      thinking: parseBoolean(env.DAEDALUS_THINKING, true, "DAEDALUS_THINKING"),
    },
    editGuard: parseBoolean(env.DAEDALUS_EDIT_GUARD, true, "DAEDALUS_EDIT_GUARD"),
    hooks: parseBoolean(env.DAEDALUS_HOOKS, true, "DAEDALUS_HOOKS"),
    context: {
      limitTokens: positiveTokenLimit(env.DAEDALUS_CONTEXT_LIMIT),
      condense: parseBoolean(env.DAEDALUS_CONDENSE, true, "DAEDALUS_CONDENSE"),
      inputTokenBudget: positiveIntOrDefault(env.DAEDALUS_INPUT_TOKEN_BUDGET, 100_000, "DAEDALUS_INPUT_TOKEN_BUDGET"),
    },
    toolOutput: {
      maxChars: positiveIntOrDefault(env.DAEDALUS_TOOL_OUTPUT_MAX_CHARS, TOOL_OUTPUT_MAX_CHARS, "DAEDALUS_TOOL_OUTPUT_MAX_CHARS"),
      maxLines: positiveIntOrDefault(env.DAEDALUS_TOOL_OUTPUT_MAX_LINES, TOOL_OUTPUT_MAX_LINES, "DAEDALUS_TOOL_OUTPUT_MAX_LINES"),
      spill: parseBoolean(env.DAEDALUS_TOOL_SPILL, true, "DAEDALUS_TOOL_SPILL"),
    },
    outputCompression: parseBoolean(env.DAEDALUS_OUTPUT_COMPRESSION, true, "DAEDALUS_OUTPUT_COMPRESSION"),
    daedalusHome: env.DAEDALUS_HOME ?? ".daedalus",
  };
}

/**
 * Resolve the local Daedalus home used for tasks, provider settings, and the
 * daemon state. An explicit absolute DAEDALUS_HOME always wins. A relative
 * home (including the default `.daedalus`) is anchored to the selected
 * workspace so `daedalus run --cwd X`, `daedalus chat --cwd X`, and the Web
 * gateway/server started for X read and write the same on-disk store instead
 * of whichever process working directory happened to launch them.
 */
export function resolveDaedalusHome(home: string, workspaceRoot?: string): string {
  if (!workspaceRoot) return resolve(home);
  return resolve(workspaceRoot, home);
}

/** `LLM_EDIT_FORMAT`: `native` (default) or `search_replace`; anything else fails fast. */
export function parseEditFormat(value: string | undefined, source = "LLM_EDIT_FORMAT"): EditFormat {
  if (value === undefined || value.trim() === "") return "native";
  const normalized = value.trim().toLowerCase();
  if (normalized === "native" || normalized === "search_replace") return normalized;
  throw new Error(`Invalid ${source}: ${value} (expected native or search_replace)`);
}

/** Lenient variant for stored provider configs: garbage means "unset". */
export function normalizeEditFormat(value: unknown): EditFormat | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === "native" || normalized === "search_replace" ? normalized : undefined;
}

export { normalizeModelTiers };

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: ${value} (expected on/off, true/false, yes/no, or 1/0)`);
}

/** `null` means "unset" — the provider then applies its own default timeout. */
function positiveInt(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid LLM_TIMEOUT_MS: ${value} (expected a positive integer number of milliseconds)`);
  }
  return parsed;
}

/** Context-window token budget for the meter/condense features; defaults to 128k. */
function positiveTokenLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 128_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid DAEDALUS_CONTEXT_LIMIT: ${value} (expected a positive integer number of tokens)`);
  }
  return parsed;
}

/** Positive-integer setting with a default; invalid values fail fast like the other numeric settings. */
function positiveIntOrDefault(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value} (expected a positive integer)`);
  }
  return parsed;
}

/** Redacted view of settings safe to log or expose over the API. */
export function redactSettings(settings: Settings): Record<string, unknown> {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? "«redacted»" : "",
    },
  };
}

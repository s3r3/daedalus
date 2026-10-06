import { AGENT_MODES, type AgentMode, type ToolModePolicy } from '../contracts.ts';
import type { ModelToolSchema } from '../tools/registry.ts';

export const AGENT_MODE_ORDER: AgentMode[] = [...AGENT_MODES];

const READ_TOOLS = new Set(['read_file', 'list_dir', 'grep', 'glob', 'git_diff', 'git_status', 'read_skill', 'lsp_diagnostics']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'edit_search_replace', 'create_dir']);
const EXECUTING_TOOLS = new Set(['run_command']);

export type ToolVisibility = 'read' | 'mutating' | 'executing' | 'none';

export function classifyToolName(name: string): ToolVisibility {
  if (READ_TOOLS.has(name)) return 'read';
  if (MUTATING_TOOLS.has(name)) return 'mutating';
  if (EXECUTING_TOOLS.has(name)) return 'executing';
  // MCP-bridged tools (`mcp__<server>__<tool>`) may change external state, so
  // they follow the mutating approval path like write tools do.
  if (name.startsWith('mcp__')) return 'mutating';
  return 'none';
}

export function nextAgentMode(current: AgentMode): AgentMode {
  const index = AGENT_MODE_ORDER.indexOf(current);
  return AGENT_MODE_ORDER[(index + 1 + AGENT_MODE_ORDER.length) % AGENT_MODE_ORDER.length] as AgentMode;
}

export function cycleAgentMode(current: AgentMode): AgentMode {
  return nextAgentMode(current);
}

export function isReadOnlyMode(mode: AgentMode): boolean {
  return mode === 'ask' || mode === 'plan';
}

export function isToolVisible(mode: AgentMode, toolName: string): boolean {
  const kind = classifyToolName(toolName);
  if (kind === 'none') return false;
  if (isReadOnlyMode(mode)) return kind === 'read';
  return true;
}

export function toolModePolicy(mode: AgentMode, toolName: string, autoApprove = false): ToolModePolicy {
  const visible = isToolVisible(mode, toolName);
  if (!visible) return { visible: false, approval: 'deny' };
  const kind = classifyToolName(toolName);
  if (kind === 'read') return { visible: true, approval: 'auto' };
  if (mode === 'manual') return { visible: true, approval: 'ask' };
  // Auto (and an Orchestrator parent acting directly): reads and file edits
  // proceed without asking; only process execution is gated, by the
  // session's auto-approve toggle (Cline keeps mode and auto-approve as two
  // orthogonal switches; Claude Code's acceptEdits draws the same line).
  if (kind === 'mutating') return { visible: true, approval: 'auto' };
  if (autoApprove) return { visible: true, approval: 'auto' };
  return { visible: true, approval: 'ask' };
}

/**
 * The mode × capability matrix, as data (OpenCode-style: modes are configs
 * over one permission engine, not prompt labels). `mutating` covers file
 * writes/edits and MCP tools; `executing` is `run_command`. Reads are free
 * in every mode — prompting on reads only trains blind approval.
 */
export const MODE_PERMISSION_MATRIX: Record<AgentMode, { read: 'allow'; mutating: 'allow' | 'ask' | 'deny'; executing: 'allow' | 'ask' | 'deny'; summary: string }> = {
  ask: { read: 'allow', mutating: 'deny', executing: 'deny', summary: 'read-only answers; no edits, no commands' },
  manual: { read: 'allow', mutating: 'ask', executing: 'ask', summary: 'every edit and command needs approval' },
  auto: { read: 'allow', mutating: 'allow', executing: 'ask', summary: 'edits run freely; commands need approval unless auto-approve is on' },
  plan: { read: 'allow', mutating: 'deny', executing: 'deny', summary: 'read-only exploration ending in a written plan' },
  orchestrator: { read: 'allow', mutating: 'allow', executing: 'ask', summary: 'decomposes into child tasks; own commands follow the auto-approve toggle' },
};

/**
 * Strictness order for orchestrator inheritance (higher = stricter). A
 * child task's effective mode is the stricter of what it asked for and the
 * ceiling its parent runs under: children may tighten, never loosen.
 */
const MODE_STRICTNESS: Record<AgentMode, number> = { orchestrator: 0, auto: 1, manual: 2, plan: 3, ask: 3 };

export function restrictMode(parentCeiling: AgentMode, requested: AgentMode): AgentMode {
  return MODE_STRICTNESS[requested] >= MODE_STRICTNESS[parentCeiling] ? requested : parentCeiling;
}

/** The behavioural contract each mode states to the model, verbatim in the prompt. */
export function modePromptContract(mode: AgentMode): string {
  switch (mode) {
    case 'ask':
      return 'Current mode: Ask (read-only). Answer the user\'s question directly from the workspace with read tools. You cannot create, edit, delete, or run anything, and no plan or task machinery applies. If the user asks for a change, briefly explain what would be done and tell them to switch to Manual or Auto mode (Shift+Tab) to have it made.';
    case 'plan':
      return 'Current mode: Plan (read-only). Explore the workspace with read tools only — edits and commands are denied by the harness. Your deliverable is the plan itself: finish with a numbered plan in your final reply where every step names the concrete file(s) it touches, followed by risks/unknowns and how completion will be verified. Do not start implementing.';
    case 'manual':
      return 'Current mode: Manual. Reads are free, but every file change and every command pauses for the user\'s approval first. Propose one concrete action at a time and let the approval flow gate it; a declined action comes back with the user\'s instructions — follow them instead of retrying the same action.';
    case 'auto':
      return 'Current mode: Auto. Reads and file edits proceed directly; commands run without asking only while auto-approve is on, otherwise each command pauses for approval. Work the plan to completion and let validation prove the result.';
    case 'orchestrator':
      return 'Current mode: Orchestrator. Your work is decomposed into child tasks that run under policies no looser than yours. Coordinate: keep each child\'s goal self-contained, respect the budgets, and treat a child\'s budget exhaustion as a partial result to report, not a success.';
    default:
      return `Current mode: ${mode}.`;
  }
}

/** Why a tool call was refused by the mode gate, phrased for the model. */
export function modeDenialMessage(mode: AgentMode, toolName: string): string {
  if (mode === 'ask') {
    return `tool ${toolName} is not available in ask mode (read-only). Answer the question with what you can read; if the user wants this change made, explain it and ask them to switch to Manual or Auto mode (Shift+Tab) — do not keep trying mutating tools.`;
  }
  if (mode === 'plan') {
    return `tool ${toolName} is not available in plan mode (read-only). Keep exploring with read tools and put this action into the plan as a step naming the file it touches.`;
  }
  return `tool ${toolName} is not available in ${mode} mode`;
}

export type ModeChange = { from: AgentMode; to: AgentMode; turnBoundary: true; replanRequired: boolean };

export class ModeController {
  #mode: AgentMode;
  #autoApprove: boolean;

  constructor(initial: AgentMode = 'auto', autoApprove = false) {
    this.#mode = AGENT_MODES.includes(initial) ? initial : 'auto';
    this.#autoApprove = autoApprove;
  }

  get mode(): AgentMode {
    return this.#mode;
  }

  get autoApprove(): boolean {
    return this.#autoApprove;
  }

  setAutoApprove(value: boolean): void {
    this.#autoApprove = value;
  }

  cycle(): ModeChange {
    return this.set(nextAgentMode(this.#mode));
  }

  describeChange(from: AgentMode, to: AgentMode): ModeChange {
    const normalizedFrom = AGENT_MODES.includes(from) ? from : 'auto';
    const normalizedTo = AGENT_MODES.includes(to) ? to : 'auto';
    return {
      from: normalizedFrom,
      to: normalizedTo,
      turnBoundary: true,
      replanRequired: normalizedFrom === 'orchestrator' || normalizedTo === 'orchestrator',
    };
  }

  set(next: AgentMode): ModeChange {
    const change = this.describeChange(this.#mode, next);
    this.#mode = change.to;
    return change;
  }

  canUseTool(toolName: string): boolean {
    return isToolVisible(this.#mode, toolName);
  }

  approvalFor(toolName: string): ToolModePolicy {
    return toolModePolicy(this.#mode, toolName, this.#autoApprove);
  }

  visibleTools<T extends { name?: string; function?: { name?: string } }>(tools: T[]): T[] {
    return tools.filter((tool) => {
      const name = 'function' in tool && tool.function ? tool.function.name : tool.name;
      return typeof name === 'string' && this.canUseTool(name);
    });
  }

  filterSchemas(tools: ModelToolSchema[] | undefined): ModelToolSchema[] | undefined {
    if (!tools) return undefined;
    return this.visibleTools(tools);
  }
}

export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  ask: 'Read-only question answering about the workspace',
  manual: 'Step-by-step actions with approval for every mutation',
  auto: 'Autonomous plan-act-validate loop',
  plan: 'Read-only exploration and plan drafting',
  orchestrator: 'Coordinator that decomposes work into child tasks',
};

export function modeIntent(mode: AgentMode): string {
  return MODE_DESCRIPTIONS[mode];
}

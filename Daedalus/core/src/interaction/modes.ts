import { AGENT_MODES, type AgentMode, type ToolModePolicy } from '../contracts.ts';
import type { ModelToolSchema } from '../tools/registry.ts';
import { ASK_USER_TOOL_NAME } from './questions.ts';
import { SPAWN_SUBAGENT_TOOL_NAME } from './subagents.ts';

/**
 * Modes the user can pick (composer select, Shift+Tab cycle, CLI --mode).
 * `orchestrator` is deliberately absent: delegation is the model-invoked
 * `spawn_subagent` tool now, not a mode. Legacy persisted values naming
 * `orchestrator` still parse (see normalizeAgentMode) and run as Auto.
 */
export const AGENT_MODE_ORDER: AgentMode[] = ['ask', 'manual', 'auto', 'plan'];

/**
 * Normalize any recorded/requested mode value. The retired `orchestrator`
 * maps to Auto (with spawn_subagent available) so legacy tasks and
 * settings load and run instead of failing; unknown values fall back to
 * Auto as before.
 */
export function normalizeAgentMode(value: unknown): AgentMode {
  if (value === 'orchestrator') return 'auto';
  return AGENT_MODES.includes(value as AgentMode) ? (value as AgentMode) : 'auto';
}

const READ_TOOLS = new Set(['read_file', 'list_dir', 'grep', 'glob', 'git_diff', 'git_status', 'read_skill', 'lsp_diagnostics', 'fetch_url', 'web_search', 'view_image', 'search_images', 'command_status']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'edit_search_replace', 'create_dir', 'download_file']);
const EXECUTING_TOOLS = new Set(['run_command', 'command_kill']);

/**
 * The Plan mode carve-out: plan documents are the ONE sanctioned write in
 * plan mode, scoped to `.daedalus/plans/**` in the workspace. Only the file
 * tools participate — MCP bridges and the shell stay fully denied, and any
 * path outside the plans folder is denied like any other mutation.
 */
export const PLAN_DOCUMENTS_ROOT = '.daedalus/plans';
const PLAN_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'edit_search_replace', 'create_dir']);

/**
 * Is this workspace-relative path a plan document the Plan mode may write?
 * Only relative paths qualify (absolute paths fail closed), `.` segments
 * are normalized away, and any `..` segment disqualifies the path.
 */
export function isPlanDocumentPath(rawPath: unknown): rawPath is string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return false;
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) return false;
  const clean = segments.join('/');
  return clean === PLAN_DOCUMENTS_ROOT || clean.startsWith(`${PLAN_DOCUMENTS_ROOT}/`);
}

export type ToolVisibility = 'read' | 'mutating' | 'executing' | 'none';

export function classifyToolName(name: string): ToolVisibility {
  // Asking the user a question changes nothing in the workspace, so the
  // question tool belongs to the read class for policy purposes; its
  // visibility rule (everywhere but Ask mode) lives in isToolVisible.
  if (name === ASK_USER_TOOL_NAME) return 'read';
  // Delegating to a subagent changes the workspace through the child, so
  // spawn_subagent takes the mutating class: visible in Auto/Manual, one
  // approval per delegation in Manual, invisible (and denied) in Ask/Plan.
  if (name === SPAWN_SUBAGENT_TOOL_NAME) return 'mutating';
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
  // The question tool is offered wherever the agent might need a human
  // decision mid-run. Ask mode is the exception: it answers directly.
  if (toolName === ASK_USER_TOOL_NAME) return mode !== 'ask';
  const kind = classifyToolName(toolName);
  if (kind === 'none') return false;
  // Plan mode sees the plan-write tools so the carve-out is callable; the
  // call-aware gate (toolCallPolicy) still denies every path outside
  // .daedalus/plans/**. Commands stay invisible — there is no carve-out
  // for the shell.
  if (mode === 'plan') return kind === 'read' || PLAN_WRITE_TOOLS.has(toolName);
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
 * Call-aware policy: `toolModePolicy` plus the Plan mode path check. In
 * plan mode the plan-write tools are visible so the model can produce its
 * deliverable, but the approval outcome is decided per call: paths under
 * `.daedalus/plans/**` run freely, every other mutating path is denied.
 * `targetPath` is the call's workspace-relative `path` argument, when any.
 */
export function toolCallPolicy(mode: AgentMode, toolName: string, targetPath?: string, autoApprove = false): ToolModePolicy {
  if (mode === 'plan' && PLAN_WRITE_TOOLS.has(toolName)) {
    return isPlanDocumentPath(targetPath)
      ? { visible: true, approval: 'auto' }
      : { visible: true, approval: 'deny' };
  }
  return toolModePolicy(mode, toolName, autoApprove);
}

/** True when the mode gate refuses this exact call (the loop's hard denial). */
export function isToolCallDenied(mode: AgentMode, toolName: string, targetPath?: string, autoApprove = false): boolean {
  return toolCallPolicy(mode, toolName, targetPath, autoApprove).approval === 'deny';
}

/**
 * The mode × capability matrix, as data (OpenCode-style: modes are configs
 * over one permission engine, not prompt labels). `mutating` covers file
 * writes/edits and MCP tools; `executing` is `run_command` (foreground or
 * background — the start is approved once, at dispatch) plus
 * `command_kill` on the task's own background jobs; `command_status` is a
 * read. Reads are free in every mode — prompting on reads only trains
 * blind approval.
 */
export const MODE_PERMISSION_MATRIX: Record<AgentMode, { read: 'allow'; mutating: 'allow' | 'ask' | 'deny'; executing: 'allow' | 'ask' | 'deny'; summary: string }> = {
  ask: { read: 'allow', mutating: 'deny', executing: 'deny', summary: 'read-only answers; no edits, no commands' },
  manual: { read: 'allow', mutating: 'ask', executing: 'ask', summary: 'every edit and command needs approval' },
  auto: { read: 'allow', mutating: 'allow', executing: 'ask', summary: 'edits run freely; commands need approval unless auto-approve is on' },
  plan: { read: 'allow', mutating: 'deny', executing: 'deny', summary: 'read-only exploration; the only sanctioned write is the plan itself under .daedalus/plans/**' },
  orchestrator: { read: 'allow', mutating: 'allow', executing: 'ask', summary: 'retired mode; runs as Auto (delegation via the spawn_subagent tool)' },
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

/**
 * The plan document skeletons Plan mode writes into
 * `.daedalus/plans/<slug>/`: plan.md is the approval summary (the
 * document the user approves; execution keys off it), and PRD.md,
 * architecture.md, design.md, tasks.md are its companions — what &
 * why, how (technically), how it looks, and the execution contract.
 * They are part of the prompt contract (the model fills them in), not
 * runtime generators — prompt-driven on purpose.
 */
export const PLAN_DOCUMENT_TEMPLATE = [
  '# <Title>',
  '',
  '## Goal',
  '<What is being built and why, in one short paragraph.>',
  '',
  '## Scope / Non-goals',
  '- In scope: <what this plan covers>',
  '- Non-goals: <what is deliberately left out>',
  '',
  '## Decisions',
  '- <question asked> → <the answer the user gave> (an "(assumed)" suffix marks a choice you made when a question went unanswered)',
  '',
  '## Steps',
  '1. <step> (files: <concrete paths this step creates or changes>)',
  '',
  '## Acceptance criteria',
  '- <observable condition that proves the work is done>',
].join('\n');

/** PRD.md: the WHAT & WHY of a product-shaped plan (Kiro requirements shape, BMAD PRD slot). */
export const PRD_DOCUMENT_TEMPLATE = [
  '# PRD: <Title>',
  '',
  '## Goal',
  '<What is being built and why, in one short paragraph.>',
  '',
  '## Users & roles',
  '- <role: who they are and what they do with this>',
  '',
  '## Features',
  '- F1: <feature>',
  '  - WHEN <event/condition> THE SYSTEM SHALL <observable behavior>',
  '',
  '## Scope / Non-goals',
  '- In scope: <what v1 covers>',
  '- Non-goals: <what is deliberately left out>',
  '',
  '## Core entities',
  '- <Entity>: <key fields>',
  '',
  '## Constraints & assumptions',
  '- <chosen stack, storage, hard limits; "(assumed)" marks choices made when a question went unanswered>',
  '',
  '## Decisions',
  '- <question asked> → <the answer the user gave> (an "(assumed)" suffix marks a choice you made when a question went unanswered)',
].join('\n');

/** architecture.md: the HOW — stack, modules, data, and the target file list execution anchors to. */
export const ARCHITECTURE_DOCUMENT_TEMPLATE = [
  '# Architecture: <Title>',
  '',
  '## Stack',
  '- <framework/language/styling, one line each with the reason>',
  '',
  '## Components / modules',
  '- <page or module>: <responsibility>',
  '',
  '## Data model',
  '- <Entity> (<fields>) — <relations>',
  '',
  '## Storage & state',
  '<localStorage / static data / API / database — the decision from the interview, stated explicitly>',
  '',
  '## Routes / pages',
  '- <route>: <what renders there>',
  '',
  '## Target files',
  '- <folder or file execution must create, relative to the target directory>',
].join('\n');

/** design.md: how it looks and feels — screens, layout, visual style, states. */
export const DESIGN_DOCUMENT_TEMPLATE = [
  '# Design: <Title>',
  '',
  '## Screens',
  '- <screen>: <layout, main components, data shown>',
  '',
  '## Visual style',
  '- Palette: <colors>',
  '- Typography: <fonts/scale>',
  '- Density: <compact / comfortable>',
  '',
  '## Interactions & states',
  '- <empty/loading/error states and key interactions>',
  '',
  '## Responsive notes',
  '- <how screens adapt to small widths>',
].join('\n');

/** tasks.md: the execution contract — one checkbox unit per concrete deliverable. */
export const TASKS_DOCUMENT_TEMPLATE = [
  '# Tasks: <Title>',
  '',
  '- [ ] <one logical unit: one route, one screen, one entity> (files: <target paths>; verifies: <observable check>; PRD: F<n>)',
  '- [ ] Run the project validation and confirm every check passes',
].join('\n');

/** The behavioural contract each mode states to the model, verbatim in the prompt. */
export function modePromptContract(mode: AgentMode): string {
  switch (mode) {
    case 'ask':
      return 'Current mode: Ask (read-only). Answer the user\'s question directly from the workspace with read tools. You cannot create, edit, delete, or run anything, and no plan or task machinery applies. If the user asks for a change, briefly explain what would be done and tell them to switch to Manual or Auto mode (Shift+Tab) to have it made.';
    case 'plan':
      return [
        'Current mode: Plan (read-only apart from the plan itself). Your deliverable is a plan the user can approve and hand to Auto or Orchestrator for execution. Work in this order:',
        '1. Explore the workspace with read tools first, so your questions and plan are grounded in what is actually there. Edits and commands are denied by the harness, and every path outside .daedalus/plans/ stays read-only.',
        `2. Interview before you write anything: when a requirement is genuinely ambiguous, ask the user with the ${ASK_USER_TOOL_NAME} tool instead of guessing — at most 4 questions, 2-4 concrete options each, and cover the spec slots an implementer cannot invent: the main entities, where data is stored, who uses it (roles, and whether login exists), and the look/scope (style, pages). Never ask what the workspace already tells you.`,
        '3. Write the finished plan as a DOCUMENT SET in .daedalus/plans/<task-slug>/, where <task-slug> is a short kebab-case name from the goal (the one write plan mode allows; create the folder with create_dir), generated from the goal and the interview answers:',
        '   - PRD.md — what & why: users/roles, features with WHEN … THE SYSTEM SHALL acceptance lines, scope/non-goals, core entities, decisions.',
        '   - architecture.md — how, technically: stack, components, data model, the storage decision, routes, and the concrete target files execution will create.',
        '   - design.md — how it looks: screens, layout, visual style, interaction/empty/loading states.',
        '   - plan.md — the approval summary the user approves (template below); record every question you asked and its answer under Decisions, marking "(assumed)" for choices you made when a question went unanswered.',
        '   - tasks.md — the execution contract: one checkbox per concrete unit (a route, a screen, an entity), each naming its target files, its verification, and the PRD feature it serves. Execution runs against tasks.md — granularity "one route/screen", never "the whole app".',
        '   The plan file follows this template exactly:',
        PLAN_DOCUMENT_TEMPLATE,
        'Finish with a brief reply that names the plan folder and restates the numbered plan; every step names the concrete file(s) it touches, and the reply ends with risks/unknowns and how completion will be verified. Do not start implementing — execution begins only when the user approves the plan.',
      ].join('\n');
    case 'manual':
      return 'Current mode: Manual. Reads are free, but every file change and every command pauses for the user\'s approval first. Propose one concrete action at a time and let the approval flow gate it; a declined action comes back with the user\'s instructions — follow them instead of retrying the same action. When the goal is ambiguous, ask with ask_user (2-4 options) before proposing actions.';
    case 'auto':
      return 'Current mode: Auto. Reads/edits proceed directly; commands run freely with auto-approve on, otherwise they pause for approval. Work the plan to completion; validation proves the result. Ask with ask_user when ambiguous; delegate hard/parallel subtasks via spawn_subagent.';
    case 'orchestrator':
      // Retired mode, kept for legacy task records: it runs exactly as
      // Auto, with delegation available through the spawn_subagent tool.
      return modePromptContract('auto');
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
    return `tool ${toolName} is not available in plan mode outside the plan documents. Keep exploring with read tools; the only sanctioned write in plan mode is your plan document set under .daedalus/plans/<task-slug>/ (PRD.md, architecture.md, design.md, plan.md, tasks.md), and every other action belongs in the plan as a step naming the file it touches.`;
  }
  return `tool ${toolName} is not available in ${mode} mode`;
}

export type ModeChange = { from: AgentMode; to: AgentMode; turnBoundary: true; replanRequired: boolean };

export class ModeController {
  #mode: AgentMode;
  #autoApprove: boolean;

  constructor(initial: AgentMode = 'auto', autoApprove = false) {
    this.#mode = normalizeAgentMode(initial);
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
    const normalizedFrom = normalizeAgentMode(from);
    const normalizedTo = normalizeAgentMode(to);
    return {
      from: normalizedFrom,
      to: normalizedTo,
      turnBoundary: true,
      // The old Orchestrator boundary (the only re-planning switch) is
      // retired with the mode; mode changes never re-plan now.
      replanRequired: false,
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

  /** Call-aware variant of approvalFor: the Plan carve-out decides per path. */
  approvalForCall(toolName: string, targetPath?: string): ToolModePolicy {
    return toolCallPolicy(this.#mode, toolName, targetPath, this.#autoApprove);
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
  orchestrator: 'Retired: runs as Auto (spawn_subagent delegation)',
};

export function modeIntent(mode: AgentMode): string {
  return MODE_DESCRIPTIONS[mode];
}

import { AGENT_MODES, type AgentMode, type ToolModePolicy } from '../contracts.ts';
import type { ModelToolSchema } from '../tools/registry.ts';

export const AGENT_MODE_ORDER: AgentMode[] = [...AGENT_MODES];

const READ_TOOLS = new Set(['read_file', 'list_dir', 'grep', 'glob', 'git_diff', 'git_status', 'read_skill', 'lsp_diagnostics']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'create_dir']);
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
  if (autoApprove) return { visible: true, approval: 'auto' };
  return { visible: true, approval: 'ask' };
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

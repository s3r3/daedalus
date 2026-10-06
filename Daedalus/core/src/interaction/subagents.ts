import type { ChildTask } from '../contracts.ts';
import type { ToolDefinition, ToolExecutionContext } from '../tools/registry.ts';

/**
 * Model-invoked subagents (Claude Code's Agent-tool shape, replacing the
 * retired Orchestrator mode): delegation is a TOOL the agent calls when
 * work is hard, parallelizable, or long — never a mode the user picks and
 * never automatic fan-out. One call = one child task with a fresh context,
 * its own slice of the parent's iteration pool, and exactly one distilled
 * result back. Foreground calls block until the child finishes; background
 * calls return immediately and the child's distilled result is delivered
 * into a later parent turn as a `[background subagent finished]` notice.
 * Children can never spawn further subagents (depth 1 hard stop), enforced
 * by construction: child runs never get this tool.
 */
export const SPAWN_SUBAGENT_TOOL_NAME = 'spawn_subagent';

/** What the model supplies for one delegation. */
export type SpawnSubagentInput = {
  /** Short label for the delegation (shown in the Child Tasks panel). */
  description: string;
  /** Full, self-contained brief: the child sees nothing of this conversation. */
  goal: string;
  /** Run without blocking; the result arrives as a later notice. Default false. */
  background?: boolean;
};

/** How one spawn resolved, as decided by the runtime's spawner. */
export type SpawnDispatch =
  | { kind: 'completed'; child: ChildTask }
  | { kind: 'background'; child: ChildTask }
  | { kind: 'error'; output: string };

export type SpawnSubagentToolDeps = {
  /**
   * Run (or launch) one child task. `signal` is the harness abort signal
   * for this tool call; the spawner cancels the child when it fires.
   */
  spawn: (input: SpawnSubagentInput, signal?: AbortSignal) => Promise<SpawnDispatch>;
};

const TOOL_DESCRIPTION = [
  'Delegate one self-contained subtask to a subagent with a fresh context, and get back one short distilled result (what it did, which files it changed) — never its raw work.',
  'Delegate when work is hard enough to deserve its own focus, when several independent investigations can run at once, or when a long chore should proceed in the background. Do NOT delegate work you can do in a few tool calls yourself, and do not delegate tightly sequential steps that all depend on each other.',
  'The subagent cannot see this conversation: put everything it needs (goal, relevant paths, constraints, done criteria) into `goal`, and give it a short `description` label.',
  'Emit several spawn_subagent calls in one block to run subagents in parallel (at most 3 at a time); parallel subagents must NOT edit the same files. With background: true the call returns immediately and the result arrives later as a "[background subagent finished]" notice — keep doing other work meanwhile.',
  'Subagents cannot delegate further; a background result is also recorded on the task report if the task ends first.',
].join(' ');

/**
 * The `spawn_subagent` tool: one instance per top-level run, closing over
 * the runtime's spawner (budget pool, child execution, notice queue). Mode
 * gating lives in the mode policy (mutating class: visible in Auto/Manual,
 * approval-gated in Manual, invisible in Ask/Plan); child runs are built
 * without this tool at all, so nesting cannot happen.
 */
export function createSpawnSubagentTool(deps: SpawnSubagentToolDeps): ToolDefinition {
  return {
    name: SPAWN_SUBAGENT_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    mutating: true,
    // A subagent may legitimately work for minutes; the harness timeout
    // only aborts the tool's signal (which cancels the child), never the
    // run itself. Same pattern as ask_user's question budget.
    timeoutMs: 30 * 60_000,
    inputSchema: {
      type: 'object',
      required: ['description', 'goal'],
      properties: {
        description: { type: 'string', description: 'Short label for this subagent (3-8 words), shown in the Child Tasks panel.' },
        goal: { type: 'string', description: 'The complete, self-contained brief for the subagent: goal, relevant file paths, constraints, and what done looks like.' },
        background: { type: 'boolean', description: 'Run in the background and report back in a later turn instead of blocking. Default false.' },
      },
      additionalProperties: false,
    },
    async execute(args, context: ToolExecutionContext) {
      const a = (args ?? {}) as { description?: unknown; goal?: unknown; background?: unknown };
      const description = typeof a.description === 'string' ? a.description.trim() : '';
      const goal = typeof a.goal === 'string' ? a.goal.trim() : '';
      if (!description || !goal) {
        return {
          call_id: '',
          status: 'error',
          output: 'spawn_subagent needs a non-empty "description" (short label) and "goal" (the complete brief the subagent works from)',
          truncated: false,
          meta: { tool: SPAWN_SUBAGENT_TOOL_NAME, mutating: true },
        };
      }
      const dispatch = await deps.spawn({ description, goal, ...(a.background === true ? { background: true } : {}) }, context.signal);
      if (dispatch.kind === 'error') {
        return { call_id: '', status: 'error', output: dispatch.output, truncated: false, meta: { tool: SPAWN_SUBAGENT_TOOL_NAME, mutating: true, reason: 'spawn_failed' } };
      }
      const child = dispatch.child;
      if (dispatch.kind === 'background') {
        return {
          call_id: '',
          status: 'ok',
          output: `subagent "${description}" (child task ${child.id}) is running in the background. Keep working on other things — do not wait idle. When it finishes, its distilled result arrives as a "[background subagent finished]" notice; it also appears in the Child Tasks panel and on the final report.`,
          truncated: false,
          meta: { tool: SPAWN_SUBAGENT_TOOL_NAME, mutating: true, child_task_id: child.id, background: true, status: child.status },
        };
      }
      return {
        call_id: '',
        status: 'ok',
        output: `subagent "${description}" (child task ${child.id}) finished with status ${child.status}:\n${child.result_summary ?? child.status}`,
        truncated: false,
        meta: { tool: SPAWN_SUBAGENT_TOOL_NAME, mutating: true, child_task_id: child.id, background: false, status: child.status },
      };
    },
  };
}

/** The system-style notice a finished background subagent leaves for the parent's next turn. */
export function backgroundFinishedNotice(child: ChildTask): string {
  const label = child.label ?? 'subagent';
  return `[background subagent finished] "${label}" (child task ${child.id}) status: ${child.status}\n${child.result_summary ?? child.status}`;
}

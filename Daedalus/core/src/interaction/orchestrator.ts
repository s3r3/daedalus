import { randomUUID } from 'node:crypto';
import type { ChildTask, ChildTaskBudget, Event, TaskSpec } from '../contracts.ts';
import type { EventBus } from '../events.ts';
import { emitEvent } from '../events.ts';
import type { TaskStore } from '../persistence.ts';
import { createPlan } from '../agent/planner.ts';

export type ChildTaskInput = {
  goal: string;
  mode?: ChildTask['mode'];
  budget?: ChildTaskBudget;
  /** File-defined subagent (.daedalus/agents/<name>.md) that runs this child, if any. */
  agent?: string;
  /** Run this child in an isolated git worktree instead of the shared workspace. */
  isolation?: 'worktree';
};

export type ChildTaskExecution = {
  status: ChildTask['status'];
  summary?: string;
  diff?: string;
  iterations?: number;
  errors?: number;
};

export type ChildTaskExecutor = (child: ChildTask) => Promise<ChildTaskExecution>;

export type OrchestratorResult = {
  parent_task_id: string;
  children: ChildTask[];
  status: 'done' | 'failed' | 'cancelled';
  summary: string;
  diff: string;
  no_progress: boolean;
  budget_exceeded: boolean;
};

export function childTaskFromInput(parentTaskId: string, input: ChildTaskInput): ChildTask {
  return {
    id: randomUUID(),
    parent_task_id: parentTaskId,
    goal: input.goal,
    mode: input.mode,
    status: 'pending',
    budget: input.budget,
    created_at: new Date().toISOString(),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
  };
}

/**
 * Deterministic decomposition used when the caller does not provide an
 * explicit child list: one child per done-criterion, otherwise one child per
 * planner step. The child's goal always carries the parent goal so a child run
 * cannot lose the overall intent.
 */
export async function decomposeTask(spec: TaskSpec): Promise<ChildTask[]> {
  if (spec.done_criteria.length > 1) {
    return spec.done_criteria.map((criterion) => childTaskFromInput(spec.id, {
      goal: `${spec.goal}\nChild task: satisfy this done criterion: ${criterion}`,
      mode: 'auto',
    }));
  }
  const plan = await createPlan(spec);
  return plan.steps.map((step) => childTaskFromInput(spec.id, {
    goal: `${spec.goal}\nChild task: ${step.intent}`,
    mode: 'auto',
  }));
}

export class OrchestratorRunner {
  readonly #bus?: EventBus;
  readonly #store?: TaskStore;
  readonly #executeChild: ChildTaskExecutor;
  readonly #totalBudget?: ChildTaskBudget;

  constructor(options: { bus?: EventBus; store?: TaskStore; executeChild: ChildTaskExecutor; totalBudget?: ChildTaskBudget }) {
    this.#bus = options.bus;
    this.#store = options.store;
    this.#executeChild = options.executeChild;
    this.#totalBudget = options.totalBudget;
  }

  async run(parentTaskId: string, inputs: ChildTaskInput[]): Promise<OrchestratorResult> {
    const children = inputs.map((input) => childTaskFromInput(parentTaskId, input));
    const diffs: string[] = [];
    const summaries: string[] = [];
    let previousFingerprint: string | undefined;
    let noProgress = false;
    let budgetExceeded = false;
    let totalIterations = 0;
    let totalErrors = 0;

    for (const child of children) {
      if (noProgress) {
        child.status = 'cancelled';
        child.result_summary = 'cancelled after no-progress stop';
        continue;
      }
      if (budgetExceeded || this.#budgetExhausted(totalIterations, totalErrors)) {
        budgetExceeded = true;
        child.status = 'cancelled';
        child.result_summary = 'cancelled after total budget exceeded';
        continue;
      }
      child.status = 'running';
      this.#emit(parentTaskId, 'CHILD_TASK_STARTED', { child: { ...child } });
      try {
        const execution = await this.#executeChild({ ...child });
        child.status = execution.status;
        child.result_summary = execution.summary;
        totalIterations += execution.iterations ?? 1;
        totalErrors += execution.errors ?? (execution.status === 'failed' ? 1 : 0);
        if (this.#budgetExceeded(totalIterations, totalErrors)) budgetExceeded = true;
        if (execution.diff) diffs.push(execution.diff);
        if (execution.summary) summaries.push(`${child.goal}: ${execution.summary}`);
        const fingerprint = `${child.goal}:${execution.status}:${execution.summary ?? ''}:${execution.diff ?? ''}`;
        if (previousFingerprint !== undefined && fingerprint === previousFingerprint) noProgress = true;
        previousFingerprint = fingerprint;
      } catch (error) {
        child.status = 'failed';
        child.result_summary = String(error);
        totalIterations += 1;
        totalErrors += 1;
        if (this.#budgetExceeded(totalIterations, totalErrors)) budgetExceeded = true;
        summaries.push(`${child.goal}: ${child.result_summary}`);
      }
      this.#emit(parentTaskId, 'CHILD_TASK_FINISHED', { child: { ...child } });
    }

    const failed = children.some((child) => child.status === 'failed');
    const cancelled = children.some((child) => child.status === 'cancelled');
    const status: OrchestratorResult['status'] = failed || noProgress || budgetExceeded ? 'failed' : cancelled ? 'cancelled' : 'done';
    return {
      parent_task_id: parentTaskId,
      children,
      status,
      summary: summaries.join('\n'),
      diff: diffs.join(''),
      no_progress: noProgress,
      budget_exceeded: budgetExceeded,
    };
  }

  #budgetExceeded(totalIterations: number, totalErrors: number): boolean {
    if (!this.#totalBudget) return false;
    return totalIterations > this.#totalBudget.max_iterations || totalErrors > this.#totalBudget.max_errors;
  }

  #budgetExhausted(totalIterations: number, totalErrors: number): boolean {
    if (!this.#totalBudget) return false;
    return totalIterations >= this.#totalBudget.max_iterations || totalErrors >= this.#totalBudget.max_errors;
  }

  #emit(taskId: string, type: Event['type'], payload: unknown): void {
    if (!this.#bus && !this.#store) return;
    if (this.#bus) {
      emitEvent({ bus: this.#bus, store: this.#store }, taskId, undefined, type, payload);
      return;
    }
    const store = this.#store!;
    store.append(taskId, {
      seq: store.replay(taskId).length + 1,
      task_id: taskId,
      type,
      payload,
      ts: new Date().toISOString(),
    });
  }
}

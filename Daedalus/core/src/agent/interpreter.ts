import { randomUUID } from 'node:crypto';
import type { TaskSpec } from '../contracts.ts';

/**
 * Task Interpreter: natural language -> structured TaskSpec.
 * Extracted done-criteria become lines like "done: <text>"; remaining prose stays in goal.
 */
export async function interpretTask(input: string, options: Partial<Omit<TaskSpec, 'goal'>> = {}): Promise<TaskSpec> {
  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const doneCriteria = [...(options.done_criteria ?? [])];
  const constraints = [...(options.constraints ?? [])];
  const goalLines: string[] = [];
  for (const line of lines) {
    const done = /^done\s*:\s*(.+)$/i.exec(line);
    if (done?.[1]) { doneCriteria.push(done[1].trim()); continue; }
    const constraint = /^(?:constraint|must)\s*:\s*(.+)$/i.exec(line);
    if (constraint?.[1]) { constraints.push(constraint[1].trim()); continue; }
    goalLines.push(line);
  }
  const goal = goalLines.join('\n') || input.trim();
  return {
    id: options.id ?? randomUUID(),
    goal,
    repo_path: options.repo_path ?? process.cwd(),
    constraints,
    done_criteria: doneCriteria,
    created_at: options.created_at ?? new Date().toISOString(),
    mode: options.mode,
    parent_task_id: options.parent_task_id,
    plan_task_id: options.plan_task_id,
    attachments: options.attachments,
    provider_id: options.provider_id,
    model: options.model,
    models: options.models,
    model_strategy: options.model_strategy,
    thinking: options.thinking,
    title: options.title,
    rules_files: options.rules_files,
    agent: options.agent,
  };
}
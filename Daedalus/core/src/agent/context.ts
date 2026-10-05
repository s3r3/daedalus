import type { Message, ToolDefinition } from '../providers/llm/types.ts';
import type { TaskState } from '../contracts.ts';
import { buildPrompt, estimateTokens, systemMessage, userMessage } from '../providers/index.ts';
import type { ContextManager, Observation } from './types.ts';

/**
 * Context Manager: ordered prompt sections (role, task, plan, constraints),
 * token budgeting, and observation truncation (PLAN.md §3.1).
 */
export class DefaultContextManager implements ContextManager {
  readonly #budget: number;

  constructor(budget = 16_000) {
    this.#budget = budget;
  }

  async buildMessages(state: TaskState, observations: Observation[], tools?: ToolDefinition[]): Promise<Message[]> {
    const template = {
      version: '1.0.0',
      sections: [
        { id: 'role', content: 'You are Daedalus, an autonomous coding agent operating on a local repository.' },
        { id: 'task', content: state.goal },
        { id: 'repo', content: `Repository: ${state.repo_path}` },
        { id: 'plan', content: state.steps.map((s) => `- [${s.status}] ${s.intent}`).join('\n') || '(no plan yet)' },
        { id: 'constraints', content: state.constraints.join('\n') || '(none)' },
        {
          id: 'protocol',
          content:
            'Respond with a tool call to act, or reply starting with "done: <summary>" when every plan step is satisfied, "replan: <reason>" to amend the plan, or "stop: <reason>" to abort.',
        },
      ],
    };
    const messages: Message[] = [systemMessage(buildPrompt(template)), userMessage(state.last_observation ?? state.goal)];
    for (const observation of observations) {
      if (observation.kind === 'tool_result') {
        messages.push({ role: 'tool', content: truncate(observation.result.output, 4_000), tool_call_id: observation.result.call_id });
      } else if (observation.kind === 'assistant') {
        messages.push(observation.message);
      }
    }
    if (tools?.length) {
      messages.push(userMessage(`Available tools: ${tools.map((t) => t.function.name).join(', ')}`));
    }
    return this.compact(messages, this.#budget);
  }

  async compact(messages: Message[], budget: number): Promise<Message[]> {
    const system = messages[0];
    const rest = messages.slice(1);
    const result: Message[] = [];
    let used = system ? this.estimate([system]) : 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      const message = rest[i]!;
      const cost = this.estimate([message]);
      if (used + cost > budget) continue;
      used += cost;
      result.unshift(message);
    }
    return system ? [system, ...result] : result;
  }

  estimate(messages: Message[]): number {
    let total = 0;
    for (const message of messages) {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      total += estimateTokens(text);
      if (message.tool_calls?.length) total += estimateTokens(JSON.stringify(message.tool_calls));
    }
    return total;
  }
}

/** Truncate large observations with explicit metadata (ACI principle, PLAN.md §2.4). */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const kept = text.slice(0, limit);
  return `${kept}\n…[truncated ${text.length - limit} chars of ${text.length}]`;
}
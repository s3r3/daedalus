import { describe, expect, test } from 'vitest';
import { classifyResearchIntent, generateResearchPlan } from './plan.ts';
import type { LLMProvider, Message } from '../providers/llm/types.ts';

/** Fake provider scripted by system-prompt marker (pola analysis-plan.test.ts). */
function scriptedProvider(responses: Record<string, string>): LLMProvider {
  return {
    name: 'fake',
    async chat(messages: Message[]) {
      const system = String(messages[0]?.content ?? '');
      const key = Object.keys(responses).find((k) => system.includes(k)) ?? '';
      return { message: { role: 'assistant', content: responses[key] ?? '{}' } };
    },
  } as unknown as LLMProvider;
}

describe('classifyResearchIntent', () => {
  test('call 1: routing intent + bahasa', async () => {
    const provider = scriptedProvider({
      'triage a research question': JSON.stringify({ complexity: 'moderate', language: 'id', needsScholarly: true }),
    });
    const intent = await classifyResearchIntent(provider, 'Bandingkan arsitektur agent framework');
    expect(intent).toEqual({ complexity: 'moderate', language: 'id', needsScholarly: true });
  });

  test('menolak intent tak valid lalu retry', async () => {
    let calls = 0;
    const provider = {
      name: 'fake',
      async chat() {
        calls += 1;
        return {
          message: {
            role: 'assistant',
            content: calls === 1 ? '{"complexity": "gigantic"}' : '{"complexity": "simple", "language": "en", "needsScholarly": false}',
          },
        };
      },
    } as unknown as LLMProvider;
    const intent = await classifyResearchIntent(provider, 'What is X?');
    expect(intent.complexity).toBe('simple');
    expect(calls).toBe(2);
  });
});

describe('generateResearchPlan', () => {
  test('call 2: spec plan tervalidasi, tanpa fakta', async () => {
    const provider = scriptedProvider({
      'planner of an agentic deep-research engine': JSON.stringify({
        question: 'Bandingkan framework X dan Y untuk skripsi',
        language: 'id',
        subQuestions: [
          { id: 'sq1', text: 'Apa arsitektur framework X?', rationale: 'dasar perbandingan' },
          { id: 'sq2', text: 'Apa arsitektur framework Y?', rationale: 'dasar perbandingan' },
        ],
        sourceStrategy: 'dokumentasi resmi + paper',
        budget: { maxQueries: 6, maxSources: 20 },
      }),
    });
    const plan = await generateResearchPlan(provider, 'Bandingkan X dan Y', {
      complexity: 'moderate', language: 'id', needsScholarly: false,
    });
    expect(plan.subQuestions).toHaveLength(2);
    expect(plan.budget.maxQueries).toBe(6);
    expect(plan.question).toContain('Bandingkan');
  });
});

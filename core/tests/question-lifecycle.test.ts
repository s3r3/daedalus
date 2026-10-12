/**
 * Question lifecycle at task end (live bug, 2026-10-07): a loop-breaker
 * question card stayed rendered after the task had already failed with
 * input_token_budget, and pressing it produced a bare
 * `question_not_pending`. The card must close the moment its wait
 * resolves (QUESTION_ANSWERED for every outcome), a question left
 * pending when its task ends settles as cancelled, and no task may end
 * while one of its questions is still answerable.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TaskRunner,
  TaskStore,
  type ChatResponse,
  type Event,
  type LLMProvider,
  type UserQuestionInfo,
} from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Reply = { content?: string; toolCalls?: Array<{ id: string; name: string; args: unknown }>; usage?: ChatResponse['usage'] };

/** Sequence-scripted provider (mirrors read-loop-stalls.test.ts). */
function scriptedProvider(replies: Reply[]): LLMProvider {
  let index = 0;
  return {
    name: 'fake',
    async chat(): Promise<ChatResponse> {
      const reply = replies[index] ?? { content: 'done: script exhausted' };
      index += 1;
      if (reply.toolCalls?.length) {
        return {
          message: {
            role: 'assistant',
            content: reply.content ?? '',
            tool_calls: reply.toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args) } })),
          },
          finish_reason: 'tool_calls',
          ...(reply.usage ? { usage: reply.usage } : {}),
        };
      }
      return { message: { role: 'assistant', content: reply.content ?? 'done: finished' }, finish_reason: 'stop', ...(reply.usage ? { usage: reply.usage } : {}) };
    },
    async *stream() {
      yield { type: 'delta', content: 'done' };
    },
  };
}

async function until(check: () => boolean, tries = 400): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

const usage = (promptTokens: number) => ({ prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens });

describe('loop-pause question answered over a blown budget', () => {
  test('Continue ends the task partial with input_token_budget; the card closes and nothing stays pending', async () => {
    const home = temp('daedalus-q-life-home-');
    const ws = temp('daedalus-q-life-ws-');
    // Fat page body: the budget meters the harness's LOCAL context
    // estimate (auto-speed fix — billed prompt_tokens no longer counts),
    // so the crossing is driven by context growth: each real read adds
    // ~1k estimated tokens to the history, and cumulative local spend by
    // the 5th reply lands above the budget while the first four stay
    // under it, exactly where this ordering test needs the crossing.
    writeFileSync(join(ws, 'page.txt'), `${'page body '.repeat(430)}\n`);
    const replies: Reply[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: 'page.txt' } }], usage: usage(10) })),
      { toolCalls: [{ id: 'c4', name: 'read_file', args: { path: 'page.txt' } }], usage: usage(500) },
      { content: 'done: never reached' },
    ];
    const store = new TaskStore(home);
    const runner = new TaskRunner({ workspaceRoot: ws, store, provider: scriptedProvider(replies), approvalPolicy: 'auto', inputTokenBudget: 15_500, maxIterations: 20 });

    let finished = false;
    const runPromise = runner
      .run({ goal: 'read the file and report', taskId: 'lp-budget', cwd: ws })
      .then((result) => { finished = true; return result; });

    // The card is up and the budget is already blown — but the task must
    // still be waiting on the user, not failed behind the card.
    expect(await until(() => runner.questions.pending('lp-budget').length > 0)).toBe(true);
    const question = runner.questions.pending('lp-budget')[0]?.info;
    expect(question?.id.startsWith('loop-pause-')).toBe(true);
    expect(finished).toBe(false);

    expect(runner.questions.answer(question!.id, 'Continue a different way')).toBe(true);
    const result = await runPromise;

    expect(result.state.status).toBe('failed');
    expect(result.state.last_error).toBe('input_token_budget');
    expect(result.report.outcome).toBe('partial');
    expect(result.report.evidence.join('\n')).toContain('input token budget');

    // The card closed: the broker holds nothing for this task, a second
    // answer goes nowhere, and the log carries the closing event BEFORE
    // the task's completion — so the Web clears the card.
    expect(runner.questions.pending()).toEqual([]);
    expect(runner.questions.answer(question!.id, 'Stop the task')).toBe(false);
    const events = store.replay('lp-budget');
    const answeredAt = events.findIndex(
      (event: Event) => event.type === 'QUESTION_ANSWERED' && (event.payload as { question_id?: string }).question_id === question!.id,
    );
    const completedAt = events.findIndex((event: Event) => event.type === 'TASK_COMPLETED');
    expect(answeredAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(answeredAt);
    const answeredPayload = events[answeredAt]?.payload as { outcome?: string; answer?: string };
    expect(answeredPayload.outcome).toBe('answered');
    expect(answeredPayload.answer).toBe('Continue a different way');
  });
});

describe('task end settles pending questions', () => {
  test('a question left pending when its task ends settles cancelled; other tasks stay answerable', async () => {
    const home = temp('daedalus-q-end-home-');
    const ws = temp('daedalus-q-end-ws-');
    const store = new TaskStore(home);
    const runner = new TaskRunner({
      workspaceRoot: ws,
      store,
      provider: scriptedProvider([
        { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'note.txt', content: 'hi\n' } }] },
        { content: 'done: note written' },
      ]),
      approvalPolicy: 'auto',
      questionGate: false,
      validator: {
        async validate() {
          return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
        },
      },
    });
    const createdAt = new Date().toISOString();
    const orphanInfo: UserQuestionInfo = {
      id: 'orphan-q',
      taskId: 'qt-1',
      question: 'Pick one?',
      options: [{ label: 'A' }, { label: 'B' }],
      allowFreeText: true,
      createdAt,
    };
    const otherInfo: UserQuestionInfo = { ...orphanInfo, id: 'other-q', taskId: 'qt-2' };
    const orphan = runner.questions.ask(orphanInfo);
    const other = runner.questions.ask(otherInfo);

    const result = await runner.run({ goal: 'write a note file\ndone: note.txt written', taskId: 'qt-1', cwd: ws });
    expect(result.state.status).toBe('done');

    // The finished task's pending question settled as cancelled and is
    // no longer answerable; an unrelated task's question is untouched.
    expect(runner.questions.pending('qt-1')).toEqual([]);
    await expect(orphan).resolves.toEqual({ outcome: 'cancelled' });
    expect(runner.questions.answer('orphan-q', 'A')).toBe(false);
    expect(runner.questions.answer('other-q', 'A')).toBe(true);
    await expect(other).resolves.toEqual({ outcome: 'answered', answer: 'A' });
  });

  test('stopping a task with an ask_user question open settles it cancelled and closes the card', async () => {
    const home = temp('daedalus-q-stop-home-');
    const ws = temp('daedalus-q-stop-ws-');
    const store = new TaskStore(home);
    const provider = scriptedProvider([
      { toolCalls: [{ id: 'a1', name: 'ask_user', args: { question: 'Which theme?', options: [{ label: 'Light' }, { label: 'Dark' }] } }] },
      { content: 'done: after answer' },
    ]);
    const runner = new TaskRunner({ workspaceRoot: ws, store, provider, approvalPolicy: 'auto' });

    const runPromise = runner.run({ goal: 'build the page', taskId: 'ask-1', cwd: ws });
    expect(await until(() => store.replay('ask-1').some((event) => event.type === 'QUESTION_REQUESTED'))).toBe(true);
    const requested = store.replay('ask-1').find((event) => event.type === 'QUESTION_REQUESTED');
    const questionId = (requested?.payload as { question?: UserQuestionInfo }).question?.id;
    expect(questionId).toBeDefined();

    runner.cancel('ask-1');
    const result = await runPromise;
    expect(result.state.status).toBe('failed');
    expect(result.state.last_error).toBe('aborted');

    const events = store.replay('ask-1');
    const answered = events.find(
      (event) => event.type === 'QUESTION_ANSWERED' && (event.payload as { question_id?: string }).question_id === questionId,
    );
    expect(answered).toBeDefined();
    expect((answered?.payload as { outcome?: string }).outcome).toBe('cancelled');
    expect(runner.questions.pending()).toEqual([]);
    expect(runner.questions.answer(questionId!, 'Light')).toBe(false);
  });
});

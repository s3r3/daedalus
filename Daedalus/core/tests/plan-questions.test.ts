import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  QuestionBroker,
  TaskRunner,
  TaskStore,
  isPlanDocumentPath,
  isToolCallDenied,
  isToolVisible,
  toolCallPolicy,
  type Event,
  type LLMProvider,
  type Message,
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

type ScriptStep = { tool: string; args: unknown } | { text: string };

function scriptedProvider(script: ScriptStep[], captured?: Message[][]): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat(messages) {
      captured?.push(messages);
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: work complete' } };
      if ('text' in step) return { message: { role: 'assistant', content: step.text } };
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call-${index}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
        },
      };
    },
    async *stream() {
      yield { type: 'delta', content: '' };
    },
  };
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

function questionInfo(overrides: Partial<UserQuestionInfo> = {}): UserQuestionInfo {
  return {
    id: `question-${Math.random().toString(36).slice(2, 9)}`,
    taskId: 'task-1',
    question: 'Website ini mau dipakai untuk apa?',
    options: [{ label: 'Website e-commerce' }, { label: 'Website e-learning' }],
    allowFreeText: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('plan document path carve-out', () => {
  test('only .daedalus/plans paths qualify, and traversal fails closed', () => {
    expect(isPlanDocumentPath('.daedalus/plans')).toBe(true);
    expect(isPlanDocumentPath('.daedalus/plans/website-sekolah/plan.md')).toBe(true);
    expect(isPlanDocumentPath('./.daedalus/plans/x/PRD.md')).toBe(true);
    expect(isPlanDocumentPath('.daedalus/plansx/plan.md')).toBe(false);
    expect(isPlanDocumentPath('.daedalus/tasks/t1/plan.md')).toBe(false);
    expect(isPlanDocumentPath('src/index.ts')).toBe(false);
    expect(isPlanDocumentPath('.daedalus/plans/../evil.md')).toBe(false);
    expect(isPlanDocumentPath('/abs/.daedalus/plans/x/plan.md')).toBe(false);
    expect(isPlanDocumentPath('')).toBe(false);
    expect(isPlanDocumentPath(undefined)).toBe(false);
    expect(isPlanDocumentPath(42)).toBe(false);
  });

  test('the call-aware policy allows plan documents and denies everything else in plan mode', () => {
    expect(toolCallPolicy('plan', 'write_file', '.daedalus/plans/a/plan.md')).toEqual({ visible: true, approval: 'auto' });
    expect(toolCallPolicy('plan', 'create_dir', '.daedalus/plans/a')).toEqual({ visible: true, approval: 'auto' });
    expect(toolCallPolicy('plan', 'write_file', 'src/evil.ts')).toEqual({ visible: true, approval: 'deny' });
    expect(toolCallPolicy('plan', 'run_command', undefined)).toEqual({ visible: false, approval: 'deny' });
    expect(toolCallPolicy('plan', 'mcp__demo__write', '.daedalus/plans/a/plan.md')).toEqual({ visible: false, approval: 'deny' });
    expect(isToolCallDenied('plan', 'edit_file', 'README.md')).toBe(true);
    expect(isToolCallDenied('plan', 'edit_file', '.daedalus/plans/a/plan.md')).toBe(false);
  });

  test('ask_user is offered everywhere but Ask mode, and never approval-gated', () => {
    expect(isToolVisible('plan', 'ask_user')).toBe(true);
    expect(isToolVisible('manual', 'ask_user')).toBe(true);
    expect(isToolVisible('auto', 'ask_user')).toBe(true);
    expect(isToolVisible('orchestrator', 'ask_user')).toBe(true);
    expect(isToolVisible('ask', 'ask_user')).toBe(false);
    expect(isToolCallDenied('plan', 'ask_user')).toBe(false);
    expect(isToolCallDenied('ask', 'ask_user')).toBe(true);
  });
});

describe('QuestionBroker', () => {
  test('an answer resolves the wait verbatim with outcome answered', async () => {
    const broker = new QuestionBroker();
    const info = questionInfo();
    const pending = broker.ask(info);
    expect(broker.hasPending(info.id)).toBe(true);
    expect(broker.answer(info.id, 'Website e-learning')).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: 'answered', answer: 'Website e-learning' });
    expect(broker.hasPending(info.id)).toBe(false);
  });

  test('answering an unknown or settled question returns false', async () => {
    const broker = new QuestionBroker({ timeoutMs: 20 });
    expect(broker.answer('nope', 'x')).toBe(false);
    const info = questionInfo();
    const pending = broker.ask(info);
    await expect(pending).resolves.toEqual({ outcome: 'timeout' });
    expect(broker.answer(info.id, 'too late')).toBe(false);
  });

  test('cancellation settles pending questions as cancelled, including children', async () => {
    const broker = new QuestionBroker();
    const own = questionInfo();
    const child = questionInfo({ taskId: 'child-1', parentTaskId: 'task-1' });
    const other = questionInfo({ taskId: 'task-2' });
    const ownResult = broker.ask(own);
    const childResult = broker.ask(child);
    const otherResult = broker.ask(other);
    expect(broker.cancelTasks(['task-1'])).toBe(2);
    await expect(ownResult).resolves.toEqual({ outcome: 'cancelled' });
    await expect(childResult).resolves.toEqual({ outcome: 'cancelled' });
    expect(broker.answer(other.id, 'still open')).toBe(true);
    await expect(otherResult).resolves.toEqual({ outcome: 'answered', answer: 'still open' });
  });
});

describe('interactive plan mode through the runner', () => {
  const planContent = [
    '# Website Sekolah',
    '',
    '## Goal',
    'Buat website e-learning dengan database terintegrasi.',
    '',
    '## Scope / Non-goals',
    '- In scope: katalog kelas',
    '- Non-goals: pembayaran',
    '',
    '## Decisions',
    '- Website ini mau dipakai untuk apa? → Website e-learning',
    '',
    '## Steps',
    '1. Buat halaman katalog (files: src/katalog.html)',
    '',
    '## Acceptance criteria',
    '- Halaman katalog tampil dari database',
    '',
  ].join('\n');

  test('the agent asks, the user picks an option, and the plan lands as files with a Decisions section', async () => {
    const root = temp('daedalus-ask-flow-ws-');
    const home = temp('daedalus-ask-flow-home-');
    const captured: Message[][] = [];
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider(
        [
          {
            tool: 'ask_user',
            args: {
              question: 'Website ini mau dipakai untuk apa?',
              options: [
                { label: 'Website e-commerce', description: 'Jualan online' },
                { label: 'Website pendidikan' },
                { label: 'Website e-learning', description: 'Kelas online' },
              ],
            },
          },
          { tool: 'create_dir', args: { path: '.daedalus/plans/website-sekolah' } },
          { tool: 'write_file', args: { path: '.daedalus/plans/website-sekolah/plan.md', content: planContent } },
          { tool: 'write_file', args: { path: '.daedalus/plans/website-sekolah/PRD.md', content: '# PRD\n\n## Decisions\n- Website ini mau dipakai untuk apa? → Website e-learning\n' } },
          { text: 'done: plan written to .daedalus/plans/website-sekolah/plan.md' },
        ],
        captured,
      ),
      validator: passingValidator,
      maxIterations: 8,
    });
    let asked: UserQuestionInfo | undefined;
    const result = await runner.run({
      goal: 'Buat website dengan database terintegrasi\ndone: plan folder created\ndone: plan.md written\ndone: PRD.md written',
      mode: 'plan',
      onEvent: (event) => {
        if (event.type !== 'QUESTION_REQUESTED') return;
        asked = (event.payload as { question?: UserQuestionInfo }).question;
        if (asked) setTimeout(() => runner.questions.answer(asked!.id, 'Website e-learning'), 5);
      },
    });

    expect(result.state.status).toBe('done');
    expect(asked?.mode).toBe('plan');
    expect(asked?.options.map((option) => option.label)).toEqual(['Website e-commerce', 'Website pendidikan', 'Website e-learning']);
    // The answer came back to the model naming the chosen option.
    const afterAnswer = JSON.stringify(captured[1] ?? []);
    expect(afterAnswer).toContain('choosing option 3 of 3');
    expect(afterAnswer).toContain('Website e-learning');
    // The plan is a real file with the Decisions the Q&A produced.
    const written = readFileSync(join(root, '.daedalus/plans/website-sekolah/plan.md'), 'utf8');
    expect(written).toContain('## Decisions');
    expect(written).toContain('Website e-learning');
    // Events: the Q&A is on the log, and the closing PLAN_CREATED names the documents.
    const answered = result.events.find((event) => event.type === 'QUESTION_ANSWERED');
    expect((answered?.payload as { answer?: string; outcome?: string }).answer).toBe('Website e-learning');
    expect((answered?.payload as { option_index?: number }).option_index).toBe(2);
    const closing = [...result.events].reverse().find((event) => event.type === 'PLAN_CREATED');
    expect((closing?.payload as { mode?: string }).mode).toBe('plan');
    expect((closing?.payload as { documents?: string[] }).documents).toEqual([
      '.daedalus/plans/website-sekolah/plan.md',
      '.daedalus/plans/website-sekolah/PRD.md',
    ]);
  });

  test('a free-text answer reaches the model verbatim', async () => {
    const root = temp('daedalus-ask-free-ws-');
    const home = temp('daedalus-ask-free-home-');
    const captured: Message[][] = [];
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider(
        [
          { tool: 'ask_user', args: { question: 'Temanya apa?', options: [{ label: 'Terang' }, { label: 'Gelap' }] } },
          { tool: 'write_file', args: { path: '.daedalus/plans/tema/plan.md', content: '# Tema\n\n## Decisions\n- Temanya apa? → nuansa senja seperti kopi\n' } },
          { text: 'done: noted' },
        ],
        captured,
      ),
      validator: passingValidator,
      maxIterations: 6,
    });
    const result = await runner.run({
      goal: 'Rencanakan tema situs\ndone: plan file written',
      mode: 'plan',
      onEvent: (event) => {
        if (event.type !== 'QUESTION_REQUESTED') return;
        const info = (event.payload as { question?: UserQuestionInfo }).question;
        if (info) setTimeout(() => runner.questions.answer(info.id, 'nuansa senja seperti kopi'), 5);
      },
    });
    expect(result.state.status).toBe('done');
    const afterAnswer = JSON.stringify(captured[1] ?? []);
    expect(afterAnswer).toContain('with their own text');
    expect(afterAnswer).toContain('nuansa senja seperti kopi');
  });

  test('an unanswered question times out into proceed-with-assumptions, never a failure', async () => {
    const root = temp('daedalus-ask-timeout-ws-');
    const home = temp('daedalus-ask-timeout-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'ask_user', args: { question: 'Stack-nya apa?', options: [{ label: 'Statis' }, { label: 'Dinamis' }] } },
        { tool: 'write_file', args: { path: '.daedalus/plans/situs/plan.md', content: '# Situs\n\n## Decisions\n- Stack-nya apa? → Statis (assumed)\n' } },
        { text: 'done: planned with a stated assumption' },
      ]),
      validator: passingValidator,
      questionTimeoutMs: 30,
      maxIterations: 6,
    });
    const result = await runner.run({ goal: 'Rencanakan situs\ndone: planned', mode: 'plan' });
    expect(result.state.status).toBe('done');
    const finished = result.events.find(
      (event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'ask_user',
    );
    const toolResult = (finished?.payload as { result?: { status: string; output: string } }).result;
    expect(toolResult?.status).toBe('ok');
    expect(toolResult?.output).toContain('No answer arrived');
    expect(toolResult?.output).toContain('assumption');
    const answered = result.events.find((event) => event.type === 'QUESTION_ANSWERED');
    expect((answered?.payload as { timed_out?: boolean }).timed_out).toBe(true);
    expect(existsSync(join(root, '.daedalus/plans/situs/plan.md'))).toBe(true);
  });

  test('plan mode allows plan documents but denies other writes and commands', async () => {
    const root = temp('daedalus-plan-gate-ws-');
    const home = temp('daedalus-plan-gate-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: '.daedalus/plans/demo' } },
        { tool: 'write_file', args: { path: '.daedalus/plans/demo/plan.md', content: '# Demo\n' } },
        { tool: 'write_file', args: { path: 'src/evil.ts', content: 'no' } },
        { tool: 'run_command', args: { command: 'echo', args: ['hi'] } },
        { tool: 'edit_file', args: { path: '.daedalus/plans/demo/plan.md', old_string: '# Demo', new_string: '# Demo v2' } },
        { text: 'done: plan drafted' },
      ]),
      validator: passingValidator,
      maxIterations: 8,
    });
    const result = await runner.run({ goal: 'Draft the plan\ndone: plan folder created\ndone: plan file written\ndone: plan refined', mode: 'plan' });
    expect(result.state.status).toBe('done');
    expect(readFileSync(join(root, '.daedalus/plans/demo/plan.md'), 'utf8')).toBe('# Demo v2\n');
    expect(existsSync(join(root, 'src/evil.ts'))).toBe(false);
    const finished = result.events.filter((event) => event.type === 'TOOL_CALL_FINISHED');
    const byTool = (tool: string): Array<{ status: string; output: string }> =>
      finished
        .filter((event) => (event.payload as { call?: { tool?: string } }).call?.tool === tool)
        .map((event) => (event.payload as { result: { status: string; output: string } }).result);
    expect(byTool('write_file').map((r) => r.status)).toEqual(['ok', 'denied']);
    expect(byTool('run_command')[0]?.status).toBe('denied');
    expect(byTool('run_command')[0]?.output).toContain('plan mode');
    expect(byTool('edit_file')[0]?.status).toBe('ok');
  });

  test('ask mode refuses the question tool', async () => {
    const root = temp('daedalus-ask-mode-ws-');
    const home = temp('daedalus-ask-mode-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'ask_user', args: { question: 'Yang mana?', options: [{ label: 'A' }, { label: 'B' }] } },
        { text: 'done: answered directly' },
      ]),
      validator: passingValidator,
      maxIterations: 4,
    });
    const result = await runner.run({ goal: 'Jelaskan folder ini\ndone: answered directly', mode: 'ask' });
    const finished = result.events.find(
      (event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'ask_user',
    );
    const toolResult = (finished?.payload as { result?: { status: string; output: string } }).result;
    expect(toolResult?.status).toBe('denied');
    expect(toolResult?.output).toContain('ask mode');
    expect(result.events.some((event) => event.type === 'QUESTION_REQUESTED')).toBe(false);
  });

  test('a cancelled task settles its pending question instead of hanging', async () => {
    const root = temp('daedalus-ask-cancel-ws-');
    const home = temp('daedalus-ask-cancel-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'ask_user', args: { question: 'Lanjut?', options: [{ label: 'Ya' }, { label: 'Tidak' }] } },
        { text: 'done: unreachable' },
      ]),
      validator: passingValidator,
      maxIterations: 4,
    });
    const run = runner.run({
      goal: 'Rencanakan sesuatu\ndone: never',
      mode: 'plan',
      onEvent: (event: Event) => {
        if (event.type === 'QUESTION_REQUESTED') setTimeout(() => runner.cancel(event.task_id), 10);
      },
    });
    const result = await run;
    const answered = result.events.find((event) => event.type === 'QUESTION_ANSWERED');
    expect((answered?.payload as { cancelled?: boolean }).cancelled).toBe(true);
  });
});

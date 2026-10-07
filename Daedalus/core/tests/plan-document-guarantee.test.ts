import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  TaskRunner,
  TaskStore,
  assembledPlanPath,
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

type ScriptStep = { tool: string; args: unknown } | { text: string };

function scriptedProvider(script: ScriptStep[]): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
      const step = script[index++];
      if (!step) return { message: { role: 'assistant', content: 'done: finished' } };
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

function answerQuestions(runner: TaskRunner, answer: string) {
  return (event: { type: string; payload: unknown }) => {
    if (event.type !== 'QUESTION_REQUESTED') return;
    const info = (event.payload as { question?: UserQuestionInfo }).question;
    if (info) setTimeout(() => runner.questions.answer(info.id, answer), 5);
  };
}

describe('plan-document guarantee', () => {
  test('a model that asks then stops without writing gets one repair turn, then a harness-assembled plan.md', async () => {
    const root = temp('daedalus-plan-guarantee-ws-');
    const home = temp('daedalus-plan-guarantee-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      // The live failure shape (Farid's run): the model asks, creates the
      // plans FOLDER (which completes its step), and finishes — the plan
      // file itself is never written, even after the repair turn.
      provider: scriptedProvider([
        {
          tool: 'ask_user',
          args: {
            question: 'Website ini mau dipakai untuk apa?',
            options: [{ label: 'Website e-commerce' }, { label: 'Website e-learning' }],
          },
        },
        { tool: 'create_dir', args: { path: '.daedalus/plans/buat-website-dengan-database-terintegrasi' } },
        { tool: 'create_dir', args: { path: '.daedalus/plans/buat-website-dengan-database-terintegrasi' } },
        { text: 'done: all set' },
      ]),
      validator: passingValidator,
      maxIterations: 10,
    });
    const result = await runner.run({
      goal: 'Buat website dengan database terintegrasi\ndone: plan file written',
      mode: 'plan',
      onEvent: answerQuestions(runner, 'Website e-learning'),
    });

    expect(result.outcome).toBe('success');
    expect(result.state.status).toBe('done');
    // Exactly one repair turn was offered, for the missing document.
    const repairs = result.events.filter(
      (event) => event.type === 'RECOVERY_STARTED' && (event.payload as { reason?: string }).reason === 'plan_document_missing',
    );
    expect(repairs).toHaveLength(1);
    // The harness assembled the file deterministically, honestly labeled.
    const assembledRel = assembledPlanPath('Buat website dengan database terintegrasi');
    const assembled = join(root, ...assembledRel.split('/'));
    expect(existsSync(assembled)).toBe(true);
    const content = readFileSync(assembled, 'utf8');
    expect(content).toContain('Assembled by the Daedalus harness');
    expect(content).toContain('## Decisions');
    expect(content).toContain('Website ini mau dipakai untuk apa? → Website e-learning');
    expect(content).toContain('## Steps');
    expect(content).toContain('## Acceptance criteria');
    // The final report names the assembly, and the closing PLAN_CREATED
    // points at the assembled document.
    expect(result.report?.evidence.some((line) => line.includes('assembled by the harness'))).toBe(true);
    expect(result.report?.evidence.some((line) => line.includes(assembledRel))).toBe(true);
    const closing = [...result.events].reverse().find((event) => event.type === 'PLAN_CREATED');
    // The assembled set is the full plan-document set now, plan.md first.
    const slugDir = assembledRel.split('/').slice(0, -1).join('/');
    expect((closing?.payload as { documents?: string[] }).documents).toEqual([
      assembledRel,
      `${slugDir}/PRD.md`,
      `${slugDir}/architecture.md`,
      `${slugDir}/design.md`,
      `${slugDir}/tasks.md`,
    ]);
    // And the write shows up as a real file change.
    expect(result.events.some((event) => event.type === 'FILE_CHANGED' && (event.payload as { path?: string }).path?.endsWith('plan.md'))).toBe(true);
  });

  test('the repair turn is enough when the model uses it: its own plan.md is kept, nothing is assembled', async () => {
    const root = temp('daedalus-plan-repair-ws-');
    const home = temp('daedalus-plan-repair-home-');
    const ownPlan = '# Situs Toko\n\n## Decisions\n- Website ini mau dipakai untuk apa? → Website e-commerce\n';
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        {
          tool: 'ask_user',
          args: { question: 'Website ini mau dipakai untuk apa?', options: [{ label: 'Website e-commerce' }, { label: 'Website e-learning' }] },
        },
        // folder first (completes the step, triggers the repair turn) —
        // then the model uses the repair turn to actually write the plan
        { tool: 'create_dir', args: { path: '.daedalus/plans/situs-toko' } },
        { tool: 'write_file', args: { path: '.daedalus/plans/situs-toko/plan.md', content: ownPlan } },
        { text: 'done: plan written' },
      ]),
      validator: passingValidator,
      maxIterations: 10,
    });
    const result = await runner.run({
      goal: 'Buat website toko\ndone: plan file written',
      mode: 'plan',
      onEvent: answerQuestions(runner, 'Website e-commerce'),
    });

    expect(result.outcome).toBe('success');
    expect(
      result.events.some(
        (event) => event.type === 'RECOVERY_STARTED' && (event.payload as { reason?: string }).reason === 'plan_document_missing',
      ),
    ).toBe(true);
    expect(readFileSync(join(root, '.daedalus/plans/situs-toko/plan.md'), 'utf8')).toBe(ownPlan);
    expect(result.report?.evidence.some((line) => line.includes('assembled by the harness'))).toBe(false);
    expect(existsSync(join(root, '.daedalus/plans/buat-website-toko'))).toBe(false);
  });

  test('a plan the model writes without being asked is never overwritten or "repaired"', async () => {
    const root = temp('daedalus-plan-own-ws-');
    const home = temp('daedalus-plan-own-home-');
    const ownPlan = '# Punya Model\n\n## Goal\nDitulis sendiri oleh model.\n';
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: '.daedalus/plans/manual' } },
        { tool: 'write_file', args: { path: '.daedalus/plans/manual/plan.md', content: ownPlan } },
        { text: 'done: plan written' },
      ]),
      validator: passingValidator,
      maxIterations: 6,
    });
    const result = await runner.run({ goal: 'Rencanakan sesuatu\ndone: plan folder created\ndone: plan file written', mode: 'plan' });
    expect(result.outcome).toBe('success');
    expect(readFileSync(join(root, '.daedalus/plans/manual/plan.md'), 'utf8')).toBe(ownPlan);
    expect(
      result.events.some(
        (event) => event.type === 'RECOVERY_STARTED' && (event.payload as { reason?: string }).reason === 'plan_document_missing',
      ),
    ).toBe(false);
    expect(result.report?.evidence.some((line) => line.includes('assembled by the harness'))).toBe(false);
  });

  test('non-plan modes never trigger the guarantee', async () => {
    const root = temp('daedalus-plan-auto-ws-');
    const home = temp('daedalus-plan-auto-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      // This test pins only the plan-document guarantee; the creation
      // question gate is orthogonal here, so it is switched off.
      questionGate: false,
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'hello.txt', content: 'halo' } },
        { text: 'done: file written' },
      ]),
      validator: passingValidator,
      maxIterations: 6,
    });
    const result = await runner.run({ goal: 'Buat file halo\ndone: file written', mode: 'auto' });
    expect(result.outcome).toBe('success');
    expect(existsSync(join(root, '.daedalus/plans'))).toBe(false);
    expect(
      result.events.some(
        (event) => event.type === 'RECOVERY_STARTED' && (event.payload as { reason?: string }).reason === 'plan_document_missing',
      ),
    ).toBe(false);
  });
});

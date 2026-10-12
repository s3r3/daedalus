import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { EventBus, TaskRunner, TaskStore, type Event, type LLMProvider } from '../src/index.ts';

/**
 * Regressions for the plan-execution follow-up incident (PR #27 fallout):
 * an approved plan being executed in Auto must never be re-interrogated
 * by the creation question gate (the plan interview already happened),
 * and its target anchor must come from the PLAN's own documents — not
 * from an earlier task's folder still sitting in the chat history.
 */

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

/** Same scripted-provider shape as question-gate-plan-docs.test.ts. */
function scriptedProvider(script: ScriptStep[]): LLMProvider {
  let index = 0;
  return {
    name: 'scripted',
    async chat() {
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

function finishedResults(events: Event[]) {
  return events
    .filter((event) => event.type === 'TOOL_CALL_FINISHED')
    .map((event) => (event.payload as { result?: { status?: string; meta?: Record<string, unknown> } }).result ?? {});
}

function gateDenials(events: Event[]) {
  return finishedResults(events).filter((result) => result.meta?.reason === 'question_gate');
}

const planDir = '.daedalus/plans/buatlah-folder-baru-ayid-dan-buatkan-did';
const prdContent = '# PRD\n\nBuatlah folder baru ayid dan buatkan didalamnya landing page html yang lengkap.\n';
const tasksContent = '# Tasks\n\n- Buat folder ayid (files: ayid/index.html)\n- Tulis halaman landing (files: ayid/index.html)\n';

async function seedPlan(root: string, home: string) {
  const runner = new TaskRunner({
    workspaceRoot: root,
    store: new TaskStore(home),
    bus: new EventBus(),
    provider: scriptedProvider([
      { tool: 'create_dir', args: { path: planDir } },
      { tool: 'write_file', args: { path: `${planDir}/PRD.md`, content: prdContent } },
      { tool: 'write_file', args: { path: `${planDir}/architecture.md`, content: '# Architecture\n\nFiles: ayid/index.html\n' } },
      { tool: 'write_file', args: { path: `${planDir}/design.md`, content: '# Design\n\nMinimal.\n' } },
      { tool: 'write_file', args: { path: `${planDir}/plan.md`, content: '# buatlah folder baru ayid dan buatkan didalamnya landing page html\n' } },
      { tool: 'write_file', args: { path: `${planDir}/tasks.md`, content: tasksContent } },
      { text: 'done: dokumen rencana ditulis' },
    ]),
    validator: passingValidator,
    maxIterations: 12,
  });
  return runner.run({
    goal: 'rencanakan buatlah folder baru ayid dan buatkan didalamnya landing page html\ndone: PRD.md ditulis\ndone: architecture.md ditulis\ndone: design.md ditulis\ndone: plan.md ditulis\ndone: tasks.md ditulis\ndone: pratinjau dokumen selesai',
    mode: 'plan',
  });
}

describe('plan execution follow-up (gate + anchor)', () => {
  test('plan execution with pinned PRD containing creation verbs is never question-gated', async () => {
    const root = temp('daedalus-followup-gate-ws-');
    const home = temp('daedalus-followup-gate-home-');
    const planned = await seedPlan(root, home);
    expect(planned.state.status).toBe('done');

    const executor = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'ayid' } },
        { tool: 'write_file', args: { path: 'ayid/index.html', content: '<h1>Landing</h1>' } },
        { text: 'done: landing page selesai' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 8,
    });
    const executed = await executor.run({
      goal: `Execute the approved plan in ${planDir}/plan.md`,
      mode: 'auto',
      autoApprove: true,
      planTaskId: planned.state.id,
    });

    expect(gateDenials(executed.events)).toHaveLength(0);
    expect(executed.events.some((event) => event.type === 'QUESTION_REQUESTED')).toBe(false);
    // The very first mutation executed — no clarifying round beforehand.
    expect(finishedResults(executed.events)[0]?.status).toBe('ok');
    expect(existsSync(join(root, 'ayid/index.html'))).toBe(true);
    expect(executed.state.status).toBe('done');
    expect(executed.outcome).toBe('success');
  });

  test('plan execution anchors to the plan folder, not an earlier task folder from the same session', async () => {
    const root = temp('daedalus-followup-anchor-ws-');
    const home = temp('daedalus-followup-anchor-home-');
    const planned = await seedPlan(root, home);
    expect(planned.state.status).toBe('done');
    // The earlier task in this chat session built in jojo/; it exists on
    // disk and the conversation history still talks about it.
    mkdirSync(join(root, 'jojo'), { recursive: true });

    const executor = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'ayid' } },
        // Stray write into the earlier task's folder, attempted while the
        // plan still has open steps: confinement must refuse it now that
        // the plan's own target is the anchor.
        { tool: 'write_file', args: { path: 'jojo/nyasar.html', content: '<h1>Nyasar</h1>' } },
        { tool: 'write_file', args: { path: 'ayid/index.html', content: '<h1>Landing</h1>' } },
        { text: 'done: landing page selesai' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 8,
    });
    const executed = await executor.run({
      goal: `Execute the approved plan in ${planDir}/plan.md`,
      mode: 'auto',
      autoApprove: true,
      planTaskId: planned.state.id,
      priorContext: 'Earlier user turn: buat folder jojo disitu buat project vite tentang biodata presiden. Assistant: project dibuat di folder jojo.',
    });

    expect(executed.state.target_dir).toBe('ayid');
    expect(executed.report?.evidence).toContain('target_dir: ayid');
    expect(existsSync(join(root, 'ayid/index.html'))).toBe(true);
    expect(existsSync(join(root, 'jojo/nyasar.html'))).toBe(false);
    const stray = finishedResults(executed.events).find((result) => result.meta?.reason === 'outside_task_target');
    expect(stray?.status).toBe('denied');
  });

  test('a plain Auto creation prompt without a plan is still question-gated', async () => {
    const root = temp('daedalus-followup-plain-ws-');
    const home = temp('daedalus-followup-plain-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'app' } },
        {
          tool: 'ask_user',
          args: {
            question: 'Datanya disimpan di mana?',
            options: [{ label: 'localStorage browser' }, { label: 'Langsung buat saja' }],
          },
        },
        { tool: 'create_dir', args: { path: 'app' } },
        { tool: 'write_file', args: { path: 'app/index.html', content: '<h1>Kehadiran</h1>' } },
        { text: 'done: aplikasi kehadiran dibuat' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 10,
    });
    const events: Event[] = [];
    const result = await runner.run({
      goal: 'buat project vite tentang kehadiran mahasiswa',
      mode: 'auto',
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'QUESTION_REQUESTED') {
          const question = (event.payload as { question?: { id: string; question: string } }).question;
          if (question) setTimeout(() => runner.questions.answer(question.id, 'localStorage browser'), 5);
        }
      },
    });
    expect(result.events.some((event) => event.type === 'QUESTION_REQUESTED')).toBe(true);
    expect(gateDenials(result.events).length).toBeGreaterThan(0);
    expect(existsSync(join(root, 'app/index.html'))).toBe(true);
  });
});

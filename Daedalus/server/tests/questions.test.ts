import { afterEach, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, TaskStore, type Event, type Settings, type UserQuestionInfo } from '@daedalus/core';
import { attachWebSocket, createApp, createContext, type EventChannel } from '../src/app.ts';

let app: ReturnType<typeof createApp> | undefined;
let channel: EventChannel | undefined;
let providerServer: Server | undefined;
const dirs: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  channel?.close();
  channel = undefined;
  if (app) await new Promise<void>((resolve) => app?.close(() => resolve()));
  app = undefined;
  if (providerServer) await new Promise<void>((resolve) => providerServer?.close(() => resolve()));
  providerServer = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listen(workspace: string, home: string): Promise<{ base: string; ctx: ReturnType<typeof createContext> }> {
  const settings: Settings = {
    llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: '', models: [], modelStrategy: 'failover', timeoutMs: null },
    server: { host: '127.0.0.1', port: 3080 },
    daedalusHome: home,
  };
  const ctx = createContext({ settings, store: new TaskStore(join(home, 'state')), bus: new EventBus(), cwd: workspace });
  app = createApp(ctx);
  channel = attachWebSocket(ctx, app);
  return new Promise((resolve) => {
    app?.listen(0, '127.0.0.1', () => {
      const { port } = (app as NonNullable<typeof app>).address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, ctx });
    });
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const PLAN_MD = [
  '# Website E-Learning',
  '',
  '## Goal',
  'Buat website e-learning dengan database terintegrasi.',
  '',
  '## Decisions',
  '- Website ini mau dipakai untuk apa? → Website e-learning',
  '',
  '## Steps',
  '1. Buat halaman katalog (files: src/katalog.html)',
  '',
].join('\n');

/** Fake OpenAI-compatible provider: ask a question, then write the plan, then finish. */
async function startFakeProvider(): Promise<string> {
  let chatCalls = 0;
  providerServer = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        chatCalls++;
        const tool =
          chatCalls === 1
            ? {
                name: 'ask_user',
                arguments: JSON.stringify({
                  question: 'Website ini mau dipakai untuk apa?',
                  options: [
                    { label: 'Website e-commerce' },
                    { label: 'Website pendidikan' },
                    { label: 'Website e-learning' },
                  ],
                }),
              }
            : chatCalls === 2
              ? {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: '.daedalus/plans/website-e-learning/plan.md', content: PLAN_MD }),
                }
              : undefined;
        const message = tool
          ? { role: 'assistant', content: '', tool_calls: [{ id: `web-${chatCalls}`, type: 'function', function: tool }] }
          : { role: 'assistant', content: 'done: plan written' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => providerServer?.listen(0, '127.0.0.1', resolve));
  const address = providerServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('POST /tasks/{id}/questions/{questionId}', () => {
  test('resolves a pending question with the answer, and 404s unknown ids', async () => {
    const workspace = temp('daedalus-srv-q-ws-');
    const home = temp('daedalus-srv-q-home-');
    const { base, ctx } = await listen(workspace, home);
    ctx.store.saveState('tq', { status: 'active' });
    const { TaskRunner } = await import('@daedalus/core');
    const runner = new TaskRunner({ workspaceRoot: workspace, bus: ctx.bus, store: ctx.store });
    ctx.activeRunners.set('tq', runner);
    const info: UserQuestionInfo = {
      id: 'question-1',
      taskId: 'tq',
      question: 'Temanya apa?',
      options: [{ label: 'Terang' }, { label: 'Gelap' }],
      allowFreeText: true,
      createdAt: new Date().toISOString(),
    };
    const pending = runner.questions.ask(info);

    const missing = await fetch(new URL('/tasks/tq/questions/nope', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Terang' }),
    });
    expect(missing.status).toBe(404);

    const empty = await fetch(new URL('/tasks/tq/questions/question-1', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: '  ' }),
    });
    expect(empty.status).toBe(400);

    const res = await fetch(new URL('/tasks/tq/questions/question-1', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Gelap' }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; question_id: string }>(res);
    expect(body).toMatchObject({ success: true, question_id: 'question-1' });
    await expect(pending).resolves.toEqual({ outcome: 'answered', answer: 'Gelap' });
  });
});

describe('interactive plan mode end-to-end', () => {
  test('a plan task asks over HTTP, gets its answer, and writes plan.md with the Decisions', async () => {
    const workspace = temp('daedalus-srv-plan-ws-');
    const home = temp('daedalus-srv-plan-home-');
    const { base } = await listen(workspace, home);
    const fakeBase = await startFakeProvider();

    const providerRes = await fetch(new URL('/providers', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'fake', name: 'Fake', baseUrl: fakeBase, apiKey: 'fake-key', models: ['fake-model'] }),
    });
    expect(providerRes.status).toBe(201);

    const createdRes = await fetch(new URL('/tasks', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Buat website dengan database terintegrasi untuk sekolah',
        repo_path: workspace,
        provider_id: 'fake',
        model: 'fake-model',
        mode: 'plan',
        done_criteria: ['plan.md written'],
      }),
    });
    expect(createdRes.status).toBe(201);
    const task = await json<{ id: string }>(createdRes);

    // Wait for the question, then answer it through the endpoint.
    let questionId: string | undefined;
    for (let attempt = 0; attempt < 100 && !questionId; attempt++) {
      const snapshot = await json<{ events: Event[] }>(await fetch(new URL(`/tasks/${task.id}/events`, base)));
      const requested = snapshot.events.find((event) => event.type === 'QUESTION_REQUESTED');
      questionId = (requested?.payload as { question?: UserQuestionInfo } | undefined)?.question?.id;
      if (!questionId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(questionId).toBeDefined();
    const answerRes = await fetch(new URL(`/tasks/${task.id}/questions/${questionId}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: 'Website e-learning' }),
    });
    expect(answerRes.status).toBe(200);

    let snapshot: { state: { status: string }; report: { outcome: string } | null; events: Event[] } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await json<typeof snapshot>(await fetch(new URL(`/tasks/${task.id}`, base)));
      if (snapshot?.report || snapshot?.state.status === 'done' || snapshot?.state.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(snapshot?.state.status).toBe('done');
    expect(snapshot?.report?.outcome).toBe('success');

    const planPath = join(workspace, '.daedalus/plans/website-e-learning/plan.md');
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(planPath, 'utf8')).toContain('## Decisions');

    const events = snapshot?.events ?? [];
    const answered = events.find((event) => event.type === 'QUESTION_ANSWERED');
    expect((answered?.payload as { answer?: string }).answer).toBe('Website e-learning');
    const closing = [...events].reverse().find((event) => event.type === 'PLAN_CREATED');
    expect((closing?.payload as { documents?: string[] }).documents).toEqual(['.daedalus/plans/website-e-learning/plan.md']);
  }, 30_000);
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  ApprovalBroker,
  DefaultContextManager,
  EventBus,
  ExecutionHarness,
  ModeController,
  TaskRunner,
  TaskStore,
  commandLineOf,
  createPlan,
  detectScaffoldRequest,
  renderScaffoldPlaybook,
  resolveApprovalTimeoutMs,
  scaffoldApprovalChain,
  scaffoldChainStepFor,
  scaffoldPlanSteps,
  writeFileTool,
  type ApprovalRequestInfo,
  type LLMProvider,
  type Message,
  type ScaffoldMatch,
  type ToolDefinition,
  type ToolResult,
} from '../src/index.ts';

/**
 * The live incident these pin (Farid, 2026-10-07): create-next-app
 * succeeded, then `npm install`'s approval "timed out" (10 min, nobody
 * answered) into a decline; the agent improvised `npm run dev` instead
 * of install → write → build, and 16 minutes died waiting. The fixes:
 * one approval covers the recipe's declared chain per task, an
 * unanswered approval never auto-declines, and the playbook + plan
 * narration lock the install → write → build sequence (no dev server).
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

const GOAL = 'di folder jojo buat project next js buat halaman biodata presiden putin';
const GENERATOR_LINE = 'npx -y create-next-app@latest jojo --yes --skip-install --disable-git --ts --app --eslint --tailwind --src-dir --import-alias "@/*" --use-npm';

function nextjsMatch(): ScaffoldMatch {
  const match = detectScaffoldRequest(GOAL);
  if (!match) throw new Error('fixture goal must match the nextjs recipe');
  return match;
}

const ALL_OK_PROBES = [
  { tool: 'node', ok: true, version: 'v22.0.0' },
  { tool: 'npm', ok: true, version: '10.0.0' },
  { tool: 'npx', ok: true, version: '10.0.0' },
];

describe('scaffoldApprovalChain', () => {
  test('nextjs chain declares generator → install → build (plus the container-route generator)', () => {
    const chain = scaffoldApprovalChain(nextjsMatch(), { workspaceRoot: '/ws', uidGid: '1000:1000' });
    const steps = chain.map((step) => step.step);
    expect(steps).toEqual(['generate', 'generate', 'install', 'build']);
    expect(chain[0]?.display).toBe(GENERATOR_LINE);
    expect(chain[0]?.tokens.slice(0, 3)).toEqual(['npx', '-y', 'create-next-app@latest']);
    expect(chain[1]?.tokens[0]).toBe('docker'); // container route, same step
    expect(chain[2]).toMatchObject({ display: 'npm install', tokens: ['npm', 'install'] });
    expect(chain[3]).toMatchObject({ display: 'npm run build', tokens: ['npm', 'run', 'build'] });
  });

  test('matching is leading-token: variants of a step match, undeclared commands do not', () => {
    const chain = scaffoldApprovalChain(nextjsMatch());
    expect(scaffoldChainStepFor(chain, GENERATOR_LINE)?.step).toBe('generate');
    expect(scaffoldChainStepFor(chain, 'npm install')?.step).toBe('install');
    expect(scaffoldChainStepFor(chain, 'npm install --no-audit --no-fund')?.step).toBe('install');
    expect(scaffoldChainStepFor(chain, 'npm run build')?.step).toBe('build');
    // The dev-server detour and other undeclared commands are NOT chain.
    expect(scaffoldChainStepFor(chain, 'npm run dev')).toBeUndefined();
    expect(scaffoldChainStepFor(chain, 'npm test')).toBeUndefined();
    expect(scaffoldChainStepFor(chain, 'git status')).toBeUndefined();
    expect(scaffoldChainStepFor(chain, '')).toBeUndefined();
  });

  test('express chains only its generator (it installs in the same step); django chains generate + check', () => {
    const express = detectScaffoldRequest('buat api express di folder api');
    if (!express) throw new Error('express fixture must match');
    expect(scaffoldApprovalChain(express).map((step) => step.step)).toEqual(['generate', 'generate']);
    const django = detectScaffoldRequest('buat project django di folder web');
    if (!django) throw new Error('django fixture must match');
    const djangoChain = scaffoldApprovalChain(django);
    // host generator + container-route generator + the check step.
    expect(djangoChain.map((step) => step.step)).toEqual(['generate', 'generate', 'build']);
    expect(scaffoldChainStepFor(djangoChain, 'python3 manage.py check')?.step).toBe('build');
  });

  test('database recipes chain start + verify', () => {
    const postgres = detectScaffoldRequest('buatkan database postgres di folder db');
    if (!postgres) throw new Error('postgres fixture must match');
    const chain = scaffoldApprovalChain(postgres);
    expect(chain.map((step) => step.step)).toEqual(['start', 'verify']);
    expect(scaffoldChainStepFor(chain, 'docker compose up -d')?.step).toBe('start');
    expect(scaffoldChainStepFor(chain, 'docker compose ps')?.step).toBe('verify');
  });
});

describe('playbook step lock', () => {
  test('pins install → write → build order, the dev-server ban, the chain, and the declined-step contract', () => {
    const text = renderScaffoldPlaybook(nextjsMatch(), ALL_OK_PROBES, { workspaceRoot: '/ws', uidGid: '1000:1000' });
    expect(text).toContain('STEP LOCK');
    const installAt = text.indexOf('install dependencies: npm install');
    const writeAt = text.indexOf('write the requested content/pages');
    const buildAt = text.indexOf('verify by building: npm run build');
    expect(installAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(installAt);
    expect(buildAt).toBeGreaterThan(writeAt);
    expect(text).toContain('NEVER run a dev server as an agent step');
    expect(text).toContain('npm run dev');
    expect(text).toContain('covered by ONE approval for this task');
    expect(text).toContain('DECLINES a required chain step');
    expect(text).toContain('ask_user');
    expect(text).toContain('plain partial report');
    expect(text).toContain('no dev-server detour');
  });

  test('the database playbook carries the chain + declined contract too', () => {
    const postgres = detectScaffoldRequest('buatkan database postgres di folder db');
    if (!postgres) throw new Error('postgres fixture must match');
    const text = renderScaffoldPlaybook(postgres, [{ tool: 'docker', ok: true, version: '27.0.0' }]);
    expect(text).toContain('covered by ONE approval for this task');
    expect(text).toContain('DECLINES starting the stack');
  });
});

describe('scaffold plan steps', () => {
  test('derive from the recipe sequence, not the canned pipeline', () => {
    expect(scaffoldPlanSteps(nextjsMatch())).toEqual([
      'Run the official Next.js generator into jojo/',
      'Install dependencies (npm install in jojo/)',
      'Write the requested content into the generated project',
      'Build to verify (npm run build in jojo/)',
    ]);
  });

  test('createPlan uses them for a scaffold goal without criteria; criteria and plain goals are untouched', async () => {
    const spec = {
      id: 't-scaffold',
      goal: GOAL,
      repo_path: '/ws',
      constraints: [],
      done_criteria: [],
      created_at: new Date().toISOString(),
    };
    const plan = await createPlan(spec);
    expect(plan.steps.map((step) => step.intent)).toEqual(scaffoldPlanSteps(nextjsMatch()));
    expect(plan.steps.map((step) => step.intent)).not.toContain('Run the project validation checks');

    const withCriteria = await createPlan({ ...spec, done_criteria: ['halaman tampil'] });
    expect(withCriteria.steps.map((step) => step.intent)).toEqual(['Satisfy: halaman tampil']);

    const plain = await createPlan({ ...spec, goal: 'fix the login bug' });
    expect(plain.steps.map((step) => step.intent)).toContain('Run the project validation checks');
  });
});

describe('no auto-decline on approval wait', () => {
  const SAVED_ENV = process.env.DAEDALUS_APPROVAL_TIMEOUT_MS;
  beforeEach(() => {
    delete process.env.DAEDALUS_APPROVAL_TIMEOUT_MS;
  });
  afterEach(() => {
    if (SAVED_ENV === undefined) delete process.env.DAEDALUS_APPROVAL_TIMEOUT_MS;
    else process.env.DAEDALUS_APPROVAL_TIMEOUT_MS = SAVED_ENV;
  });

  test('the default wait has no expiry; an explicit cap is still honored', () => {
    expect(resolveApprovalTimeoutMs()).toBe(0);
    expect(resolveApprovalTimeoutMs(45_000)).toBe(45_000);
    process.env.DAEDALUS_APPROVAL_TIMEOUT_MS = '30000';
    expect(resolveApprovalTimeoutMs()).toBe(30_000);
  });

  test('an unanswered approval stays pending until the task is cancelled — it never expires into a decline', async () => {
    const broker = new ApprovalBroker();
    let settled: unknown;
    const pending = broker.request({
      id: 'a-wait',
      key: { taskId: 'task-wait', tool: 'run_command', action: 'execute' },
      policy: 'ask',
      tool: 'run_command',
      preview: { kind: 'command', command: 'npm install' },
      requestedBy: { taskId: 'task-wait' },
      createdAt: new Date().toISOString(),
    } satisfies ApprovalRequestInfo);
    void pending.then((result) => {
      settled = result;
    });
    // Well past the old behavior's spirit: nothing settles it.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBeUndefined();
    expect(broker.pending()).toHaveLength(1);
    // Stopping the task is what settles it — as a visible decline.
    expect(broker.cancelTasks(['task-wait'])).toBe(1);
    await expect(pending).resolves.toMatchObject({ decision: 'deny', outcome: 'cancelled' });
  });

  test('TaskRunner: an unanswered approval blocks (no silent decline) until cancel settles it', async () => {
    const root = temp('daedalus-nodeline-ws-');
    const home = temp('daedalus-nodeline-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([{ tool: 'write_file', args: { path: 'slow.txt', content: 'x' } }]),
      validator: passingValidator,
      approvalPolicy: 'ask',
      // No approvalTimeoutMs: the default is now "wait for the human".
      maxIterations: 3,
    });
    let settled = false;
    const runPromise = runner.run({ goal: 'Write a file\ndone: file written', mode: 'manual' }).then((result) => {
      settled = true;
      return result;
    });
    for (let i = 0; i < 200 && runner.approvals.pending().length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runner.approvals.pending()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    expect(runner.approvals.pending()).toHaveLength(1);
    const taskId = runner.approvals.pending()[0]?.info.key.taskId;
    if (!taskId) throw new Error('pending approval must carry its task id');
    runner.cancel(taskId);
    const result = await runPromise;
    expect(existsSync(join(root, 'slow.txt'))).toBe(false);
    const decided = result.events.find((event) => event.type === 'APPROVAL_DECIDED');
    expect((decided?.payload as { cancelled?: boolean }).cancelled).toBe(true);
    expect((decided?.payload as { timed_out?: boolean }).timed_out).toBeUndefined();
  });
});

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

/** run_command stand-in: records lines, "generates" the marker on the generator call. */
function fakeCommandTool(root: string, executed: string[]): ToolDefinition {
  return {
    name: 'run_command',
    description: 'fake command runner',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    execute: async (args) => {
      const line = commandLineOf(args as Record<string, unknown>) ?? '';
      executed.push(line);
      if (line.startsWith('npx -y create-next-app@latest')) {
        mkdirSync(join(root, 'jojo'), { recursive: true });
        writeFileSync(join(root, 'jojo', 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }));
      }
      const result: ToolResult = { call_id: 'fake', status: 'ok', output: `ran: ${line}`, truncated: false, meta: { exit_code: 0 } };
      return result;
    },
  };
}

function chainHarness(root: string, answers: Array<'grant' | 'deny'>, options: { denyAll?: boolean } = {}) {
  const prompts: ApprovalRequestInfo[] = [];
  const executed: string[] = [];
  const match = nextjsMatch();
  const chain = scaffoldApprovalChain(match, { workspaceRoot: root, uidGid: '1000:1000' });
  const harness = new ExecutionHarness(
    {
      defaultApprovalPolicy: 'ask',
      ...(options.denyAll ? { policyFor: () => 'deny' as const } : {}),
      scaffoldChainFor: (key, call) => {
        if (key.taskId !== 'task-1' || call.tool !== 'run_command') return undefined;
        const line = commandLineOf((call.args ?? {}) as Record<string, unknown>);
        const step = line ? scaffoldChainStepFor(chain, line) : undefined;
        return step ? { chainId: match.recipe.id, step: step.step, covers: chain.map((s) => s.label) } : undefined;
      },
    },
    { bus: new EventBus(), store: new TaskStore(temp('daedalus-chain-home-')) },
  );
  harness.setApprovalCallback(async (info) => {
    prompts.push(info);
    return { decision: answers.shift() ?? 'grant' };
  });
  const tool = fakeCommandTool(root, executed);
  const call = (id: string, line: string, taskId = 'task-1') => {
    const [command, ...rest] = line.split(' ');
    return harness.execute(
      { id, task_id: taskId, turn_id: 'u1', tool: 'run_command', args: { command, args: rest }, started_at: new Date().toISOString() },
      tool,
      { workspaceRoot: root, taskId },
    );
  };
  return { prompts, executed, call };
}

const GENERATOR_ARGS = { command: 'npx', args: ['-y', 'create-next-app@latest', 'jojo', '--yes', '--skip-install'] };

describe('scaffold-chain single approval (harness)', () => {
  test('approving the generator covers install + build: exactly one prompt for the chain', async () => {
    const root = temp('daedalus-chain-ws-');
    const { prompts, executed, call } = chainHarness(root, ['grant']);
    const gen = await call('c1', 'npx -y create-next-app@latest jojo --yes --skip-install');
    const install = await call('c2', 'npm install');
    const build = await call('c3', 'npm run build');
    expect(gen.status).toBe('ok');
    expect(install.status).toBe('ok');
    expect(build.status).toBe('ok');
    expect(executed).toHaveLength(3);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.chain).toMatchObject({ id: 'nextjs', step: 'generate' });
    expect(prompts[0]?.chain?.covers).toContain('install');
    expect(prompts[0]?.chain?.covers).toContain('build');
  });

  test('a decline does NOT chain: each later chain step asks on its own merits', async () => {
    const root = temp('daedalus-chain-ws-');
    const { prompts, executed, call } = chainHarness(root, ['deny', 'deny', 'grant']);
    // The user declines the generator. No chain grant can exist now, so
    // when the model nevertheless tries the install, it prompts again —
    // and declining that leaves the build to ask for itself too.
    const gen = await call('c1', 'npx -y create-next-app@latest jojo --yes --skip-install');
    expect(gen.status).toBe('denied');
    const install = await call('c2', 'npm install');
    expect(install.status).toBe('denied');
    expect(install.output).toContain('approval denied');
    const build = await call('c3', 'npm run build');
    expect(build.status).toBe('ok');
    expect(prompts).toHaveLength(3);
    expect(prompts[0]?.chain?.step).toBe('generate');
    expect(prompts[1]?.chain?.step).toBe('install');
    expect(prompts[2]?.chain?.step).toBe('build');
    expect(executed).toEqual(['npm run build']);
  });

  test('non-chain commands keep per-class behavior, and the chain is scoped to its task', async () => {
    const root = temp('daedalus-chain-ws-');
    const { prompts, call } = chainHarness(root, ['grant', 'grant', 'grant']);
    await call('c1', 'npx -y create-next-app@latest jojo --yes --skip-install'); // chain grant (1 prompt)
    const dev = await call('c2', 'npm run dev'); // not a chain step: prompts
    expect(dev.status).toBe('ok');
    const otherTask = await call('c3', 'npm install', 'task-2'); // another task: prompts
    expect(otherTask.status).toBe('ok');
    expect(prompts).toHaveLength(3);
    expect(prompts[1]?.chain).toBeUndefined();
    expect(prompts[2]?.chain).toBeUndefined();
  });

  test('a policy deny beats the chain grant (Ask/Plan stay read-only)', async () => {
    const root = temp('daedalus-chain-ws-');
    const { prompts, call } = chainHarness(root, ['grant'], { denyAll: true });
    const gen = await call('c1', 'npx -y create-next-app@latest jojo --yes --skip-install');
    expect(gen.status).toBe('denied');
    expect(prompts).toHaveLength(0);
  });
});

describe('live-run regression: one prompt, generator → install → build', () => {
  test('a scripted scaffold run completes with exactly ONE approval request total', async () => {
    const root = temp('daedalus-live-ws-');
    const store = new TaskStore(temp('daedalus-live-home-'));
    const bus = new EventBus();
    const match = nextjsMatch();
    const chain = scaffoldApprovalChain(match, { workspaceRoot: root, uidGid: '1000:1000' });
    const prompts: ApprovalRequestInfo[] = [];
    const harness = new ExecutionHarness(
      {
        // Commands are approval-gated; file writes are auto-approved in
        // this configuration. The chain is what is under test — under
        // it, the whole generator → install → build sequence must cost
        // exactly ONE approval request total.
        defaultApprovalPolicy: 'ask',
        policyFor: (key) => (key.action === 'execute' ? 'ask' : 'auto'),
        scaffoldChainFor: (key, call) => {
          if (call.tool !== 'run_command') return undefined;
          const line = commandLineOf((call.args ?? {}) as Record<string, unknown>);
          const step = line ? scaffoldChainStepFor(chain, line) : undefined;
          return step ? { chainId: match.recipe.id, step: step.step, covers: chain.map((s) => s.label) } : undefined;
        },
      },
      { bus, store },
    );
    harness.setApprovalCallback(async (info) => {
      prompts.push(info);
      return { decision: 'grant' };
    });
    const executed: string[] = [];
    const tool = fakeCommandTool(root, executed);
    const captured: Message[][] = [];
    const loop = new AgentLoop({
      provider: scriptedProvider(
        [
          { tool: 'run_command', args: { ...GENERATOR_ARGS, timeout_ms: 600_000 } },
          { tool: 'run_command', args: { command: 'npm', args: ['install'], cwd: 'jojo', timeout_ms: 600_000 } },
          { tool: 'write_file', args: { path: 'jojo/src/app/page.tsx', content: 'export default function Page() { return <main>Biodata Presiden Putin</main>; }' } },
          { tool: 'run_command', args: { command: 'npm', args: ['run', 'build'], cwd: 'jojo', timeout_ms: 600_000 } },
          { text: 'done: project created, installed, and built' },
        ],
        captured,
      ),
      bus,
      store,
      context: new DefaultContextManager({
        workspaceRoot: root,
        scaffoldPlaybook: renderScaffoldPlaybook(match, ALL_OK_PROBES, { workspaceRoot: root, uidGid: '1000:1000' }),
      }),
      modeController: new ModeController('manual', false),
      stopPolicy: { max_iterations: 8, max_errors: 3 },
      executeTool: async (call) =>
        harness.execute(call, call.tool === 'write_file' ? writeFileTool : tool, { workspaceRoot: root, taskId: call.task_id }),
    });

    const state = await loop.run({
      id: 'task-live-regression',
      goal: GOAL,
      repo_path: root,
      constraints: [],
      done_criteria: [],
      created_at: new Date().toISOString(),
      mode: 'manual',
    });
    expect(state.status).toBe('done');
    // The page the user asked for really is in the generated structure.
    expect(existsSync(join(root, 'jojo', 'src', 'app', 'page.tsx'))).toBe(true);
    // The whole chain ran, in the locked order.
    expect(executed).toEqual([
      'npx -y create-next-app@latest jojo --yes --skip-install',
      'npm install',
      'npm run build',
    ]);
    // Exactly ONE approval request for the entire run.
    const events = store.replay(state.id);
    expect(events.filter((event) => event.type === 'APPROVAL_REQUESTED')).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.chain?.id).toBe('nextjs');
    const decided = events.filter((event) => event.type === 'APPROVAL_DECIDED');
    expect(decided).toHaveLength(1);
    expect((decided[0]?.payload as { scaffold_chain?: string }).scaffold_chain).toBe('nextjs');
    // The plan narration is the recipe sequence (no "validation checks"
    // while install had not run).
    const planCreated = events.find((event) => event.type === 'PLAN_CREATED');
    const intents = ((planCreated?.payload as { plan?: { steps?: Array<{ intent: string }> } }).plan?.steps ?? []).map((step) => step.intent);
    expect(intents).toEqual(scaffoldPlanSteps(match));
    // The agent-facing contract rode into the prompt.
    const promptText = JSON.stringify(captured[1] ?? []);
    expect(promptText).toContain('STEP LOCK');
    expect(promptText).toContain('NEVER run a dev server');
    expect(promptText).toContain('ONE approval');
  });
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgentLoop,
  BOOTSTRAP_PROBE_TOOLS,
  DefaultContextManager,
  EventBus,
  ExecutionHarness,
  LLMTimeoutError,
  MAX_SKILL_INDEX_CHARS,
  MAX_TOOL_CALL_TIMEOUT_MS,
  MISE_PACKAGE_BY_TOOL,
  SANDBOX_ALLOWLIST,
  SCAFFOLD_RECIPES,
  SPAWN_SUBAGENT_TOOL_NAME,
  TaskRunner,
  TaskStore,
  clampCallTimeoutMs,
  createDefaultRegistry,
  creationCompletionRefusal,
  summarizeCommandFailure,
  detectCreationGoal,
  detectScaffoldRequest,
  detectUnsupportedFramework,
  djangoProjectName,
  extractTargetDir,
  interpretTask,
  probeToolchains,
  renderDatabasePlaybook,
  renderDockerGeneratorLine,
  renderScaffoldPlaybook,
  renderUnsupportedPlaybook,
  scaffoldMarkerPresent,
  runCommandTool,
  type LLMProvider,
  type Message,
  type SkillInfo,
  type TaskState,
  type ToolDefinition,
  type ToolchainProbe,
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

/**
 * Scripted provider: consumes steps in order, then answers with the
 * fallback text forever. Records every message batch it received so tests
 * can assert on the exact prompt the model saw.
 */
function scriptedProvider(steps: ScriptStep[], hooks: { seen?: Message[][] } = {}): LLMProvider {
  let index = 0;
  return {
    name: 'scaffold-scripted',
    async chat(messages: Message[]) {
      hooks.seen?.push(messages);
      const step = steps[index++];
      if (!step) return { message: { role: 'assistant' as const, content: 'done: nothing further scripted' } };
      if ('text' in step) return { message: { role: 'assistant' as const, content: step.text } };
      return {
        message: {
          role: 'assistant' as const,
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

function systemTextOf(messages: Message[]): string {
  const system = messages.find((message) => message.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'test', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

describe('scaffold recipe detection', () => {
  test('detects Farid’s incident phrasing: Indonesian nextjs request with a folder target', () => {
    const match = detectScaffoldRequest('di folder jojo itu buat project next js buat halaman website tentang biodata presiden putin');
    expect(match?.recipe.id).toBe('nextjs');
    expect(match?.targetDir).toBe('jojo');
    expect(match?.recipe.generator('jojo').display).toBe(
      'npx -y create-next-app@latest jojo --yes --skip-install --disable-git --ts --app --eslint --tailwind --src-dir --import-alias "@/*" --use-npm',
    );
  });

  test('detects English phrasings across the recipe table', () => {
    expect(detectScaffoldRequest('create a vite app with react and typescript')?.recipe.id).toBe('vite-react');
    expect(detectScaffoldRequest('scaffold a new angular project called admin-panel')?.recipe.id).toBe('angular');
    expect(detectScaffoldRequest('scaffold a new angular project called admin-panel')?.targetDir).toBe('admin-panel');
    expect(detectScaffoldRequest('setup a flutter app in the shop folder')?.recipe.id).toBe('flutter');
    expect(detectScaffoldRequest('setup a flutter app in the shop folder')?.targetDir).toBe('shop');
  });

  test('detects Indonesian phrasings for vue and laravel', () => {
    expect(detectScaffoldRequest('buat aplikasi vue baru untuk dashboard')?.recipe.id).toBe('vite-vue');
    const laravel = detectScaffoldRequest('project laravel baru di folder backend');
    expect(laravel?.recipe.id).toBe('laravel');
    expect(laravel?.targetDir).toBe('backend');
    expect(laravel?.recipe.generator('backend').display).toBe('composer create-project laravel/laravel backend --no-interaction --prefer-dist');
  });

  test('detects the expanded framework and API recipes in English and Indonesian', () => {
    const svelte = detectScaffoldRequest('buat project sveltekit baru di folder web');
    expect(svelte?.recipe.id).toBe('sveltekit');
    expect(svelte?.targetDir).toBe('web');
    expect(svelte?.recipe.generator('web').display).toBe('npx -y sv@latest create web --template minimal --types ts --no-add-ons --no-install');

    const nuxt = detectScaffoldRequest('create a Nuxt app called portal');
    expect(nuxt?.recipe.id).toBe('nuxt');
    expect(nuxt?.targetDir).toBe('portal');
    expect(nuxt?.recipe.generator('portal').display).toBe('npx -y nuxi@latest init portal --template minimal --packageManager npm --no-install --no-gitInit');

    const astro = detectScaffoldRequest('buat website astro di folder site');
    expect(astro?.recipe.id).toBe('astro');
    expect(astro?.recipe.generator('site').display).toBe('npm create astro@latest site -- --template minimal --no-install --no-git --skip-houston --yes');

    const nest = detectScaffoldRequest('create a NestJS API in the api folder');
    expect(nest?.recipe.id).toBe('nestjs');
    expect(nest?.recipe.category).toBe('api');
    expect(nest?.recipe.generator('api').display).toBe('npx --yes @nestjs/cli@latest new api --package-manager npm --skip-git --skip-install --strict');

    const django = detectScaffoldRequest('buat project django di folder backend-api');
    expect(django?.recipe.id).toBe('django');
    expect(djangoProjectName('backend-api')).toBe('backend_api');
    expect(django?.recipe.generator('backend-api').display).toBe('django-admin startproject backend_api backend-api');

    const expo = detectScaffoldRequest('buat aplikasi react native dengan expo di folder mobile');
    expect(expo?.recipe.id).toBe('expo');
    expect(expo?.recipe.generator('mobile').display).toBe('npx -y create-expo-app@latest mobile --template blank-typescript --no-install --yes');

    const express = detectScaffoldRequest('create an express API server in the api folder');
    expect(express?.recipe.id).toBe('express');
    expect(express?.recipe.category).toBe('api');
    expect(express?.recipe.generator('api').display).toBe('npm install express --prefix api --no-audit --no-fund');
  });

  test('detects database goals as Docker Compose recipes, not project generators', () => {
    const mysql = detectScaffoldRequest('setup database mysql untuk aplikasi');
    expect(mysql?.recipe.id).toBe('mysql');
    expect(mysql?.recipe.category).toBe('database');
    expect(mysql?.recipe.toolchains).toEqual(['docker']);

    expect(detectScaffoldRequest('buat database postgres di folder infra')?.recipe.id).toBe('postgres');
    expect(detectScaffoldRequest('buat database postgres di folder infra')?.targetDir).toBe('infra');
    expect(detectScaffoldRequest('create a MongoDB database for the service')?.recipe.id).toBe('mongodb');
    expect(detectScaffoldRequest('setup redis cache')?.recipe.id).toBe('redis');
    expect(SCAFFOLD_RECIPES.mongodb.category).toBe('database');
    expect(SCAFFOLD_RECIPES.redis.composeFile?.content('app')).toContain('image: redis:8');
  });

  test('non-scaffold goals stay untouched', () => {
    expect(detectScaffoldRequest('fix the bug in the next.js middleware')).toBeUndefined();
    expect(detectScaffoldRequest('explain how next js routing works')).toBeUndefined();
    expect(detectScaffoldRequest('how do I create a next js app?')).toBeUndefined();
    expect(detectScaffoldRequest('update the laravel dependencies')).toBeUndefined();
    expect(detectScaffoldRequest('refactor the flutter widget tree')).toBeUndefined();
  });

  test('unsupported technologies are named honestly instead of matched to a recipe', () => {
    // Changed with the recipe-table v2 batch: React Native now maps to the
    // verified Expo generator, and MySQL/PostgreSQL now map to Docker
    // Compose database recipes. Kotlin/Android and embedded SQLite remain
    // honesty-only because neither has a verified generated-project flow.
    expect(detectScaffoldRequest('buat aplikasi react native untuk android')?.recipe.id).toBe('expo');
    expect(detectScaffoldRequest('setup a mysql database for the app')?.recipe.id).toBe('mysql');
    expect(detectScaffoldRequest('setup postgres untuk project ini')?.recipe.id).toBe('postgres');
    expect(detectUnsupportedFramework('buat project kotlin android baru')?.name).toBe('Kotlin/Android');
    expect(detectUnsupportedFramework('setup sqlite untuk aplikasi ini')?.name).toBe('SQLite');
  });

  test('extractTargetDir sanitizes and defaults safely', () => {
    expect(extractTargetDir('buat project di folder web-app.')).toBe('web-app');
    expect(extractTargetDir('create it in the Portal folder please')).toBe('Portal');
    expect(extractTargetDir('buat project next js')).toBe('app');
    expect(extractTargetDir('buat di folder itu project next js')).toBe('app');
    expect(extractTargetDir('create in folder ../escape please')).not.toContain('..');
  });

  test('the unsupported-framework playbook sends the agent to fetch_url, then --help, never to invented steps', () => {
    const playbook = renderUnsupportedPlaybook(detectUnsupportedFramework('buat project kotlin android baru')!);
    expect(playbook).toContain('fetch_url');
    expect(playbook).toContain('official Kotlin/Android install/docs page');
    expect(playbook).toContain('--help');
    // Fallback order: docs fetch first, generator help second, invention never.
    expect(playbook.indexOf('fetch_url')).toBeLessThan(playbook.indexOf('--help'));
    expect(playbook).toContain('NEVER invent install steps');
  });
});

describe('creation-goal classification (completion gate surface)', () => {
  test('creation-shaped goals classify as creation', () => {
    expect(detectCreationGoal('buat file config.json untuk aplikasi').creation).toBe(true);
    expect(detectCreationGoal('create a landing page for the product').creation).toBe(true);
    expect(detectCreationGoal('add a health endpoint to the server').creation).toBe(true);
    expect(detectCreationGoal('di folder jojo itu buat project next js').scaffold?.recipe.id).toBe('nextjs');
  });

  test('questions, explanations, and fixes to existing files never classify as creation', () => {
    expect(detectCreationGoal('udah dibuat project next js nya?').creation).toBe(false);
    expect(detectCreationGoal('what does this function do?').creation).toBe(false);
    expect(detectCreationGoal('explain the vite config').creation).toBe(false);
    expect(detectCreationGoal('fix the login page crash').creation).toBe(false);
    expect(detectCreationGoal('perbaiki file login yang error').creation).toBe(false);
    expect(detectCreationGoal('refactor the auth module to use JWT').creation).toBe(false);
    expect(detectCreationGoal('update the README with install steps').creation).toBe(false);
    expect(detectCreationGoal('investigate why the build is slow').creation).toBe(false);
  });
});

describe('creation completion gate failure evidence', () => {
  const goal = detectCreationGoal('buat folder jojo disitu buat project vite buat halaman website tentang biodata presiden putin dari russia yang lengkap');

  test('summarizeCommandFailure keeps the bounded error tail', () => {
    const summary = summarizeCommandFailure('npm create vite@latest jojo', 'noise line\n\n> create-vite jojo\n└  Operation cancelled\n');
    expect(summary).toContain('`npm create vite@latest jojo`');
    expect(summary).toContain('Operation cancelled');
    expect(summarizeCommandFailure('npm install', '')).toBe('`npm install` failed with no output');
  });

  test('a missing scaffold marker refusal names the last failed command when known', () => {
    const refusal = creationCompletionRefusal(
      goal,
      {
        filesChanged: 7,
        commandsSucceeded: 0,
        delegated: false,
        lastCommandFailure: summarizeCommandFailure('npm create vite@latest jojo -- --template react-ts --no-interactive', '└  Operation cancelled'),
      },
      false,
    );
    expect(refusal?.reason).toBe('no_files_created');
    expect(refusal?.detail).toContain('scaffold marker package.json was not found under jojo/');
    expect(refusal?.detail).toContain('the last failed command shows why');
    expect(refusal?.detail).toContain('Operation cancelled');
  });

  test('without a recorded failure the refusal stays the plain marker message', () => {
    const refusal = creationCompletionRefusal(goal, { filesChanged: 0, commandsSucceeded: 0, delegated: false }, false);
    expect(refusal?.detail).toContain('scaffold marker package.json was not found under jojo/');
    expect(refusal?.detail).not.toContain('last failed command');
  });
});

describe('scaffold playbook rendering + preflight', () => {
  const nextjs = detectScaffoldRequest('di folder jojo itu buat project next js')!;

  test('playbook carries the exact generator command, the install split, and probe results', () => {
    const text = renderScaffoldPlaybook(nextjs, [
      { tool: 'node', ok: true, version: 'v20.11.0' },
      { tool: 'npm', ok: true, version: '10.2.3' },
      { tool: 'npx', ok: true, version: '10.2.3' },
    ]);
    expect(text).toContain('npx -y create-next-app@latest jojo --yes --skip-install');
    expect(text).toContain('timeout_ms 600000');
    expect(text).toContain('separate steps');
    expect(text).toContain('Toolchains on this machine: node v20.11.0; npm 10.2.3; npx 10.2.3');
    expect(text).not.toContain('MISSING');
  });

  test('playbook warns the generator needs an empty folder and names the cancelled-run recovery', () => {
    const vite = detectScaffoldRequest('buat folder jojo disitu buat project vite')!;
    const text = renderScaffoldPlaybook(vite, [
      { tool: 'node', ok: true, version: 'v24.0.0' },
      { tool: 'npm', ok: true, version: '10.9.4' },
    ]);
    expect(text).toContain('COMPLETELY EMPTY');
    expect(text).toContain('do not write any file inside `jojo/`');
    expect(text).toContain('Operation cancelled');
    expect(text).toContain('run the generator once more');
    expect(text).toContain('Never hand-write a skeleton to fake the marker');
  });

  test('a missing toolchain turns the playbook into a plain stop instruction', () => {
    const laravel = detectScaffoldRequest('project laravel baru di folder backend')!;
    const text = renderScaffoldPlaybook(laravel, [
      { tool: 'php', ok: true, version: 'PHP 8.3.0' },
      { tool: 'composer', ok: false },
    ]);
    expect(text).toContain('composer MISSING');
    expect(text).toContain('STOP');
    expect(text).toContain('never hand-write a fake');
  });

  test('database playbook writes the Compose stack, starts it, and checks it', () => {
    const match = detectScaffoldRequest('setup database mysql di folder infra')!;
    const text = renderDatabasePlaybook(match, [{ tool: 'docker', ok: true, version: 'Docker version 27.0.0' }]);
    expect(text).toContain('write_file to `infra/docker-compose.yml`');
    expect(text).toContain('image: mysql:8.4');
    expect(text).toContain('MYSQL_DATABASE: app');
    expect(text).toContain('mysql_data:/var/lib/mysql');
    expect(text).toContain('docker compose up -d (with cwd infra)');
    expect(text).toContain('docker compose ps');
    expect(text).toContain('Docker version 27.0.0');
    expect(text).not.toContain('STOP BEFORE WRITING');
  });

  test('missing Docker turns the database playbook into an honest stop before any stack is written', () => {
    const match = detectScaffoldRequest('setup database postgres di folder infra')!;
    const text = renderDatabasePlaybook(match, [{ tool: 'docker', ok: false }]);
    expect(text).toContain('docker MISSING');
    expect(text).toContain('STOP BEFORE WRITING OR STARTING THE STACK');
    expect(text).toContain('never invent SQL files');
    expect(text).not.toContain('Write this exact stack');
    expect(text).not.toContain('docker compose up -d');
  });

  test('database completion marker requires the Compose file with the right official image', () => {
    const root = temp('daedalus-db-marker-');
    const match = detectScaffoldRequest('setup database mysql di folder infra')!;
    const target = join(root, 'infra');
    mkdirSync(target, { recursive: true });

    expect(scaffoldMarkerPresent(root, match)).toBe(false);
    writeFileSync(join(target, 'docker-compose.yml'), 'services:\n  postgres:\n    image: postgres:17\n');
    expect(scaffoldMarkerPresent(root, match)).toBe(false);
    writeFileSync(join(target, 'docker-compose.yml'), SCAFFOLD_RECIPES.mysql.composeFile!.content('infra'));
    expect(scaffoldMarkerPresent(root, match)).toBe(true);
  });

  test('probeToolchains never throws — failures read as MISSING', async () => {
    const probes = await probeToolchains(['node', 'nope'], async (tool) => {
      if (tool === 'nope') throw new Error('spawn ENOENT');
      return { tool, ok: true, version: 'v1' };
    });
    expect(probes).toEqual([
      { tool: 'node', ok: true, version: 'v1' },
      { tool: 'nope', ok: false },
    ]);
  });
});

describe('run_command timeout_ms', () => {
  test('clampCallTimeoutMs clamps to the 600s cap and rejects non-numbers', () => {
    expect(MAX_TOOL_CALL_TIMEOUT_MS).toBe(600_000);
    expect(clampCallTimeoutMs(undefined)).toBeUndefined();
    expect(clampCallTimeoutMs('5000')).toBeUndefined();
    expect(clampCallTimeoutMs(0)).toBeUndefined();
    expect(clampCallTimeoutMs(-10)).toBeUndefined();
    expect(clampCallTimeoutMs(Number.NaN)).toBeUndefined();
    expect(clampCallTimeoutMs(250)).toBe(250);
    expect(clampCallTimeoutMs(999_999_999)).toBe(600_000);
  });

  test('run_command honors a small timeout_ms end to end (harness + tool)', async () => {
    const root = temp('daedalus-timeout-ws-');
    const bus = new EventBus();
    const harness = new ExecutionHarness({ defaultApprovalPolicy: 'auto' }, { bus, store: new TaskStore(join(root, '.daedalus')) });
    const started = Date.now();
    const result = await harness.execute(
      { id: 'c1', task_id: 't1', turn_id: 'u1', tool: 'run_command', args: { command: 'sleep', args: ['5'], timeout_ms: 150 }, started_at: new Date().toISOString() },
      runCommandTool,
      { workspaceRoot: root, taskId: 't1' },
    );
    expect(result.status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('an oversized timeout_ms is clamped, not honored literally or rejected', async () => {
    const root = temp('daedalus-timeout-clamp-');
    const result = await runCommandTool.execute(
      { command: 'echo', args: ['hi'], timeout_ms: 999_999_999 },
      { workspaceRoot: root },
    );
    expect(result.status).toBe('ok');
    expect(result.output.trim()).toBe('hi');
  });

  test('the expanded recipe commands are permitted by the run_command allowlist', () => {
    expect(SANDBOX_ALLOWLIST).toEqual(expect.arrayContaining(['docker', 'django-admin', 'composer', 'flutter']));
  });

  test('the model-facing schema advertises timeout_ms without host fields', () => {
    const schema = createDefaultRegistry().schemas().find((entry) => entry.function.name === 'run_command');
    const properties = (schema?.function.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).toContain('timeout_ms');
    expect(JSON.stringify(schema)).not.toContain('"timeoutMs"');
  });
});

describe('completion gate in the agent loop', () => {
  function makeLoop(root: string, provider: LLMProvider, mode?: 'auto' | 'ask' | 'manual' | 'plan') {
    const registry = createDefaultRegistry();
    return new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(join(root, '.daedalus-tasks')),
      stopPolicy: { max_iterations: 12, max_errors: 5 },
      ...(mode ? { mode } : {}),
      executeTool: (call) => registry.execute(call, { workspaceRoot: root }),
    });
  }

  test('creation goal with zero changes is refused success (one repair turn, then no_files_created)', async () => {
    const root = temp('daedalus-gate-ws-');
    const seen: Message[][] = [];
    const provider = scriptedProvider([{ tool: 'list_dir', args: { path: '.' } }], { seen });
    const loop = makeLoop(root, provider);
    const state = await loop.run('create a config file for the app\ndone: config file exists');
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('no_files_created');
    // The refusal bought one repair turn: the model was asked again after
    // the first "done" claim instead of the run silently succeeding.
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  test('creation goal completed with a real write still succeeds', async () => {
    const root = temp('daedalus-gate-ok-');
    const provider = scriptedProvider([
      { tool: 'write_file', args: { path: 'config.json', content: '{}\n' } },
    ]);
    const state = await makeLoop(root, provider).run('create a config file for the app\ndone: config file exists');
    expect(state.status).toBe('done');
    expect(existsSync(join(root, 'config.json'))).toBe(true);
  });

  test('non-creation goals with zero changes keep today’s outcome', async () => {
    const root = temp('daedalus-gate-none-');
    writeFileSync(join(root, 'build.log'), 'compile: slow because of codegen\n');
    const provider = scriptedProvider([{ tool: 'read_file', args: { path: 'build.log' } }]);
    const state = await makeLoop(root, provider).run('investigate the slow build\ndone: read the build log');
    expect(state.status).toBe('done');
  });

  test('ask mode is exempt: answering a creation-shaped question is not a failed creation', async () => {
    const root = temp('daedalus-gate-ask-');
    writeFileSync(join(root, 'config.json'), '{}\n');
    const provider = scriptedProvider([{ tool: 'read_file', args: { path: 'config.json' } }]);
    const state = await makeLoop(root, provider, 'ask').run('create a summary of the config file\ndone: read the config file');
    expect(state.status).toBe('done');
  });

  test('scaffold goal whose marker never appears is refused, naming the marker', async () => {
    const root = temp('daedalus-gate-marker-');
    // The model hand-writes a stub package.json (no next dependency):
    // ledger non-empty, but the scaffold marker check must still refuse.
    const provider = scriptedProvider([
      { tool: 'create_dir', args: { path: 'jojo' } },
      { tool: 'write_file', args: { path: 'jojo/package.json', content: '{"name":"fake"}\n' } },
    ]);
    const spec = await interpretTask('di folder jojo itu buat project next js\ndone: project created', { repo_path: root });
    const state = await makeLoop(root, provider).run(spec);
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('no_files_created');
  });

  test('scaffold goal with a real generated marker passes', async () => {
    const root = temp('daedalus-gate-marker-ok-');
    const provider = scriptedProvider([
      { tool: 'create_dir', args: { path: 'jojo' } },
      { tool: 'write_file', args: { path: 'jojo/package.json', content: '{"name":"jojo","dependencies":{"next":"15.0.0"}}\n' } },
    ]);
    const spec = await interpretTask('di folder jojo itu buat project next js\ndone: project created', { repo_path: root });
    const state = await makeLoop(root, provider).run(spec);
    expect(state.status).toBe('done');
  });
});

describe('completion gate end to end (TaskRunner)', () => {
  test('incident regression: list-only provider on a nextjs goal ends refused-with-evidence, prompt carried create-next-app', async () => {
    const root = temp('daedalus-incident-ws-');
    const home = temp('daedalus-incident-home-');
    const seen: Message[][] = [];
    const provider = scriptedProvider(
      [
        { tool: 'list_dir', args: { path: '.' } },
        { tool: 'list_dir', args: { path: '.' } },
      ],
      { seen },
    );
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    const result = await runner.run({
      goal: 'di folder jojo itu buat project next js buat halaman website tentang biodata presiden putin',
    });
    expect(result.outcome).not.toBe('success');
    expect(result.report.outcome).not.toBe('success');
    expect(result.report.evidence.some((line) => line.startsWith('no files were created'))).toBe(true);
    expect(result.events.some((event) => event.type === 'RECOVERY_STARTED' && (event.payload as { reason?: string }).reason === 'no_files_created')).toBe(true);
    expect(existsSync(join(root, 'jojo'))).toBe(false);
    // The prompt the model received carried the playbook (preflight ran
    // against this machine's real node toolchain).
    const prompt = systemTextOf(seen[0]!);
    expect(prompt).toContain('## scaffold playbook');
    expect(prompt).toContain('create-next-app@latest jojo');
    expect(prompt).toContain('Toolchains on this machine:');
  });

  test('delegated creation that produces nothing is refused at the lineage level too', async () => {
    const root = temp('daedalus-gate-delegated-');
    const home = temp('daedalus-gate-delegated-home-');
    const provider: LLMProvider = {
      name: 'delegating',
      async chat(messages: Message[]) {
        const serialized = JSON.stringify(messages);
        if (serialized.includes('CHILD_BRIEF')) {
          return { message: { role: 'assistant' as const, content: 'done: looked around, nothing to do' } };
        }
        if (serialized.includes('spawn-marker') || serialized.includes('Tool result')) {
          return { message: { role: 'assistant' as const, content: 'done: delegated and finished' } };
        }
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [
              {
                id: 'call-spawn',
                type: 'function' as const,
                function: {
                  name: SPAWN_SUBAGENT_TOOL_NAME,
                  arguments: JSON.stringify({ description: 'child does nothing', goal: 'CHILD_BRIEF: create the report file' }),
                },
              },
            ],
          },
        };
      },
      async *stream() {
        yield { type: 'delta', content: '' };
      },
    };
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider,
      validator: passingValidator,
      approvalPolicy: 'auto',
      maxIterations: 12,
    });
    const result = await runner.run({ goal: 'create the report file for the team' });
    // Child created nothing, parent created nothing: not a success.
    expect(result.outcome).not.toBe('success');
    expect(result.report.evidence.some((line) => line.startsWith('no files were created'))).toBe(true);
  });
});

describe('skill index clamps (ContextManager)', () => {
  function contextState(workspace: string): TaskState {
    return {
      id: 'scaffold-ctx', goal: 'Say hi', repo_path: workspace, constraints: [], done_criteria: [], created_at: new Date().toISOString(),
      plan: { id: 'p', task_id: 'scaffold-ctx', steps: [], version: 1, status: 'active' }, steps: [], status: 'active',
    } as TaskState;
  }

  async function systemText(context: DefaultContextManager, workspace: string): Promise<string> {
    const messages = await context.buildMessages(contextState(workspace), []);
    const system = messages[0];
    return typeof system?.content === 'string' ? system.content : '';
  }

  const info = (name: string, description: string): SkillInfo => ({ name, description, source: '/x', origin: 'global' });

  test('per-entry description is hard-clamped', async () => {
    const workspace = temp('daedalus-skill-clamp-');
    const long = 'x'.repeat(500);
    const text = await systemText(new DefaultContextManager({ skills: [info('wordy', long)] }), workspace);
    expect(text).not.toContain(long);
    expect(text).toContain('- wordy: ');
    expect(text).toContain('…');
  });

  test('total index budget: names remain listed name-only past the budget', async () => {
    const workspace = temp('daedalus-skill-budget-');
    const skills = Array.from({ length: 40 }, (_, index) => info(`s${String(index).padStart(2, '0')}`, 'd'.repeat(200)));
    const text = await systemText(new DefaultContextManager({ skills }), workspace);
    // Every one of the first-40 names is still listed...
    for (const skill of skills) expect(text).toContain(skill.name);
    // ...but the DESCRIBED lines stay within the total budget.
    const described = text.split('\n').filter((line) => /^- s\d\d: /.test(line));
    const describedChars = described.reduce((sum, line) => sum + line.length + 1, 0);
    expect(described.length).toBeLessThan(40);
    expect(described.length).toBeGreaterThan(0);
    expect(describedChars).toBeLessThanOrEqual(MAX_SKILL_INDEX_CHARS);
    // And at least one skill fell back to a name-only line.
    expect(text).toMatch(/^- s\d\d \(global\)$/m);
  });
});

describe('consecutive provider timeouts', () => {
  test('two consecutive timeouts fail the turn as provider_timeout — no third send', async () => {
    const root = temp('daedalus-timeout-cap-');
    let calls = 0;
    const provider: LLMProvider = {
      name: 'always-slow',
      async chat() {
        calls++;
        throw new LLMTimeoutError('LLM request timed out after 180000ms');
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(join(root, '.daedalus-tasks')),
      stopPolicy: { max_iterations: 10, max_errors: 5 },
    });
    const state = await loop.run('Fix readme\ndone: docs updated');
    expect(calls).toBe(2);
    expect(state.status).toBe('failed');
    expect(state.last_error).toBe('provider_timeout');
  });

  test('a success between timeouts resets the streak', async () => {
    const root = temp('daedalus-timeout-reset-');
    let calls = 0;
    const registry = createDefaultRegistry();
    writeFileSync(join(root, 'README.md'), 'hi\n');
    const provider: LLMProvider = {
      name: 'flaky-slow',
      async chat() {
        calls++;
        if (calls === 1 || calls === 3) throw new LLMTimeoutError('LLM request timed out after 180000ms');
        if (calls === 2) {
          return {
            message: {
              role: 'assistant' as const,
              content: '',
              tool_calls: [{ id: 'call-ok', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
            },
          };
        }
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: 'call-write', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"summary.txt","content":"done\\n"}' } }],
          },
        };
      },
      async *stream() {},
    };
    const loop = new AgentLoop({
      provider,
      bus: new EventBus(),
      store: new TaskStore(join(root, '.daedalus-tasks')),
      stopPolicy: { max_iterations: 10, max_errors: 5 },
      executeTool: (call) => registry.execute(call, { workspaceRoot: root }),
    });
    const state = await loop.run('Fix readme\ndone: read the readme\ndone: write the summary');
    // timeout, tool success, timeout, tool success: never two timeouts in
    // a row, so the streak cap stays out of the way and the task completes.
    expect(state.status).toBe('done');
    expect(calls).toBe(4);
  });
});

describe('toolchain bootstrap (container / version-manager routes)', () => {
  const host = { workspaceRoot: '/home/user/ws', uidGid: '1000:1000' };
  const FORBIDDEN_PACKAGE_MANAGERS = /\bsudo\b|\bpacman\b|\bapt-get\b|\bbrew\s+install\b|\bapk\s+add\b|\bdnf\s+install\b|\byum\s+install\b/i;
  const nodeMissing: ToolchainProbe[] = [
    { tool: 'node', ok: false },
    { tool: 'npm', ok: false },
    { tool: 'npx', ok: false },
  ];
  const noBootstrap: ToolchainProbe[] = [
    { tool: 'docker', ok: false },
    { tool: 'mise', ok: false },
    { tool: 'fnm', ok: false },
    { tool: 'nvm', ok: false },
  ];

  test('bootstrap probe list is docker + the user-level version managers', () => {
    expect(BOOTSTRAP_PROBE_TOOLS).toEqual(['docker', 'mise', 'fnm', 'nvm']);
    expect(MISE_PACKAGE_BY_TOOL.node).toBe('node@22');
    expect(MISE_PACKAGE_BY_TOOL.npm).toBe('node@22');
    expect(MISE_PACKAGE_BY_TOOL.npx).toBe('node@22');
    expect(MISE_PACKAGE_BY_TOOL.flutter).toBe('flutter@stable');
  });

  test('bootstrap probes never throw — failures only narrow the playbook', async () => {
    const probes = await probeToolchains(BOOTSTRAP_PROBE_TOOLS, async (tool) => {
      throw new Error(`no ${tool} here`);
    });
    expect(probes).toEqual(BOOTSTRAP_PROBE_TOOLS.map((tool) => ({ tool, ok: false })));
  });

  test('docker route renders the same nextjs generator in the official node image', () => {
    const match = detectScaffoldRequest('di folder jojo itu buat project next js')!;
    expect(renderDockerGeneratorLine(match.recipe, match.targetDir, host)).toContain(
      'docker run --rm --user 1000:1000 -e HOME=/tmp -v /home/user/ws:/work -w /work node:22 npx -y create-next-app@latest jojo --yes --skip-install --disable-git',
    );
    const text = renderScaffoldPlaybook(match, [...nodeMissing, { tool: 'docker', ok: true, version: 'Docker version 27.0.0' }, ...noBootstrap.slice(1)], host);
    expect(text).toContain('CONTAINER ROUTE');
    expect(text).toContain('node:22');
    expect(text).toContain('node MISSING');
    expect(text).toContain('marker');
    expect(text).not.toContain('STOP: neither Docker');
    expect(text).not.toMatch(FORBIDDEN_PACKAGE_MANAGERS);
  });

  test('docker route uses the composer image for laravel and the flutter image for flutter', () => {
    const laravel = detectScaffoldRequest('project laravel baru di folder backend')!;
    const laravelLine = renderDockerGeneratorLine(laravel.recipe, laravel.targetDir, host);
    expect(laravelLine).toContain('composer:2');
    expect(laravelLine).toContain('composer create-project laravel/laravel backend --no-interaction --prefer-dist');

    const flutter = detectScaffoldRequest('setup a flutter app in the shop folder')!;
    const flutterLine = renderDockerGeneratorLine(flutter.recipe, flutter.targetDir, host);
    expect(flutterLine).toContain('cirruslabs/flutter:stable');
    expect(flutterLine).toContain('flutter create --project-name shop shop');
  });

  test('django container route installs Django inside python:3.12 before startproject', () => {
    const django = detectScaffoldRequest('buat project django di folder backend-api')!;
    const line = renderDockerGeneratorLine(django.recipe, django.targetDir, host);
    expect(line).toContain('python:3.12');
    expect(line).toContain('pip install --quiet django');
    expect(line).toContain('django-admin startproject backend_api backend-api');
    expect(line).not.toMatch(FORBIDDEN_PACKAGE_MANAGERS);
  });

  test('a partially missing toolchain still routes through docker', () => {
    const match = detectScaffoldRequest('create a vite app with react')!;
    const text = renderScaffoldPlaybook(
      match,
      [
        { tool: 'node', ok: true, version: 'v22.0.0' },
        { tool: 'npm', ok: false },
        { tool: 'docker', ok: true, version: 'Docker version 27.0.0' },
        ...noBootstrap.slice(1),
      ],
      host,
    );
    expect(text).toContain('docker run --rm');
    expect(text).toContain('npm MISSING');
  });

  test('mise route when docker is absent: user-level install lines, then the host generator', () => {
    const match = detectScaffoldRequest('di folder jojo itu buat project next js')!;
    const text = renderScaffoldPlaybook(match, [...nodeMissing, { tool: 'docker', ok: false }, { tool: 'mise', ok: true, version: '2024.5.0' }, ...noBootstrap.slice(2)], host);
    expect(text).toContain('VERSION-MANAGER ROUTE');
    expect(text).toContain('mise use --global node@22');
    expect(text).not.toContain('docker run');
    expect(text).not.toContain('STOP: neither Docker');
    expect(text).not.toMatch(FORBIDDEN_PACKAGE_MANAGERS);
  });

  test('fnm route covers the node family when only fnm is present', () => {
    const match = detectScaffoldRequest('create a vite app with react')!;
    const text = renderScaffoldPlaybook(
      match,
      [
        { tool: 'node', ok: false },
        { tool: 'npm', ok: false },
        { tool: 'docker', ok: false },
        { tool: 'mise', ok: false },
        { tool: 'fnm', ok: true, version: '1.37.0' },
        { tool: 'nvm', ok: false },
      ],
      host,
    );
    expect(text).toContain('fnm install 22');
    expect(text).not.toContain('mise use');
    expect(text).not.toMatch(FORBIDDEN_PACKAGE_MANAGERS);
  });

  test('neither route available: honest STOP naming both, never a package manager', () => {
    const match = detectScaffoldRequest('di folder jojo itu buat project next js')!;
    const text = renderScaffoldPlaybook(match, [...nodeMissing, ...noBootstrap], host);
    expect(text).toContain('STOP: neither Docker nor a user-level version manager (mise/fnm/nvm)');
    expect(text).toContain('never hand-write a fake Next.js skeleton');
    expect(text).not.toMatch(FORBIDDEN_PACKAGE_MANAGERS);
  });

  test('no rendered playbook ever instructs a system package manager', () => {
    const basket: string[] = [];
    const dockerProbes: ToolchainProbe[] = [{ tool: 'docker', ok: true, version: 'Docker version 27.0.0' }, ...noBootstrap.slice(1)];
    const miseProbes: ToolchainProbe[] = [{ tool: 'docker', ok: false }, { tool: 'mise', ok: true, version: '2024.5.0' }, ...noBootstrap.slice(2)];
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('buat project next js di folder jojo')!, [...nodeMissing, ...dockerProbes], host));
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('buat project next js di folder jojo')!, [...nodeMissing, ...miseProbes], host));
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('buat project next js di folder jojo')!, [...nodeMissing, ...noBootstrap], host));
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('project laravel baru di folder backend')!, [{ tool: 'php', ok: false }, { tool: 'composer', ok: false }, ...dockerProbes], host));
    basket.push(
      renderScaffoldPlaybook(detectScaffoldRequest('project laravel baru di folder backend')!, [{ tool: 'php', ok: true, version: 'PHP 8.3.0' }, { tool: 'composer', ok: false }, ...miseProbes], host),
    );
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('setup a flutter app in the shop folder')!, [{ tool: 'flutter', ok: false }, ...dockerProbes], host));
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('setup database mysql di folder infra')!, [{ tool: 'docker', ok: false }], host));
    basket.push(renderScaffoldPlaybook(detectScaffoldRequest('setup database mysql di folder infra')!, [{ tool: 'docker', ok: true, version: 'Docker version 27.0.0' }], host));
    for (const text of basket) expect(text).not.toMatch(FORBIDDEN_PACKAGE_MANAGERS);
  });

  test('install guidance offers the background job route with poll etiquette', () => {
    const match = detectScaffoldRequest('di folder jojo itu buat project next js')!;
    const text = renderScaffoldPlaybook(match, [
      { tool: 'node', ok: true, version: 'v22.0.0' },
      { tool: 'npm', ok: true, version: '10.0.0' },
      { tool: 'npx', ok: true, version: '10.0.0' },
    ]);
    expect(text).toContain('separate steps');
    expect(text).toContain('background: true');
    expect(text).toContain('command_status');
    expect(text).toContain('never poll in a tight loop');
  });
});

import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommandValidator,
  EventBus,
  TaskRunner,
  TaskStore,
  deriveTaskTargetDir,
  discoverTargetChecks,
  explicitTargetFolder,
  extractTargetDir,
  type Event,
  type LLMProvider,
  type Message,
  type UserQuestionInfo,
} from '../src/index.ts';

/**
 * Incident regressions for the task target guard (Farid's live PR #22
 * test, 2026-10-07): prompt 1 scaffolded a Vite project into `tesvite/`
 * but ended PARTIAL because validation ran the workspace ROOT's
 * monorepo scripts; prompt 2 then wrote the requested page into the
 * unrelated existing `ayid/index.html` (overwriting a landing page) and
 * still reported TASK SUCCESS — validation skipped the "outside the
 * project's packages" change and the completion gate only counted that
 * *something* changed. The declared target `tesvite/` was never
 * written. These tests pin the three fixes: the anchor derivation,
 * write confinement + gate v2, and target-scoped validation.
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function writeScript(dir: string, name: string, exitCode: 0 | 1): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), exitCode === 0 ? "console.log('check ok');\n" : "console.error('check failed');\nprocess.exit(1);\n", 'utf8');
}

const BELANJA_HTML = '<!doctype html>\n<title>BelanjaKita</title>\n<main>Landing page BelanjaKita</main>\n';
const PUTIN_HTML = '<!doctype html>\n<title>Biodata Vladimir Putin</title>\n<main>Biodata Presiden Putin</main>\n';

/**
 * The incident workspace, distilled: a monorepo-flavoured root whose
 * aggregate test/lint/build scripts FAIL loudly (so any root-script
 * invocation is visible as a failed check), the declared target
 * `tesvite/` with its own package.json (build + lint, NO test script),
 * and the unrelated `ayid/index.html` landing page.
 */
function incidentWorkspace(): string {
  const root = temp('daedalus-target-ws-');
  writeJson(join(root, 'package.json'), {
    name: 'ws-root',
    workspaces: ['tesvite'],
    scripts: { test: 'node root-check.mjs', lint: 'node root-check.mjs', build: 'node root-check.mjs' },
  });
  writeScript(root, 'root-check.mjs', 1);
  writeJson(join(root, 'tesvite', 'package.json'), {
    name: 'tesvite',
    scripts: { build: 'node ok.mjs', lint: 'node ok.mjs' },
  });
  writeScript(join(root, 'tesvite'), 'ok.mjs', 0);
  mkdirSync(join(root, 'ayid'), { recursive: true });
  writeFileSync(join(root, 'ayid', 'index.html'), BELANJA_HTML, 'utf8');
  return root;
}

type ScriptStep = { tool: string; args: unknown } | { text: string };

function scriptedProvider(script: ScriptStep[], captured?: Message[][]): LLMProvider {
  let index = 0;
  return {
    name: 'target-scripted',
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

/** The prompt-2 shape: a creation goal that names the existing target folder, no framework word. */
const TARGET_GOAL = 'buat halaman website tentang biodata presiden putin dari russia yang lengkap, simpan di folder tesvite\ndone: halaman biodata tampil dari project tesvite';

function finishedCall(events: Event[], tool: string): Array<{ result?: { status?: string; output?: string; meta?: Record<string, unknown> } }> {
  return events
    .filter((event) => event.type === 'TOOL_CALL_FINISHED')
    .map((event) => event.payload as { call?: { tool?: string }; result?: { status?: string; output?: string; meta?: Record<string, unknown> } })
    .filter((payload) => payload.call?.tool === tool)
    .map((payload) => ({ result: payload.result }));
}

describe('deriveTaskTargetDir — the anchor derivation', () => {
  test('a scaffold recipe anchors to its output dir before anything exists on disk', () => {
    const root = incidentWorkspace();
    expect(deriveTaskTargetDir({ goal: 'di folder jojo buat project next js buat halaman biodata presiden putin', workspaceRoot: root })).toBe('jojo');
    expect(deriveTaskTargetDir({ goal: 'buat project vite react di folder tesvite, buat halaman biodata putin, lalu build', workspaceRoot: root })).toBe('tesvite');
  });

  test('a named folder that exists anchors a non-scaffold creation task', () => {
    const root = incidentWorkspace();
    expect(deriveTaskTargetDir({ goal: TARGET_GOAL.replace('\ndone: halaman biodata tampil dari project tesvite', ''), workspaceRoot: root })).toBe('tesvite');
  });

  test('a named folder that neither exists nor was created by the task does not anchor (no guessing)', () => {
    const root = incidentWorkspace();
    expect(deriveTaskTargetDir({ goal: 'buat halaman html tentang putin, simpan di folder belumada', workspaceRoot: root })).toBeUndefined();
  });

  test('a named folder qualifies once the task has written into it (created by the task)', () => {
    const root = incidentWorkspace();
    expect(
      deriveTaskTargetDir({ goal: 'buat halaman html tentang putin, simpan di folder belumada', workspaceRoot: root, changedPaths: ['belumada/index.html'] }),
    ).toBe('belumada');
  });

  test('non-creation goals never anchor, even when they name an existing folder', () => {
    const root = incidentWorkspace();
    expect(deriveTaskTargetDir({ goal: 'perbaiki halaman login yang rusak di folder tesvite', workspaceRoot: root })).toBeUndefined();
    expect(deriveTaskTargetDir({ goal: 'halaman apa saja yang ada di folder tesvite?', workspaceRoot: root })).toBeUndefined();
  });

  test('explicitTargetFolder never guesses; extractTargetDir keeps its app fallback', () => {
    expect(explicitTargetFolder('simpan di folder tesvite')).toBe('tesvite');
    expect(explicitTargetFolder('buat halaman tentang putin')).toBeUndefined();
    expect(extractTargetDir('buat halaman tentang putin')).toBe('app');
  });
});

describe('target-scoped validation', () => {
  test('(c) build+lint run from tesvite; the missing test script is a skipped note; the failing root aggregate never runs', async () => {
    const root = incidentWorkspace();
    const discovery = discoverTargetChecks(root, 'tesvite');
    expect(discovery).toBeDefined();
    expect(discovery?.commands.map((command) => command.name)).toEqual(['lint', 'build']);
    expect(discovery?.commands.every((command) => command.cwd === 'tesvite')).toBe(true);
    expect(discovery?.note).toContain('checks scoped to target directory tesvite');
    expect(discovery?.note).toContain('skipped: "test" script is not defined in tesvite/package.json');

    // The root's scripts exit 1: had any root check run (e.g. a
    // --workspaces aggregate), it would show up here as a failure.
    const result = await new CommandValidator().validate({ workspaceRoot: root, targetDir: 'tesvite', changedFiles: ['tesvite/index.html'] });
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['lint', 'pass'],
      ['build', 'pass'],
    ]);
    expect(result.checks.every((check) => !check.cmd.includes('--workspaces'))).toBe(true);
    expect(result.checks.every((check) => !check.cmd.includes('root-check'))).toBe(true);
    expect(result.note).toContain('skipped: "test" script is not defined in tesvite/package.json');
  });

  test('(c) a test script the target DOES define runs from the target directory', async () => {
    const root = incidentWorkspace();
    writeJson(join(root, 'tesvite', 'package.json'), {
      name: 'tesvite',
      scripts: { test: 'node ok.mjs', build: 'node ok.mjs', lint: 'node ok.mjs' },
    });
    const result = await new CommandValidator().validate({ workspaceRoot: root, targetDir: 'tesvite' });
    expect(result.checks.map((check) => [check.name, check.status])).toEqual([
      ['test', 'pass'],
      ['lint', 'pass'],
      ['build', 'pass'],
    ]);
    expect(result.note).toBe('checks scoped to target directory tesvite');
  });

  test('a target without its own package.json does not take the anchor branch', async () => {
    const root = incidentWorkspace();
    expect(discoverTargetChecks(root, 'ayid')).toBeUndefined();
    expect(discoverTargetChecks(root, 'tidakada')).toBeUndefined();
    // Falls back to changeset discovery: ayid is outside every package.
    const result = await new CommandValidator().validate({ workspaceRoot: root, targetDir: 'ayid', changedFiles: ['ayid/index.html'] });
    expect(result.checks).toEqual([]);
    expect(result.note).toContain("outside the project's packages");
  });
});

describe('task target guard — incident regressions', () => {
  test('(a) a write to ayid/index.html is blocked when anchored to tesvite; the model gets the typed target error; success follows an inside write', async () => {
    const root = incidentWorkspace();
    const home = temp('daedalus-target-home-');
    const captured: Message[][] = [];
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider(
        [
          // The incident move: after exploring, write the page into the
          // unrelated existing landing page instead of the target.
          { tool: 'write_file', args: { path: 'ayid/index.html', content: PUTIN_HTML } },
          { tool: 'write_file', args: { path: 'tesvite/index.html', content: PUTIN_HTML } },
        ],
        captured,
      ),
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const result = await runner.run({ goal: TARGET_GOAL });
    expect(result.outcome).toBe('success');
    expect(result.state.target_dir).toBe('tesvite');
    expect(result.report.target_dir).toBe('tesvite');
    expect(result.report.evidence).toContain('target_dir: tesvite');
    // The unrelated landing page is byte-identical; the page landed inside the target.
    expect(readFileSync(join(root, 'ayid', 'index.html'), 'utf8')).toBe(BELANJA_HTML);
    expect(readFileSync(join(root, 'tesvite', 'index.html'), 'utf8')).toBe(PUTIN_HTML);
    // The blocked call produced a model-visible typed error naming the target…
    const writes = finishedCall(result.events, 'write_file');
    expect(writes[0]?.result?.status).toBe('denied');
    expect(writes[0]?.result?.meta?.reason).toBe('outside_task_target');
    expect(writes[0]?.result?.meta?.target_dir).toBe('tesvite');
    expect(writes[0]?.result?.output).toContain('declared target directory "tesvite/"');
    expect(writes[0]?.result?.output).toContain('ask_user');
    // …and it reached the model's next request verbatim.
    expect(JSON.stringify(captured)).toContain('Write blocked: this task has a declared target directory');
    // No file change was ever recorded for the outside file.
    expect(result.events.some((event) => event.type === 'FILE_CHANGED' && (event.payload as { path?: string }).path === 'ayid/index.html')).toBe(false);
    // Validation ran the target's own checks (its build+lint), not the root's.
    expect(result.validation?.checks.map((check) => [check.name, check.status])).toEqual([
      ['lint', 'pass'],
      ['build', 'pass'],
    ]);
    expect(result.report.evidence.some((line) => line.includes('checks scoped to target directory tesvite'))).toBe(true);
    expect(result.report.evidence.some((line) => line.includes('skipped: "test" script is not defined in tesvite/package.json'))).toBe(true);
    expect(result.report.metrics.checks_failed).toBe(0);
  });

  test('(a, scaffold variant) a vite prompt anchors to the recipe dir: outside write blocked, marker + inside page → success', async () => {
    const root = incidentWorkspace();
    // Give tesvite a real vite marker so the scaffold gate's disk check passes.
    writeJson(join(root, 'tesvite', 'package.json'), {
      name: 'tesvite',
      scripts: { build: 'node ok.mjs', lint: 'node ok.mjs' },
      devDependencies: { vite: '^6.0.0' },
    });
    const home = temp('daedalus-target-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      // The fixture pre-provides the generated tree (package.json with
      // the vite marker): the subject here is the anchor, not the
      // generator. Each successful call completes one of the recipe's
      // four plan steps (generate → install → write → build).
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'ayid/index.html', content: PUTIN_HTML } },
        { tool: 'write_file', args: { path: 'tesvite/index.html', content: PUTIN_HTML } },
        { tool: 'write_file', args: { path: 'tesvite/src/App.tsx', content: 'export default function App() { return <main>Biodata Presiden Putin</main>; }\n' } },
        { tool: 'write_file', args: { path: 'tesvite/src/main.tsx', content: 'import App from "./App";\nexport default App;\n' } },
        { tool: 'create_dir', args: { path: 'tesvite/public' } },
      ]),
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const result = await runner.run({ goal: 'buat project vite react di folder tesvite, buat halaman website tentang biodata presiden putin dari russia yang lengkap, lalu build' });
    expect(result.outcome).toBe('success');
    expect(result.report.target_dir).toBe('tesvite');
    expect(readFileSync(join(root, 'ayid', 'index.html'), 'utf8')).toBe(BELANJA_HTML);
    expect(existsSync(join(root, 'tesvite', 'src', 'App.tsx'))).toBe(true);
    const writes = finishedCall(result.events, 'write_file');
    expect(writes[0]?.result?.meta?.reason).toBe('outside_task_target');
    expect(result.report.evidence.some((line) => line.includes('checks scoped to target directory tesvite'))).toBe(true);
  });

  test('(b) an ask_user-approved exception lets the outside write land, but outside-only changes still cannot report success', async () => {
    const root = incidentWorkspace();
    const home = temp('daedalus-target-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        {
          tool: 'ask_user',
          args: {
            question: 'Target tugas ini folder tesvite, tapi halaman ini boleh saya tulis di ayid/index.html?',
            options: [{ label: 'Ya, tulis di ayid/index.html' }, { label: 'Tidak, tetap di tesvite' }],
          },
        },
        { tool: 'write_file', args: { path: 'ayid/index.html', content: PUTIN_HTML } },
      ]),
      approvalPolicy: 'auto',
      maxIterations: 10,
    });

    const result = await runner.run({
      goal: TARGET_GOAL,
      onEvent: (event) => {
        if (event.type !== 'QUESTION_REQUESTED') return;
        const info = (event.payload as { question?: UserQuestionInfo }).question;
        if (info) setTimeout(() => runner.questions.answer(info.id, 'Ya, tulis di ayid/index.html'), 5);
      },
    });

    // The exception was real: the sanctioned outside write landed.
    expect(readFileSync(join(root, 'ayid', 'index.html'), 'utf8')).toBe(PUTIN_HTML);
    expect(result.state.target_exceptions).toEqual(['ayid/index.html']);
    // …but a creation task whose only change is outside its target is
    // NOT a success: the loop refused completion (one repair turn,
    // then failed), and the report says why, naming both locations.
    expect(result.outcome).not.toBe('success');
    expect(result.outcome).toBe('failed');
    expect(result.state.last_error).toBe('no_files_created');
    expect(result.report.evidence).toContain('target_dir: tesvite');
    expect(result.report.evidence).toContain('target exception: ayid/index.html (approved via ask_user)');
    expect(result.report.evidence.some((line) => line.includes('no files were created inside the task target "tesvite/"'))).toBe(true);
    expect(result.report.evidence.some((line) => line.includes('ayid/index.html'))).toBe(true);
  });

  test('(d) an unanchored task keeps the old behavior: no folder named → no confinement, no target gate', async () => {
    const root = temp('daedalus-target-free-ws-');
    const home = temp('daedalus-target-home-');
    // The creation question gate is orthogonal to target confinement here.
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'write_file', args: { path: 'ayid/index.html', content: PUTIN_HTML } },
      ]),
      approvalPolicy: 'auto',
      questionGate: false,
      maxIterations: 10,
    });

    const result = await runner.run({ goal: 'buat halaman html tentang biodata presiden putin\ndone: file index.html selesai dibuat' });
    expect(result.outcome).toBe('success');
    expect(result.report.target_dir).toBeUndefined();
    expect(result.state.target_dir).toBeUndefined();
    expect(result.report.evidence.some((line) => line.startsWith('target_dir:'))).toBe(false);
    expect(readFileSync(join(root, 'ayid', 'index.html'), 'utf8')).toBe(PUTIN_HTML);
    expect(finishedCall(result.events, 'write_file')[0]?.result?.status).toBe('ok');
  });
});

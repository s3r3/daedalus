import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  EventBus,
  PLAN_DOCUMENT_FILES,
  TaskRunner,
  TaskStore,
  hasPlanDocument,
  isPlanDocumentChange,
  parseTasksDocument,
  questionGateAppliesToGoal,
  renderAssembledPlanDocuments,
  renderDecisionLines,
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

/** Same scripted-provider shape as plan-questions.test.ts. */
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

function finishedResults(events: Event[]) {
  return events
    .filter((event) => event.type === 'TOOL_CALL_FINISHED')
    .map((event) => (event.payload as { result?: { status?: string; output?: string; meta?: Record<string, unknown> } }).result ?? {});
}

function gateDenials(events: Event[]) {
  return finishedResults(events).filter((result) => result.meta?.reason === 'question_gate');
}

function answerQuestion(runner: TaskRunner, answers: Record<string, string>) {
  return (event: Event) => {
    if (event.type !== 'QUESTION_REQUESTED') return;
    const question = (event.payload as { question?: UserQuestionInfo }).question;
    if (!question) return;
    const answer = answers[question.question];
    if (answer !== undefined) setTimeout(() => runner.questions.answer(question.id, answer), 5);
  };
}

describe('creation question gate', () => {
  const packageJson = JSON.stringify({ name: 'app', scripts: { dev: 'vite' }, dependencies: { vite: '^6', react: '^19' } }, null, 2);

  test('an underspecified creation goal must ask before the first mutation, and the answers become constraints', async () => {
    const root = temp('daedalus-qgate-ws-');
    const home = temp('daedalus-qgate-home-');
    const captured: Message[][] = [];
    const provider = scriptedProvider(
      [
        // The model tries to build immediately — the gate must refuse this.
        { tool: 'create_dir', args: { path: 'app' } },
        // It asks instead; the user picks an option.
        {
          tool: 'ask_user',
          args: {
            question: 'Datanya disimpan di mana?',
            options: [
              { label: 'localStorage browser' },
              { label: 'Backend + database' },
              { label: 'Langsung buat saja' },
            ],
          },
        },
        { tool: 'create_dir', args: { path: 'app' } },
        { tool: 'write_file', args: { path: 'app/package.json', content: packageJson } },
        { tool: 'write_file', args: { path: 'app/index.html', content: '<h1>Kehadiran</h1>' } },
        { text: 'done: aplikasi kehadiran dibuat' },
      ],
      captured,
    );
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider,
      validator: passingValidator,
      questionGate: true,
      maxIterations: 12,
    });
    const result = await runner.run({
      goal: 'buat project vite tentang kehadiran mahasiswa',
      mode: 'auto',
      onEvent: answerQuestion(runner, { 'Datanya disimpan di mana?': 'localStorage browser' }),
    });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    // The first mutation was refused by the gate, before anything hit disk.
    const results = finishedResults(result.events);
    const firstCreate = results.find((entry) => entry.meta?.tool === 'create_dir');
    expect(firstCreate?.status).toBe('denied');
    expect(firstCreate?.meta?.reason).toBe('question_gate');
    expect(firstCreate?.output).toContain('ask_user');
    expect(firstCreate?.output).toContain('Langsung buat saja');
    expect(gateDenials(result.events)).toHaveLength(1);
    // The question was asked before the first successful mutation.
    const types = result.events.map((event) => event.type);
    const askedAt = types.indexOf('QUESTION_REQUESTED');
    expect(askedAt).toBeGreaterThan(-1);
    const firstOkMutation = results.findIndex((entry) => entry.status === 'ok' && entry.meta?.tool !== 'ask_user');
    expect(firstOkMutation).toBeGreaterThan(0);
    // The build went through with the answer pinned as a constraint: the
    // model request right after the answer already carries it.
    expect(existsSync(join(root, 'app/index.html'))).toBe(true);
    expect(result.state.clarifying_answers).toEqual([
      { question: 'Datanya disimpan di mana?', answer: 'localStorage browser' },
    ]);
    const afterAnswer = JSON.stringify(captured[2] ?? []);
    expect(afterAnswer).toContain('Clarifying answer');
    expect(afterAnswer).toContain('localStorage browser');
    // And the report names the decision in its evidence.
    expect(result.report?.evidence.some((line) => line === 'clarifying answer: Datanya disimpan di mana? → localStorage browser')).toBe(true);
  });

  test('the "Langsung buat saja" escape choice records the decision and builds immediately', async () => {
    const root = temp('daedalus-qgate-escape-ws-');
    const home = temp('daedalus-qgate-escape-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'app' } },
        {
          tool: 'ask_user',
          args: {
            question: 'Data kehadirannya mau disimpan di mana?',
            options: [{ label: 'localStorage browser' }, { label: 'Langsung buat saja' }],
          },
        },
        { tool: 'create_dir', args: { path: 'app' } },
        { tool: 'write_file', args: { path: 'app/package.json', content: packageJson } },
        { tool: 'write_file', args: { path: 'app/index.html', content: '<h1>Kehadiran</h1>' } },
        { text: 'done: aplikasi kehadiran dibuat' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 12,
    });
    const result = await runner.run({
      goal: 'buat project vite tentang kehadiran mahasiswa',
      mode: 'auto',
      onEvent: answerQuestion(runner, { 'Data kehadirannya mau disimpan di mana?': 'Langsung buat saja' }),
    });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(result.state.clarifying_answers).toEqual([
      { question: 'Data kehadirannya mau disimpan di mana?', answer: 'Langsung buat saja' },
    ]);
    expect(existsSync(join(root, 'app/index.html'))).toBe(true);
    expect(result.report?.evidence.some((line) => line.includes('clarifying answer:') && line.includes('Langsung buat saja'))).toBe(true);
  });

  test('a free-text "lainnya" answer is recorded too', async () => {
    const root = temp('daedalus-qgate-free-ws-');
    const home = temp('daedalus-qgate-free-home-');
    const captured: Message[][] = [];
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider(
        [
          { tool: 'create_dir', args: { path: 'app' } },
          {
            tool: 'ask_user',
            args: {
              question: 'Bentuk datanya seperti apa?',
              options: [{ label: 'Daftar kelas sederhana' }, { label: 'Langsung buat saja' }],
            },
          },
          { tool: 'create_dir', args: { path: 'app' } },
          { tool: 'write_file', args: { path: 'app/package.json', content: packageJson } },
          { tool: 'write_file', args: { path: 'app/index.html', content: '<h1>Kehadiran</h1>' } },
          { text: 'done: aplikasi kehadiran dibuat' },
        ],
        captured,
      ),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 12,
    });
    const result = await runner.run({
      goal: 'buat project vite tentang kehadiran mahasiswa',
      mode: 'auto',
      onEvent: (event) => {
        if (event.type !== 'QUESTION_REQUESTED') return;
        const question = (event.payload as { question?: UserQuestionInfo }).question;
        if (question) setTimeout(() => runner.questions.answer(question.id, 'per kelas ada sesi'), 5);
      },
    });

    expect(result.state.status).toBe('done');
    expect(result.state.clarifying_answers).toEqual([
      { question: 'Bentuk datanya seperti apa?', answer: 'per kelas ada sesi' },
    ]);
    expect(JSON.stringify(captured[2] ?? [])).toContain('per kelas ada sesi');
  });

  test('an unanswered question still lets the build proceed (timeout latch — no deadlock)', async () => {
    const root = temp('daedalus-qgate-timeout-ws-');
    const home = temp('daedalus-qgate-timeout-home-');
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
        { tool: 'write_file', args: { path: 'app/package.json', content: packageJson } },
        { tool: 'write_file', args: { path: 'app/index.html', content: '<h1>Kehadiran</h1>' } },
        { text: 'done: aplikasi kehadiran dibuat' },
      ]),
      validator: passingValidator,
      questionGate: true,
      questionTimeoutMs: 30,
      maxIterations: 12,
    });
    const result = await runner.run({ goal: 'buat project vite tentang kehadiran mahasiswa', mode: 'auto' });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(result.state.clarifying_answers ?? []).toEqual([]);
    expect(existsSync(join(root, 'app/index.html'))).toBe(true);
  });

  test('a fully named brief (folder, stack, features) is never gated', async () => {
    const root = temp('daedalus-qgate-specified-ws-');
    const home = temp('daedalus-qgate-specified-home-');
    const runner2 = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'tesvite' } },
        { tool: 'write_file', args: { path: 'tesvite/package.json', content: packageJson } },
        { tool: 'write_file', args: { path: 'tesvite/index.html', content: '<h1>Biodata</h1>' } },
        { tool: 'write_file', args: { path: 'tesvite/src/main.jsx', content: "import '../index.html';" } },
        { text: 'done: project dibuat' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 8,
    });
    const result = await runner2.run({
      goal: 'buat project vite react di folder tesvite, buat halaman biodata putin yang lengkap',
      mode: 'auto',
    });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(gateDenials(result.events)).toHaveLength(0);
    expect(result.events.some((event) => event.type === 'QUESTION_REQUESTED')).toBe(false);
    expect(result.state.clarifying_answers ?? []).toEqual([]);
  });

  test('non-creation goals are never gated: an edit mutates on the first action', async () => {
    const root = temp('daedalus-qgate-edit-ws-');
    const home = temp('daedalus-qgate-edit-home-');
    writeFileSync(join(root, 'index.html'), '<html><body><h1>Laporan</h1></body></html>', 'utf8');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'edit_file', args: { path: 'index.html', old_string: '<h1>Laporan</h1>', new_string: '<label>Tanggal <input type="date"></label><h1>Laporan</h1>' } },
        { text: 'done: pemilih tanggal ditambahkan' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 8,
    });
    const result = await runner.run({ goal: 'tambahkan pemilih tanggal di halaman laporan\ndone: pemilih tanggal tampil di halaman laporan', mode: 'auto' });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(gateDenials(result.events)).toHaveLength(0);
    const first = finishedResults(result.events)[0];
    expect(first?.status).toBe('ok');
    expect(first?.meta?.tool).toBe('edit_file');
  });

  test('questionGate=false disables the gate entirely', async () => {
    const root = temp('daedalus-qgate-off-ws-');
    const home = temp('daedalus-qgate-off-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: 'app' } },
        { tool: 'write_file', args: { path: 'app/package.json', content: packageJson } },
        { tool: 'write_file', args: { path: 'app/index.html', content: '<h1>Kehadiran</h1>' } },
        { tool: 'write_file', args: { path: 'app/src/main.jsx', content: "import '../index.html';" } },
        { text: 'done: aplikasi kehadiran dibuat' },
      ]),
      validator: passingValidator,
      questionGate: false,
      maxIterations: 8,
    });
    const result = await runner.run({ goal: 'buat project vite tentang kehadiran mahasiswa', mode: 'auto' });

    expect(result.state.status).toBe('done');
    expect(result.outcome).toBe('success');
    expect(gateDenials(result.events)).toHaveLength(0);
  });
});

describe('questionGateAppliesToGoal (classification)', () => {
  test('bare briefs gate; named or non-creation shapes do not', () => {
    // The incident shape: stack + topic only — nothing about data, roles, look.
    expect(questionGateAppliesToGoal('buat project vite tentang kehadiran mahasiswa')).toBe(true);
    expect(questionGateAppliesToGoal('buat landing page saja', [])).toBe(true);
    // Named folder or done criteria make it specified enough.
    expect(questionGateAppliesToGoal('buat project vite react di folder tesvite, buat halaman biodata putin yang lengkap')).toBe(false);
    expect(questionGateAppliesToGoal('buatkan direktori dengan nama baru terserah untuk file pengetesan', ['Folder created'])).toBe(false);
    expect(questionGateAppliesToGoal('buat project vite tentang kehadiran mahasiswa', ['Data tersimpan di localStorage'])).toBe(false);
    // Non-creation and question-shaped prompts never gate.
    expect(questionGateAppliesToGoal('tambahkan pemilih tanggal di halaman laporan')).toBe(false);
    expect(questionGateAppliesToGoal('kenapa halaman login error?')).toBe(false);
    expect(questionGateAppliesToGoal('apakah vite mendukung TypeScript?')).toBe(false);
  });
});

describe('plan document set', () => {
  const planDir = '.daedalus/plans/kehadiran-mahasiswa';

  const planContent = [
    '# Plan — Aplikasi Kehadiran',
    '',
    '## Goal',
    'Aplikasi kehadiran mahasiswa di folder app.',
    '',
    '## Approach',
    'File statis sederhana dengan localStorage.',
    '',
    '## Steps',
    '1. Scaffold halaman daftar hadir (files: app/index.html)',
    '2. Menulis rekap kehadiran (files: app/rekap.html)',
    '',
    '## Acceptance criteria',
    '- Daftar hadir tampil',
  ].join('\n');

  const prdContent = [
    '# PRD — Aplikasi Kehadiran',
    '',
    '| Tanggal & versi | 2026-10-07 · v0.1 |',
    '',
    '## Masalah & Pengguna',
    'Dosen mencatat kehadiran mahasiswa secara manual di kertas.',
    '',
    '## Pengguna & Peran',
    '- Dosen — pengguna utama.',
    '',
    '## Fitur',
    '- F1: halaman daftar hadir kelas',
    '- F2: rekap kehadiran',
    '',
    '## Kriteria Sukses',
    '- Daftar hadir bisa dibuka di browser',
  ].join('\n');

  const tasksContent = [
    '# Tasks',
    '',
    '- [ ] Scaffold halaman daftar hadir (files: app/index.html)',
    '- [ ] Menulis rekap kehadiran (files: app/rekap.html)',
    '- [ ] Memoles tampilan halaman (files: app/index.html)',
    '',
    'Validated by: `npm run build` selesai.',
  ].join('\n');

  test('plan mode writes the full five-document set and PLAN_CREATED names all five', async () => {
    const root = temp('daedalus-planset-ws-');
    const home = temp('daedalus-planset-home-');
    const runner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        {
          tool: 'ask_user',
          args: {
            question: 'Data kehadirannya disimpan di mana?',
            options: [{ label: 'localStorage browser' }, { label: 'Backend + database' }],
          },
        },
        { tool: 'create_dir', args: { path: planDir } },
        { tool: 'write_file', args: { path: `${planDir}/PRD.md`, content: prdContent } },
        { tool: 'write_file', args: { path: `${planDir}/architecture.md`, content: '# Architecture\n\n## Runtime Shape\nStatic page, no server.\n' } },
        { tool: 'write_file', args: { path: `${planDir}/design.md`, content: '# Design\n\n## Brand\nPolos dan rapi.\n' } },
        { tool: 'write_file', args: { path: `${planDir}/plan.md`, content: planContent } },
        { tool: 'write_file', args: { path: `${planDir}/tasks.md`, content: tasksContent } },
        { text: 'done: dokumen rencana lengkap ditulis' },
      ]),
      validator: passingValidator,
      questionGate: true,
      maxIterations: 12,
    });
    const result = await runner.run({
      goal: 'rencanakan website kehadiran mahasiswa\ndone: PRD.md ditulis\ndone: architecture.md ditulis\ndone: design.md ditulis\ndone: plan.md ditulis\ndone: tasks.md ditulis\ndone: pratinjau dokumen selesai',
      mode: 'plan',
      onEvent: answerQuestion(runner, { 'Data kehadirannya disimpan di mana?': 'localStorage browser' }),
    });

    expect(result.state.status).toBe('done');
    for (const name of PLAN_DOCUMENT_FILES) {
      expect(existsSync(join(root, planDir, name)), name).toBe(true);
    }
    const closing = [...result.events].reverse().find((event) => event.type === 'PLAN_CREATED');
    expect((closing?.payload as { documents?: string[] }).documents).toEqual([
      `${planDir}/plan.md`,
      `${planDir}/PRD.md`,
      `${planDir}/architecture.md`,
      `${planDir}/design.md`,
      `${planDir}/tasks.md`,
    ]);
    // The model's own documents, never harness-assembled ones.
    const assembled = result.report?.evidence.some((line) => line.includes('assembled by the harness')) ?? false;
    expect(assembled).toBe(false);
    // The document set is "written" for the loop's plan guarantee.
    expect(hasPlanDocument(PLAN_DOCUMENT_FILES.map((name) => `${planDir}/${name}`), 'plan.md')).toBe(true);
    expect(isPlanDocumentChange(`${planDir}/design.md`)).toBe(true);
    expect(isPlanDocumentChange('src/index.ts')).toBe(false);
  });

  test('tasks.md parses into steps: checkboxes win, plain lists stay honest', () => {
    expect(parseTasksDocument(tasksContent)).toEqual([
      'Scaffold halaman daftar hadir (files: app/index.html)',
      'Menulis rekap kehadiran (files: app/rekap.html)',
      'Memoles tampilan halaman (files: app/index.html)',
    ]);
    expect(parseTasksDocument('# Plan\n\n1. Pertama\n2. Kedua\n\nValidated by: `npm run build`\n')).toEqual(['Pertama', 'Kedua']);
    expect(parseTasksDocument('# Kosong\n\nTidak ada daftar.\n')).toEqual([]);
  });

  test('the harness assembles an honest five-document skeleton when the model wrote nothing', () => {
    const docs = renderAssembledPlanDocuments({
      goal: 'rencanakan website sekolah',
      plan: undefined,
      decisions: [{ question: 'Data disimpan di mana?', answer: 'localStorage', outcome: 'answered' }],
    });
    expect(docs.map((doc) => doc.name)).toEqual(PLAN_DOCUMENT_FILES);
    for (const doc of docs) expect(doc.content).toContain('Assembled by the Daedalus harness');
    const prd = docs.find((doc) => doc.name === 'PRD.md');
    expect(prd?.content).toContain('localStorage');
    expect(renderDecisionLines([{ question: 'Q', answer: 'A', outcome: 'answered' }]).join(' ')).toContain('Q → A');
  });

  test('execution pins the approved PRD + tasks into the first request and takes tasks.md as the step-lock', async () => {
    const root = temp('daedalus-exec-ws-');
    const home = temp('daedalus-exec-home-');

    // Phase 1: a plan-mode task the user "approved" (Approve & Execute
    // path): it wrote the five documents with distinctive content.
    const plannerRunner = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider([
        { tool: 'create_dir', args: { path: planDir } },
        { tool: 'write_file', args: { path: `${planDir}/PRD.md`, content: prdContent } },
        { tool: 'write_file', args: { path: `${planDir}/architecture.md`, content: '# Architecture\n\nStatic page.\n' } },
        { tool: 'write_file', args: { path: `${planDir}/design.md`, content: '# Design\n\nMinimal.\n' } },
        { tool: 'write_file', args: { path: `${planDir}/plan.md`, content: planContent } },
        { tool: 'write_file', args: { path: `${planDir}/tasks.md`, content: tasksContent } },
        { text: 'done: dokumen rencana ditulis' },
      ]),
      validator: passingValidator,
      maxIterations: 12,
    });
    const planned = await plannerRunner.run({
      goal: 'rencanakan website kehadiran mahasiswa\ndone: PRD.md ditulis\ndone: architecture.md ditulis\ndone: design.md ditulis\ndone: plan.md ditulis\ndone: tasks.md ditulis\ndone: pratinjau dokumen selesai',
      mode: 'plan',
    });
    expect(planned.state.status).toBe('done');

    // Phase 2: the follow-up executes it. The provider fulfils only the
    // FIRST tasks.md item and finishes — with gate-v1 semantics the
    // unaddressed items do not force partial (documented proposal), and
    // the follow-up is not question-gated (plan_task_id skip).
    const captured: Message[][] = [];
    const executor = new TaskRunner({
      workspaceRoot: root,
      store: new TaskStore(home),
      bus: new EventBus(),
      provider: scriptedProvider(
        [
          { tool: 'write_file', args: { path: 'index.html', content: '<h1>Daftar hadir</h1>' } },
          { tool: 'run_command', args: { command: 'echo', args: ['langkah-2-ditinjau'] } },
          { tool: 'run_command', args: { command: 'echo', args: ['langkah-3-ditinjau'] } },
          { text: 'done: halaman daftar hadir selesai' },
        ],
        captured,
      ),
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

    expect(executed.state.status).toBe('done');
    expect(executed.outcome).toBe('success');
    expect(executed.state.plan_task_id).toBe(planned.state.id);
    // The FIRST model request already carries the approved documents.
    const firstRequest = JSON.stringify(captured[0] ?? []);
    expect(firstRequest).toContain('Approved plan documents from plan task');
    expect(firstRequest).toContain('F1: halaman daftar hadir kelas');
    expect(firstRequest).toContain('Scaffold halaman daftar hadir (files: app/index.html)');
    // The step-lock: the executor's checklist IS the tasks.md list.
    expect(executed.state.plan.steps.map((step) => step.intent)).toEqual(parseTasksDocument(tasksContent));
    // Follow-ups are never question-gated, and no question was asked.
    expect(gateDenials(executed.events)).toHaveLength(0);
    expect(executed.events.some((event) => event.type === 'QUESTION_REQUESTED')).toBe(false);
    expect(executed.state.clarifying_answers ?? []).toEqual([]);
    // Gate-v1 pin: one unaddressed tasks.md item still ends success
    // (coverage gate documented as proposed, not implemented here).
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('Daftar hadir');
  });
});

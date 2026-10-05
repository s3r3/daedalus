import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CommandValidator,
  ProviderRegistryStore,
  TaskRunner,
  TaskStore,
  loadSettings,
  seedProviderFromSettings,
  type Event,
  type LLMProvider,
  type ModelStrategy,
  type Settings,
  type ValidationCommand,
  type Validator,
} from '../../core/src/index.ts';

export type EvaluationMode = 'deterministic' | 'live';
export type { ModelStrategy };
export type TaskCategory = 'bug_fix' | 'feature_addition' | 'refactor';

export interface DeterministicStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface EvaluationTask {
  id: string;
  category: TaskCategory;
  title: string;
  goal: string;
  doneCriteria: string[];
  setupFiles: Record<string, string>;
  validationCommands: ValidationCommand[];
  deterministicScript: DeterministicStep[];
}

export interface EvaluationConfig {
  mode: EvaluationMode;
  providerName: string;
  providerId?: string;
  model?: string;
  models?: string[];
  modelStrategy?: ModelStrategy;
  seed: number;
  temperature: number;
  maxIterations: number;
  maxErrors: number;
}

export interface ValidationEvidence {
  name: string;
  cmd: string;
  status: string;
  exit_code: number | null;
  summary: string;
}

export interface EvaluationRunRecord {
  run_id: string;
  task_id: string;
  title: string;
  category: TaskCategory;
  mode: EvaluationMode;
  outcome: string;
  state_status: string;
  last_error?: string;
  failure_taxonomy: string;
  turns: number;
  iterations: number;
  tool_calls: number;
  tool_calls_by_name: Record<string, number>;
  wall_clock_ms: number;
  retries: number;
  recovery_events: number;
  replans: number;
  approvals: number;
  events: number;
  files_changed: number;
  commands: number;
  validation: ValidationEvidence[];
  checks_passed: number;
  checks_failed: number;
  final_diff: string;
  provider: { name: string; id?: string; model?: string; models?: string[]; modelStrategy?: ModelStrategy };
  config: EvaluationConfig;
  workspace: string;
  event_log: string;
  started_at: string;
  finished_at: string;
}

export interface RunEvaluationOptions {
  mode: EvaluationMode;
  outputRoot: string;
  taskIds?: string[];
  category?: TaskCategory;
  limit?: number;
  providerId?: string;
  model?: string;
  models?: string[];
  modelStrategy?: ModelStrategy;
  seed?: number;
  tasksFile?: string;
}

const DEFAULT_TASKS_FILE = new URL('../tasks/tasks.json', import.meta.url);

export async function loadEvaluationTasks(tasksFile?: string): Promise<EvaluationTask[]> {
  const raw = tasksFile ? await readFile(tasksFile, 'utf8') : await readFile(DEFAULT_TASKS_FILE, 'utf8');
  const parsed = JSON.parse(raw) as EvaluationTask[];
  validateTaskSuite(parsed);
  return parsed;
}

export function validateTaskSuite(tasks: EvaluationTask[]): void {
  if (!Array.isArray(tasks) || tasks.length !== 12) throw new Error(`evaluation suite must contain exactly 12 tasks, got ${Array.isArray(tasks) ? tasks.length : 'non-array'}`);
  const ids = new Set<string>();
  const counts: Record<TaskCategory, number> = { bug_fix: 0, feature_addition: 0, refactor: 0 };
  for (const task of tasks) {
    if (!task.id || ids.has(task.id)) throw new Error(`duplicate or missing task id: ${task.id}`);
    ids.add(task.id);
    if (!(task.category in counts)) throw new Error(`task ${task.id} has unknown category ${task.category}`);
    counts[task.category]++;
    if (!task.goal || task.doneCriteria.length === 0) throw new Error(`task ${task.id} needs a goal and done criteria`);
    if (task.doneCriteria.length !== task.deterministicScript.length) {
      throw new Error(`task ${task.id} deterministic script length (${task.deterministicScript.length}) must equal done criteria (${task.doneCriteria.length}) so scripted completion cannot spin`);
    }
    if (task.validationCommands.length === 0) throw new Error(`task ${task.id} needs validation commands`);
    for (const path of Object.keys(task.setupFiles)) assertSafeRelative(path, task.id);
  }
  for (const [category, count] of Object.entries(counts)) {
    if (count !== 4) throw new Error(`evaluation suite needs exactly 4 ${category} tasks, got ${count}`);
  }
}

function assertSafeRelative(path: string, taskId: string): void {
  if (path.startsWith('/') || path.split(/[\\/]+/).includes('..')) throw new Error(`task ${taskId} has unsafe setup path: ${path}`);
}

export function selectTasks(tasks: EvaluationTask[], options: Pick<RunEvaluationOptions, 'taskIds' | 'category' | 'limit'>): EvaluationTask[] {
  let selected = tasks;
  if (options.category) selected = selected.filter((task) => task.category === options.category);
  if (options.taskIds && options.taskIds.length > 0) {
    const wanted = new Set(options.taskIds);
    selected = selected.filter((task) => wanted.has(task.id));
    const found = new Set(selected.map((task) => task.id));
    for (const id of wanted) if (!found.has(id)) throw new Error(`unknown evaluation task id: ${id}`);
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);
  if (selected.length === 0) throw new Error('no evaluation tasks selected');
  return selected;
}

export async function createFixture(task: EvaluationTask, workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const root = resolve(workspace);
  for (const [path, content] of Object.entries(task.setupFiles)) {
    assertSafeRelative(path, task.id);
    const absolute = resolve(root, path);
    if (absolute !== root && !absolute.startsWith(root + sep)) throw new Error(`fixture path escapes workspace: ${path}`);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
}

class DeterministicProvider implements LLMProvider {
  readonly name = 'deterministic-scripted';
  #index = 0;
  readonly #script: DeterministicStep[];

  constructor(script: DeterministicStep[]) {
    this.#script = script;
  }

  async chat(): Promise<{ message: { role: 'assistant'; content: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> } }> {
    const step = this.#script[this.#index++];
    if (!step) return { message: { role: 'assistant', content: 'done: deterministic script complete' } };
    return {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: `eval-call-${this.#index}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
      },
    };
  }

  async *stream(): AsyncIterable<{ type: 'delta'; content: string }> {
    yield { type: 'delta', content: '' };
  }
}

export function goalForTask(task: EvaluationTask): string {
  return [task.goal, ...task.doneCriteria.map((criterion) => `done: ${criterion}`)].join('\n');
}

function countEvents(events: Event[], type: Event['type']): number {
  return events.filter((event) => event.type === type).length;
}

function toolCounts(events: Event[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== 'TOOL_CALL_STARTED') continue;
    const payload = event.payload as { call?: { tool?: string } };
    const tool = payload.call?.tool ?? 'unknown';
    counts[tool] = (counts[tool] ?? 0) + 1;
  }
  return counts;
}

export function classifyFailure(record: Pick<EvaluationRunRecord, 'outcome' | 'state_status' | 'last_error' | 'validation'> & { events?: Event[] }): string {
  if (record.outcome === 'success') return 'none';
  const lastError = record.last_error ?? '';
  if (lastError.includes('validation') || record.validation.some((check) => check.status !== 'pass')) return 'validation_failed';
  if (lastError.includes('max_iterations')) return 'budget_exceeded';
  if (lastError.includes('max_errors')) return 'error_budget_exceeded';
  if (lastError.includes('no_progress')) return 'no_progress';
  if (lastError.includes('invalid_action')) return 'invalid_action';
  if (lastError.includes('aborted')) return 'cancelled';
  if (record.events?.some((event) => event.type === 'MODEL_REQUEST_FAILED')) return 'provider_error';
  if (record.state_status === 'runner_error') return 'runner_error';
  return 'agent_failed';
}

function settingsForRun(base: Settings, home: string): Settings {
  return { ...base, daedalusHome: home };
}

async function makeRunner(options: {
  mode: EvaluationMode;
  task: EvaluationTask;
  workspace: string;
  home: string;
  config: EvaluationConfig;
  providerId?: string;
  model?: string;
  models?: string[];
  modelStrategy?: ModelStrategy;
}): Promise<{ runner: TaskRunner; providerInfo: { name: string; id?: string; model?: string; models?: string[]; modelStrategy?: ModelStrategy } }> {
  const baseSettings = loadSettings();
  const settings = settingsForRun(baseSettings, options.home);
  const commandValidator = new CommandValidator();
  const validator: Validator = {
    async validate(validateOptions) {
      return commandValidator.validate({ ...validateOptions, commands: options.task.validationCommands });
    },
  };

  if (options.mode === 'deterministic') {
    const provider = new DeterministicProvider(options.task.deterministicScript);
    return {
      runner: new TaskRunner({
        settings,
        workspaceRoot: options.workspace,
        provider,
        store: new TaskStore(options.home),
        validator,
        approvalPolicy: 'auto',
        maxIterations: options.config.maxIterations,
      }),
      providerInfo: { name: provider.name, model: 'scripted' },
    };
  }

  const registryStore = new ProviderRegistryStore(baseSettings.daedalusHome);
  await registryStore.load(seedProviderFromSettings(baseSettings));
  const providerId = options.providerId ?? options.config.providerId;
  const selected = providerId ? registryStore.registry.get(providerId) : registryStore.registry.listInternal().find((provider) => provider.enabled);
  const models = options.models ?? options.config.models ?? (baseSettings.llm.models.length > 1 ? baseSettings.llm.models : undefined);
  const modelStrategy = options.modelStrategy ?? options.config.modelStrategy ?? baseSettings.llm.modelStrategy;
  const model = options.model ?? options.config.model ?? (models && models.length > 0 ? models[0] : undefined) ?? selected?.defaultModel ?? selected?.models[0] ?? baseSettings.llm.model;
  return {
    runner: new TaskRunner({
      settings,
      workspaceRoot: options.workspace,
      providerRegistry: registryStore.registry,
      providerId,
      model,
      models,
      modelStrategy,
      store: new TaskStore(options.home),
      validator,
      approvalPolicy: 'auto',
      maxIterations: options.config.maxIterations,
    }),
    providerInfo: { name: selected ? `provider-registry:${selected.id}` : 'settings-openai-compatible', id: providerId ?? selected?.id, model, models, modelStrategy: models && models.length > 1 ? modelStrategy : undefined },
  };
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<{ manifest: unknown; records: EvaluationRunRecord[]; outputRoot: string }> {
  const tasks = selectTasks(await loadEvaluationTasks(options.tasksFile), options);
  const outputRoot = resolve(options.outputRoot);
  const runsDir = join(outputRoot, 'runs');
  const workspacesDir = join(outputRoot, 'workspaces');
  const home = join(outputRoot, 'daedalus-home');
  await mkdir(runsDir, { recursive: true });
  await mkdir(workspacesDir, { recursive: true });
  await mkdir(home, { recursive: true });

  const config: EvaluationConfig = {
    mode: options.mode,
    providerName: options.mode === 'deterministic' ? 'deterministic-scripted' : 'configured-live-provider',
    providerId: options.providerId,
    model: options.model,
    models: options.models,
    modelStrategy: options.modelStrategy,
    seed: options.seed ?? 42,
    temperature: 0,
    maxIterations: 20,
    maxErrors: 3,
  };

  const manifest = {
    schema_version: 1,
    kind: 'daedalus-evaluation-dataset',
    mode: options.mode,
    label: options.mode === 'deterministic' ? 'Deterministic harness validation (scripted provider; not a live model evaluation)' : 'Live provider evaluation',
    generated_at: new Date().toISOString(),
    node: process.version,
    config,
    selected_tasks: tasks.map((task) => task.id),
    caveat: options.mode === 'deterministic'
      ? 'These runs validate the evaluation harness and Daedalus loop with a scripted provider. They must not be reported as live LLM performance.'
      : 'These runs use the configured live provider. Provider nondeterminism may still apply.',
  };
  await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const records: EvaluationRunRecord[] = [];
  for (const task of tasks) {
    const workspace = join(workspacesDir, task.id);
    await createFixture(task, workspace);
    const runId = `eval-${options.mode}-${task.id}`;
    const startedAt = new Date();
    const start = performance.now();
    let record: EvaluationRunRecord;

    try {
      const { runner, providerInfo } = await makeRunner({ mode: options.mode, task, workspace, home, config, providerId: options.providerId, model: options.model, models: options.models, modelStrategy: options.modelStrategy });
      const result = await runner.run({
        goal: goalForTask(task),
        taskId: runId,
        mode: 'auto',
        autoApprove: true,
        providerId: providerInfo.id,
        model: providerInfo.model,
        models: providerInfo.models,
        modelStrategy: providerInfo.modelStrategy,
        maxIterations: config.maxIterations,
        maxErrors: config.maxErrors,
      });
      const wall = Math.round(performance.now() - start);
      const validation: ValidationEvidence[] = (result.validation?.checks ?? []).map((check) => ({
        name: check.name,
        cmd: check.cmd,
        status: check.status,
        exit_code: check.exit_code,
        summary: check.summary,
      }));
      const eventsFile = join(runsDir, `${task.id}.events.jsonl`);
      await writeFile(eventsFile, result.events.map((event) => JSON.stringify(event)).join('\n') + (result.events.length ? '\n' : ''), 'utf8');
      const partial: Omit<EvaluationRunRecord, 'failure_taxonomy'> & { eventsForTaxonomy?: Event[] } = {
        run_id: runId,
        task_id: task.id,
        title: task.title,
        category: task.category,
        mode: options.mode,
        outcome: result.outcome,
        state_status: result.state.status,
        last_error: result.state.last_error,
        turns: result.state.turns ?? countEvents(result.events, 'MODEL_REQUEST_STARTED'),
        iterations: countEvents(result.events, 'MODEL_REQUEST_STARTED'),
        tool_calls: countEvents(result.events, 'TOOL_CALL_STARTED'),
        tool_calls_by_name: toolCounts(result.events),
        wall_clock_ms: wall,
        retries: countEvents(result.events, 'RECOVERY_STARTED'),
        recovery_events: countEvents(result.events, 'RECOVERY_STARTED') + countEvents(result.events, 'REPLAN_CREATED'),
        replans: countEvents(result.events, 'REPLAN_CREATED'),
        approvals: countEvents(result.events, 'APPROVAL_REQUESTED'),
        events: result.events.length,
        files_changed: countEvents(result.events, 'FILE_CHANGED'),
        commands: countEvents(result.events, 'COMMAND_FINISHED'),
        validation,
        checks_passed: validation.filter((check) => check.status === 'pass').length,
        checks_failed: validation.filter((check) => check.status !== 'pass').length,
        final_diff: result.report.diff,
        provider: providerInfo,
        config,
        workspace,
        event_log: relative(outputRoot, eventsFile),
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
        eventsForTaxonomy: result.events,
      };
      record = { ...partial, failure_taxonomy: classifyFailure({ outcome: partial.outcome, state_status: partial.state_status, last_error: partial.last_error, validation, events: result.events }) };
      delete (record as unknown as Record<string, unknown>).eventsForTaxonomy;
    } catch (error) {
      const wall = Math.round(performance.now() - start);
      const eventsFile = join(runsDir, `${task.id}.events.jsonl`);
      await writeFile(eventsFile, '', 'utf8');
      record = {
        run_id: runId,
        task_id: task.id,
        title: task.title,
        category: task.category,
        mode: options.mode,
        outcome: 'failed',
        state_status: 'runner_error',
        last_error: error instanceof Error ? error.message : String(error),
        failure_taxonomy: 'runner_error',
        turns: 0,
        iterations: 0,
        tool_calls: 0,
        tool_calls_by_name: {},
        wall_clock_ms: wall,
        retries: 0,
        recovery_events: 0,
        replans: 0,
        approvals: 0,
        events: 0,
        files_changed: 0,
        commands: 0,
        validation: [],
        checks_passed: 0,
        checks_failed: 0,
        final_diff: '',
        provider: { name: config.providerName, id: options.providerId, model: options.model },
        config,
        workspace,
        event_log: relative(outputRoot, eventsFile),
        started_at: startedAt.toISOString(),
        finished_at: new Date().toISOString(),
      };
    }

    records.push(record);
    await writeFile(join(runsDir, `${task.id}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
  }

  await writeDataset(outputRoot, manifest, records);
  return { manifest, records, outputRoot };
}

export async function writeDataset(outputRoot: string, manifest: unknown, records: EvaluationRunRecord[]): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await writeFile(join(outputRoot, 'results.json'), JSON.stringify(records, null, 2) + '\n', 'utf8');
  await writeFile(join(outputRoot, 'results.csv'), toCsv(records), 'utf8');
  const aggregate = aggregateEvaluation(records);
  await writeFile(join(outputRoot, 'aggregate.json'), JSON.stringify(aggregate, null, 2) + '\n', 'utf8');
  await writeFile(join(outputRoot, 'report.md'), renderReport(aggregate, records), 'utf8');
}

export async function readRecords(input: string): Promise<EvaluationRunRecord[]> {
  const resolved = resolve(input);
  const candidates = [resolved, join(resolved, 'results.json')];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed as EvaluationRunRecord[];
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown }).records)) return (parsed as { records: EvaluationRunRecord[] }).records;
      if (parsed && typeof parsed === 'object' && 'task_id' in parsed) return [parsed as EvaluationRunRecord];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`cannot read evaluation records from ${input}`);
}

function csvEscape(value: unknown): string {
  const text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(records: EvaluationRunRecord[]): string {
  const headers = ['run_id', 'task_id', 'category', 'mode', 'outcome', 'state_status', 'failure_taxonomy', 'turns', 'iterations', 'tool_calls', 'wall_clock_ms', 'retries', 'recovery_events', 'replans', 'approvals', 'events', 'files_changed', 'commands', 'checks_passed', 'checks_failed', 'provider_name', 'provider_id', 'model', 'validation_summary', 'event_log'];
  const lines = [headers.join(',')];
  for (const record of records) {
    const row: Record<string, unknown> = {
      ...record,
      provider_name: record.provider.name,
      provider_id: record.provider.id,
      model: record.provider.model,
      validation_summary: record.validation.map((check) => `${check.name}:${check.status}`).join(';'),
    };
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  return lines.join('\n') + '\n';
}

export interface ModeSummary {
  mode: EvaluationMode | 'all';
  status: 'recorded' | 'not_run';
  total: number;
  success: number;
  partial: number;
  failed: number;
  stopped: number;
  success_rate: number;
  avg_turns: number;
  avg_tool_calls: number;
  avg_wall_clock_ms: number;
  total_recovery_events: number;
}

export interface EvaluationAggregate {
  generated_at: string;
  total_runs: number;
  by_mode: ModeSummary[];
  comparison: ModeSummary[];
  by_category: Array<{ category: TaskCategory; total: number; success: number; success_rate: number; avg_tool_calls: number; avg_wall_clock_ms: number }>;
  failure_taxonomy: Record<string, number>;
  caveats: string[];
}

function summarizeMode(records: EvaluationRunRecord[], mode: EvaluationMode | 'all'): ModeSummary {
  const selected = mode === 'all' ? records : records.filter((record) => record.mode === mode);
  const total = selected.length;
  const success = selected.filter((record) => record.outcome === 'success').length;
  const avg = (values: number[]) => total === 0 ? 0 : Math.round((values.reduce((a, b) => a + b, 0) / total) * 100) / 100;
  return {
    mode,
    status: total === 0 ? 'not_run' : 'recorded',
    total,
    success,
    partial: selected.filter((record) => record.outcome === 'partial').length,
    failed: selected.filter((record) => record.outcome === 'failed').length,
    stopped: selected.filter((record) => record.outcome === 'stopped').length,
    success_rate: total === 0 ? 0 : Math.round((success / total) * 10000) / 100,
    avg_turns: avg(selected.map((record) => record.turns)),
    avg_tool_calls: avg(selected.map((record) => record.tool_calls)),
    avg_wall_clock_ms: avg(selected.map((record) => record.wall_clock_ms)),
    total_recovery_events: selected.reduce((sum, record) => sum + record.recovery_events, 0),
  };
}

export function aggregateEvaluation(records: EvaluationRunRecord[]): EvaluationAggregate {
  const categories: TaskCategory[] = ['bug_fix', 'feature_addition', 'refactor'];
  const byCategory = categories.map((category) => {
    const selected = records.filter((record) => record.category === category);
    const success = selected.filter((record) => record.outcome === 'success').length;
    return {
      category,
      total: selected.length,
      success,
      success_rate: selected.length === 0 ? 0 : Math.round((success / selected.length) * 10000) / 100,
      avg_tool_calls: selected.length === 0 ? 0 : Math.round((selected.reduce((sum, record) => sum + record.tool_calls, 0) / selected.length) * 100) / 100,
      avg_wall_clock_ms: selected.length === 0 ? 0 : Math.round(selected.reduce((sum, record) => sum + record.wall_clock_ms, 0) / selected.length),
    };
  });
  const failureTaxonomy: Record<string, number> = {};
  for (const record of records) {
    if (record.outcome === 'success') continue;
    failureTaxonomy[record.failure_taxonomy] = (failureTaxonomy[record.failure_taxonomy] ?? 0) + 1;
  }
  const hasLive = records.some((record) => record.mode === 'live');
  const caveats = [
    'Deterministic runs use a scripted provider and validate the harness/loop; they are not live LLM performance.',
    hasLive ? 'Live runs are included in this aggregate.' : 'No live-provider runs are included; live evaluation remains pending and must not be inferred from deterministic results.',
    'Fixture tasks are small synthetic repositories; results do not generalize directly to large real-world projects.',
  ];
  return {
    generated_at: new Date().toISOString(),
    total_runs: records.length,
    by_mode: [summarizeMode(records, 'all'), summarizeMode(records, 'deterministic'), summarizeMode(records, 'live')],
    comparison: [summarizeMode(records, 'deterministic'), summarizeMode(records, 'live')],
    by_category: byCategory,
    failure_taxonomy: failureTaxonomy,
    caveats,
  };
}

function modeRow(summary: ModeSummary): string {
  if (summary.status === 'not_run') return `| ${summary.mode} | not run | 0 | - | - | - | - | - |`;
  return `| ${summary.mode} | recorded | ${summary.total} | ${summary.success} | ${summary.partial} | ${summary.failed} | ${summary.stopped} | ${summary.success_rate}% |`;
}

export function renderReport(aggregate: EvaluationAggregate, records: EvaluationRunRecord[]): string {
  const failureRows = Object.entries(aggregate.failure_taxonomy).sort(([a], [b]) => a.localeCompare(b));
  const runRows = records.map((record) => `| ${record.task_id} | ${record.category} | ${record.mode} | ${record.outcome} | ${record.turns} | ${record.tool_calls} | ${record.wall_clock_ms} | ${record.checks_passed}/${record.checks_passed + record.checks_failed} | ${record.failure_taxonomy} |`);
  return `# Daedalus Phase 10 Evaluation Report

Generated: ${aggregate.generated_at}

> Deterministic results use a scripted provider to validate the evaluation harness. They are **not** live LLM results. Live rows are included only when a dataset with \`mode: "live"\` records is aggregated.

## Summary

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
${aggregate.by_mode.map(modeRow).join('\n')}

## Deterministic vs live comparison

| Mode | Status | Runs | Success | Partial | Failed | Stopped | Success rate |
|---|---|---:|---:|---:|---:|---:|---:|
${aggregate.comparison.map(modeRow).join('\n')}

## By category

| Category | Runs | Success | Success rate | Avg tool calls | Avg wall-clock ms |
|---|---:|---:|---:|---:|---:|
${aggregate.by_category.map((row) => `| ${row.category} | ${row.total} | ${row.success} | ${row.success_rate}% | ${row.avg_tool_calls} | ${row.avg_wall_clock_ms} |`).join('\n')}

## Failure taxonomy

${failureRows.length === 0 ? 'No non-success runs were recorded in this aggregate.' : ['| Failure type | Count |', '|---|---:|', ...failureRows.map(([name, count]) => `| ${name} | ${count} |`)].join('\n')}

## Runs

| Task | Category | Mode | Outcome | Turns | Tool calls | Wall-clock ms | Validation passed/total | Failure taxonomy |
|---|---|---|---|---:|---:|---:|---:|---|
${runRows.join('\n')}

## Threats to validity

- Small synthetic fixture repositories limit external validity; they are designed to exercise specific bug-fix, feature, and refactor behaviours rather than represent full production codebases.
- Deterministic scripted-provider runs measure harness reliability, event recording, validation gating, and fixture reproducibility. They do not measure model reasoning quality, prompt quality, token cost, or live-provider latency.
- If live runs are absent, live model performance remains pending; no success rate for a real model should be inferred from this report.
- Wall-clock timings depend on the local machine, Node.js version, filesystem, and provider/network conditions for live runs.
- Validation is limited to the commands declared by each fixture (syntax plus a behaviour script). Passing fixtures does not prove absence of regressions outside those assertions.
- Provider/model configuration, temperature support, and provider-side nondeterminism must be recorded with any future live dataset; the current core forwards timeout configuration but not a universal temperature control through TaskRunner.

## Caveats

${aggregate.caveats.map((caveat) => `- ${caveat}`).join('\n')}
`;
}

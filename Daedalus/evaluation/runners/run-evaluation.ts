import { resolve } from 'node:path';
import { aggregateEvaluation, loadEvaluationTasks, readRecords, runEvaluation, selectTasks, writeDataset, type EvaluationMode, type ModelStrategy, type TaskCategory } from './evaluation-core.ts';

function usage(): string {
  return `Usage:
  node --experimental-strip-types evaluation/runners/run-evaluation.ts --mode deterministic [--task <id> ...] [--category bug_fix|feature_addition|refactor] [--limit <n>] [--output <dir>] [--validate-suite]
  node --experimental-strip-types evaluation/runners/run-evaluation.ts --mode live [--provider-id <id>] [--model <model>] [--models <a,b,c>] [--model-strategy failover|round-robin] [--task <id> ...] [--output <dir>]

Modes:
  deterministic  Scripted-provider harness validation. Never label this as live.
  live           Uses LLM_* env settings and/or <DAEDALUS_HOME>/providers.json provider registry.
`;
}

function parseArgs(argv: string[]): Record<string, string | boolean | string[]> {
  const args: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--validate-suite') args.validateSuite = true;
    else if (arg === '--task') {
      const current = Array.isArray(args.task) ? args.task : [];
      current.push(argv[++i] ?? '');
      args.task = current;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      args[key] = argv[++i] ?? '';
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseModels(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const models = [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))];
  if (models.length === 0) throw new Error('--models expects a comma-separated list of model ids');
  return models;
}

function parseModelStrategy(value: string | undefined): ModelStrategy | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase() as ModelStrategy;
  if (normalized !== 'failover' && normalized !== 'round-robin') throw new Error(`--model-strategy expects failover or round-robin, got ${value}`);
  return normalized;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const tasks = await loadEvaluationTasks(typeof args.tasks === 'string' ? args.tasks : undefined);
  if (args.validateSuite) {
    console.log(`suite ok: ${tasks.length} tasks (${tasks.filter((task) => task.category === 'bug_fix').length} bug_fix, ${tasks.filter((task) => task.category === 'feature_addition').length} feature_addition, ${tasks.filter((task) => task.category === 'refactor').length} refactor)`);
    return;
  }

  const mode = (typeof args.mode === 'string' ? args.mode : 'deterministic') as EvaluationMode;
  if (mode !== 'deterministic' && mode !== 'live') throw new Error(`--mode must be deterministic or live, got ${mode}`);
  const selected = selectTasks(tasks, {
    taskIds: Array.isArray(args.task) ? args.task : undefined,
    category: typeof args.category === 'string' ? args.category as TaskCategory : undefined,
    limit: typeof args.limit === 'string' ? Number(args.limit) : undefined,
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputRoot = resolve(typeof args.output === 'string' ? args.output : `evaluation/reports/${mode}-${stamp}`);
  const { records } = await runEvaluation({
    mode,
    outputRoot,
    taskIds: selected.map((task) => task.id),
    providerId: typeof args['provider-id'] === 'string' ? args['provider-id'] : undefined,
    model: typeof args.model === 'string' ? args.model : undefined,
    models: parseModels(typeof args.models === 'string' ? args.models : undefined),
    modelStrategy: parseModelStrategy(typeof args['model-strategy'] === 'string' ? args['model-strategy'] : undefined),
    seed: typeof args.seed === 'string' ? Number(args.seed) : undefined,
    tasksFile: typeof args.tasks === 'string' ? args.tasks : undefined,
  });
  console.log(JSON.stringify({ mode, output: outputRoot, total: records.length, success: records.filter((record) => record.outcome === 'success').length, outcomes: Object.fromEntries(Object.entries(Object.groupBy(records, (record) => record.outcome)).map(([key, value]) => [key, value?.length ?? 0])) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { aggregateEvaluation, readRecords, writeDataset };

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { aggregateEvaluation, readRecords, renderReport, toCsv, type EvaluationRunRecord } from './evaluation-core.ts';

function usage(): string {
  return `Usage:
  node --experimental-strip-types evaluation/runners/aggregate.ts --input <results.json|dataset-dir> [--input <...>] --output <dir>

Writes aggregate.json, report.md, and combined results.csv for the supplied datasets.
`;
}

async function main(): Promise<void> {
  const inputs: string[] = [];
  let output = '';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return;
    }
    if (arg === '--input') inputs.push(argv[++i] ?? '');
    else if (arg === '--output') output = argv[++i] ?? '';
    else if (arg.startsWith('--input=')) inputs.push(arg.slice('--input='.length));
    else if (arg.startsWith('--output=')) output = arg.slice('--output='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (inputs.length === 0 || !output) throw new Error(usage());

  const records: EvaluationRunRecord[] = [];
  for (const input of inputs) records.push(...await readRecords(input));
  const outputRoot = resolve(output);
  await mkdir(outputRoot, { recursive: true });
  const aggregate = aggregateEvaluation(records);
  await writeFile(resolve(outputRoot, 'aggregate.json'), JSON.stringify(aggregate, null, 2) + '\n', 'utf8');
  await writeFile(resolve(outputRoot, 'report.md'), renderReport(aggregate, records), 'utf8');
  await writeFile(resolve(outputRoot, 'results.csv'), toCsv(records), 'utf8');
  console.log(JSON.stringify({ output: outputRoot, total: records.length, by_mode: aggregate.by_mode }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

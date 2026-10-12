import { CommandValidator, discoverChecks } from './core/src/validation/index.ts';

const workspaceRoot = '/home/xyconix11x/Ayid/xyconix11x/Skripsi/Daedalus';

async function run(label: string, timeoutMs?: number): Promise<void> {
  const validator = new CommandValidator();
  const started = Date.now();
  const result = await validator.validate({ workspaceRoot, timeoutMs });
  const elapsed = Date.now() - started;
  console.log(`\n=== ${label} (timeoutMs=${timeoutMs ?? 'unset'}) total=${elapsed}ms ===`);
  for (const check of result.checks) {
    console.log(
      [
        `  ${check.name}`,
        `status=${check.status}`,
        `exit_code=${String(check.exit_code)}`,
        `summary=${check.summary}`,
        `diagnostics=${check.diagnostics.length}`,
        `last=${JSON.stringify(check.diagnostics.at(-1)?.message ?? '')}`,
      ].join(' | '),
    );
  }
}

await run('current agent-loop behaviour (no timeout propagated)');
await run('with explicit 600s timeout', 600_000);

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  MAX_CHILD_SUMMARY_CHARS,
  TaskRunner,
  TaskStore,
  distillChildSummary,
  type Event,
  type LLMProvider,
  type Message,
  type ToolDefinition,
} from '../src/index.ts';
import { EventBus } from '../src/events.ts';

/**
 * PR #18's child-economics guarantees — distillation, budget slices, the
 * findings carriage, and FILE_CHANGED mirroring — re-pointed at the
 * spawn_subagent tool path that replaced the retired Orchestrator mode's
 * fan-out. The machinery (distillChildSummary, per-child slices, mirroring)
 * is unchanged; only the trigger differs: the model delegates, no mode
 * decomposes.
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
type Route = { match: string; steps: ScriptStep[] };

/** Parent and children share one provider; each conversation routes by a marker in its own goal. */
function routedProvider(routes: Route[], seen?: Message[][]): LLMProvider {
  return {
    name: 'routed',
    async chat(messages: Message[]) {
      seen?.push(messages);
      const serialized = JSON.stringify(messages);
      const route = routes.find((candidate) => candidate.steps.length > 0 && serialized.includes(candidate.match));
      const step = route?.steps.shift();
      if (!step) return { message: { role: 'assistant' as const, content: 'done: work complete' } };
      if ('text' in step) return { message: { role: 'assistant' as const, content: step.text } };
      return {
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: `call-${route?.match}`, type: 'function' as const, function: { name: step.tool, arguments: JSON.stringify(step.args) } }],
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

function makeRunner(root: string, home: string, provider: LLMProvider, maxIterations = 25): TaskRunner {
  return new TaskRunner({
    workspaceRoot: root,
    store: new TaskStore(home),
    bus: new EventBus(),
    provider,
    validator: passingValidator,
    approvalPolicy: 'auto',
    maxIterations,
  });
}

function finishedChild(events: Event[]): { status: string; error_reason?: string; result_summary?: string; budget?: { max_iterations: number } } {
  const finished = events.find((event) => event.type === 'CHILD_TASK_FINISHED');
  return (finished?.payload as { child: never }).child;
}

describe('distilled child returns (unit)', () => {
  test('distillChildSummary hard-caps even with many files and long evidence', () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `src/module-${i}.ts`, added: 100, removed: 50 }));
    const summary = distillChildSummary({
      status: 'done',
      summary: 'all done here',
      filesChanged: files,
      evidence: ['e'.repeat(900), 'f'.repeat(900), 'g'.repeat(900)],
    });
    expect(summary.length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
    expect(summary).toContain('[summary truncated]');
    expect(summary).toContain('changed: src/module-0.ts (+100/-50)');
  });

  test('distillChildSummary keeps a genuine short closing line but drops observation dumps', () => {
    const clean = distillChildSummary({ status: 'done', summary: 'Added the hero image and stylesheet.' });
    expect(clean).toContain('Added the hero image and stylesheet.');
    const dumped = distillChildSummary({ status: 'failed', errorReason: 'budget_exceeded', summary: 'ok: 1: const x = 1;\n2: const y = 2;' });
    expect(dumped).toBe('failed (budget_exceeded)');
  });
});

describe('distilled child returns (spawn path)', () => {
  test('a child ending on a huge read returns a distilled summary to the parent, never the dump', async () => {
    const root = temp('daedalus-distill-ws-');
    const home = temp('daedalus-distill-home-');
    // 600 lines ≈ 14KB: far above the 1,500-char distilled cap, small
    // enough to survive the terminal tool's output limit as a clean dump.
    const bigLines = Array.from({ length: 600 }, (_, i) => `line ${i} of the big file`);
    bigLines.push('SECRET-TAIL-MARKER-AT-END');
    writeFileSync(join(root, 'big.txt'), bigLines.join('\n'));
    const provider = routedProvider([
      {
        match: 'PARENT-DISTILL',
        steps: [
          { tool: 'spawn_subagent', args: { description: 'big reader', goal: 'Summarize the big file [[child-distill]]\ndone: output file written\ndone: big file dumped' } },
        ],
      },
      {
        match: '[[child-distill]]',
        steps: [
          { tool: 'write_file', args: { path: 'child-out.txt', content: 'summary placeholder' } },
          { tool: 'run_command', args: { command: 'cat', args: ['big.txt'] } },
        ],
      },
    ]);
    const runner = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-DISTILL\ndone: subagent result received', mode: 'auto' });

    expect(result.state.status).toBe('done');
    const child = finishedChild(result.events);
    expect(child.status).toBe('done');
    expect((child.result_summary ?? '').length).toBeLessThanOrEqual(MAX_CHILD_SUMMARY_CHARS);
    expect(child.result_summary ?? '').not.toContain('SECRET-TAIL-MARKER-AT-END');
    expect(child.result_summary).toContain('changed: child-out.txt');
    // The tool result the model received is the distilled shape too.
    const spawnFinish = result.events.find(
      (event) => event.type === 'TOOL_CALL_FINISHED' && (event.payload as { call?: { tool?: string } }).call?.tool === 'spawn_subagent',
    );
    const output = (spawnFinish?.payload as { result?: { output: string } }).result?.output ?? '';
    expect(output).not.toContain('SECRET-TAIL-MARKER-AT-END');
    expect(output.length).toBeLessThan(MAX_CHILD_SUMMARY_CHARS + 200);
  });
});

describe('per-child budget slices (spawn path)', () => {
  test('the first spawn is granted floor-8/even-share of the remaining pool, recorded on the child', async () => {
    const root = temp('daedalus-slice-ws-');
    const home = temp('daedalus-slice-home-');
    const provider = routedProvider([
      {
        match: 'PARENT-SLICE',
        steps: [{ tool: 'spawn_subagent', args: { description: 'slice probe', goal: 'Write slice.txt [[child-slice]]\ndone: slice file written' } }],
      },
      {
        match: '[[child-slice]]',
        steps: [{ tool: 'write_file', args: { path: 'slice.txt', content: 'x' } }],
      },
    ]);
    const runner = makeRunner(root, home, provider, 25);
    const result = await runner.run({ goal: 'PARENT-SLICE\ndone: subagent result received', mode: 'auto' });
    expect(result.state.status).toBe('done');
    const started = result.events.find((event) => event.type === 'CHILD_TASK_STARTED');
    const child = (started?.payload as { child: { budget?: { max_iterations: number } } }).child;
    // Pool 25, one parent turn spent: 24 remain → even share 12 beats the floor 8.
    expect(child.budget?.max_iterations).toBe(12);
  });
});

describe('findings carriage (spawn path)', () => {
  test("the parent's next request carries the first child's distilled result for the model to build on", async () => {
    const root = temp('daedalus-carriage-ws-');
    const home = temp('daedalus-carriage-home-');
    const seen: Message[][] = [];
    const provider = routedProvider(
      [
        {
          match: 'PARENT-CARRY',
          steps: [
            { tool: 'spawn_subagent', args: { description: 'first investigator', goal: 'Write first.txt [[child-first]]\ndone: first file written' } },
            { tool: 'spawn_subagent', args: { description: 'second investigator', goal: 'Write second.txt using the earlier findings [[child-second]]\ndone: second file written' } },
          ],
        },
        {
          match: '[[child-first]]',
          steps: [{ tool: 'write_file', args: { path: 'first.txt', content: 'one' } }],
        },
        {
          match: '[[child-second]]',
          steps: [{ tool: 'write_file', args: { path: 'second.txt', content: 'two' } }],
        },
      ],
      seen,
    );
    const runner = makeRunner(root, home, provider);
    const result = await runner.run({ goal: 'PARENT-CARRY\ndone: first result received\ndone: second result received', mode: 'auto' });

    expect(result.state.status).toBe('done');
    expect(existsSync(join(root, 'first.txt'))).toBe(true);
    expect(existsSync(join(root, 'second.txt'))).toBe(true);
    expect(readFileSync(join(root, 'second.txt'), 'utf8')).toBe('two');
    // The parent's second spawn request shows the first child's distilled
    // result in the conversation — the model itself carries findings into
    // the next brief (the fan-out-era handoff, now model-mediated).
    const parentRequests = seen.filter((messages) => JSON.stringify(messages).includes('PARENT-CARRY'));
    const second = JSON.stringify(parentRequests[1] ?? []);
    expect(second).toContain('changed: first.txt');
    expect(second).toContain('finished with status done');
  });
});

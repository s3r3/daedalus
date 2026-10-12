import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AGENT_MODE_ORDER,
  EventBus,
  ProviderRegistry,
  TaskRunner,
  TaskStore,
  VIEW_IMAGE_MAX_BYTES,
  classifyToolName,
  isToolVisible,
  viewImageTool,
  type Event,
  type LLMProvider,
  type Message,
  type ToolExecutionContext,
} from '../src/index.ts';

/**
 * view_image: unit behaviour (vision gate, MIME sniff, size cap) plus the
 * loop-level carriage — the image bytes must reach the NEXT model request
 * as an image_url block while every emitted/persisted result stays the
 * one-line placeholder (no base64 in events, state, or transcripts).
 */

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ctx = (root: string, extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({ workspaceRoot: root, ...extra });

const passingValidator = {
  async validate() {
    return { checks: [{ name: 'stub', cmd: 'true', status: 'pass' as const, exit_code: 0, summary: 'passed', diagnostics: [] }] };
  },
};

describe('view_image tool', () => {
  test('returns the image as a data URL in meta with a placeholder text output', async () => {
    const root = temp('daedalus-view-ws-');
    writeFileSync(join(root, 'shot.png'), PNG_BYTES);
    const result = await viewImageTool.execute({ path: 'shot.png' }, ctx(root, { visionEnabled: true }));
    expect(result.status).toBe('ok');
    expect(result.meta.image_mime).toBe('image/png');
    expect(result.meta.image_bytes).toBe(PNG_BYTES.length);
    expect(String(result.meta.image_data_url)).toMatch(/^data:image\/png;base64,/);
    // The text output is the placeholder every transcript renders.
    expect(result.output).toContain('viewed image shot.png (image/png,');
    expect(result.output).not.toContain('base64');
  });

  test('sniffs jpeg, gif, and webp by magic bytes, not by file name', async () => {
    const root = temp('daedalus-view-formats-');
    writeFileSync(join(root, 'a.bin'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    writeFileSync(join(root, 'b.bin'), Buffer.from('GIF89a......', 'ascii'));
    writeFileSync(join(root, 'c.bin'), Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]));
    expect((await viewImageTool.execute({ path: 'a.bin' }, ctx(root))).meta.image_mime).toBe('image/jpeg');
    expect((await viewImageTool.execute({ path: 'b.bin' }, ctx(root))).meta.image_mime).toBe('image/gif');
    expect((await viewImageTool.execute({ path: 'c.bin' }, ctx(root))).meta.image_mime).toBe('image/webp');
  });

  test('rejects non-images even when named like one', async () => {
    const root = temp('daedalus-view-fake-');
    writeFileSync(join(root, 'fake.png'), 'this is plain text, not a png');
    const result = await viewImageTool.execute({ path: 'fake.png' }, ctx(root));
    expect(result.status).toBe('error');
    expect(result.meta.reason).toBe('unsupported_image');
    expect(result.meta.image_data_url).toBeUndefined();
  });

  test('rejects empty, oversize, missing, and workspace-escaping paths', async () => {
    const root = temp('daedalus-view-guards-');
    writeFileSync(join(root, 'empty.png'), '');
    const big = Buffer.alloc(VIEW_IMAGE_MAX_BYTES + 1);
    PNG_BYTES.copy(big);
    writeFileSync(join(root, 'big.png'), big);

    const empty = await viewImageTool.execute({ path: 'empty.png' }, ctx(root));
    expect(empty.status).toBe('error');
    expect(empty.meta.reason).toBe('empty');

    const oversize = await viewImageTool.execute({ path: 'big.png' }, ctx(root));
    expect(oversize.status).toBe('error');
    expect(oversize.meta.reason).toBe('too_large');
    expect(oversize.output).toContain(String(VIEW_IMAGE_MAX_BYTES));

    const missing = await viewImageTool.execute({ path: 'gone.png' }, ctx(root));
    expect(missing.status).toBe('error');

    const escape = await viewImageTool.execute({ path: '../outside.png' }, ctx(root));
    expect(escape.status).toBe('error');
    expect(escape.meta.reason).toBe('path_escape');
  });

  test('refuses with the typed vision_unsupported reason when the model cannot see images', async () => {
    const root = temp('daedalus-view-novision-');
    writeFileSync(join(root, 'shot.png'), PNG_BYTES);
    const result = await viewImageTool.execute({ path: 'shot.png' }, ctx(root, { visionEnabled: false }));
    expect(result.status).toBe('denied');
    expect(result.meta.reason).toBe('vision_unsupported');
    expect(result.output).toContain('current model cannot view images');
    expect(result.meta.image_data_url).toBeUndefined();
  });

  test('classified read and visible in every mode (Ask included)', () => {
    expect(classifyToolName('view_image')).toBe('read');
    for (const mode of [...AGENT_MODE_ORDER, 'orchestrator' as const]) {
      expect(isToolVisible(mode, 'view_image'), mode).toBe(true);
    }
  });
});

/** Provider: view_image first, then read both notes files, then "done:". */
function viewThenDoneProvider(seen: Message[][]): LLMProvider {
  let calls = 0;
  const script: Array<{ name: string; args: string }> = [
    { name: 'view_image', args: '{"path":"pic.png"}' },
    { name: 'read_file', args: '{"path":"notes.txt"}' },
    { name: 'read_file', args: '{"path":"notes2.txt"}' },
  ];
  return {
    name: 'capture',
    async chat(messages: Message[]) {
      seen.push(messages);
      const step = script[calls++];
      if (step) {
        return {
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{ id: `c${calls}`, type: 'function' as const, function: { name: step.name, arguments: step.args } }],
          },
        };
      }
      return { message: { role: 'assistant' as const, content: 'done: complete' } };
    },
    async *stream() { /* non-streaming provider */ },
  };
}

function visionRunner(root: string, home: string, seen: Message[][], events: Event[]): TaskRunner {
  const registry = new ProviderRegistry();
  registry.upsert({ id: 'fake', name: 'Fake', baseUrl: 'https://example.test/v1', apiKey: 'k', models: ['gpt-4o', 'text-only'], supportsVision: true });
  return new TaskRunner({
    workspaceRoot: root,
    store: new TaskStore(home),
    bus: new EventBus(),
    provider: viewThenDoneProvider(seen),
    providerRegistry: registry,
    validator: passingValidator,
    approvalPolicy: 'auto',
    maxIterations: 5,
  });
}

describe('view_image through the agent loop', () => {
  test('a vision model receives the image part on the next request; logs stay base64-free', async () => {
    const root = temp('daedalus-view-loop-ws-');
    const home = temp('daedalus-view-loop-home-');
    writeFileSync(join(root, 'pic.png'), PNG_BYTES);
    writeFileSync(join(root, 'notes.txt'), 'the screenshot shows a login form\n');
    writeFileSync(join(root, 'notes2.txt'), 'second note\n');
    const seen: Message[][] = [];
    const events: Event[] = [];
    const runner = visionRunner(root, home, seen, events);

    const result = await runner.run({
      goal: 'Inspect the screenshot and the notes\ndone: inspect the image\ndone: read notes.txt',
      providerId: 'fake',
      model: 'gpt-4o',
      onEvent: (event: Event) => events.push(event),
    });
    expect(result.outcome).toBe('success');
    expect(seen.length).toBeGreaterThanOrEqual(2);

    // The next request carries the image as an image_url content block…
    const secondRequest = JSON.stringify(seen[1]);
    expect(secondRequest).toContain('"type":"image_url"');
    expect(secondRequest).toContain('data:image/png;base64,iVBOR');
    // …labelled as the view_image attachment, next to the placeholder result.
    expect(secondRequest).toContain('Image attached from view_image (pic.png, image/png)');
    expect(secondRequest).toContain('viewed image pic.png');

    // Nothing emitted carries the bytes: events render the placeholder only.
    const finished = events.find((event) => event.type === 'TOOL_CALL_FINISHED'
      && (event.payload as { call?: { tool?: string } }).call?.tool === 'view_image');
    expect(finished).toBeDefined();
    const finishedPayload = finished!.payload as { result: { output: string; meta: Record<string, unknown> } };
    expect(finishedPayload.result.output).toContain('viewed image pic.png (image/png,');
    expect(finishedPayload.result.meta.image_attached).toBe(true);
    expect(JSON.stringify(events)).not.toContain('data:image/png;base64');

    // The persisted state carries no image bytes anywhere either.
    expect(JSON.stringify(result.state)).not.toContain('data:image/png;base64');
  });

  test('a text-only model gets the refusal and no image bytes in its request', async () => {
    const root = temp('daedalus-view-loop-novision-ws-');
    const home = temp('daedalus-view-loop-novision-home-');
    writeFileSync(join(root, 'pic.png'), PNG_BYTES);
    writeFileSync(join(root, 'notes.txt'), 'the screenshot shows a login form\n');
    writeFileSync(join(root, 'notes2.txt'), 'second note\n');
    const seen: Message[][] = [];
    const events: Event[] = [];
    const runner = visionRunner(root, home, seen, events);

    const result = await runner.run({
      goal: 'Inspect the screenshot and the notes\ndone: inspect the image\ndone: read notes.txt',
      providerId: 'fake',
      model: 'text-only',
      onEvent: (event: Event) => events.push(event),
    });
    expect(result.outcome).toBe('success');
    const finished = events.find((event) => event.type === 'TOOL_CALL_FINISHED'
      && (event.payload as { call?: { tool?: string } }).call?.tool === 'view_image');
    const payload = finished!.payload as { result: { status: string; output: string; meta: Record<string, unknown> } };
    expect(payload.result.status).toBe('denied');
    expect(payload.result.output).toContain('current model cannot view images');
    expect(payload.result.meta.reason).toBe('vision_unsupported');
    expect(JSON.stringify(seen[1] ?? [])).not.toContain('data:image');
  });
});

describe('view_image workspace hygiene', () => {
  test('the workspace keeps the file untouched (read-only tool)', async () => {
    const root = temp('daedalus-view-readonly-');
    writeFileSync(join(root, 'shot.png'), PNG_BYTES);
    const result = await viewImageTool.execute({ path: 'shot.png' }, ctx(root));
    expect(result.status).toBe('ok');
    expect(existsSync(join(root, 'shot.png'))).toBe(true);
  });
});

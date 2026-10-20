import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DefaultContextManager,
  extractMentionPaths,
  resolveMentionSection,
  type TaskState,
} from '../src/index.ts';

async function makeWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'daedalus-mentions-'));
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'daedalus-web', 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'index.ts'), 'export const x = 1\n');
  await fs.writeFile(path.join(workspace, 'daedalus-web', 'package.json'), '{ "name": "web" }\n');
  await fs.writeFile(path.join(workspace, 'daedalus-web', 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n');
  await fs.writeFile(path.join(workspace, 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  return workspace;
}

function fixtureState(workspace: string, goal: string): TaskState {
  return {
    id: 'task-mentions',
    goal,
    repo_path: workspace,
    constraints: [],
    done_criteria: [],
    created_at: '2026-10-06T00:00:00.000Z',
    plan: { planner: 'local', steps: [], status: 'complete' },
    steps: [],
    status: 'active',
    mode: 'auto',
  };
}

describe('extractMentionPaths', () => {
  test('extracts workspace paths at the start and after whitespace', () => {
    expect(extractMentionPaths('@src/index.ts fix this')).toEqual(['src/index.ts']);
    expect(extractMentionPaths('fix @src/index.ts and @daedalus-web please')).toEqual(['src/index.ts', 'daedalus-web']);
    expect(extractMentionPaths('multi\nline @a/b-c_d.ts')).toEqual(['a/b-c_d.ts']);
  });

  test('trims trailing sentence punctuation', () => {
    expect(extractMentionPaths('see @docs/guide.md, then @src/index.ts.')).toEqual(['docs/guide.md', 'src/index.ts']);
    expect(extractMentionPaths('look at (@src/index.ts)')).toEqual([]);
  });

  test('ignores e-mail style @ and bare tokens', () => {
    expect(extractMentionPaths('mail me at foo@bar.com')).toEqual([]);
    expect(extractMentionPaths('just an @ sign')).toEqual([]);
    expect(extractMentionPaths('no mentions here')).toEqual([]);
  });

  test('dedupes repeated mentions, preserving order', () => {
    expect(extractMentionPaths('@b.ts @a.ts @b.ts')).toEqual(['b.ts', 'a.ts']);
  });
});

describe('resolveMentionSection', () => {
  test('returns undefined for mention-free goals', async () => {
    const workspace = await makeWorkspace();
    expect(await resolveMentionSection(workspace, 'fix the bug')).toBeUndefined();
    expect(await resolveMentionSection(workspace, 'mail foo@bar.com')).toBeUndefined();
  });

  test('inlines file contents and directory listings', async () => {
    const workspace = await makeWorkspace();
    const section = await resolveMentionSection(workspace, 'fix @src/index.ts using @daedalus-web');
    expect(section).toContain('Referenced with @ in the prompt');
    expect(section).toContain('@src/index.ts:');
    expect(section).toContain('export const x = 1');
    expect(section).toContain('@daedalus-web (directory listing, shallow):');
    expect(section).toContain('- package.json');
    // node_modules is pruned from listings, exactly like the agent's own tools.
    expect(section).not.toContain('node_modules');
  });

  test('missing, escaping, and binary mentions are noted, never fatal', async () => {
    const workspace = await makeWorkspace();
    const section = await resolveMentionSection(workspace, 'check @nope.txt and @../outside.txt and @img.png');
    expect(section).toContain('@nope.txt: (not found in the workspace)');
    expect(section).toContain('@../outside.txt: (outside the workspace — not included)');
    expect(section).toContain('@img.png: (binary file — contents not included)');
  });

  test('per-file excerpt cap truncates with a note', async () => {
    const workspace = await makeWorkspace();
    await fs.writeFile(path.join(workspace, 'big.txt'), 'b'.repeat(7_000));
    const section = await resolveMentionSection(workspace, 'read @big.txt');
    expect(section).toContain('b'.repeat(6_000));
    expect(section).not.toContain('b'.repeat(6_001));
    expect(section).toContain('file truncated: showing the first 6000 chars');
  });

  test('mention-count cap keeps the first 8 and notes the rest', async () => {
    const workspace = await makeWorkspace();
    const names: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const name = `f${index}.ts`;
      names.push(name);
      await fs.writeFile(path.join(workspace, name), `content-${index}\n`);
    }
    const section = await resolveMentionSection(workspace, names.map((name) => `@${name}`).join(' '));
    expect(section).toContain('content-7');
    expect(section).not.toContain('content-8');
    expect(section).toContain('2 more @ reference(s) omitted');
  });

  test('total budget cap truncates with an honest note', async () => {
    const workspace = await makeWorkspace();
    const names: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const name = `big${index}.txt`;
      names.push(name);
      await fs.writeFile(path.join(workspace, name), 'a'.repeat(5_000));
    }
    const section = await resolveMentionSection(workspace, names.map((name) => `@${name}`).join(' '));
    expect(section).toContain('@-referenced contents truncated at 24000 chars total');
    expect(section!.length).toBeLessThan(26_000);
  });
});

describe('context manager mention injection', () => {
  test('mention-free goals keep the prompt byte-identical (no mentions section)', async () => {
    const workspace = await makeWorkspace();
    const manager = new DefaultContextManager({ workspaceRoot: workspace });
    const plain = await manager.buildMessages(fixtureState(workspace, 'fix the bug'), []);
    expect(plain[0]!.content).not.toContain('## mentions');
    const emailed = await manager.buildMessages(fixtureState(workspace, 'mail foo@bar.com about it'), []);
    expect(emailed[0]!.content).not.toContain('## mentions');
  });

  test('a mention adds one section between workspace and plan', async () => {
    const workspace = await makeWorkspace();
    const manager = new DefaultContextManager({ workspaceRoot: workspace });
    const messages = await manager.buildMessages(fixtureState(workspace, 'fix @src/index.ts now'), []);
    const system = messages[0]!.content as string;
    expect(system).toContain('## mentions');
    expect(system).toContain('export const x = 1');
    expect(system.indexOf('## workspace')).toBeLessThan(system.indexOf('## mentions'));
    expect(system.indexOf('## mentions')).toBeLessThan(system.indexOf('## plan'));
    // The visible goal text keeps the @path; the section carries the contents.
    expect(system).toContain('## task\nfix @src/index.ts now');
  });
});

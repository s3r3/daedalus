import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillConfig } from '@daedalus/core';
import { formatSkillsListing, listSkills, setSkillDisabledForWorkspace } from '../src/skills-bundled.ts';
import { InteractiveSession } from '../src/interactive.ts';
import { formatEvent } from '../src/index.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('skills enable|disable (shared core config)', () => {
  test('round-trips through .daedalus/skills.json and the listing shows the disabled state', async () => {
    const home = temp('daedalus-cli-hybrid-home-');
    const workspace = temp('daedalus-cli-hybrid-ws-');
    const skillDir = join(workspace, '.daedalus', 'skills', 'greeter');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: greeter\ndescription: Greets users warmly\n---\nBody');

    const disabled = await setSkillDisabledForWorkspace(workspace, 'greeter', true);
    expect(disabled.disabledSkills).toEqual(['greeter']);
    // The core reader — the same file the loader and the Web gateway use.
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: ['greeter'] });

    const listing = await listSkills({ workspaceRoot: workspace, env: {}, homeDir: home });
    expect(listing.detected.find((skill) => skill.name === 'greeter')).toMatchObject({ disabled: true });
    expect(formatSkillsListing(listing)).toContain('greeter (workspace) — Greets users warmly — disabled for this workspace');

    await setSkillDisabledForWorkspace(workspace, 'greeter', false);
    const after = await listSkills({ workspaceRoot: workspace, env: {}, homeDir: home });
    expect(after.detected.find((skill) => skill.name === 'greeter')).toMatchObject({ disabled: false });
    await expect(loadSkillConfig(workspace)).resolves.toEqual({ disabled: [] });
  });
});

describe('interactive /skill invocation', () => {
  function session(): InteractiveSession {
    const root = temp('daedalus-cli-hybrid-session-');
    const interactive = new InteractiveSession({ workspaceRoot: root });
    interactive.setSkills([
      { name: 'greeter', detail: 'Greets users warmly' },
      { name: 'muted', detail: 'Turned off' },
    ]);
    interactive.setDisabledSkills(['muted']);
    return interactive;
  }

  test('/skill <name> <task> returns a task carrying the forced-load marker', async () => {
    const interactive = session();
    const handled = await interactive.handleInput('/skill greeter greet the new user');
    expect(handled.kind).toBe('task');
    expect(handled.text).toBe('greet the new user');
    expect(handled.data).toEqual({ skills: ['greeter'] });
  });

  test('/skill <name> alone stages it for the next plain task, then clears', async () => {
    const interactive = session();
    const staged = await interactive.handleInput('/skill greeter');
    expect(staged.kind).toBe('slash');
    expect(staged.text).toContain('force-loaded into the next task');
    expect(interactive.invokedSkills).toEqual(['greeter']);

    const task = await interactive.handleInput('create a welcome page for new users');
    expect(task.kind).toBe('task');
    expect(task.data).toEqual({ skills: ['greeter'] });
    expect(interactive.invokedSkills).toEqual([]);
  });

  test('unknown and disabled names warn visibly and submit nothing', async () => {
    const interactive = session();
    const unknown = await interactive.handleInput('/skill ghost do something');
    expect(unknown.kind).toBe('slash');
    expect(unknown.text).toContain('Unknown skill "ghost"');

    const disabled = await interactive.handleInput('/skill muted do something');
    expect(disabled.kind).toBe('slash');
    expect(disabled.text).toContain('disabled for this workspace');
  });

  test('/skills prints the disabled marker for workspace-disabled skills', async () => {
    const interactive = session();
    const listed = await interactive.handleInput('/skills');
    expect(listed.text).toContain('greeter: Greets users warmly');
    expect(listed.text).toContain('muted: Turned off [disabled for this workspace]');
  });
});

describe('skill activation transcript line', () => {
  test('SKILL_LOADED formats distinctly for agent loads and user invocations', () => {
    expect(formatEvent({ task_id: 't', type: 'SKILL_LOADED', payload: { name: 'deploy', origin: 'claude', via: 'agent' } })).toContain('Skill loaded: deploy (claude — loaded by agent)');
    expect(formatEvent({ task_id: 't', type: 'SKILL_LOADED', payload: { name: 'deploy', origin: 'workspace', via: 'user' } })).toContain('Skill loaded: deploy (workspace — invoked by you)');
  });
});

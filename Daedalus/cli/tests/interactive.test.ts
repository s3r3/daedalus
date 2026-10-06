import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderRegistry } from '@daedalus/core';
import { InteractiveSession, padVisibleEnd, sanitizeTerminalText, truncateVisible, visibleWidth } from '../src/interactive.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daedalus-interactive-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('InteractiveSession', () => {
  test('status bar carries mode, provider, model, workspace, auto-approve, and status', () => {
    const root = workspace();
    const session = new InteractiveSession({ workspaceRoot: root, providerId: 'nine-router', model: 'kr/auto' });
    const bar = session.statusBar();
    expect(bar).toContain('mode auto');
    expect(bar).toContain('provider nine-router');
    expect(bar).toContain('model kr/auto');
    expect(bar).toContain(root);
    expect(bar).toContain('auto-approve off');
    expect(bar).toContain('status idle');
  });

  test('renders a bordered input box', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    const box = session.renderInputBox('hello');
    expect(box).toContain('╭');
    expect(box).toContain('│ > hello');
    expect(box).toContain('╰');
  });

  test('Shift+Tab cycles modes at a turn boundary', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), initialMode: 'ask' });
    expect(session.isShiftTab('\u001b[Z')).toBe(true);
    expect(session.isShiftTab('', { name: 'tab', shift: true })).toBe(true);
    expect(session.isShiftTab('', { name: 'tab', shift: false })).toBe(false);
    const result = await session.handleInput('\u001b[Z');
    expect(result).toMatchObject({ kind: 'slash', action: 'mode' });
    expect(session.mode).toBe('manual');
    expect(session.handleShiftTab().text).toContain('Code');
  });

  test('slash commands share the core registry semantics', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    expect(session.suggestions('/mo').map((command) => command.name)).toEqual(['mode', 'models']);

    const mode = await session.handleInput('/mode plan');
    expect(mode.text).toContain('Plan');
    expect(session.mode).toBe('plan');

    const code = await session.handleInput('/mode code');
    expect(code.text).toContain('Code');
    expect(session.mode).toBe('auto');

    const auto = await session.handleInput('/auto-approve on');
    expect(auto.text).toContain('on');
    expect(session.autoApprove).toBe(true);

    const models = await session.handleInput('/models nine-router/kr/auto');
    expect(models.text).toContain('nine-router/kr/auto');
    expect(session.providerId).toBe('nine-router');
    expect(session.model).toBe('kr/auto');

    const help = await session.handleInput('/help');
    expect(help.text).toContain('/providers');
    const unknown = await session.handleInput('/wat');
    expect(unknown.text).toContain('Unknown command');
  });

  test('plain text is returned as a task, not executed as a slash command', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    await expect(session.handleInput('create a README')).resolves.toEqual({ kind: 'task', text: 'create a README' });
    await expect(session.handleInput('   ')).resolves.toEqual({ kind: 'empty', text: '' });
  });

  test('attaches workspace files and images as metadata', async () => {
    const root = workspace();
    writeFileSync(join(root, 'notes.txt'), 'hello');
    writeFileSync(join(root, 'screen.png'), 'fake-png');
    const session = new InteractiveSession({ workspaceRoot: root });

    const file = await session.handleInput('/upload notes.txt');
    expect(file.text).toContain('Attached file notes.txt');
    const image = await session.handleInput('/image screen.png');
    expect(image.text).toContain('supports vision');
    expect(session.attachments).toHaveLength(2);
    expect(session.attachments.map((attachment) => attachment.kind)).toEqual(['file', 'image']);

    const missing = await session.handleInput('/image missing.png');
    expect(missing.text).toContain('File not found');
    expect(session.attachments).toHaveLength(2);
  });

  test('/files lists workspace entries and /status returns the status bar', async () => {
    const root = workspace();
    writeFileSync(join(root, 'a.txt'), 'a');
    const session = new InteractiveSession({ workspaceRoot: root });
    const files = await session.handleInput('/files');
    expect(files.text).toContain('a.txt');
    const status = await session.handleInput('/status');
    expect(status.text).toContain('workspace ' + root);
  });

  test('renders a Crush-style layout with Daedalus sidebar and honest empty sections', () => {
    const root = workspace();
    const session = new InteractiveSession({
      workspaceRoot: root,
      providerId: 'nine-router',
      model: 'good-model',
      models: ['bad-model', 'good-model'],
      modelStrategy: 'failover',
    });
    const layout = session.renderLayout({ transcript: ['hello from transcript'], columns: 110 });
    expect(layout).toContain('hello from transcript');
    expect(layout).toContain('◇ Daedalus');
    expect(layout).toContain('mode auto');
    expect(layout).toContain('provider nine-router');
    expect(layout).toContain('model good-model');
    expect(layout).toContain('pool failover (2)');
    expect(layout).toContain('Modified Files');
    expect(layout).toContain('None');
    expect(layout).toContain('LSPs');
    expect(layout).toContain('MCPs');
    expect(layout).toContain('Skills');
    expect(layout).toContain('None (not configured)');
    expect(layout).not.toContain('Crush');
  });

  test('FILE_CHANGED events fill Modified Files and PROVIDER_CHANGED updates the active pool model', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), models: ['bad-model', 'good-model'] });
    session.observeEvent({ seq: 1, task_id: 't1', type: 'FILE_CHANGED', payload: { path: 'src/app.ts', operation: 'modified', added: 3, removed: 1, tool: 'edit_file' }, ts: new Date().toISOString() });
    session.observeEvent({ seq: 2, task_id: 't1', type: 'PROVIDER_CHANGED', payload: { to_model: 'good-model', provider_id: 'nine-router' }, ts: new Date().toISOString() });

    expect(session.modifiedFiles).toEqual([expect.objectContaining({ path: 'src/app.ts', added: 3, removed: 1 })]);
    expect(session.activePoolModel).toBe('good-model');
    const sidebar = session.renderSidebar().join('\n');
    expect(sidebar).toContain('src/app.ts');
    expect(sidebar).toContain('active good-model');
  });

  test('command palette filters, groups, selects, and accepts commands', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    const opened = session.openCommandPalette('mo');
    expect(opened.map((item) => item.command.name)).toEqual(['mode', 'models']);
    expect(session.selectedPaletteItem()?.command.name).toBe('mode');
    expect(session.movePaletteSelection(1)?.command.name).toBe('models');
    expect(session.movePaletteSelection(1)?.command.name).toBe('mode');

    const palette = session.renderCommandPalette();
    expect(palette).toContain('Commands /mo');
    expect(palette).toContain('System');
    expect(palette).toContain('/models');
    expect(session.acceptPaletteSelection()).toBe('/mode');
    expect(session.paletteOpen).toBe(false);

    expect(session.suggestions('/fi').map((command) => command.name)).toEqual(['files']);
    expect(session.paletteItems()[0]?.group).toBe('Workspace');
  });

  test('key handling toggles the sidebar, opens palette/models, and cycles mode', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), initialMode: 'ask' });
    expect(session.sidebarVisible).toBe(true);
    expect(session.handleKey('', { name: 'b', ctrl: true }).action).toBe('toggle_sidebar');
    expect(session.sidebarVisible).toBe(false);
    expect(session.renderLayout({ columns: 110 })).not.toContain('Modified Files');
    expect(session.handleKey('', { name: 'b', ctrl: true }).action).toBe('toggle_sidebar');
    expect(session.sidebarVisible).toBe(true);

    expect(session.handleKey('', { name: 'p', ctrl: true }).action).toBe('open_commands');
    expect(session.paletteOpen).toBe(true);
    expect(session.handleKey('', { name: 'escape' }).action).toBe('palette_close');
    expect(session.handleKey('', { name: 'm', ctrl: true })).toMatchObject({ action: 'open_models', command: '/models' });
    expect(session.handleKey('', { name: 'return', shift: true }).action).toBe('newline');
    expect(session.handleKey('\u001b[Z', { name: 'tab', shift: true }).action).toBe('cycle_mode');
    expect(session.mode).toBe('manual');
  });

  test('fullscreen screen keeps the composer at the bottom and overlays the command palette', () => {
    const session = new InteractiveSession({
      workspaceRoot: workspace(),
      providerId: 'nine-router',
      model: 'claude-lo',
      models: ['claude-lo', 'kr/claude-sonnet-4-agentic'],
      modelStrategy: 'round-robin',
    });
    session.addTranscript('Farid: Fix greet() for empty names');
    session.addTranscript('Daedalus: Validation passed.');
    const screen = session.renderScreen({ input: 'Fix the cart total bug', columns: 132, rows: 34 });
    const lines = screen.split('\n');
    expect(lines).toHaveLength(34);
    expect(screen).toContain('◇ DAEDALUS');
    expect(screen).toContain('Modified Files');
    expect(screen).toContain('LSPs');
    expect(lines.at(-3)).toContain('> Fix the cart total bug█');
    expect(lines.at(-4)).toContain('Daedalus · Code');
    expect(lines.at(-1)).toContain('shift+tab mode');

    session.openCommandPalette('mo');
    const overlay = session.renderScreen({ input: '/mo', columns: 132, rows: 34 });
    expect(overlay).toContain('Commands /mo');
    expect(overlay).toContain('> mo');
    expect(overlay).toContain('Switch Model');
    expect(overlay).toContain('enter confirm');
    expect(overlay).toContain('/models');
  });

  test('sidebar shows real LSP/MCP/Skills entries when extension state is set', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });

    // Unset state keeps the honest placeholder in both sidebar renderers.
    expect(session.renderSidebarLines().join('\n')).toContain('None (not configured)');
    expect(session.renderSidebar().join('\n')).toContain('None (not configured)');

    session.setLsps([{ name: 'fake-lsp', detail: '.ts · running' }]);
    session.setMcps([{ name: 'fake', detail: 'connected · 3 tools' }]);
    session.setSkills([{ name: 'greeter', detail: 'Greets users warmly' }]);
    session.setAgents([{ name: 'only-reader', detail: 'Read-only child' }]);

    const lines = session.renderSidebarLines().join('\n');
    expect(lines).toContain('LSPs');
    expect(lines).toContain('fake-lsp .ts · running');
    expect(lines).toContain('MCPs');
    expect(lines).toContain('fake connected · 3 tools');
    expect(lines).toContain('Skills');
    expect(lines).toContain('greeter Greets users warmly');
    expect(lines).toContain('Subagents');
    expect(lines).toContain('only-reader Read-only child');
    expect(lines).not.toContain('None (not configured)');

    const boxed = session.renderSidebar().join('\n');
    expect(boxed).toContain('fake-lsp · .ts · running');
    expect(boxed).toContain('fake · connected · 3 tools');
    expect(boxed).toContain('greeter · Greets users warmly');

    expect(session.mcps).toEqual([{ name: 'fake', detail: 'connected · 3 tools' }]);
    expect(session.skills.map((skill) => skill.name)).toEqual(['greeter']);
    expect(session.lsps.map((lsp) => lsp.name)).toEqual(['fake-lsp']);
  });

  test('/mcp, /skills, and /lsp slash commands print the session extension state', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });

    const empty = await session.handleInput('/skills');
    expect(empty).toMatchObject({ kind: 'slash', action: 'skills' });
    expect(empty.text).toContain('No skills found');

    session.setMcps([{ name: 'fake', detail: 'connected · 3 tools' }]);
    session.setSkills([{ name: 'greeter', detail: 'Greets users warmly' }]);
    session.setLsps([{ name: 'fake-lsp', detail: '.ts · running' }]);

    expect((await session.handleInput('/mcp')).text).toContain('fake: connected · 3 tools');
    expect((await session.handleInput('/skills')).text).toContain('greeter: Greets users warmly');
    expect((await session.handleInput('/lsp')).text).toContain('fake-lsp: .ts · running');
    expect(session.suggestions('/mc').map((command) => command.name)).toEqual(['mcp']);
    expect(session.suggestions('/sk').map((command) => command.name)).toEqual(['skills']);
  });

  test('thinking setting is visible, slash-toggleable, and filters THOUGHT transcript entries', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), thinking: true });
    expect(session.thinking).toBe(true);
    expect(session.statusBar()).toContain('thinking on');
    expect(session.renderSidebarLines().join('\n')).toContain('thinking on');

    session.observeEvent({ seq: 1, task_id: 't1', type: 'THOUGHT', payload: { text: 'inspect before editing', source: 'provider_reasoning' }, ts: new Date().toISOString() });
    expect(session.transcript.join('\n')).toContain('thinking · inspect before editing');

    const off = await session.handleInput('/settings thinking off');
    expect(off.text).toContain('Thinking off');
    expect(session.thinking).toBe(false);
    expect(session.statusBar()).toContain('thinking off');
    session.observeEvent({ seq: 2, task_id: 't1', type: 'THOUGHT', payload: { text: 'hidden thought', source: 'provider_reasoning' }, ts: new Date().toISOString() });
    expect(session.transcript.join('\n')).not.toContain('hidden thought');

    const on = await session.handleInput('/settings thinking on');
    expect(on.text).toContain('Thinking on');
    expect(session.thinking).toBe(true);
  });
});

describe('model picker overlay', () => {
  function offlineRegistry(models: string[]): ProviderRegistry {
    // Fetch always fails: discovery is offline, configured models remain.
    const registry = new ProviderRegistry(async () => { throw new Error('offline'); });
    registry.upsert({ id: 'nine-router', name: '9Router', baseUrl: 'http://127.0.0.1:9/v1', models });
    return registry;
  }

  test('bare /models opens the picker and never dumps the list into the transcript', async () => {
    const session = new InteractiveSession({
      workspaceRoot: workspace(),
      providerRegistry: offlineRegistry(['kr/auto', 'claude-lo', 'cx/gpt-5.5']),
      providerId: 'nine-router',
      model: 'kr/auto',
    });
    const result = await session.handleInput('/models');
    expect(result).toMatchObject({ kind: 'slash', action: 'models' });
    expect(session.modelPickerOpen).toBe(true);
    expect(session.modelPickerItems().map((item) => item.model)).toEqual(['kr/auto', 'claude-lo', 'cx/gpt-5.5']);
    // The transcript carries only the command echo — no model list lines.
    expect(session.transcript).toEqual(['You › /models']);
    expect(session.transcript.join('\n')).not.toContain('claude-lo');
    await session.refreshModelPicker();
    expect(session.modelPickerOpen).toBe(true);
  });

  test('filter narrows by substring, shows the matched/total count, and Enter applies the selection', async () => {
    const session = new InteractiveSession({
      workspaceRoot: workspace(),
      providerRegistry: offlineRegistry(['kr/auto', 'claude-lo', 'kr/claude-sonnet-4-agentic']),
      providerId: 'nine-router',
      model: 'kr/auto',
    });
    await session.openModelPicker();
    const render = session.renderModelPicker();
    expect(render).toContain('Switch Model');
    expect(render).toContain('3/3');
    expect(render).toContain('nine-router');
    expect(render).toContain('type to filter');
    const widths = new Set(render.split('\n').map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);

    session.setModelPickerFilter('sonnet');
    expect(session.modelPickerItems().map((item) => item.model)).toEqual(['kr/claude-sonnet-4-agentic']);
    expect(session.renderModelPicker()).toContain('1/3');

    const accepted = session.acceptModelPickerSelection();
    expect(accepted?.text).toContain('nine-router/kr/claude-sonnet-4-agentic');
    expect(session.modelPickerOpen).toBe(false);
    expect(session.providerId).toBe('nine-router');
    expect(session.model).toBe('kr/claude-sonnet-4-agentic');
    // Exactly one confirmation line; the sidebar and composer follow the choice.
    const confirmations = session.transcript.filter((line) => line.includes('claude-sonnet'));
    expect(confirmations).toHaveLength(1);
    expect(session.renderSidebarLines().join('\n')).toContain('◇ kr/claude-sonnet-4-agentic');
    expect(session.renderScreen({ columns: 132, rows: 34 })).toContain('nine-router/kr/claude-sonnet-4-agentic');
  });

  test('arrow keys move the highlight, Esc cancels without changing the model', async () => {
    const session = new InteractiveSession({
      workspaceRoot: workspace(),
      providerRegistry: offlineRegistry(['kr/auto', 'claude-lo']),
      providerId: 'nine-router',
      model: 'kr/auto',
    });
    await session.openModelPicker();
    expect(session.selectedModelPickerItem()?.model).toBe('kr/auto');
    expect(session.handleKey('', { name: 'down' }).action).toBe('model_down');
    expect(session.selectedModelPickerItem()?.model).toBe('claude-lo');
    expect(session.handleKey('', { name: 'p', ctrl: true }).action).toBe('model_up');
    expect(session.selectedModelPickerItem()?.model).toBe('kr/auto');
    session.moveModelPickerSelection(1);
    expect(session.handleKey('', { name: 'escape' }).action).toBe('model_close');
    expect(session.modelPickerOpen).toBe(false);
    expect(session.model).toBe('kr/auto');
    expect(session.transcript.join('\n')).not.toContain('Model set to');
  });

  test('typing in the picker edits the filter and Enter accepts through handleKey', async () => {
    const session = new InteractiveSession({
      workspaceRoot: workspace(),
      providerRegistry: offlineRegistry(['kr/auto', 'claude-lo']),
      providerId: 'nine-router',
      model: 'kr/auto',
    });
    await session.openModelPicker();
    for (const ch of 'claude') expect(session.handleKey(ch, { name: ch }).action).toBe('model_filter');
    expect(session.modelPickerFilter).toBe('claude');
    expect(session.modelPickerItems()).toHaveLength(1);
    expect(session.handleKey('', { name: 'backspace' }).action).toBe('model_filter');
    expect(session.modelPickerFilter).toBe('claud');
    const accepted = session.handleKey('', { name: 'return' });
    expect(accepted.action).toBe('model_accept');
    expect(session.model).toBe('claude-lo');
    expect(session.modelPickerOpen).toBe(false);
  });

  test('picker falls back to the session model without a provider registry', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), model: 'solo-model' });
    const items = await session.openModelPicker();
    expect(items).toEqual([{ providerId: 'default', model: 'solo-model' }]);
    expect(session.acceptModelPickerSelection()?.text).toContain('solo-model');
    expect(session.transcript.filter((line) => line.includes('solo-model'))).toHaveLength(1);
  });

  test('fullscreen screen overlays the Switch Model modal within the terminal width', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `vendor/model-${i}`);
    const session = new InteractiveSession({
      workspaceRoot: workspace(),
      providerRegistry: offlineRegistry(many),
      providerId: 'nine-router',
      model: 'vendor/model-0',
    });
    await session.openModelPicker();
    session.setModelPickerFilter('model-3');
    const screen = session.renderScreen({ input: '', columns: 120, rows: 35 });
    expect(screen).toContain('Switch Model');
    expect(screen).toContain('11/40');
    expect(screen).toContain('enter confirm');
    for (const line of screen.split('\n')) {
      expect(line).not.toContain('\x1b');
      expect(visibleWidth(line)).toBeLessThanOrEqual(120);
    }
    // Non-matching models never leak into the transcript or the frame body.
    expect(session.transcript.join('\n')).not.toContain('model-7');
  });
});

describe('frame renderer safety (ghosting regression)', () => {
  test('visible width ignores ANSI escapes and counts wide glyphs as two cells', () => {
    expect(visibleWidth('\x1b[38;2;255;0;0mab\x1b[0m')).toBe(2);
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth('你好世界')).toBe(8);
    expect(visibleWidth('a\rb')).toBe(2);
  });

  test('sanitize strips escapes and control bytes but keeps text', () => {
    expect(sanitizeTerminalText('\x1b[31mred\x1b[0m plain')).toBe('red plain');
    expect(sanitizeTerminalText('a\rb\tc')).toBe('ab  c');
    expect(sanitizeTerminalText('up\x1b[2Aover')).toBe('upover');
  });

  test('truncateVisible caps cell width and never slices an escape sequence', () => {
    const truncated = truncateVisible('\x1b[31mabcdefghij\x1b[0m', 4);
    expect(truncated).not.toContain('\x1b');
    expect(visibleWidth(truncated)).toBeLessThanOrEqual(4);
    expect(truncateVisible('abcdefghij', 12)).toBe('abcdefghij');
    expect(visibleWidth(truncateVisible('你好世界你好', 5))).toBeLessThanOrEqual(5);
  });

  test('padVisibleEnd pads by visible width with ANSI or wide glyphs present', () => {
    expect(visibleWidth(padVisibleEnd('\x1b[31mab\x1b[0m', 6))).toBe(6);
    expect(visibleWidth(padVisibleEnd('你好', 6))).toBe(6);
    expect(visibleWidth(padVisibleEnd('abcdefghij', 4))).toBeLessThanOrEqual(4);
  });

  test('no frame line exceeds the terminal width at narrow or wide sizes', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), providerId: 'nine-router', model: 'claude-lo' });
    // ANSI-laden, control-laden, and wide-glyph transcript lines: exactly what
    // live formatted events push into the transcript.
    session.addTranscript(`\x1b[38;2;107;80;255m⠋\x1b[0m list_dir ${JSON.stringify({ path: '/home/xyconix11x/Ayid/xyconix11x/Skripsi/Daedalus/.daedalus/tasks/2417ea7f-7b82-4cf2-ba2c-b1425deb0ebd' })}`);
    session.addTranscript('thinking · Hai! Saya Kiro, AI coding assistant. Kamu siapa?\r');
    session.addTranscript('你好世界，这是一个很长的中文句子，用来验证宽字符不会把侧边栏挤出屏幕外面去。');
    session.addTranscript(`✔ list_dir -> ${'.daedalus/tasks/'.repeat(12)}`);
    for (const columns of [100, 132, 200]) {
      const screen = session.renderScreen({ input: 'saya siapa kamu siapa?', columns, rows: 30 });
      const lines = screen.split('\n');
      expect(lines).toHaveLength(30);
      for (const line of lines) {
        expect(line).not.toContain('\x1b');
        expect(line).not.toContain('\r');
        expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  test('sidebar separator stays at a fixed visible column on every content row', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), providerId: 'nine-router', model: 'claude-lo' });
    session.addTranscript('short line');
    session.addTranscript(`long ${'lorem ipsum dolor sit amet '.repeat(8)}`);
    const columns = 132;
    const screen = session.renderScreen({ input: '', columns, rows: 34 });
    const lines = screen.split('\n');
    const contentRows = lines.slice(0, lines.length - 4);
    const offsets = new Set<number>();
    for (const line of contentRows) {
      const sep = line.lastIndexOf('│');
      expect(sep).toBeGreaterThan(0);
      offsets.add(visibleWidth(line.slice(0, sep)));
    }
    // 132 cols → sidebar 35, main 93: separator sits at visible cell 94 always.
    expect(offsets).toEqual(new Set([94]));
  });

  test('composer and palette overlays stay within the terminal width', () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    session.addTranscript('palette test');
    session.openCommandPalette('mo');
    const screen = session.renderScreen({ input: '/mo', columns: 100, rows: 30 });
    for (const line of screen.split('\n')) {
      expect(line).not.toContain('\x1b');
      expect(visibleWidth(line)).toBeLessThanOrEqual(100);
    }
    expect(screen).toContain('Commands /mo');
  });
});

describe('casual chat never becomes a task', () => {
  test('"hai" gets a direct reply: no task, no plan, no tool lines', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), initialMode: 'ask' });
    let taskRuns = 0;
    session.setCallbacks({
      runTask: async () => { taskRuns += 1; return 'should never run'; },
      chatReply: async ({ input }) => `Halo juga! (menjawab: ${input}) Ada tugas coding?`,
    });
    const result = await session.handleInput('hai');
    expect(result.kind).toBe('chat');
    expect(result.text).toContain('Halo juga!');
    expect(taskRuns).toBe(0);
    expect(session.status).toBe('idle');
    const screen = session.renderScreen({ columns: 132, rows: 40 });
    expect(screen).toContain('Halo juga!');
    expect(screen).toContain('No active plan');
    expect(session.transcript.join('\n')).not.toContain('Plan (');
    expect(session.transcript.join('\n')).not.toContain('Task:');
  });

  test('without a chatReply callback the local fallback answers, still no task', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    let taskRuns = 0;
    session.setCallbacks({ runTask: async () => { taskRuns += 1; return 'x'; } });
    const result = await session.handleInput('kamu siapa?');
    expect(result.kind).toBe('chat');
    expect(result.text).toContain('Daedalus');
    expect(taskRuns).toBe(0);
  });

  test('a throwing provider degrades to a friendly line, never a task', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    session.setCallbacks({
      chatReply: async () => { throw new Error('provider down'); },
    });
    const result = await session.handleInput('halo');
    expect(result.kind).toBe('chat');
    expect(result.text).toContain('provider error');
  });

  test('greeting plus a real request still routes to the task path', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    session.setCallbacks({ chatReply: async () => 'should not be used' });
    await expect(session.handleInput('hai, tolong buatkan fungsi login')).resolves.toEqual({
      kind: 'task',
      text: 'hai, tolong buatkan fungsi login',
    });
    await expect(session.handleInput('hai tolong fix bug ini')).resolves.toMatchObject({ kind: 'task' });
  });

  test('conversational history accumulates for follow-ups', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    const seen: number[] = [];
    session.setCallbacks({
      chatReply: async ({ history }) => { seen.push(history.length); return 'balasan'; },
    });
    await session.handleInput('hai');
    await session.handleInput('apa kabar');
    expect(seen).toEqual([0, 2]);
    expect(session.chatHistory).toHaveLength(4);
  });
});

describe('questions are answered, never tasked', () => {
  test('a repo question gets a direct grounded answer with labeled entries and an empty plan', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), initialMode: 'ask' });
    let taskRuns = 0;
    const asked: string[] = [];
    session.setCallbacks({
      runTask: async () => { taskRuns += 1; return 'should never run'; },
      questionReply: async ({ input }) => { asked.push(input); return 'Ini repo Daedalus, framework agentic coding.'; },
    });
    const result = await session.handleInput('hai kamu siapa dan aku siapa? dan repo ini tentang apa?');
    expect(result.kind).toBe('question');
    expect(asked).toEqual(['hai kamu siapa dan aku siapa? dan repo ini tentang apa?']);
    expect(taskRuns).toBe(0);
    expect(session.status).toBe('idle');
    const transcript = session.transcript.join('\n');
    expect(transcript).toContain('You › hai kamu siapa');
    expect(transcript).toContain('Daedalus › Ini repo Daedalus');
    expect(transcript).not.toContain('Plan (');
    expect(transcript).not.toContain('Task:');
    expect(session.renderScreen({ columns: 132, rows: 40 })).toContain('No active plan');
  });

  test('questions bypass the task path in every mode', async () => {
    for (const mode of ['ask', 'manual', 'auto', 'plan', 'orchestrator'] as const) {
      const session = new InteractiveSession({ workspaceRoot: workspace(), initialMode: mode });
      session.setCallbacks({ questionReply: async () => 'jawaban langsung' });
      const result = await session.handleInput('kenapa build gagal?');
      expect(result.kind).toBe('question');
      expect(result.text).toBe('jawaban langsung');
      expect(session.transcript.join('\n')).toContain('Daedalus › jawaban langsung');
    }
  });

  test('without a questionReply callback the local fallback answers, still no task', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace(), initialMode: 'plan' });
    const result = await session.handleInput('repo ini tentang apa?');
    expect(result.kind).toBe('question');
    expect(result.text).toContain('/models');
    expect(session.transcript.join('\n')).toContain('Daedalus ›');
  });

  test('a throwing Q&A provider degrades to a friendly line, never a task', async () => {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    session.setCallbacks({ questionReply: async () => { throw new Error('provider down'); } });
    const result = await session.handleInput('apa fungsi file config.ts?');
    expect(result.kind).toBe('question');
    expect(result.text).toContain('provider error');
  });
});

describe('transcript scrolling', () => {
  function longSession(): InteractiveSession {
    const session = new InteractiveSession({ workspaceRoot: workspace() });
    for (let i = 1; i <= 60; i += 1) session.addTranscript(`line ${i}`);
    return session;
  }

  test('PgUp pages toward older lines, shows the scrolled indicator, and End jumps back', () => {
    const session = longSession();
    // rows 24 -> 20 content rows (4 footer lines); page step is 19.
    let screen = session.renderScreen({ columns: 100, rows: 24 });
    expect(screen).toContain('line 60');
    expect(screen).not.toContain('▲ scrolled');

    session.scrollTranscriptPage(1);
    expect(session.scrollOffset).toBe(19);
    screen = session.renderScreen({ columns: 100, rows: 24 });
    expect(screen).toContain('▲ scrolled — End to jump back');
    expect(screen).toContain('line 25');
    expect(screen).not.toContain('line 60');

    session.scrollTranscriptPage(1);
    screen = session.renderScreen({ columns: 100, rows: 24 });
    expect(screen).toContain('line 5');

    session.jumpTranscriptToBottom();
    expect(session.scrollOffset).toBe(0);
    screen = session.renderScreen({ columns: 100, rows: 24 });
    expect(screen).toContain('line 60');
    expect(screen).not.toContain('▲ scrolled');
  });

  test('offset clamps at the oldest line and at the bottom', () => {
    const session = longSession();
    session.renderScreen({ columns: 100, rows: 24 });
    session.scrollTranscriptPage(1);
    session.scrollTranscriptPage(1);
    session.scrollTranscriptPage(1);
    session.scrollTranscriptPage(1);
    session.renderScreen({ columns: 100, rows: 24 });
    // 60 wrapped lines, 20 visible: the farthest useful offset is 40.
    expect(session.scrollOffset).toBe(40);
    session.scrollTranscript(-1000);
    expect(session.scrollOffset).toBe(0);
  });

  test('new output does not yank a scrolled view to the bottom', () => {
    const session = longSession();
    session.renderScreen({ columns: 100, rows: 24 });
    session.scrollTranscriptPage(1);
    session.addTranscript('line 61');
    const screen = session.renderScreen({ columns: 100, rows: 24 });
    expect(session.isTranscriptScrolled).toBe(true);
    expect(screen).toContain('▲ scrolled');
    expect(screen).not.toContain('line 61');
    expect(screen).not.toContain('line 60');
  });

  test('jump-to-top shows the oldest lines', () => {
    const session = longSession();
    session.renderScreen({ columns: 100, rows: 24 });
    session.jumpTranscriptToTop();
    const screen = session.renderScreen({ columns: 100, rows: 24 });
    expect(screen).toContain('line 1');
    expect(screen).toContain('▲ scrolled');
  });
});

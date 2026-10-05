import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
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

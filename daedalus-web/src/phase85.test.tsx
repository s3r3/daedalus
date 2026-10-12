import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Event } from '@daedalus/core'
import { AGENT_MODE_ORDER, nextAgentMode } from '@daedalus/core/interaction/modes'
import { SLASH_COMMANDS, SlashCommandRegistry, slashCommandSuggestions } from '@daedalus/core/interaction/slash-commands'
import { useDaedalusStore } from './state/taskStore'
import { Composer } from './components/composer/composer'
import { SettingsPanel } from './components/settings/settings-panel'
import { SettingsDialog } from './components/settings/settings-dialog'
import { loadComposerPrefs } from './state/prefs'
import { WorkspacePanel } from './components/workspace/workspace-panel'
import { TopBar } from './components/layout/top-bar'
import { AttachmentsPanel, ChildTasksPanel } from './components/report/report-panels'
import { modeCssVar } from './theme/theme'

const session = { mode: 'auto' as const, autoApprove: false, thinkingLevel: 'medium' as const, workspaceRoot: '/workspace' }
const provider = {
  id: 'nine-router',
  name: '9Router (Farid)',
  baseUrl: 'https://llm.ayid.cc.cd/v1',
  apiKeyMasked: 'sk-…1234',
  hasApiKey: true,
  models: ['kr/auto'],
  defaultModel: 'kr/auto',
  enabled: true,
  supportsVision: true,
}
const presets = [
  { id: 'nine-router', name: '9Router (Farid)', baseUrl: 'https://llm.ayid.cc.cd/v1', supportsVision: true },
  { id: 'custom', name: 'Custom OpenAI-compatible', baseUrl: '' },
]
const modelOptions = [
  { providerId: 'nine-router', model: 'kr/auto', supportsVision: true },
  { providerId: 'fake', model: 'text-only', supportsVision: false },
]

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  session: vi.fn(),
  updateSession: vi.fn(),
  setMode: vi.fn(),
  cycleMode: vi.fn(),
  setAutoApprove: vi.fn(),
  providers: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setProviderEnabled: vi.fn(),
  testProvider: vi.fn(),
  models: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  task: vi.fn(),
  taskEvents: vi.fn(),
  extensionsStatus: vi.fn(),
  taskAttachments: vi.fn(),
  cancelTask: vi.fn(),
  approve: vi.fn(),
  roots: vi.fn(),
  pins: vi.fn(),
  savePins: vi.fn(),
  tree: vi.fn(),
  list: vi.fn(),
  file: vi.fn(),
  createWorkspace: vi.fn(),
  createFolder: vi.fn(),
  createFile: vi.fn(),
  renameWorkspaceEntry: vi.fn(),
  saveFile: vi.fn(),
  upload: vi.fn(),
  uploadJson: vi.fn(),
}))

vi.mock('./api/client', () => ({ api: mocks }))

function resetMocks(): void {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.settings.mockResolvedValue({
    settings: {
      llm: { temperature: 0.7, promptCaching: false, models: ['kr/auto'] },
      tailor: { modelRouting: true, qualityEscalation: true, reviewGate: false, earlyEscalation: true },
      outputCompression: true,
      maxIterations: 25,
      context: { limitTokens: 128000 },
      domains: {},
    },
    session,
    providers: [provider],
  })
  mocks.updateSettings.mockImplementation(async (input: Record<string, unknown>) => ({
    settings: { domains: (input.domains as Record<string, unknown> | undefined) ?? {} },
    session,
  }))
  mocks.session.mockResolvedValue({ session })
  mocks.updateSession.mockImplementation(async (input: Record<string, unknown>) => ({ session: { ...session, ...input } }))
  mocks.setMode.mockImplementation(async (mode: string) => ({ session: { ...session, mode } }))
  mocks.cycleMode.mockResolvedValue({ session: { ...session, mode: 'plan' } })
  mocks.setAutoApprove.mockImplementation(async (enabled: boolean) => ({ session: { ...session, autoApprove: enabled } }))
  mocks.providers.mockResolvedValue({ providers: [provider], presets })
  mocks.createProvider.mockResolvedValue({ provider })
  mocks.updateProvider.mockResolvedValue({ provider })
  mocks.deleteProvider.mockResolvedValue({ removed: true, id: provider.id })
  mocks.setProviderEnabled.mockResolvedValue({ provider })
  mocks.testProvider.mockResolvedValue({ ok: true, providerId: provider.id, models: ['kr/auto'], message: 'Connection OK (1 models)' })
  mocks.models.mockResolvedValue({ models: modelOptions, session, count: modelOptions.length })
  mocks.listTasks.mockResolvedValue({ tasks: [], count: 0 })
  mocks.createTask.mockResolvedValue({ id: 'task-new', goal: 'do it', repo_path: '/workspace', created_at: new Date().toISOString() })
  mocks.task.mockResolvedValue({ events: [], report: null, running: false })
  mocks.taskEvents.mockResolvedValue({ events: [], count: 0, task: { id: 'task-1', status: 'active', event_count: 0, last_seq: 0, last_event: null, updated_at: null, running: false } })
  mocks.extensionsStatus.mockResolvedValue({ root: '/workspace', mcp: [], skills: [], lsp: [], problems: [] })
  mocks.taskAttachments.mockResolvedValue({ attachments: [], count: 0 })
  mocks.cancelTask.mockResolvedValue({ cancelled: true, task_id: 'task-1' })
  mocks.roots.mockResolvedValue({ roots: [{ path: '/workspace', name: 'workspace' }], cwd: '/workspace' })
  mocks.pins.mockResolvedValue({ root: '/workspace', pins: [] })
  mocks.savePins.mockResolvedValue({ root: '/workspace', pins: [] })
  mocks.tree.mockResolvedValue({ name: 'workspace', path: '.', isDirectory: true, children: [] })
  mocks.list.mockResolvedValue({ path: '.', items: [] })
  mocks.file.mockResolvedValue({ path: 'README.md', content: 'hello', size: 5 })
  mocks.createWorkspace.mockResolvedValue({ path: '/workspace/app', name: 'app', root: '/workspace', session })
  mocks.createFolder.mockResolvedValue({ path: 'src/components', absolute: '/workspace/src/components', root: '/workspace' })
  mocks.createFile.mockResolvedValue({ path: 'src/index.ts', absolute: '/workspace/src/index.ts', root: '/workspace', size: 10 })
  mocks.renameWorkspaceEntry.mockResolvedValue({ from: 'src/index.ts', to: 'src/main.ts', root: '/workspace' })
  mocks.saveFile.mockResolvedValue({ path: 'src/main.ts', absolute: '/workspace/src/main.ts', root: '/workspace' })
  mocks.upload.mockResolvedValue({
    attachments: [{ id: 'att-1', workspacePath: '.daedalus/attachments/uploads/hello.txt', name: 'hello.txt', kind: 'file', size: 5, createdAt: new Date().toISOString() }],
    files: [{ path: '.daedalus/attachments/uploads/hello.txt', size: 5 }],
    limits: { maxFiles: 20, maxFileBytes: 10, maxTotalBytes: 25, maxZipEntries: 200, maxZipUncompressedBytes: 50 },
    destination: '.daedalus/attachments/uploads',
  })
}

let seq = 0
function ev(type: string, payload: unknown, taskId = 'task-1'): Event {
  seq += 1
  return { seq, task_id: taskId, ts: new Date().toISOString(), type, payload } as Event
}

function textOf(node: Element | null): string {
  return node?.textContent ?? ''
}

beforeEach(() => {
  seq = 0
  resetMocks()
  useDaedalusStore.getState().reset()
})

afterEach(() => cleanup())

describe('shared core interaction contracts in Web', () => {
  test('mode cycle order is Ask → Manual → Auto → Plan (orchestrator retired)', () => {
    expect(AGENT_MODE_ORDER).toEqual(['ask', 'manual', 'auto', 'plan'])
    expect(nextAgentMode('ask')).toBe('manual')
    expect(nextAgentMode('manual')).toBe('auto')
    expect(nextAgentMode('auto')).toBe('plan')
    expect(nextAgentMode('plan')).toBe('ask')
    // Legacy records still resolve: the retired name cycles as Auto's slot.
    expect(nextAgentMode('orchestrator')).toBe('ask')
    expect(modeCssVar('orchestrator')).toBe('var(--daedalus-modeOrchestrator)')
  })

  test('slash suggestions and help come from the shared core registry', () => {
    expect(slashCommandSuggestions('/mo').map((command) => command.name)).toEqual(expect.arrayContaining(['mode', 'models']))
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining(['help', 'mode', 'models', 'providers', 'settings', 'auto-approve', 'plan', 'workspace', 'files', 'upload', 'image', 'diff', 'validate', 'new', 'clear', 'status', 'cancel', 'exit']),
    )
    expect(new SlashCommandRegistry().help()).toContain('/auto-approve')
  })
})

describe('Composer Phase 8.5', () => {
  test('mode badge uses the shared mode token and Shift+Tab cycles at the session boundary', async () => {
    useDaedalusStore.getState().setComposer({ mode: 'ask' })
    render(<Composer />)
    expect(screen.getByTestId('mode-badge').getAttribute('data-mode')).toBe('ask')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Tab', shiftKey: true })
    await screen.findByText(/Mode set to manual/)
    expect(mocks.setMode).toHaveBeenCalledWith('manual')
    expect(useDaedalusStore.getState().composer.mode).toBe('manual')
  })

  test('typing slash shows the shared palette and clicking fills the command', async () => {
    render(<Composer />)
    await userEvent.type(screen.getByTestId('composer-input'), '/mo')
    const palette = screen.getByTestId('slash-palette')
    expect(textOf(palette)).toContain('/mode')
    expect(textOf(palette)).toContain('/models')
    await userEvent.click(screen.getAllByTestId('slash-suggestion')[0] as HTMLElement)
    expect(useDaedalusStore.getState().composer.goal.startsWith('/')).toBe(true)
  })

  test('/mode and /auto-approve execute through the shared registry and gateway session', async () => {
    useDaedalusStore.getState().setComposer({ goal: '/mode plan' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.setMode).toHaveBeenCalledWith('plan')
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('Mode set to plan')

    cleanup()
    useDaedalusStore.getState().setComposer({ goal: '/auto-approve on' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.setAutoApprove).toHaveBeenCalledWith(true)
  })

  test('/models lists the enabled-provider model union and unknown commands are honest', async () => {
    useDaedalusStore.getState().setComposer({ goal: '/models' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.models).toHaveBeenCalled()
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('nine-router/kr/auto')

    cleanup()
    useDaedalusStore.getState().setComposer({ goal: '/definitely-not-a-command' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(textOf(await screen.findByTestId('slash-output'))).toContain('Try /help')
  })

  test('image attachments warn and are stripped when the selected model is not vision-capable', async () => {
    useDaedalusStore.getState().setModels(modelOptions)
    useDaedalusStore.getState().setComposer({
      goal: 'describe this image',
      providerId: 'fake',
      model: 'text-only',
      attachments: [{ id: 'img-1', workspacePath: '.daedalus/attachments/uploads/pic.png', name: 'pic.png', kind: 'image', size: 12, createdAt: new Date().toISOString() }],
    })
    render(<Composer />)
    expect(textOf(screen.getByTestId('vision-warning'))).toContain('does not support vision')
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ attachments: [] }))
  })

  test('upload stages the attachment returned by the gateway', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    render(<Composer />)
    const input = screen.getByTestId('composer-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })] } })
    expect(await screen.findByTestId('attachment-chip')).toBeTruthy()
    expect(mocks.upload).toHaveBeenCalled()
    expect(textOf(screen.getByTestId('attachment-chips'))).toContain('hello.txt')
  })
})

describe('SettingsPanel Phase 8.5', () => {
  test('providers are masked, testable, and a new API key is sent only through the form', async () => {
    render(<SettingsPanel />)
    const row = await screen.findByTestId('provider-row')
    expect(textOf(row)).toContain('sk-…1234')
    expect(document.body.textContent).not.toContain('super-secret')
    await userEvent.click(within(row).getByText('test'))
    expect(mocks.testProvider).toHaveBeenCalledWith('nine-router')
    expect(textOf(await screen.findByTestId('settings-status'))).toContain('Connection OK')

    await userEvent.type(screen.getByLabelText('provider base URL'), 'https://example.test/v1')
    await userEvent.type(screen.getByLabelText('provider API key'), 'new-secret-value')
    await userEvent.click(screen.getByText('add provider'))
    expect(mocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'new-secret-value', baseUrl: 'https://example.test/v1' }))
    expect((screen.getByLabelText('provider API key') as HTMLInputElement).value).toBe('')
  })
})

describe('SettingsDialog and functional settings', () => {
  test('the dialog shows the settings panel and closes via its button and backdrop', async () => {
    useDaedalusStore.getState().setSettingsOpen(true)
    render(<SettingsDialog />)
    expect(screen.getByTestId('settings-dialog')).toBeTruthy()
    expect(screen.getByTestId('settings-panel')).toBeTruthy()
    await userEvent.click(screen.getByTestId('settings-close'))
    expect(useDaedalusStore.getState().settingsOpen).toBe(false)

    cleanup()
    useDaedalusStore.getState().setSettingsOpen(true)
    render(<SettingsDialog />)
    await userEvent.click(screen.getByTestId('settings-backdrop'))
    expect(useDaedalusStore.getState().settingsOpen).toBe(false)
  })

  test('Escape closes the dialog', () => {
    useDaedalusStore.getState().setSettingsOpen(true)
    render(<SettingsDialog />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(useDaedalusStore.getState().settingsOpen).toBe(false)
  })

  test('the thinking level selector writes through to the gateway session', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    const select = screen.getByTestId('settings-thinking-level') as HTMLSelectElement
    expect(select.value).toBe('medium')
    await userEvent.selectOptions(select, 'off')
    expect(mocks.updateSession).toHaveBeenCalledWith({ thinkingLevel: 'off' })
    expect(textOf(await screen.findByTestId('settings-status'))).toContain('Thinking off')
  })

  test('mode and auto-approve live in the composer only — not in the settings panel', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    expect(screen.queryByTestId('settings-mode-badge')).toBeNull()
    expect(screen.queryByLabelText('settings agent mode')).toBeNull()
  })

  test('max iterations is a server-side global setting now', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    const input = screen.getByTestId('settings-max-iterations') as HTMLInputElement
    expect(input.value).toBe('25')
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.blur(input)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ maxIterations: 9 })
    expect(textOf(await screen.findByTestId('settings-status'))).toContain('Max iterations global 9')
  })

  test('temperature and prompt caching persist server-side', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    const temp = screen.getByTestId('settings-temperature') as HTMLInputElement
    fireEvent.change(temp, { target: { value: '0.2' } })
    fireEvent.blur(temp)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ llm: { temperature: 0.2 } })

    const caching = screen.getByTestId('settings-prompt-caching') as HTMLInputElement
    expect(caching.checked).toBe(false)
    await userEvent.click(caching)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ llm: { promptCaching: true } })
    expect(textOf(screen.getByTestId('prompt-caching-settings'))).toContain('aktif penuh setelah mesin prompt-caching mendarat')
  })

  test('the model pool moved to Global: comma-separated input, failover-only, round-robin gone', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    const pool = screen.getByTestId('settings-model-pool') as HTMLInputElement
    expect(pool.value).toBe('kr/auto')
    await userEvent.clear(pool)
    await userEvent.type(pool, 'alpha-model, beta-model')
    fireEvent.blur(pool)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ llm: { models: ['alpha-model', 'beta-model'] } })

    // The strategy dropdown is gone; the label is a static failover.
    expect(screen.queryByTestId('settings-model-strategy')).toBeNull()
    expect(textOf(screen.getByTestId('model-pool-strategy'))).toBe('failover')
    expect(textOf(screen.getByTestId('model-pool-settings'))).toContain('Round-robin dihapus')

    // The composer no longer sends a pool or a strategy with the task.
    cleanup()
    useDaedalusStore.getState().setComposer({ goal: 'pool task' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    const payload = mocks.createTask.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('models')
    expect(payload).not.toHaveProperty('model_strategy')
  })

  test('review gate and escalation toggles show the disabled hint with fewer than 2 pool models', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    // The mocked settings carry a 1-model pool: every pool-gated toggle is disabled with the hint.
    for (const testId of ['settings-review-gate', 'settings-early-escalation', 'settings-model-routing', 'settings-quality-escalation']) {
      expect((screen.getByTestId(testId) as HTMLInputElement).disabled).toBe(true)
    }
    expect(screen.getAllByText('butuh pool 2+ model').length).toBeGreaterThanOrEqual(4)

    // With 2+ models typed, the toggles enable and the hints disappear.
    const pool = screen.getByTestId('settings-model-pool') as HTMLInputElement
    await userEvent.clear(pool)
    await userEvent.type(pool, 'alpha-model, beta-model')
    for (const testId of ['settings-review-gate', 'settings-early-escalation', 'settings-model-routing', 'settings-quality-escalation']) {
      expect((screen.getByTestId(testId) as HTMLInputElement).disabled).toBe(false)
    }
    expect(screen.queryByText('butuh pool 2+ model')).toBeNull()

    // The new tailor toggles write through with honest labels.
    await userEvent.click(screen.getByTestId('settings-model-routing'))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ tailor: { modelRouting: false } })
    expect(textOf(screen.getByTestId('model-routing-settings'))).toContain('routing model per fase')
    await userEvent.click(screen.getByTestId('settings-quality-escalation'))
    expect(mocks.updateSettings).toHaveBeenCalledWith({ tailor: { qualityEscalation: false } })
    expect(textOf(screen.getByTestId('quality-escalation-settings'))).toContain('eskalasi kualitas')
  })

  test('tab switching renders the domain tab with ikut-global defaults and the effective caption', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    await userEvent.click(screen.getByTestId('settings-tab-slide'))
    const tab = screen.getByTestId('settings-tab-domain-slide')
    expect(textOf(tab)).toContain('Ikut global')
    // No overrides stored: the effective line follows the global settings.
    expect(textOf(screen.getByTestId('domain-effective-slide'))).toContain('efektif:')
    expect(textOf(screen.getByTestId('domain-effective-slide'))).toContain('temp 0.7')
  })

  test('a domain override saves through PUT /settings and the draft reflects it', async () => {
    mocks.models.mockResolvedValue({ models: modelOptions, session, count: modelOptions.length })
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    await userEvent.click(screen.getByTestId('settings-tab-slide'))

    await userEvent.selectOptions(screen.getByTestId('domain-model-slide'), 'nine-router::kr/auto')
    fireEvent.change(screen.getByTestId('domain-temperature-slide'), { target: { value: '0.3' } })
    fireEvent.change(screen.getByTestId('domain-max-iterations-slide'), { target: { value: '' } })
    await userEvent.click(screen.getByTestId('domain-save-slide'))

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      domains: { slide: { model: 'kr/auto', temperature: 0.3, maxIterations: null } },
    })
    expect(textOf(await screen.findByTestId('settings-status'))).toContain('Override Slide disimpan')
    // The echoed response drives the draft: model kept, temperature kept, iterations cleared.
    expect((screen.getByTestId('domain-temperature-slide') as HTMLInputElement).value).toBe('0.3')
    expect((screen.getByTestId('domain-max-iterations-slide') as HTMLInputElement).value).toBe('')
  })

  test('the composer per-task controls flow into the task payload and persist in this browser', async () => {
    localStorage.clear()
    useDaedalusStore.getState().setModels(modelOptions)
    render(<Composer />)
    // Token budget.
    const budget = screen.getByTestId('composer-token-budget') as HTMLInputElement
    expect(budget.placeholder).toContain('kosong = tanpa batas')
    fireEvent.change(budget, { target: { value: '75000' } })
    // Tool rules.
    fireEvent.change(screen.getByTestId('composer-tool-rules-allow'), { target: { value: 'read_file, list_dir' } })
    fireEvent.change(screen.getByTestId('composer-tool-rules-deny'), { target: { value: 'delete_file' } })
    // One-shot model override: the "model tugas ini" picker sets the taskModel override.
    await userEvent.click(screen.getByTestId('task-model-picker-button'))
    const options = screen.getAllByTestId('model-option')
    await userEvent.click(options.find((option) => option.getAttribute('data-value') === 'nine-router/kr/auto') as HTMLElement)

    const composer = useDaedalusStore.getState().composer
    expect(composer.tokenBudget).toBe(75000)
    expect(composer.taskModel).toBe('nine-router::kr/auto')
    expect(composer.toolRules).toEqual({ allow: ['read_file', 'list_dir'], ask: [], deny: ['delete_file'] })
    // Persisted to the browser prefs.
    expect(loadComposerPrefs().tokenBudget).toBe(75000)
    expect(loadComposerPrefs().taskModel).toBe('nine-router::kr/auto')

    useDaedalusStore.getState().setComposer({ goal: 'per-task controls' })
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'per-task controls',
        provider_id: 'nine-router',
        model: 'kr/auto',
        token_budget: 75000,
        tool_rules: { allow: ['read_file', 'list_dir'], ask: [], deny: ['delete_file'] },
      }),
    )
  })
})

describe('WorkspacePanel Phase 8.5', () => {
  test('creates folders and files inside the selected workspace', async () => {
    render(<WorkspacePanel />)
    await screen.findByTestId('workspace-actions')
    await userEvent.type(screen.getByLabelText('new folder path'), 'src/components')
    await userEvent.click(screen.getByTestId('workspace-create-folder'))
    expect(mocks.createFolder).toHaveBeenCalledWith('/workspace', 'src/components')
    expect(textOf(await screen.findByTestId('workspace-status'))).toContain('Folder created')

    await userEvent.type(screen.getByLabelText('new file path'), 'src/index.ts')
    await userEvent.click(screen.getByTestId('workspace-create-file'))
    expect(mocks.createFile).toHaveBeenCalledWith('/workspace', 'src/index.ts', '')
  })

  test('upload preserves the selected workspace root and stages attachments', async () => {
    render(<WorkspacePanel />)
    await screen.findByTestId('workspace-actions')
    const input = screen.getByTestId('workspace-file-input') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })] } })
    expect(textOf(await screen.findByTestId('workspace-status'))).toContain('Uploaded 1 file')
    expect(mocks.upload).toHaveBeenCalled()
    expect(useDaedalusStore.getState().composer.attachments[0]?.name).toBe('hello.txt')
  })
})

describe('TopBar and report panels Phase 8.5', () => {
  test('top bar shows mode/provider/model and toggles settings', async () => {
    useDaedalusStore.getState().setComposer({ mode: 'plan', providerId: 'nine-router', model: 'kr/auto', autoApprove: true })
    render(<TopBar />)
    expect(screen.getByTestId('topbar-mode-badge').getAttribute('data-mode')).toBe('plan')
    expect(textOf(screen.getByTestId('topbar-model-summary'))).toContain('nine-router/kr/auto')
    await userEvent.click(screen.getByTestId('settings-toggle'))
    expect(useDaedalusStore.getState().settingsOpen).toBe(true)
  })

  test('attachment and child task panels derive from Phase 8.5 events', () => {
    const attachment = { id: 'att-1', taskId: 'task-1', workspacePath: '.daedalus/attachments/task-1/pic.png', name: 'pic.png', kind: 'image' as const, size: 42, createdAt: new Date().toISOString() }
    const child = { id: 'child-1', parent_task_id: 'task-1', goal: 'write tests', status: 'done' as const, result_summary: 'tests written', created_at: new Date().toISOString(), budget: { max_iterations: 5, max_errors: 2 } }
    useDaedalusStore.setState({
      taskId: 'task-1',
      events: [ev('ATTACHMENT_ADDED', { attachment }), ev('CHILD_TASK_STARTED', { child: { ...child, status: 'running' } }), ev('CHILD_TASK_FINISHED', { child })],
    })
    render(
      <>
        <AttachmentsPanel />
        <ChildTasksPanel />
      </>,
    )
    expect(textOf(screen.getByTestId('attachments-panel'))).toContain('pic.png')
    expect(textOf(screen.getByTestId('child-tasks-panel'))).toContain('write tests')
    expect(textOf(screen.getByTestId('child-tasks-panel'))).toContain('tests written')
  })
})

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

const session = { mode: 'auto' as const, autoApprove: false, thinking: true, workspaceRoot: '/workspace' }
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
  mocks.settings.mockResolvedValue({ settings: { llm: { apiKey: '«redacted»' } }, session, providers: [provider] })
  mocks.updateSettings.mockResolvedValue({ settings: {}, session })
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
  test('mode cycle order is Ask → Manual → Auto → Plan → Orchestrator', () => {
    expect(AGENT_MODE_ORDER).toEqual(['ask', 'manual', 'auto', 'plan', 'orchestrator'])
    expect(nextAgentMode('ask')).toBe('manual')
    expect(nextAgentMode('manual')).toBe('auto')
    expect(nextAgentMode('auto')).toBe('plan')
    expect(nextAgentMode('plan')).toBe('orchestrator')
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

  test('the thinking toggle writes through to the gateway session and the composer', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    const toggle = screen.getByTestId('settings-thinking') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await userEvent.click(toggle)
    expect(mocks.updateSession).toHaveBeenCalledWith({ thinking: false })
    expect(useDaedalusStore.getState().composer.thinking).toBe(false)
  })

  test('max iterations persists in the browser and flows into the next task payload', async () => {
    localStorage.clear()
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    fireEvent.change(screen.getByTestId('settings-max-iterations'), { target: { value: '9' } })
    expect(useDaedalusStore.getState().composer.maxIterations).toBe(9)
    expect(loadComposerPrefs().maxIterations).toBe(9)

    cleanup()
    useDaedalusStore.getState().setComposer({ goal: 'ship it' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.createTask).toHaveBeenCalledWith(expect.objectContaining({ goal: 'ship it', max_iterations: 9 }))
  })

  test('a saved model pool flows into the next task payload with its strategy', async () => {
    localStorage.clear()
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    await userEvent.type(screen.getByTestId('settings-model-pool'), 'alpha-model, beta-model')
    await userEvent.selectOptions(screen.getByTestId('settings-model-strategy'), 'round-robin')
    expect(useDaedalusStore.getState().composer.modelPool).toBe('alpha-model, beta-model')
    expect(useDaedalusStore.getState().composer.modelStrategy).toBe('round-robin')
    expect(loadComposerPrefs().modelPool).toBe('alpha-model, beta-model')

    cleanup()
    useDaedalusStore.getState().setComposer({ goal: 'pool task' })
    render(<Composer />)
    await userEvent.click(screen.getByTestId('composer-submit'))
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ goal: 'pool task', models: ['alpha-model', 'beta-model'], model_strategy: 'round-robin' }),
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

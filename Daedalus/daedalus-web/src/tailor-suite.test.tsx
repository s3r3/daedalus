import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useDaedalusStore } from './state/taskStore'
import { SettingsPanel } from './components/settings/settings-panel'
import { WorkspacePanel } from './components/workspace/workspace-panel'

const session = { mode: 'auto' as const, autoApprove: false, thinking: true, workspaceRoot: '/workspace' }
const provider = {
  id: 'nine-router',
  name: '9Router (Farid)',
  baseUrl: 'http://127.0.0.1:20128/v1',
  apiKeyMasked: 'sk-…1234',
  hasApiKey: true,
  models: ['weak-m', 'strong-m'],
  modelTiers: { 'weak-m': 'fast' },
  defaultModel: 'weak-m',
  enabled: true,
  supportsVision: false,
}
const presets = [{ id: 'nine-router', name: '9Router (Farid)', baseUrl: 'https://llm.ayid.cc.cd/v1', supportsVision: true }]

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  session: vi.fn(),
  updateSession: vi.fn(),
  providers: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setProviderEnabled: vi.fn(),
  testProvider: vi.fn(),
  models: vi.fn(),
  roots: vi.fn(),
  tree: vi.fn(),
  list: vi.fn(),
  file: vi.fn(),
  pins: vi.fn(),
  savePins: vi.fn(),
}))

vi.mock('./api/client', () => ({ api: mocks }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.mockResolvedValue({
    settings: { llm: { apiKey: '«redacted»' }, tailor: { reviewGate: false, modelRouting: true, qualityEscalation: true } },
    session,
    providers: [provider],
  })
  mocks.updateSettings.mockResolvedValue({ settings: {}, session })
  mocks.session.mockResolvedValue({ session })
  mocks.providers.mockResolvedValue({ providers: [provider], presets })
  mocks.createProvider.mockResolvedValue({ provider })
  mocks.updateProvider.mockResolvedValue({ provider })
  mocks.deleteProvider.mockResolvedValue({ removed: true, id: provider.id })
  mocks.setProviderEnabled.mockResolvedValue({ provider })
  mocks.testProvider.mockResolvedValue({ ok: true, providerId: provider.id, models: [], message: 'OK' })
  mocks.models.mockResolvedValue({ models: [], session, count: 0 })
  mocks.roots.mockResolvedValue({ roots: [{ path: '/workspace', name: 'workspace' }], cwd: '/workspace' })
  mocks.tree.mockResolvedValue({
    name: 'workspace',
    path: '.',
    isDirectory: true,
    children: [{ name: 'index.ts', path: 'src/index.ts', isDirectory: false }],
  })
  mocks.list.mockResolvedValue({ path: '.', items: [] })
  mocks.file.mockResolvedValue({ path: 'src/index.ts', content: 'hello', size: 5 })
  mocks.pins.mockResolvedValue({ root: '/workspace', pins: [] })
  mocks.savePins.mockResolvedValue({ root: '/workspace', pins: ['src/index.ts'] })
})

afterEach(() => cleanup())

describe('tailor suite Web surfaces', () => {
  test('per-model tier selects save into the provider modelTiers', async () => {
    render(<SettingsPanel />)
    const row = await screen.findByTestId('provider-row')
    expect(row.textContent).toContain('tiers:')
    await userEvent.click(within(row).getByText('edit'))
    const editor = await screen.findByTestId('model-tier-editor')
    const selects = within(editor).getAllByTestId('model-tier-select')
    const strongSelect = selects.find((el) => el.getAttribute('data-model') === 'strong-m') as HTMLSelectElement
    expect(strongSelect).toBeTruthy()
    await userEvent.selectOptions(strongSelect, 'strong')
    await userEvent.click(screen.getByText('save provider'))
    expect(mocks.updateProvider).toHaveBeenCalledWith(
      'nine-router',
      expect.objectContaining({ modelTiers: { 'weak-m': 'fast', 'strong-m': 'strong' } }),
    )
  })

  test('review gate toggle posts the tailor settings update', async () => {
    render(<SettingsPanel />)
    await screen.findByTestId('provider-row')
    const toggle = await screen.findByTestId('settings-review-gate')
    await userEvent.click(toggle)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ tailor: { reviewGate: true } })
  })

  test('workspace pin toggle persists through the pins endpoint', async () => {
    useDaedalusStore.getState().setWorkspace({ root: '/workspace' })
    render(<WorkspacePanel />)
    const pinButton = await screen.findByTestId('file-tree-pin')
    expect(pinButton.getAttribute('data-path')).toBe('src/index.ts')
    expect(pinButton.getAttribute('data-pinned')).toBe('false')
    await userEvent.click(pinButton)
    expect(mocks.savePins).toHaveBeenCalledWith('/workspace', ['src/index.ts'])
    expect((await screen.findByTestId('file-tree-pin')).getAttribute('data-pinned')).toBe('true')
  })
})

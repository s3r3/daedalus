import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsPanel } from './components/settings/settings-panel'

const session = { mode: 'auto' as const, autoApprove: false, thinking: true, workspaceRoot: '/workspace' }
const provider = {
  id: 'nine-router',
  name: '9Router',
  baseUrl: 'http://127.0.0.1:20128/v1',
  apiKeyMasked: 'sk-…1234',
  hasApiKey: true,
  models: ['weak-m'],
  modelTiers: {},
  defaultModel: 'weak-m',
  enabled: true,
  supportsVision: false,
}
const presets = [{ id: 'nine-router', name: '9Router', baseUrl: 'https://llm.ayid.cc.cd/v1', supportsVision: true }]

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
}))

vi.mock('./api/client', () => ({ api: mocks }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings.mockResolvedValue({
    settings: { llm: { apiKey: '«redacted»' }, tailor: { reviewGate: false }, outputCompression: true },
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
})

afterEach(() => cleanup())

describe('output compression setting', () => {
  test('toggle reflects the setting and posts the update', async () => {
    render(<SettingsPanel />)
    const toggle = (await screen.findByTestId('settings-output-compression')) as HTMLInputElement
    expect(toggle.checked).toBe(true)
    await userEvent.click(toggle)
    expect(mocks.updateSettings).toHaveBeenCalledWith({ outputCompression: false })
  })
})

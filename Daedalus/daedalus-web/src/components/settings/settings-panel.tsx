import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, PlugZap, RefreshCw, Save, Trash2 } from 'lucide-react'
import type { AgentMode, ProviderConfigPublic } from '@daedalus/core'
import { AGENT_MODE_ORDER } from '@daedalus/core/interaction/modes'
import { api } from '../../api/client'
import type { ProviderInput, ProviderPreset } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Panel } from '../common/panel'
import { MODE_LABELS, modeCssVar } from '../../theme/theme'

type ProviderForm = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string
  defaultModel: string
  enabled: boolean
  supportsVision: boolean
}

const EMPTY_FORM: ProviderForm = {
  id: 'custom',
  name: 'Custom OpenAI-compatible',
  baseUrl: '',
  apiKey: '',
  models: '',
  defaultModel: '',
  enabled: true,
  supportsVision: false,
}

/**
 * Provider/session settings. API keys are write-only here: the form sends a new
 * key to the gateway, while every provider shown back to the browser is the
 * masked public view returned by the server.
 */
export function SettingsPanel() {
  const providers = useDaedalusStore((state) => state.providers)
  const presets = useDaedalusStore((state) => state.providerPresets)
  const models = useDaedalusStore((state) => state.models)
  const composer = useDaedalusStore((state) => state.composer)
  const session = useDaedalusStore((state) => state.session)
  const setProviders = useDaedalusStore((state) => state.setProviders)
  const setModels = useDaedalusStore((state) => state.setModels)
  const setSession = useDaedalusStore((state) => state.setSession)
  const setComposer = useDaedalusStore((state) => state.setComposer)

  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadAll = useCallback(async (): Promise<void> => {
    setError(null)
    const [settingsResult, providersResult, modelsResult] = await Promise.allSettled([api.settings(), api.providers(), api.models()])
    if (settingsResult.status === 'fulfilled') {
      setSession(settingsResult.value.session)
      if (settingsResult.value.providers) setProviders(settingsResult.value.providers)
    }
    if (providersResult.status === 'fulfilled') setProviders(providersResult.value.providers, providersResult.value.presets)
    if (modelsResult.status === 'fulfilled') setModels(modelsResult.value.models)
    const failure = [settingsResult, providersResult, modelsResult].find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') setError(errorMessage(failure.reason))
  }, [setModels, setProviders, setSession])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const enabledProviders = useMemo(() => providers.filter((provider) => provider.enabled), [providers])

  const applyPreset = (preset: ProviderPreset): void => {
    setEditingId(null)
    setForm({
      id: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: '',
      models: preset.defaultModel ?? '',
      defaultModel: preset.defaultModel ?? '',
      enabled: true,
      supportsVision: Boolean(preset.supportsVision),
    })
  }

  const editProvider = (provider: ProviderConfigPublic): void => {
    setEditingId(provider.id)
    setForm({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: '',
      models: provider.models.join(', '),
      defaultModel: provider.defaultModel ?? '',
      enabled: provider.enabled,
      supportsVision: Boolean(provider.supportsVision),
    })
  }

  const formToInput = (): ProviderInput => ({
    id: form.id.trim(),
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    models: form.models.split(',').map((model) => model.trim()).filter(Boolean),
    defaultModel: form.defaultModel.trim() || undefined,
    enabled: form.enabled,
    supportsVision: form.supportsVision,
  })

  const saveProvider = async (): Promise<ProviderConfigPublic | null> => {
    setBusy(true)
    setError(null)
    try {
      const input = formToInput()
      const response = editingId ? await api.updateProvider(editingId, input) : await api.createProvider(input)
      setStatus(`Saved provider ${response.provider.name}.`)
      setForm((current) => ({ ...current, apiKey: '' }))
      await loadAll()
      return response.provider
    } catch (caught) {
      setError(errorMessage(caught))
      return null
    } finally {
      setBusy(false)
    }
  }

  const testProvider = async (providerId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.testProvider(providerId)
      setStatus(result.message)
      await loadAll()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const testFormProvider = async (): Promise<void> => {
    const saved = await saveProvider()
    if (saved) await testProvider(saved.id)
  }

  const toggleProvider = async (provider: ProviderConfigPublic): Promise<void> => {
    setBusy(true)
    try {
      await api.setProviderEnabled(provider.id, !provider.enabled)
      await loadAll()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const removeProvider = async (provider: ProviderConfigPublic): Promise<void> => {
    setBusy(true)
    try {
      await api.deleteProvider(provider.id)
      if (editingId === provider.id) {
        setEditingId(null)
        setForm(EMPTY_FORM)
      }
      setStatus(`Removed provider ${provider.name}.`)
      await loadAll()
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const changeMode = async (mode: AgentMode): Promise<void> => {
    setComposer({ mode })
    try {
      const response = await api.setMode(mode)
      setSession(response.session)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const changeAutoApprove = async (enabled: boolean): Promise<void> => {
    setComposer({ autoApprove: enabled })
    try {
      const response = await api.setAutoApprove(enabled)
      setSession(response.session)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const changeModel = async (value: string): Promise<void> => {
    if (!value) return
    const [providerId, ...rest] = value.split('::')
    const model = rest.join('::')
    setComposer({ providerId, model })
    try {
      const response = await api.updateSession({ providerId, model })
      setSession(response.session)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <Panel
      title="settings & providers"
      data-testid="settings-panel"
      action={
        <Button variant="ghost" size="sm" onClick={() => void loadAll()} disabled={busy} aria-label="refresh settings">
          <RefreshCw /> refresh
        </Button>
      }
      bodyClassName="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-2" data-testid="session-settings">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ borderColor: modeCssVar(composer.mode), color: modeCssVar(composer.mode) }}
            data-testid="settings-mode-badge"
          >
            {MODE_LABELS[composer.mode]}
          </span>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            mode
            <select
              aria-label="settings agent mode"
              className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
              value={composer.mode}
              onChange={(event) => void changeMode(event.target.value as AgentMode)}
            >
              {AGENT_MODE_ORDER.map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <input type="checkbox" className="size-3 accent-primary" checked={composer.autoApprove} onChange={(event) => void changeAutoApprove(event.target.checked)} />
            auto-approve
          </label>
        </div>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          session model
          <select
            aria-label="settings model picker"
            className="h-6 max-w-[280px] flex-1 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={composer.providerId && composer.model ? `${composer.providerId}::${composer.model}` : ''}
            onChange={(event) => void changeModel(event.target.value)}
          >
            <option value="">default model</option>
            {models.map((entry) => (
              <option key={`${entry.providerId}::${entry.model}`} value={`${entry.providerId}::${entry.model}`}>
                {entry.providerId}/{entry.model}{entry.supportsVision ? ' · vision' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="text-[10px] text-muted">
          {enabledProviders.length} enabled provider(s) · {models.length} model(s) · workspace {session?.workspaceRoot ?? 'not loaded'}
        </p>
      </div>

      <div className="border-t border-line pt-2">
        <p className="mb-1 text-[10px] uppercase tracking-wider text-muted">providers</p>
        {providers.length === 0 ? (
          <p className="text-[11px] text-muted">No providers loaded yet. Add one below; the 9Router preset points at Farid's gateway.</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="provider-list">
            {providers.map((provider) => (
              <li key={provider.id} className="rounded border border-line px-2 py-1.5 text-[11px]" data-testid="provider-row" data-provider={provider.id}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold text-foreground">{provider.name}</span>
                  <Badge tone={provider.enabled ? 'success' : 'neutral'}>{provider.enabled ? 'enabled' : 'disabled'}</Badge>
                  <Badge tone={provider.hasApiKey ? 'info' : 'warning'}>{provider.hasApiKey ? `key ${provider.apiKeyMasked ?? 'saved'}` : 'no API key'}</Badge>
                  <span className="ml-auto flex gap-1">
                    <Button variant="outline" size="sm" onClick={() => void testProvider(provider.id)} disabled={busy}>
                      <PlugZap /> test
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => editProvider(provider)}>
                      edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void toggleProvider(provider)} disabled={busy}>
                      {provider.enabled ? 'disable' : 'enable'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void removeProvider(provider)} disabled={busy} aria-label={`delete provider ${provider.name}`}>
                      <Trash2 />
                    </Button>
                  </span>
                </div>
                <p className="truncate text-[10px] text-muted">{provider.id} · {provider.baseUrl || '(no base URL)'}</p>
                <p className="text-[10px] text-muted">
                  models: {provider.models.length ? provider.models.join(', ') : '(discover with Test connection)'}
                  {provider.supportsVision ? ' · vision-capable provider' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form
        className="flex flex-col gap-2 border-t border-line pt-2"
        data-testid="provider-form"
        onSubmit={(event) => {
          event.preventDefault()
          void saveProvider()
        }}
      >
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          preset
          <select
            aria-label="provider preset"
            className="h-6 flex-1 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            defaultValue=""
            onChange={(event) => {
              const preset = presets.find((entry) => entry.id === event.target.value)
              if (preset) applyPreset(preset)
            }}
          >
            <option value="">choose preset…</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Input aria-label="provider id" placeholder="provider id" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} />
          <Input aria-label="provider name" placeholder="provider name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        <Input aria-label="provider base URL" placeholder="https://llm.ayid.cc.cd/v1" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <Input aria-label="provider API key" type="password" placeholder={editingId ? 'API key (leave blank to keep current)' : 'API key'} value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <Input aria-label="provider models" placeholder="models, comma separated" value={form.models} onChange={(event) => setForm({ ...form, models: event.target.value })} />
          <Input aria-label="provider default model" placeholder="default model" value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <input type="checkbox" className="size-3 accent-primary" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
            enabled
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <input type="checkbox" className="size-3 accent-primary" checked={form.supportsVision} onChange={(event) => setForm({ ...form, supportsVision: event.target.checked })} />
            vision-capable
          </label>
          <span className="ml-auto flex gap-1">
            <Button type="button" variant="outline" size="sm" onClick={() => void testFormProvider()} disabled={busy}>
              <CheckCircle2 /> test connection
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              <Save /> {editingId ? 'save provider' : 'add provider'}
            </Button>
          </span>
        </div>
      </form>

      {status ? <p className="text-[11px] text-success" data-testid="settings-status">{status}</p> : null}
      {error ? (
        <p role="alert" className="text-[11px] text-error">
          {error}
        </p>
      ) : null}
    </Panel>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

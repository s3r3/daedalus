import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, PlugZap, RefreshCw, Save, Trash2, X } from 'lucide-react'
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

type ModelTierValue = 'strong' | 'balanced' | 'fast'
type PromptFamilyValue = 'auto' | 'claude' | 'gpt' | 'qwen' | 'llama' | 'gemini' | 'generic'

type ProviderForm = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  models: string
  defaultModel: string
  enabled: boolean
  supportsVision: boolean
  toolProtocol: 'auto' | 'native' | 'text'
  modelTiers: Record<string, ModelTierValue>
  promptFamily: PromptFamilyValue
  editFormat: 'native' | 'search_replace'
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
  toolProtocol: 'auto',
  modelTiers: {},
  promptFamily: 'auto',
  editFormat: 'native',
}

/**
 * Provider/session settings. API keys are write-only here: the form sends a new
 * key to the gateway, while every provider shown back to the browser is the
 * masked public view returned by the server.
 */
export function SettingsPanel({ onClose }: { onClose?: () => void } = {}) {
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
  const [reviewGate, setReviewGate] = useState(false)

  const loadAll = useCallback(async (): Promise<void> => {
    setError(null)
    const [settingsResult, providersResult, modelsResult] = await Promise.allSettled([api.settings(), api.providers(), api.models()])
    if (settingsResult.status === 'fulfilled') {
      setSession(settingsResult.value.session)
      if (settingsResult.value.providers) setProviders(settingsResult.value.providers)
      const tailor = (settingsResult.value.settings as { tailor?: { reviewGate?: boolean } }).tailor
      if (typeof tailor?.reviewGate === 'boolean') setReviewGate(tailor.reviewGate)
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
      toolProtocol: 'auto',
      modelTiers: {},
      promptFamily: 'auto',
      editFormat: 'native',
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
      toolProtocol: provider.toolProtocol ?? 'auto',
      modelTiers: provider.modelTiers ?? {},
      promptFamily: provider.promptFamily ?? 'auto',
      editFormat: provider.editFormat ?? 'native',
    })
  }

  const formModelList = useMemo(
    () => form.models.split(',').map((model) => model.trim()).filter(Boolean),
    [form.models],
  )

  const setModelTier = (model: string, tier: string): void => {
    setForm((current) => {
      const modelTiers = { ...current.modelTiers }
      if (tier === 'strong' || tier === 'balanced' || tier === 'fast') modelTiers[model] = tier
      else delete modelTiers[model]
      return { ...current, modelTiers }
    })
  }

  const changeReviewGate = async (enabled: boolean): Promise<void> => {
    setReviewGate(enabled)
    try {
      await api.updateSettings({ tailor: { reviewGate: enabled } })
      setStatus(enabled ? 'Review gate on: the strongest pool model reviews weaker models\' changes before completion.' : 'Review gate off.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
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
    toolProtocol: form.toolProtocol,
    modelTiers: Object.fromEntries(Object.entries(form.modelTiers).filter(([model]) => formModelList.includes(model))),
    promptFamily: form.promptFamily,
    editFormat: form.editFormat,
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

  const changeThinking = async (enabled: boolean): Promise<void> => {
    setComposer({ thinking: enabled })
    try {
      const response = await api.updateSession({ thinking: enabled })
      setSession(response.session)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  // Max iterations and the model pool are Web-side run defaults: they live in
  // the composer (persisted in this browser, see state/prefs.ts) and are sent
  // with every task, which is where they take effect.
  const changeMaxIterations = (value: number): void => {
    setComposer({ maxIterations: Math.min(100, Math.max(1, Math.round(value) || 1)) })
  }

  return (
    <Panel
      title="settings & providers"
      data-testid="settings-panel"
      action={
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => void loadAll()} disabled={busy} aria-label="refresh settings">
            <RefreshCw /> refresh
          </Button>
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="close settings" data-testid="settings-close">
              <X />
            </Button>
          ) : null}
        </span>
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
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <input
              type="checkbox"
              className="size-3 accent-primary"
              checked={composer.thinking}
              onChange={(event) => void changeThinking(event.target.checked)}
              data-testid="settings-thinking"
              aria-label="thinking"
            />
            thinking
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            max iterations
            <input
              type="number"
              min={1}
              max={100}
              aria-label="settings max iterations"
              data-testid="settings-max-iterations"
              className="h-6 w-16 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
              value={composer.maxIterations}
              onChange={(event) => changeMaxIterations(Number(event.target.value))}
            />
          </label>
          <span className="text-[10px] normal-case text-muted">default for new tasks; saved in this browser and sent with every task you run</span>
        </div>
        <div className="flex flex-col gap-1" data-testid="model-pool-settings">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-[220px] flex-1 items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
              model pool
              <Input
                aria-label="model pool"
                data-testid="settings-model-pool"
                placeholder="model-a, model-b, model-c"
                value={composer.modelPool}
                onChange={(event) => setComposer({ modelPool: event.target.value })}
              />
            </label>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
              strategy
              <select
                aria-label="model pool strategy"
                data-testid="settings-model-strategy"
                className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
                value={composer.modelStrategy}
                onChange={(event) => setComposer({ modelStrategy: event.target.value as 'failover' | 'round-robin' })}
              >
                <option value="failover">failover</option>
                <option value="round-robin">round-robin</option>
              </select>
            </label>
          </div>
          <p className="text-[10px] text-muted">
            With 2+ models, tasks run against the pool on the selected provider instead of the single model above (failover: switch on
            error · round-robin: rotate per request). Saved in this browser and sent with every task; leave empty to use the session model.
          </p>
        </div>
        <div className="flex flex-col gap-1" data-testid="review-gate-settings">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <input
              type="checkbox"
              className="size-3 accent-primary"
              checked={reviewGate}
              onChange={(event) => void changeReviewGate(event.target.checked)}
              data-testid="settings-review-gate"
              aria-label="review gate"
            />
            review gate — strongest model checks weaker models' work
          </label>
          <p className="text-[10px] text-muted">
            Off by default. When on and a pool with 2+ models is in play, the strongest model reviews a weaker model's file changes
            before completion; blocking findings demote the result to partial. Report-only — it never re-runs the task.
          </p>
        </div>
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
                <p className="truncate text-[10px] text-muted">{provider.id} · {provider.baseUrl || '(no base URL)'} · tools: {provider.toolProtocol ?? 'auto'}</p>
                <p className="text-[10px] text-muted">
                  models: {provider.models.length ? provider.models.join(', ') : '(discover with Test connection)'}
                  {provider.supportsVision ? ' · vision-capable provider' : ''}
                </p>
                {provider.modelTiers && Object.keys(provider.modelTiers).length > 0 ? (
                  <p className="text-[10px] text-muted" data-testid="provider-tiers">
                    tiers: {Object.entries(provider.modelTiers).map(([model, tier]) => `${model}=${tier}`).join(' · ')}
                  </p>
                ) : null}
                <p className="text-[10px] text-muted">
                  dialect: {provider.promptFamily ?? 'auto'} · edits: {provider.editFormat ?? 'native'}
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
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          tool protocol
          <select
            aria-label="provider tool protocol"
            className="h-6 flex-1 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={form.toolProtocol}
            onChange={(event) => setForm({ ...form, toolProtocol: event.target.value as ProviderForm['toolProtocol'] })}
          >
            <option value="auto">auto — native first, text fallback</option>
            <option value="native">native — function calling only</option>
            <option value="text">text — XML-style tool blocks</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            prompt family
            <select
              aria-label="provider prompt family"
              className="h-6 flex-1 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
              value={form.promptFamily}
              onChange={(event) => setForm({ ...form, promptFamily: event.target.value as PromptFamilyValue })}
            >
              <option value="auto">auto — detect from model id</option>
              <option value="claude">claude</option>
              <option value="gpt">gpt</option>
              <option value="qwen">qwen</option>
              <option value="llama">llama</option>
              <option value="gemini">gemini</option>
              <option value="generic">generic</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            edit format
            <select
              aria-label="provider edit format"
              className="h-6 flex-1 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
              value={form.editFormat}
              onChange={(event) => setForm({ ...form, editFormat: event.target.value as ProviderForm['editFormat'] })}
            >
              <option value="native">native — function-call edits</option>
              <option value="search_replace">search/replace blocks (Aider-style)</option>
            </select>
          </label>
        </div>
        {formModelList.length > 0 ? (
          <div className="flex flex-col gap-1" data-testid="model-tier-editor">
            <p className="text-[10px] uppercase tracking-wider text-muted">model tiers (pool routing)</p>
            {formModelList.map((model) => (
              <label key={model} className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <span className="min-w-0 flex-1 truncate normal-case">{model}</span>
                <select
                  aria-label={`tier for ${model}`}
                  data-testid="model-tier-select"
                  data-model={model}
                  className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
                  value={form.modelTiers[model] ?? ''}
                  onChange={(event) => setModelTier(model, event.target.value)}
                >
                  <option value="">auto (balanced)</option>
                  <option value="strong">strong</option>
                  <option value="balanced">balanced</option>
                  <option value="fast">fast</option>
                </select>
              </label>
            ))}
            <p className="text-[10px] text-muted">
              Strong models take edit and repair turns; fast/balanced models take exploration. A failed validation escalates the
              rest of the task to the strongest model.
            </p>
          </div>
        ) : null}
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

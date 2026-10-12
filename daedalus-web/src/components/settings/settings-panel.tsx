import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, PlugZap, RefreshCw, Save, Trash2, X } from 'lucide-react'
import type { ProviderConfigPublic, TaskDomain, ThinkingLevel } from '@daedalus/core'
import { api } from '../../api/client'
import type { DomainsSettings, ProviderInput, ProviderPreset, UpdateSettingsInput } from '../../api/types'
import { useDaedalusStore } from '../../state/taskStore'
import { parseModelPool, sessionThinkingOn } from '../../state/selectors'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Panel } from '../common/panel'

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

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']
const DOMAIN_TABS: TaskDomain[] = ['coding', 'slide', 'spreadsheet', 'dokumen', 'research']
const DOMAIN_LABELS: Record<TaskDomain, string> = { coding: 'Coding', slide: 'Slide', spreadsheet: 'Spreadsheet', dokumen: 'Dokumen', research: 'Research' }

type SettingsTab = 'global' | TaskDomain

type DomainDraft = { model: string; temperature: string; maxIterations: string }
const EMPTY_DOMAIN_DRAFT: DomainDraft = { model: '', temperature: '', maxIterations: '' }

/**
 * Provider/session settings, restructured into the 3-layer model:
 * - Global: the session model, thinking level, and every server-side LLM
 *   default (temperature, prompt caching, model pool, max iterations,
 *   output compression, tailor suite) plus the providers section.
 * - Coding/Slide/Spreadsheet/Dokumen: per-domain model/temperature/
 *   max-iterations overrides; empty = ikut global.
 *
 * Mode and auto-approve live in the composer only (no duplicate panels);
 * thinking/max-iterations/pool moved here from the composer because the
 * server owns them now.
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

  const [tab, setTab] = useState<SettingsTab>('global')
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Server-side settings (PUT /settings). Text/number inputs commit on
  // blur or Enter; selects and checkboxes commit immediately.
  const [temperature, setTemperature] = useState(0.7)
  const [temperatureDraft, setTemperatureDraft] = useState('0.7')
  const [promptCaching, setPromptCaching] = useState(false)
  const [poolInput, setPoolInput] = useState('')
  const [maxIterations, setMaxIterations] = useState<number | undefined>(undefined)
  const [maxIterationsDraft, setMaxIterationsDraft] = useState('')
  const [contextLimit, setContextLimit] = useState<number | undefined>(undefined)
  const [modelRouting, setModelRouting] = useState(true)
  const [qualityEscalation, setQualityEscalation] = useState(true)
  const [reviewGate, setReviewGate] = useState(false)
  const [earlyEscalation, setEarlyEscalation] = useState(true)
  const [outputCompression, setOutputCompression] = useState(true)
  const [domains, setDomains] = useState<DomainsSettings>({})
  const [domainDrafts, setDomainDrafts] = useState<Record<TaskDomain, DomainDraft>>({
    coding: { ...EMPTY_DOMAIN_DRAFT },
    slide: { ...EMPTY_DOMAIN_DRAFT },
    spreadsheet: { ...EMPTY_DOMAIN_DRAFT },
    dokumen: { ...EMPTY_DOMAIN_DRAFT },
    research: { ...EMPTY_DOMAIN_DRAFT },
  })
  const [domainBusy, setDomainBusy] = useState<TaskDomain | null>(null)

  const loadAll = useCallback(async (): Promise<void> => {
    setError(null)
    const [settingsResult, providersResult, modelsResult] = await Promise.allSettled([api.settings(), api.providers(), api.models()])
    if (settingsResult.status === 'fulfilled') {
      setSession(settingsResult.value.session)
      if (settingsResult.value.providers) setProviders(settingsResult.value.providers)
      const settings = settingsResult.value.settings as {
        llm?: { temperature?: number; promptCaching?: boolean; models?: string[] }
        tailor?: { modelRouting?: boolean; qualityEscalation?: boolean; reviewGate?: boolean; earlyEscalation?: boolean }
        outputCompression?: boolean
        maxIterations?: number
        context?: { limitTokens?: number }
        domains?: DomainsSettings
      }
      if (typeof settings.llm?.temperature === 'number') {
        setTemperature(settings.llm.temperature)
        setTemperatureDraft(String(settings.llm.temperature))
      }
      if (typeof settings.llm?.promptCaching === 'boolean') setPromptCaching(settings.llm.promptCaching)
      if (Array.isArray(settings.llm?.models)) setPoolInput(settings.llm.models.join(', '))
      if (typeof settings.maxIterations === 'number' && Number.isInteger(settings.maxIterations) && settings.maxIterations > 0) {
        setMaxIterations(settings.maxIterations)
        setMaxIterationsDraft(String(settings.maxIterations))
      } else {
        setMaxIterations(undefined)
        setMaxIterationsDraft('')
      }
      if (typeof settings.context?.limitTokens === 'number') setContextLimit(settings.context.limitTokens)
      const tailor = settings.tailor
      if (typeof tailor?.modelRouting === 'boolean') setModelRouting(tailor.modelRouting)
      if (typeof tailor?.qualityEscalation === 'boolean') setQualityEscalation(tailor.qualityEscalation)
      if (typeof tailor?.reviewGate === 'boolean') setReviewGate(tailor.reviewGate)
      if (typeof tailor?.earlyEscalation === 'boolean') setEarlyEscalation(tailor.earlyEscalation)
      const compression = settings.outputCompression
      if (typeof compression === 'boolean') setOutputCompression(compression)
      const loadedDomains = settings.domains ?? {}
      setDomains(loadedDomains)
      setDomainDrafts({
        coding: draftOf(loadedDomains.coding),
        slide: draftOf(loadedDomains.slide),
        spreadsheet: draftOf(loadedDomains.spreadsheet),
        dokumen: draftOf(loadedDomains.dokumen),
        research: draftOf(loadedDomains.research),
      })
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
  /** Pool size from the draft: the review/escalation toggles react to what is typed, and converge on blur-save. */
  const poolCount = useMemo(() => parseModelPool(poolInput).length, [poolInput])
  const poolReady = poolCount >= 2

  const pushSettings = async (input: UpdateSettingsInput, okMessage: string): Promise<void> => {
    try {
      await api.updateSettings(input)
      setStatus(okMessage)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const changeThinkingLevel = async (level: ThinkingLevel): Promise<void> => {
    try {
      const response = await api.updateSession({ thinkingLevel: level })
      setSession(response.session)
      setStatus(
        level === 'off'
          ? 'Thinking off: the model answers without a reasoning budget and THOUGHT events stay hidden.'
          : `Thinking level ${level}: reasoning budget ${level} for every model call.`,
      )
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  const commitTemperature = async (): Promise<void> => {
    const value = Number(temperatureDraft)
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      setError('Temperature harus di antara 0 dan 2.')
      setTemperatureDraft(String(temperature))
      return
    }
    setTemperature(value)
    await pushSettings({ llm: { temperature: value } }, `Temperature ${value}: default sampling untuk semua model call.`)
  }

  const changePromptCaching = async (enabled: boolean): Promise<void> => {
    setPromptCaching(enabled)
    await pushSettings(
      { llm: { promptCaching: enabled } },
      enabled ? 'Prompt caching on: preferensi diteruskan ke provider.' : 'Prompt caching off.',
    )
  }

  const commitPool = async (): Promise<void> => {
    const list = parseModelPool(poolInput)
    setPoolInput(list.join(', '))
    await pushSettings(
      { llm: { models: list } },
      list.length === 0
        ? 'Model pool dikosongkan: task berjalan pada session model.'
        : `Model pool disimpan: ${list.length} model (strategi failover — pindah model saat error).`,
    )
  }

  const commitMaxIterations = async (): Promise<void> => {
    const trimmed = maxIterationsDraft.trim()
    if (trimmed === '') {
      setMaxIterations(undefined)
      await pushSettings({ maxIterations: null }, 'Max iterations global dikosongkan: kembali ke default 25.')
      return
    }
    const value = Math.round(Number(trimmed))
    if (!Number.isInteger(value) || value < 1) {
      setError('Max iterations harus bilangan bulat positif.')
      setMaxIterationsDraft(maxIterations !== undefined ? String(maxIterations) : '')
      return
    }
    setMaxIterations(value)
    await pushSettings({ maxIterations: value }, `Max iterations global ${value}: default untuk semua task.`)
  }

  const changeTailor = async (key: 'modelRouting' | 'qualityEscalation' | 'reviewGate' | 'earlyEscalation', enabled: boolean): Promise<void> => {
    if (key === 'modelRouting') setModelRouting(enabled)
    if (key === 'qualityEscalation') setQualityEscalation(enabled)
    if (key === 'reviewGate') setReviewGate(enabled)
    if (key === 'earlyEscalation') setEarlyEscalation(enabled)
    const messages: Record<typeof key, string> = {
      modelRouting: enabled
        ? 'Routing model on: tiap fase dikerjakan model pool yang tier-nya cocok.'
        : 'Routing model off: semua fase berjalan pada model yang sama.',
      qualityEscalation: enabled
        ? 'Eskalasi kualitas on: validasi gagal memindahkan sisa task ke model terkuat (sekali per task).'
        : 'Eskalasi kualitas off: task yang gagal validasi tidak dipindahkan.',
      reviewGate: enabled
        ? "Review gate on: the strongest pool model reviews weaker models' changes before completion."
        : 'Review gate off.',
      earlyEscalation: enabled
        ? 'Early escalation on: a looping task is pinned to the strongest pool model once.'
        : 'Early escalation off: loop warnings only advise the current model.',
    }
    await pushSettings({ tailor: { [key]: enabled } }, messages[key])
  }

  const changeOutputCompression = async (enabled: boolean): Promise<void> => {
    setOutputCompression(enabled)
    await pushSettings(
      { outputCompression: enabled },
      enabled ? 'Output compression on: noisy command output is filtered before the model reads it.' : 'Output compression off: command output reaches the model raw (caps still apply).',
    )
  }

  const setDomainDraft = (domain: TaskDomain, patch: Partial<DomainDraft>): void => {
    setDomainDrafts((current) => ({ ...current, [domain]: { ...current[domain], ...patch } }))
  }

  const saveDomain = async (domain: TaskDomain): Promise<void> => {
    const draft = domainDrafts[domain]
    const modelName = draft.model.includes('::') ? draft.model.split('::').slice(1).join('::').trim() : draft.model.trim()
    const temperatureValue = draft.temperature.trim() === '' ? null : Number(draft.temperature)
    const maxIterationsValue = draft.maxIterations.trim() === '' ? null : Math.round(Number(draft.maxIterations))
    if (temperatureValue !== null && (!Number.isFinite(temperatureValue) || temperatureValue < 0 || temperatureValue > 2)) {
      setError(`Temperature ${DOMAIN_LABELS[domain]} harus di antara 0 dan 2, atau kosongkan untuk ikut global.`)
      return
    }
    if (maxIterationsValue !== null && (!Number.isInteger(maxIterationsValue) || maxIterationsValue < 1)) {
      setError(`Max iterations ${DOMAIN_LABELS[domain]} harus bilangan bulat positif, atau kosongkan untuk ikut global.`)
      return
    }
    setDomainBusy(domain)
    setError(null)
    try {
      // null clears the override back to "ikut global" (DomainModelSettings: unset = follow the global setting).
      const response = await api.updateSettings({
        domains: { [domain]: { model: modelName || null, temperature: temperatureValue, maxIterations: maxIterationsValue } },
      })
      const next = (response.settings as { domains?: DomainsSettings }).domains ?? {}
      setDomains(next)
      setDomainDrafts((current) => ({ ...current, [domain]: draftOf(next[domain]) }))
      setStatus(`Override ${DOMAIN_LABELS[domain]} disimpan.`)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setDomainBusy(null)
    }
  }

  /** Effective values shown under each domain tab: override, else the global setting. */
  const effectiveLine = (domain: TaskDomain): string => {
    const override = domains[domain] ?? {}
    const model = override.model?.trim()
      ? override.model.trim()
      : composer.providerId && composer.model
        ? `${composer.providerId}/${composer.model}`
        : composer.model || 'model global'
    const temp = override.temperature ?? temperature
    const iters = override.maxIterations ?? maxIterations ?? 25
    return `efektif: ${model} · temp ${temp} · maks iterasi ${iters}`
  }

  /** Context caption under the session model picker: global limit + per-model value when the provider knows it. */
  const contextCaption = (): string | null => {
    const parts: string[] = []
    if (typeof contextLimit === 'number' && contextLimit > 0) parts.push(`konteks global ${formatTokens(contextLimit)}`)
    if (composer.providerId && composer.model) {
      const provider = providers.find((entry) => entry.id === composer.providerId)
      const perModel = provider?.contextWindows?.[composer.model]
      if (typeof perModel === 'number' && perModel > 0) parts.push(`${composer.model} ${formatTokens(perModel)} ctx`)
    }
    return parts.length > 0 ? parts.join(' · ') : null
  }

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

  const commitOnEnter = (event: React.KeyboardEvent, commit: () => void): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void commit()
    }
  }

  const sessionLevel: ThinkingLevel = session?.thinkingLevel ?? (sessionThinkingOn(session) ? 'medium' : 'off')
  const caption = contextCaption()

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
      <div className="flex gap-1 border-b border-line pb-2" role="tablist" aria-label="settings layers" data-testid="settings-tabs">
        {(['global', ...DOMAIN_TABS] as SettingsTab[]).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            data-testid={`settings-tab-${entry}`}
            onClick={() => setTab(entry)}
            className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${tab === entry ? 'bg-primary/15 text-primary' : 'text-muted hover:text-foreground'}`}
          >
            {entry === 'global' ? 'Global' : DOMAIN_LABELS[entry]}
          </button>
        ))}
      </div>

      {tab === 'global' ? (
        <div className="flex flex-col gap-3" data-testid="settings-tab-global">
          <div className="flex flex-col gap-2" data-testid="global-model-section">
            <p className="text-[10px] uppercase tracking-wider text-muted">model & perilaku</p>
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-muted">
              <span className="flex items-center gap-1.5">
                session model
                <select
                  aria-label="settings model picker"
                  className="h-6 max-w-[280px] flex-1 rounded border border-line bg-surface px-1.5 text-[11px] normal-case text-foreground"
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
              </span>
              {caption ? (
                <span className="normal-case text-muted" data-testid="settings-context-caption">{caption}</span>
              ) : null}
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                thinking
                <select
                  aria-label="thinking level"
                  data-testid="settings-thinking-level"
                  className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] normal-case text-foreground"
                  value={sessionLevel}
                  onChange={(event) => void changeThinkingLevel(event.target.value as ThinkingLevel)}
                >
                  {THINKING_LEVELS.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                max iterations
                <input
                  type="number"
                  min={1}
                  aria-label="settings max iterations"
                  data-testid="settings-max-iterations"
                  placeholder="25"
                  className="h-6 w-20 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
                  value={maxIterationsDraft}
                  onChange={(event) => setMaxIterationsDraft(event.target.value)}
                  onBlur={() => void commitMaxIterations()}
                  onKeyDown={(event) => commitOnEnter(event, () => void commitMaxIterations())}
                />
              </label>
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                temperature
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  aria-label="settings temperature"
                  data-testid="settings-temperature"
                  className="h-6 w-20 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
                  value={temperatureDraft}
                  onChange={(event) => setTemperatureDraft(event.target.value)}
                  onBlur={() => void commitTemperature()}
                  onKeyDown={(event) => commitOnEnter(event, () => void commitTemperature())}
                />
              </label>
            </div>
            <p className="text-[10px] text-muted">
              Thinking level off mematikan reasoning budget; max iterations & temperature kosong = default (25 / 0.7). Nilai tersimpan di server, bukan browser ini.
            </p>
            <div className="flex flex-col gap-1" data-testid="prompt-caching-settings">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={promptCaching}
                  onChange={(event) => void changePromptCaching(event.target.checked)}
                  data-testid="settings-prompt-caching"
                  aria-label="prompt caching"
                />
                prompt caching
              </label>
              <p className="text-[10px] text-muted">
                Preferensi tersimpan & diteruskan ke provider; aktif penuh setelah mesin prompt-caching mendarat.
              </p>
            </div>
            <div className="flex flex-col gap-1" data-testid="output-compression-settings">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={outputCompression}
                  onChange={(event) => void changeOutputCompression(event.target.checked)}
                  data-testid="settings-output-compression"
                  aria-label="output compression"
                />
                output compression — shrink noisy command output before the model reads it
              </label>
              <p className="text-[10px] text-muted">
                On by default. Install logs, test runs, and git output are semantically filtered before entering the model's context;
                failures and exit codes stay verbatim and the complete text is kept in the task store. Turn off to feed the model raw
                output (the size caps still apply).
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-line pt-2" data-testid="model-pool-settings">
            <p className="text-[10px] uppercase tracking-wider text-muted">model pool (server)</p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex min-w-[220px] flex-1 items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                model pool
                <Input
                  aria-label="model pool"
                  data-testid="settings-model-pool"
                  placeholder="model-a, model-b, model-c"
                  value={poolInput}
                  onChange={(event) => setPoolInput(event.target.value)}
                  onBlur={() => void commitPool()}
                  onKeyDown={(event) => commitOnEnter(event, () => void commitPool())}
                />
              </label>
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                strategy
                <span className="rounded border border-line px-1.5 py-0.5 text-[11px] normal-case text-foreground" data-testid="model-pool-strategy">
                  failover
                </span>
              </span>
            </div>
            <p className="text-[10px] text-muted">
              Dengan 2+ model, task berjalan pada pool ini (failover: pindah model saat error). Round-robin dihapus. Kosongkan untuk memakai session model.
            </p>
            <div className="flex flex-col gap-1" data-testid="review-gate-settings">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={reviewGate}
                  disabled={!poolReady}
                  onChange={(event) => void changeTailor('reviewGate', event.target.checked)}
                  data-testid="settings-review-gate"
                  aria-label="review gate"
                />
                review gate — strongest model checks weaker models' work
                {!poolReady ? <span className="normal-case text-warning" data-testid="pool-hint-review-gate">butuh pool 2+ model</span> : null}
              </label>
              <p className="text-[10px] text-muted">
                Off by default. When on and a pool with 2+ models is in play, the strongest model reviews a weaker model's file changes
                before completion; blocking findings demote the result to partial. Report-only — it never re-runs the task.
              </p>
            </div>
            <div className="flex flex-col gap-1" data-testid="early-escalation-settings">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={earlyEscalation}
                  disabled={!poolReady}
                  onChange={(event) => void changeTailor('earlyEscalation', event.target.checked)}
                  data-testid="settings-early-escalation"
                  aria-label="early escalation"
                />
                early escalation — pin looping tasks to the strongest model
                {!poolReady ? <span className="normal-case text-warning" data-testid="pool-hint-early-escalation">butuh pool 2+ model</span> : null}
              </label>
              <p className="text-[10px] text-muted">
                On by default. When the loop breaker or the stall counter fires and a pool with 2+ models is in play, the task is
                pinned to the strongest model once (recorded as TAILOR_ESCALATED). Without a pool nothing is spent — the directive
                and fail-fast behaviors still apply.
              </p>
            </div>
            <div className="flex flex-col gap-1" data-testid="model-routing-settings">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={modelRouting}
                  disabled={!poolReady}
                  onChange={(event) => void changeTailor('modelRouting', event.target.checked)}
                  data-testid="settings-model-routing"
                  aria-label="routing model per fase"
                />
                routing model per fase
                {!poolReady ? <span className="normal-case text-warning" data-testid="pool-hint-model-routing">butuh pool 2+ model</span> : null}
              </label>
              <p className="text-[10px] text-muted">
                On by default. Tiap fase (eksplorasi/edit/perbaikan) dikerjakan model pool yang tier-nya paling cocok; tanpa pool bertier tidak berpengaruh.
              </p>
            </div>
            <div className="flex flex-col gap-1" data-testid="quality-escalation-settings">
              <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
                <input
                  type="checkbox"
                  className="size-3 accent-primary"
                  checked={qualityEscalation}
                  disabled={!poolReady}
                  onChange={(event) => void changeTailor('qualityEscalation', event.target.checked)}
                  data-testid="settings-quality-escalation"
                  aria-label="eskalasi kualitas"
                />
                eskalasi kualitas
                {!poolReady ? <span className="normal-case text-warning" data-testid="pool-hint-quality-escalation">butuh pool 2+ model</span> : null}
              </label>
              <p className="text-[10px] text-muted">
                On by default. Validasi yang gagal memindahkan sisa task ke model terkuat di pool — sekali per task; tanpa pool tidak berpengaruh.
              </p>
            </div>
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

          <p className="text-[10px] text-muted">
            {enabledProviders.length} enabled provider(s) · {models.length} model(s) · workspace {session?.workspaceRoot ?? 'not loaded'}
          </p>
        </div>
      ) : (
        <DomainTab
          domain={tab}
          draft={domainDrafts[tab]}
          onDraft={(patch) => setDomainDraft(tab, patch)}
          onSave={() => void saveDomain(tab)}
          saving={domainBusy === tab}
          models={models}
          effective={effectiveLine(tab)}
        />
      )}

      {status ? <p className="text-[11px] text-success" data-testid="settings-status">{status}</p> : null}
      {error ? (
        <p role="alert" className="text-[11px] text-error">
          {error}
        </p>
      ) : null}
    </Panel>
  )
}

/** Server domain settings → the tab's text drafts (empty = ikut global). */
function draftOf(settings: DomainsSettings[TaskDomain]): DomainDraft {
  return {
    model: settings?.model?.trim() ?? '',
    temperature: settings?.temperature !== undefined ? String(settings.temperature) : '',
    maxIterations: settings?.maxIterations !== undefined ? String(settings.maxIterations) : '',
  }
}

function DomainTab({
  domain,
  draft,
  onDraft,
  onSave,
  saving,
  models,
  effective,
}: {
  domain: TaskDomain
  draft: DomainDraft
  onDraft: (patch: Partial<DomainDraft>) => void
  onSave: () => void
  saving: boolean
  models: { providerId: string; model: string; supportsVision: boolean }[]
  effective: string
}) {
  // The override stores the bare model name (core resolves it against the
  // session provider); the picker works in providerId::model values.
  const selectedValue = useMemo(() => {
    const name = draft.model.includes('::') ? draft.model.split('::').slice(1).join('::') : draft.model
    const match = models.find((entry) => entry.model === name)
    return match ? `${match.providerId}::${match.model}` : ''
  }, [draft.model, models])
  return (
    <div className="flex flex-col gap-2" data-testid={`settings-tab-domain-${domain}`}>
      <p className="text-[10px] uppercase tracking-wider text-muted">override {DOMAIN_LABELS[domain]} — kosong = ikut global</p>
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        model
        <select
          aria-label={`${DOMAIN_LABELS[domain]} model override`}
          data-testid={`domain-model-${domain}`}
          className="h-6 max-w-[280px] flex-1 rounded border border-line bg-surface px-1.5 text-[11px] normal-case text-foreground"
          value={selectedValue}
          onChange={(event) => onDraft({ model: event.target.value })}
        >
          <option value="">Ikut global</option>
          {models.map((entry) => (
            <option key={`${entry.providerId}::${entry.model}`} value={`${entry.providerId}::${entry.model}`}>
              {entry.providerId}/{entry.model}{entry.supportsVision ? ' · vision' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          temperature
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            aria-label={`${DOMAIN_LABELS[domain]} temperature override`}
            data-testid={`domain-temperature-${domain}`}
            placeholder="ikut global"
            className="h-6 w-24 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={draft.temperature}
            onChange={(event) => onDraft({ temperature: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          max iterations
          <input
            type="number"
            min={1}
            aria-label={`${DOMAIN_LABELS[domain]} max iterations override`}
            data-testid={`domain-max-iterations-${domain}`}
            placeholder="ikut global"
            className="h-6 w-24 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={draft.maxIterations}
            onChange={(event) => onDraft({ maxIterations: event.target.value })}
          />
        </label>
        <Button variant="outline" size="sm" onClick={onSave} disabled={saving} data-testid={`domain-save-${domain}`}>
          <Save /> {saving ? 'menyimpan…' : 'simpan'}
        </Button>
      </div>
      <p className="text-[10px] text-muted" data-testid={`domain-effective-${domain}`}>
        {effective}
      </p>
    </div>
  )
}

/** 200000 → "200k", 1500000 → "1.5M". */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`
  if (value >= 1_000) return `${Math.round((value / 1_000) * 10) / 10}k`
  return String(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { ImagePlus, Paperclip, Play, UploadCloud, X } from 'lucide-react'
import type { AgentMode, Attachment } from '@daedalus/core'
import { AGENT_MODE_ORDER, nextAgentMode } from '@daedalus/core/interaction/modes'
import { SlashCommandRegistry, slashCommandSuggestions, type SlashCommandContext, type SlashCommandResult } from '@daedalus/core/interaction/slash-commands'
import { Button } from '../ui/button'
import { Textarea } from '../ui/input'
import { useDaedalusStore } from '../../state/taskStore'
import { useTaskEvents } from '../../state/hooks'
import { fileChanges, latestPlan, validation } from '../../state/selectors'
import { api } from '../../api/client'
import { MODE_LABELS, modeCssVar } from '../../theme/theme'

type UploadKind = 'file' | 'folder' | 'image' | 'zip'

/**
 * Task composer (PLAN.md §3.4 + Phase 8.5). The composer owns only drafts and
 * staged attachments; mode/provider/model changes are written through the
 * gateway session so CLI and Web observe the same session state.
 */
export function Composer() {
  const composer = useDaedalusStore((state) => state.composer)
  const workspaceRoot = useDaedalusStore((state) => state.workspace.root)
  const activeTaskId = useDaedalusStore((state) => state.taskId)
  const models = useDaedalusStore((state) => state.models)
  const providers = useDaedalusStore((state) => state.providers)
  const setComposer = useDaedalusStore((state) => state.setComposer)
  const setTask = useDaedalusStore((state) => state.setTask)
  const setSession = useDaedalusStore((state) => state.setSession)
  const setProviders = useDaedalusStore((state) => state.setProviders)
  const setModels = useDaedalusStore((state) => state.setModels)
  const addAttachments = useDaedalusStore((state) => state.addAttachments)
  const removeAttachment = useDaedalusStore((state) => state.removeAttachment)
  const setSettingsOpen = useDaedalusStore((state) => state.setSettingsOpen)
  const events = useTaskEvents()

  const [touched, setTouched] = useState(false)
  const [slashOutput, setSlashOutput] = useState<string | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const registry = useMemo(() => new SlashCommandRegistry(), [])

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

  const suggestions = useMemo(() => {
    const goal = composer.goal
    if (!goal.startsWith('/') || goal.includes('\n')) return []
    if (/^\/\S+\s/.test(goal)) return []
    return slashCommandSuggestions(goal)
  }, [composer.goal])

  const selectedModel = useMemo(
    () => models.find((entry) => entry.providerId === composer.providerId && entry.model === composer.model),
    [composer.model, composer.providerId, models],
  )
  const hasImageAttachment = composer.attachments.some((attachment) => attachment.kind === 'image')
  const visionWarning = hasImageAttachment && selectedModel && !selectedModel.supportsVision
    ? `The selected model ${selectedModel.providerId}/${selectedModel.model} does not support vision. Image attachments will not be sent to the model.`
    : null

  const applySession = (session: Parameters<typeof setSession>[0]): void => {
    setSession(session)
  }

  const changeMode = async (mode: AgentMode): Promise<SlashCommandResult> => {
    try {
      const response = await api.setMode(mode)
      applySession(response.session)
      return { text: `Mode set to ${mode}. It applies at the next turn boundary.`, action: 'mode' }
    } catch (error) {
      setComposer({ mode })
      return { text: `Mode set locally to ${mode}. Server session update failed: ${errorMessage(error)}`, action: 'mode' }
    }
  }

  const cycleMode = async (): Promise<void> => {
    const next = nextAgentMode(useDaedalusStore.getState().composer.mode)
    const result = await changeMode(next)
    setSlashOutput(result.text)
  }

  const changeAutoApprove = async (enabled: boolean): Promise<SlashCommandResult> => {
    try {
      const response = await api.setAutoApprove(enabled)
      applySession(response.session)
      return { text: `Auto-approve ${enabled ? 'enabled' : 'disabled'}.`, action: 'auto-approve' }
    } catch (error) {
      setComposer({ autoApprove: enabled })
      return { text: `Auto-approve set locally ${enabled ? 'on' : 'off'}. Server update failed: ${errorMessage(error)}`, action: 'auto-approve' }
    }
  }

  const changeThinking = async (enabled: boolean): Promise<SlashCommandResult> => {
    try {
      const response = await api.updateSession({ thinking: enabled })
      applySession(response.session)
      return { text: `Thinking ${enabled ? 'on' : 'off'}. ${enabled ? 'Provider THOUGHT events will appear in the activity timeline.' : 'THOUGHT events remain in the local event log but are hidden here.'}`, action: 'settings', data: { thinking: enabled } }
    } catch (error) {
      setComposer({ thinking: enabled })
      return { text: `Thinking set locally ${enabled ? 'on' : 'off'}. Server update failed: ${errorMessage(error)}`, action: 'settings', data: { thinking: enabled } }
    }
  }

  const loadExtensionStatus = async () => {
    const state = useDaedalusStore.getState()
    const root = state.workspace.root || state.session?.workspaceRoot
    if (!root) throw new Error('Choose a workspace before checking extensions.')
    return api.extensionsStatus(root)
  }

  const changeModel = async (selection: string): Promise<SlashCommandResult> => {
    const state = useDaedalusStore.getState()
    let providerId = state.composer.providerId
    let model = selection.trim()
    const known = state.models.find((entry) => `${entry.providerId}/${entry.model}` === model || entry.model === model)
    if (known) {
      providerId = known.providerId
      model = known.model
    } else if (model.includes('/')) {
      const [provider, ...rest] = model.split('/')
      if (provider && rest.length > 0) {
        providerId = provider
        model = rest.join('/')
      }
    }
    setComposer({ providerId, model })
    try {
      const response = await api.updateSession({ providerId, model })
      applySession(response.session)
    } catch {
      /* the local draft remains usable while the gateway is unreachable */
    }
    return { text: `Model set to ${providerId ? `${providerId}/` : ''}${model}. It applies at the next turn.`, action: 'models' }
  }

  const loadModels = async (): Promise<Array<{ providerId: string; model: string }>> => {
    try {
      const response = await api.models()
      setModels(response.models)
      return response.models
    } catch {
      return useDaedalusStore.getState().models
    }
  }

  const loadProviders = async (): Promise<ReturnType<typeof useDaedalusStore.getState>['providers']> => {
    try {
      const response = await api.providers()
      setProviders(response.providers, response.presets)
      return response.providers
    } catch {
      return useDaedalusStore.getState().providers
    }
  }

  const uploadFiles = async (files: FileList | File[], kind: UploadKind): Promise<SlashCommandResult> => {
    const list = [...files]
    if (list.length === 0) return { text: 'No files selected.', action: 'upload' }
    const root = useDaedalusStore.getState().workspace.root
    if (!root) return { text: 'Choose a workspace before uploading files.', action: 'upload' }
    const form = new FormData()
    form.set('root', root)
    form.set('kind', kind)
    const taskId = useDaedalusStore.getState().taskId
    if (taskId) form.set('task_id', taskId)
    for (const file of list) {
      const relativePath = kind === 'folder' ? relativePathOf(file) : file.name
      form.append('files', new File([file], relativePath, { type: file.type, lastModified: file.lastModified }))
    }
    try {
      const response = await api.upload(form)
      addAttachments(response.attachments)
      return {
        text: `Uploaded ${response.files.length} file(s) to ${response.destination}. ${response.attachments.length} attachment(s) staged for the next task.`,
        action: 'upload',
        data: response,
      }
    } catch (error) {
      return { text: `Upload failed: ${errorMessage(error)}`, action: 'upload' }
    }
  }

  const openUpload = (kind: UploadKind): SlashCommandResult => {
    if (kind === 'folder') folderInputRef.current?.click()
    else if (kind === 'image') imageInputRef.current?.click()
    else fileInputRef.current?.click()
    return { text: kind === 'image' ? 'Choose an image to attach.' : kind === 'folder' ? 'Choose a folder to upload.' : 'Choose files or a ZIP to upload.', action: 'upload' }
  }

  const slashContext = (): SlashCommandContext => ({
    getMode: () => useDaedalusStore.getState().composer.mode,
    setMode: changeMode,
    cycleMode: async () => {
      const next = nextAgentMode(useDaedalusStore.getState().composer.mode)
      return changeMode(next)
    },
    getAutoApprove: () => useDaedalusStore.getState().composer.autoApprove,
    setAutoApprove: changeAutoApprove,
    listModels: loadModels,
    listProviders: loadProviders,
    getCurrentModel: () => {
      const current = useDaedalusStore.getState().composer
      return { providerId: current.providerId || undefined, model: current.model || undefined }
    },
    setModel: changeModel,
    testProvider: async (id) => {
      const providerId = id ?? (useDaedalusStore.getState().composer.providerId || useDaedalusStore.getState().providers[0]?.id)
      if (!providerId) return { text: 'No provider selected to test.', action: 'providers' }
      const result = await api.testProvider(providerId)
      await loadProviders()
      await loadModels()
      return { text: result.message, action: 'providers', data: result }
    },
    getSettings: async () => {
      const response = await api.settings()
      applySession(response.session)
      if (response.providers) setProviders(response.providers)
      return { session: response.session, settings: response.settings }
    },
    setSetting: async (key, value) => {
      if (key === 'mode') return changeMode(value as AgentMode)
      if (key === 'model') return changeModel(value)
      if (key === 'auto-approve') return changeAutoApprove(value === 'on' || value === 'true')
      if (key === 'thinking') {
        if (!['on', 'off', 'true', 'false'].includes(value.trim().toLowerCase())) return { text: 'Usage: /settings thinking on|off', action: 'settings' }
        return changeThinking(value === 'on' || value === 'true')
      }
      const response = await api.updateSettings({ [key]: value })
      applySession(response.session)
      return { text: `Setting ${key} updated.`, action: 'settings', data: response }
    },
    getPlan: () => {
      const plan = latestPlan(events)
      if (!plan) return 'No plan yet. Run a task or switch to Plan mode.'
      return plan.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.intent}`).join('\n')
    },
    getWorkspace: () => {
      const state = useDaedalusStore.getState()
      return `Workspace: ${state.workspace.root || '(none)'}\nSession workspace: ${state.session?.workspaceRoot ?? state.workspace.root}\nMode: ${state.composer.mode}`
    },
    listFiles: async () => {
      const root = useDaedalusStore.getState().workspace.root
      if (!root) return 'No workspace selected.'
      const response = await api.list(root, '.')
      return response.items.map((item) => `${item.isDirectory ? 'dir ' : 'file'} ${item.path}`).join('\n') || '(workspace is empty)'
    },
    getDiff: () => {
      const changes = fileChanges(events)
      return changes.length ? changes.map((change) => `${change.operation} ${change.path} (+${change.added}/-${change.removed})`).join('\n') : 'No file changes yet.'
    },
    validate: () => {
      const result = validation(events)
      if (result.running) return 'Validation is running.'
      if (!result.result) return 'No validation evidence yet. Validation runs as part of a task; switch to Auto or Orchestrator to execute and validate.'
      return result.result.checks.map((check) => `${check.name}: ${check.status} (${check.cmd})`).join('\n')
    },
    upload: () => openUpload('file'),
    image: () => openUpload('image'),
    newTask: () => {
      useDaedalusStore.setState({ taskId: null, events: [], report: null, taskAttachments: [] })
      setComposer({ goal: '', attachments: [], error: null })
      return { text: 'New task draft started.', action: 'new' }
    },
    clear: () => {
      setComposer({ goal: '', error: null })
      setSlashOutput(null)
      return { text: 'Composer cleared.', action: 'clear' }
    },
    status: () => {
      const state = useDaedalusStore.getState()
      return `Connection: ${state.connection}\nTask: ${state.taskId ?? '(new)'}\nMode: ${state.composer.mode}\nThinking: ${state.composer.thinking ? 'on' : 'off'}\nProvider: ${state.composer.providerId || '(default)'}\nModel: ${state.composer.model || '(default)'}\nWorkspace: ${state.workspace.root || '(none)'}\nEvents: ${events.length}`
    },
    cancel: async () => {
      const taskId = useDaedalusStore.getState().taskId
      if (!taskId) return { text: 'No running task to cancel.', action: 'cancel' }
      await api.cancelTask(taskId)
      return { text: `Cancellation requested for task ${taskId}.`, action: 'cancel' }
    },
    exit: () => ({ text: 'Close this browser tab to leave the Web UI. The background server keeps running until `daedalus stop`.', action: 'exit' }),
    getMcpStatus: async () => {
      try {
        const status = await loadExtensionStatus()
        if (status.mcp.length === 0) return `No MCP servers configured for ${status.root}. Add .daedalus/mcp.json to enable MCP tools.`
        return status.mcp.map((server) => `${server.name}: ${server.connected ? `connected · ${server.toolCount} tools` : `offline${server.error ? ` · ${server.error}` : ''}`}`).join('\n')
      } catch (error) {
        return `MCP status failed: ${errorMessage(error)}`
      }
    },
    listSkills: async () => {
      try {
        const status = await loadExtensionStatus()
        return status.skills.length ? status.skills.map((skill) => `${skill.name} — ${skill.description || 'skill'}`).join('\n') : `No skills found under ${status.root}/.daedalus/skills.`
      } catch (error) {
        return `Skill listing failed: ${errorMessage(error)}`
      }
    },
    listAgents: async () => {
      try {
        const status = await loadExtensionStatus()
        if (!status.agents?.length) return `No subagents defined under ${status.root}/.daedalus/agents. Add .md files there to define one.`
        return status.agents
          .map((agent) => `${agent.name} — ${agent.description || 'subagent'}${agent.mode ? ` · mode ${agent.mode}` : ''}${agent.model ? ` · model ${agent.model}` : ''}${agent.tools ? ` · tools: ${agent.tools.join(', ')}` : ''}`)
          .join('\n')
      } catch (error) {
        return `Agent listing failed: ${errorMessage(error)}`
      }
    },
    review: async () => {
      const state = useDaedalusStore.getState()
      const root = state.workspace.root || state.session?.workspaceRoot
      if (!root) return { text: 'Choose a workspace before running /review.', action: 'review' }
      try {
        const result = await api.review({
          root,
          ...(state.taskId ? { task_id: state.taskId } : {}),
          ...(state.composer.providerId ? { provider_id: state.composer.providerId } : {}),
          ...(state.composer.model ? { model: state.composer.model } : {}),
        })
        return { text: result.raw, action: 'review', data: result }
      } catch (error) {
        return { text: `Review failed: ${errorMessage(error)}`, action: 'review' }
      }
    },
    getLspStatus: async () => {
      try {
        const status = await loadExtensionStatus()
        if (status.lsp.length === 0) return `No language servers configured for ${status.root}. Add .daedalus/lsp.json to enable lsp_diagnostics.`
        return status.lsp.map((server) => `${server.name}: configured · ${server.extensions.join(', ') || 'no extensions'}${server.error ? ` · ${server.error}` : ''}`).join('\n')
      } catch (error) {
        return `LSP status failed: ${errorMessage(error)}`
      }
    },
  })

  const executeSlash = async (input: string): Promise<void> => {
    const result = await registry.execute(input, slashContext())
    setSlashOutput(result.text)
    if (result.action === 'settings' || result.action === 'providers') setSettingsOpen(true)
    setComposer({ goal: '', error: null })
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const goal = composer.goal.trim()
    if (goal.startsWith('/')) {
      await executeSlash(goal)
      return
    }
    if (goal.length === 0) {
      setTouched(true)
      return
    }
    setComposer({ submitting: true, error: null })
    try {
      const attachmentsForTask = visionWarning ? composer.attachments.filter((attachment) => attachment.kind !== 'image') : composer.attachments
      const created = await api.createTask({
        goal,
        repo_path: workspaceRoot,
        auto_approve: composer.autoApprove,
        max_iterations: composer.maxIterations,
        mode: composer.mode,
        thinking: composer.thinking,
        provider_id: composer.providerId || undefined,
        model: composer.model || undefined,
        attachments: attachmentsForTask,
      })
      setTask(created.id, goal)
      setComposer({ submitting: false, goal, attachments: [] })
      if (visionWarning) setSlashOutput(visionWarning)
    } catch (error) {
      setComposer({ submitting: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault()
      void cycleMode()
      return
    }
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSuggestion((current) => (current + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length)
    } else if (event.key === 'Tab' || event.key === 'Enter') {
      const suggestion = suggestions[activeSuggestion] ?? suggestions[0]
      if (suggestion) {
        event.preventDefault()
        setComposer({ goal: `/${suggestion.name} ` })
      }
    } else if (event.key === 'Escape') {
      setActiveSuggestion(0)
      setComposer({ goal: '' })
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    void uploadFiles(files, 'image').then((result) => setSlashOutput(result.text))
  }

  const onModeSelect = (mode: AgentMode): void => {
    void changeMode(mode).then((result) => setSlashOutput(result.text))
  }

  const onModelSelect = (value: string): void => {
    if (!value) return
    const [providerId, ...rest] = value.split('::')
    const model = rest.join('::')
    void changeModel(providerId && model ? `${providerId}/${model}` : value)
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={`flex flex-col gap-2 border-b border-line bg-surface-base px-3 py-2 ${activeTaskId ? 'motion-composer-collapse' : ''}`}
      data-testid="composer"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ borderColor: modeCssVar(composer.mode), color: modeCssVar(composer.mode) }}
          data-testid="mode-badge"
          data-mode={composer.mode}
          title="Shift+Tab cycles Ask → Manual → Auto → Plan → Orchestrator"
        >
          {MODE_LABELS[composer.mode]}
        </span>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          mode
          <select
            aria-label="agent mode"
            data-testid="mode-select"
            className="h-6 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            style={{ borderColor: modeCssVar(composer.mode) }}
            value={composer.mode}
            onChange={(event) => onModeSelect(event.target.value as AgentMode)}
          >
            {AGENT_MODE_ORDER.map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[10px] text-muted">Shift+Tab switches mode at the next turn boundary</span>
        <span className="ml-auto text-[10px] text-muted" data-testid="composer-session-summary">
          {providers.length ? `${providers.filter((provider) => provider.enabled).length} providers · ` : ''}
          {models.length ? `${models.length} models` : 'models load from settings'}
        </span>
      </div>

      <Textarea
        aria-label="task goal"
        data-testid="composer-input"
        rows={2}
        placeholder="Describe the coding task… or type /help for slash commands"
        value={composer.goal}
        onChange={(event) => {
          setComposer({ goal: event.target.value })
          setActiveSuggestion(0)
        }}
        onKeyDown={onComposerKeyDown}
        onPaste={onPaste}
      />

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap gap-1" data-testid="slash-palette" role="listbox" aria-label="slash commands">
          {suggestions.map((command, index) => (
            <button
              key={command.name}
              type="button"
              role="option"
              aria-selected={index === activeSuggestion}
              data-testid="slash-suggestion"
              data-command={command.name}
              className={`rounded border px-1.5 py-0.5 text-left text-[10px] ${index === activeSuggestion ? 'border-primary text-primary' : 'border-line text-muted'}`}
              onClick={() => setComposer({ goal: `/${command.name} ` })}
            >
              {command.usage} <span className="text-muted">— {command.description}</span>
            </button>
          ))}
        </div>
      ) : null}

      <input ref={fileInputRef} type="file" multiple className="hidden" data-testid="composer-file-input" onChange={(event) => void uploadFiles(event.target.files ?? [], 'file').then((result) => setSlashOutput(result.text))} />
      <input ref={folderInputRef} type="file" multiple className="hidden" data-testid="composer-folder-input" onChange={(event) => void uploadFiles(event.target.files ?? [], 'folder').then((result) => setSlashOutput(result.text))} />
      <input ref={imageInputRef} type="file" multiple accept="image/*" className="hidden" data-testid="composer-image-input" onChange={(event) => void uploadFiles(event.target.files ?? [], 'image').then((result) => setSlashOutput(result.text))} />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          <input
            type="checkbox"
            className="size-3 accent-primary"
            checked={composer.autoApprove}
            onChange={(event) => void changeAutoApprove(event.target.checked).then((result) => setSlashOutput(result.text))}
          />
          auto-approve
        </label>

        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          <input
            type="checkbox"
            className="size-3 accent-primary"
            checked={composer.thinking}
            data-testid="thinking-toggle"
            aria-label="thinking"
            onChange={(event) => void changeThinking(event.target.checked).then((result) => setSlashOutput(result.text))}
          />
          thinking
        </label>

        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          max iterations
          <input
            type="number"
            min={1}
            max={100}
            aria-label="max iterations"
            className="h-6 w-16 rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={composer.maxIterations}
            onChange={(event) => setComposer({ maxIterations: Math.max(1, Number(event.target.value) || 1) })}
          />
        </label>

        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
          model
          <select
            aria-label="model picker"
            data-testid="model-picker"
            className="h-6 max-w-[260px] rounded border border-line bg-surface px-1.5 text-[11px] text-foreground"
            value={composer.providerId && composer.model ? `${composer.providerId}::${composer.model}` : ''}
            onChange={(event) => onModelSelect(event.target.value)}
          >
            <option value="">{composer.model ? `${composer.providerId ? `${composer.providerId}/` : ''}${composer.model}` : 'default model'}</option>
            {models.map((entry) => (
              <option key={`${entry.providerId}::${entry.model}`} value={`${entry.providerId}::${entry.model}`}>
                {entry.providerId}/{entry.model}{entry.supportsVision ? ' · vision' : ''}
              </option>
            ))}
          </select>
        </label>

        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} data-testid="composer-upload">
            <Paperclip /> upload
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => folderInputRef.current?.click()} data-testid="composer-upload-folder">
            <UploadCloud /> folder
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => imageInputRef.current?.click()} data-testid="composer-upload-image">
            <ImagePlus /> image
          </Button>
          <Button type="submit" size="sm" disabled={composer.submitting} data-testid="composer-submit">
            <Play />
            {composer.submitting ? 'submitting…' : 'run task'}
          </Button>
        </div>
      </div>

      {composer.attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-1" data-testid="attachment-chips">
          {composer.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-foreground"
              data-testid="attachment-chip"
              data-kind={attachment.kind}
            >
              <span>{attachment.kind}: {attachment.name}</span>
              <span className="text-muted">{formatBytes(attachment.size)}</span>
              <button type="button" aria-label={`remove attachment ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {slashOutput ? (
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface px-2 py-1 text-[11px] text-foreground" data-testid="slash-output">
          {slashOutput}
        </pre>
      ) : null}
      {visionWarning ? (
        <p className="text-[11px] text-warning" data-testid="vision-warning">
          {visionWarning}
        </p>
      ) : null}
      {touched && composer.goal.trim().length === 0 ? (
        <p role="alert" className="text-[11px] text-error">
          a task description is required
        </p>
      ) : null}
      {composer.error ? (
        <p role="alert" className="text-[11px] text-error">
          {composer.error}
        </p>
      ) : null}
    </form>
  )
}

function relativePathOf(file: File): string {
  const withPath = file as File & { webkitRelativePath?: string }
  return withPath.webkitRelativePath && withPath.webkitRelativePath.length > 0 ? withPath.webkitRelativePath : file.name
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`
  return `${Math.round(size / (1024 * 102.4)) / 10} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { Attachment }

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { ImagePlus, Paperclip, Play, Square, UploadCloud, X } from 'lucide-react'
import type { AgentMode, Attachment } from '@daedalus/core'
import { formatSkillOrigin, type SkillOrigin } from '@daedalus/core'
import { AGENT_MODE_ORDER, nextAgentMode } from '@daedalus/core/interaction/modes'
import { SlashCommandRegistry, slashCommandSuggestions, type SlashCommandContext, type SlashCommandResult } from '@daedalus/core/interaction/slash-commands'
import { Button } from '../ui/button'
import { Textarea } from '../ui/input'
import { useDaedalusStore } from '../../state/taskStore'
import { useTaskEvents } from '../../state/hooks'
import { approvalId, fileChanges, latestPlan, parseModelPool, pendingApprovals, pendingQuestions, taskStatus, validation } from '../../state/selectors'
import { api } from '../../api/client'
import type { Conversation, ConversationTurn, ExtensionStatus, WorkspaceFileEntry } from '../../api/types'
import { saveActiveConversationId } from '../../state/prefs'
import { ModelPicker } from './model-picker'
import { SlideComposerControls } from './slide-controls'
import { DokumenComposerControls } from './dokumen-controls'
import { MODE_LABELS, modeCssVar } from '../../theme/theme'

type UploadKind = 'file' | 'folder' | 'image' | 'zip'

/**
 * Task composer (PLAN.md §3.4 + Phase 8.5). The composer owns only drafts and
 * staged attachments; mode/provider/model changes are written through the
 * gateway session so CLI and Web observe the same session state.
 */
export function Composer() {
  const composer = useDaedalusStore((state) => state.composer)
  const domain = useDaedalusStore((state) => state.domain)
  const slideOptions = useDaedalusStore((state) => state.slideOptions)
  const dokumenOptions = useDaedalusStore((state) => state.dokumenOptions)
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
  // Palette state machine: the menus are derived from the draft, so each
  // carries the draft text it was dismissed for — Esc and outside clicks
  // hide the menu WITHOUT touching the draft, and typing (which changes
  // the draft) may open it again.
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [stopping, setStopping] = useState(false)
  // @-mention completion: the caret drives token detection; the workspace
  // file index is fetched once per workspace and filtered client-side.
  const [caret, setCaret] = useState(0)
  const [activeMention, setActiveMention] = useState(0)
  const [dismissedMention, setDismissedMention] = useState<string | null>(null)
  const [fileIndex, setFileIndex] = useState<{ root: string; entries: WorkspaceFileEntry[] }>({ root: '', entries: [] })
  // Explicit skill invocations staged from `/skill <name>` (chips below
  // the composer): the next submit force-loads those skill bodies.
  const [invokedSkills, setInvokedSkills] = useState<string[]>([])
  const [activeSkill, setActiveSkill] = useState(0)
  const [dismissedSkill, setDismissedSkill] = useState<string | null>(null)
  const [skillInventory, setSkillInventory] = useState<{ root: string; skills: ExtensionStatus['skills'] }>({ root: '', skills: [] })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const indexRequestedFor = useRef('')
  const skillIndexRoot = useRef('')
  const registry = useMemo(() => new SlashCommandRegistry(), [])

  useEffect(() => {
    if (!workspaceRoot || indexRequestedFor.current === workspaceRoot) return
    indexRequestedFor.current = workspaceRoot
    let cancelled = false
    void (async () => {
      try {
        const response = await api.files(workspaceRoot)
        if (!cancelled) setFileIndex({ root: workspaceRoot, entries: response.files })
      } catch {
        if (!cancelled) setFileIndex({ root: workspaceRoot, entries: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  // After a mention insertion the controlled textarea re-renders with the
  // new goal; restore the caret to just after the inserted `@path `.
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return
    const position = pendingCaret.current
    pendingCaret.current = null
    const node = textareaRef.current
    if (!node) return
    node.focus()
    node.setSelectionRange(position, position)
    setCaret(position)
  }, [composer.goal])

  // While the selected task is running, the Run button morphs into Stop —
  // the user should never have to hunt for how to halt a run they started.
  const activeStatus = taskStatus(events, pendingApprovals(events).length, pendingQuestions(events).length)
  const activeRunning = Boolean(activeTaskId) && (activeStatus === 'running' || activeStatus === 'awaiting-approval' || activeStatus === 'awaiting-answer')

  useEffect(() => {
    if (!activeRunning) setStopping(false)
  }, [activeRunning, activeTaskId])

  const stopActiveTask = async (): Promise<void> => {
    if (!activeTaskId || stopping) return
    setStopping(true)
    try {
      await api.cancelTask(activeTaskId)
    } catch {
      setStopping(false)
    }
  }

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
  /** The slash palette is open only when it has entries AND wasn't dismissed for this exact draft text. */
  const slashOpen = suggestions.length > 0 && dismissedSlash !== composer.goal

  // The `/skill <name>` completion menu: while the draft is an invocation
  // prefix, offer the workspace's enabled skill names (from the same
  // gateway inventory the Settings panel shows).
  const skillMatch = useMemo(() => activeSkillInvocation(composer.goal), [composer.goal])
  const skillCandidates = useMemo(() => {
    if (!skillMatch || dismissedSkill === composer.goal) return []
    const entries = skillInventory.root === workspaceRoot ? skillInventory.skills : []
    const needle = skillMatch.query.toLowerCase()
    return entries.filter((skill) => !skill.disabled && !skill.shadowedBy && (needle === '' || skill.name.toLowerCase().includes(needle))).slice(0, 12)
  }, [skillMatch, dismissedSkill, composer.goal, skillInventory, workspaceRoot])
  const skillOpen = skillCandidates.length > 0

  // Fetch the skill inventory (once per workspace) when an invocation is
  // being typed, so the menu and the unknown/disabled warnings have data.
  useEffect(() => {
    if (!/^\/skill(\s|$)/.test(composer.goal)) return
    if (!workspaceRoot || skillIndexRoot.current === workspaceRoot) return
    skillIndexRoot.current = workspaceRoot
    let cancelled = false
    void (async () => {
      try {
        const status = await api.extensionsStatus(workspaceRoot)
        if (!cancelled) setSkillInventory({ root: workspaceRoot, skills: status.skills })
      } catch {
        if (!cancelled) setSkillInventory({ root: workspaceRoot, skills: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [composer.goal, workspaceRoot])

  // Clicking outside the composer closes any open menu. The draft text
  // itself is never touched by dismissal — only the menus close.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const form = formRef.current
      if (!form || form.contains(event.target as Node)) return
      const goal = useDaedalusStore.getState().composer.goal
      setDismissedSlash(goal)
      setDismissedSkill(goal)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const mentionToken = useMemo(() => activeMentionToken(composer.goal, caret), [composer.goal, caret])
  const mentionKey = mentionToken ? `${mentionToken.start}:${mentionToken.query}` : null
  const mentionCandidates = useMemo(() => {
    // Only one menu at a time: an open slash palette wins over @ completion.
    if (!mentionToken || mentionKey === dismissedMention || suggestions.length > 0 || skillOpen) return []
    const entries = fileIndex.root === workspaceRoot ? fileIndex.entries : []
    const needle = mentionToken.query.toLowerCase()
    const matches = entries.filter((entry) => entry.path.toLowerCase().includes(needle))
    return rankMentionMatches(matches, needle).slice(0, 50)
  }, [mentionToken, mentionKey, dismissedMention, suggestions.length, skillOpen, fileIndex, workspaceRoot])
  const mentionOpen = mentionToken !== null && mentionCandidates.length > 0

  const insertMention = (entry: WorkspaceFileEntry): void => {
    if (!mentionToken) return
    const inserted = `@${entry.path} `
    const nextGoal = composer.goal.slice(0, mentionToken.start) + inserted + composer.goal.slice(caret)
    pendingCaret.current = mentionToken.start + inserted.length
    setDismissedMention(null)
    setActiveMention(0)
    setComposer({ goal: nextGoal })
  }

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
    // An empty selection is the "default model" entry: clear both halves so
    // the next task really runs on the gateway default.
    if (!model) providerId = ''
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

  /**
   * Why `/skill <name>` cannot be honored right now, or null when it can.
   * Answered from the fetched inventory; when the inventory has not
   * loaded yet the server is the backstop (it 400s with the same words).
   */
  const skillInvocationProblem = (name: string): string | null => {
    if (skillInventory.root !== workspaceRoot) return null
    const winner = skillInventory.skills.find((skill) => skill.name === name && !skill.shadowedBy)
    if (!winner) {
      return `Unknown skill "${name}" — no skill with that name was found in this workspace or the global skill directories. It was not invoked.`
    }
    if (winner.disabled) {
      return `Skill "${name}" is disabled for this workspace (.daedalus/skills.json). Re-enable it in Settings → Extensions to invoke it. It was not invoked.`
    }
    return null
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
      if (!result.result) return 'No validation evidence yet. Validation runs as part of a task; switch to Auto to execute and validate.'
      return result.result.checks.map((check) => `${check.name}: ${check.status} (${check.cmd})`).join('\n')
    },
    upload: () => openUpload('file'),
    image: () => openUpload('image'),
    newTask: () => {
      // /new also ends the chat conversation: the next submit starts a
      // fresh one (the old session stays saved on the server).
      const state = useDaedalusStore.getState()
      state.setConversation(null)
      if (state.workspace.root) saveActiveConversationId(state.workspace.root, null)
      useDaedalusStore.setState({ taskId: null, events: [], report: null, taskAttachments: [] })
      setComposer({ goal: '', attachments: [], error: null })
      return { text: 'New chat started. The next prompt opens a fresh conversation.', action: 'new' }
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
        return status.skills.length ? status.skills.map((skill) => `${skill.name} — ${skill.description || 'skill'}${skill.disabled ? ' [disabled for this workspace]' : ''}`).join('\n') : `No skills found under ${status.root}/.daedalus/skills.`
      } catch (error) {
        return `Skill listing failed: ${errorMessage(error)}`
      }
    },
    invokeSkill: (name) => {
      // `/skill <name>` with no task text yet: stage the invocation as a
      // chip; the next submit force-loads the skill body. (With task text
      // the submit path submits directly and never routes here.)
      const problem = skillInvocationProblem(name)
      if (problem) return { text: problem, action: 'skill' }
      setInvokedSkills((current) => (current.includes(name) ? current : [...current, name]))
      return {
        text: `Skill "${name}" will be force-loaded into the next task — it shows as a chip under the composer. Type the task and send.`,
        action: 'skill',
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
    // Executing a command closes every menu: the draft is cleared and any
    // dismissal markers reset, so the next `/` opens a fresh palette.
    setDismissedSlash(null)
    setDismissedSkill(null)
    setComposer({ goal: '', error: null })
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void submitGoal()
  }

  const submitGoal = async (): Promise<void> => {
    const goal = composer.goal.trim()
    // `/skill <name> <task…>`: an explicit invocation with its task text
    // submits directly, forcing that skill's body into the task context.
    // Unknown/disabled names warn visibly and never submit silently
    // un-skilled; the gateway repeats the check as the backstop.
    const invocation = parseSkillInvocation(goal)
    if (invocation?.task) {
      const problem = skillInvocationProblem(invocation.name)
      if (problem) {
        setSlashOutput(problem)
        setComposer({ error: problem })
        setTouched(true)
        return
      }
      await runTask(invocation.task, [invocation.name, ...invokedSkills.filter((name) => name !== invocation.name)])
      return
    }
    if (goal.startsWith('/')) {
      await executeSlash(goal)
      return
    }
    if (goal.length === 0) {
      setTouched(true)
      return
    }
    // Cline pattern: text submitted while an approval is pending answers
    // the approval itself — declined, with this text delivered to the
    // agent verbatim as the reason — instead of starting a second task.
    // Staged skill invocations are explicit task intent and bypass the
    // decline-note path (the task carries the skills instead).
    const firstPending = pendingApprovals(events)[0]
    if (firstPending && activeTaskId && invokedSkills.length === 0) {
      try {
        await api.decideApproval(activeTaskId, firstPending.approval?.id ?? approvalId(firstPending.key), 'decline', { note: goal })
        setComposer({ goal: '', error: null })
        setSlashOutput(`Declined the pending ${firstPending.key.tool} request and sent your note to the agent.`)
      } catch (error) {
        setComposer({ error: errorMessage(error) })
      }
      return
    }
    await runTask(goal, invokedSkills)
  }

  const runTask = async (taskGoal: string, skillNames: string[]): Promise<void> => {
    const goal = taskGoal
    setComposer({ submitting: true, error: null })
    try {
      const attachmentsForTask = visionWarning ? composer.attachments.filter((attachment) => attachment.kind !== 'image') : composer.attachments
      // A configured pool (settings → model pool) replaces the single-model
      // pick for this task; the provider still selects the connection, and
      // core routes across the pool with the chosen strategy.
      const pool = parseModelPool(composer.modelPool)
      // Plan continuity (Cline-style): when the task on screen produced a
      // plan, the follow-up task carries it — switching to Auto/Manual and
      // sending "jalankan rencananya" executes those steps in this context.
      const planTaskId = activeTaskId && latestPlan(events) && composer.mode !== 'plan' ? activeTaskId : undefined
      // The chat is one continuing conversation: submit into the active
      // one (creating it on first use), so the server records this prompt
      // as a turn and hands the next one the session's memory. If the
      // gateway is unreachable the task still runs, just without a session.
      let activeConversation: Conversation | null = null
      const store = useDaedalusStore.getState()
      if (workspaceRoot) {
        if (store.conversation && store.conversation.root === workspaceRoot) {
          activeConversation = store.conversation
        } else {
          try {
            const fresh = await api.createConversation(workspaceRoot)
            activeConversation = fresh.conversation
            store.setConversation(activeConversation)
            saveActiveConversationId(workspaceRoot, activeConversation.id)
          } catch {
            activeConversation = null
          }
        }
      }
      const created = await api.createTask({
        goal,
        repo_path: workspaceRoot,
        domain,
        auto_approve: composer.autoApprove,
        max_iterations: composer.maxIterations,
        mode: composer.mode,
        thinking: composer.thinking,
        provider_id: composer.providerId || undefined,
        ...(pool.length > 0 ? { models: pool } : { model: composer.model || undefined }),
        ...(pool.length > 1 ? { model_strategy: composer.modelStrategy } : {}),
        attachments: attachmentsForTask,
        ...(skillNames.length ? { skills: skillNames } : {}),
        ...(domain === 'dokumen'
          ? {
              dokumen: {
                sub_mode: dokumenOptions.subMode,
                ...(dokumenOptions.sources.length > 0 ? { sources: dokumenOptions.sources } : {}),
                ...(dokumenOptions.docxPath ? { docx_path: dokumenOptions.docxPath } : {}),
              },
            }
          : {}),
        ...(domain === 'slide'
          ? {
              slide: {
                generation: slideOptions.generation,
                ...(slideOptions.slideCount ? { slide_count: slideOptions.slideCount } : {}),
                ...(slideOptions.language ? { language: slideOptions.language } : {}),
                ...(slideOptions.customTemplateId
                  ? { custom_template_id: slideOptions.customTemplateId }
                  : {
                      ...(slideOptions.designId ? { design_id: slideOptions.designId } : {}),
                      ...(slideOptions.templateId ? { template_id: slideOptions.templateId } : {}),
                    }),
              },
            }
          : {}),
        ...(planTaskId ? { plan_task_id: planTaskId } : {}),
        ...(activeConversation ? { conversation_id: activeConversation.id } : {}),
      })
      setTask(created.id, goal)
      if (activeConversation) {
        // Show the prompt in the session at once (the server recorded the
        // same turn; the fresh copy replaces this optimistic one).
        const optimistic: Conversation = {
          ...activeConversation,
          turns: [
            ...activeConversation.turns,
            { role: 'user', text: goal, task_id: created.id, mode: composer.mode, ts: new Date().toISOString() } satisfies ConversationTurn,
          ],
        }
        store.setConversation(optimistic)
        void api
          .getConversation(workspaceRoot, activeConversation.id)
          .then(({ conversation }) => store.setConversation(conversation))
          .catch(() => undefined)
      }
      setComposer({ submitting: false, goal, attachments: [] })
      setInvokedSkills([])
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
    if (slashOpen) {
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
        // Esc closes the palette and keeps the draft — it must never
        // nuke what the user typed (the old behavior cleared the goal).
        event.preventDefault()
        setDismissedSlash(composer.goal)
        setActiveSuggestion(0)
      }
      return
    }
    if (skillOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveSkill((current) => (current + 1) % skillCandidates.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveSkill((current) => (current - 1 + skillCandidates.length) % skillCandidates.length)
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        const candidate = skillCandidates[activeSkill] ?? skillCandidates[0]
        if (candidate) {
          event.preventDefault()
          setComposer({ goal: `/skill ${candidate.name} ` })
          setActiveSkill(0)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedSkill(composer.goal)
        setActiveSkill(0)
      }
      return
    }
    if (mentionOpen && mentionToken) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveMention((current) => (current + 1) % mentionCandidates.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveMention((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length)
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        const entry = mentionCandidates[activeMention] ?? mentionCandidates[0]
        if (entry) {
          event.preventDefault()
          insertMention(entry)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedMention(mentionKey)
      }
      return
    }
    // With no menu open, Esc dismisses the slash output block (the skills
    // dump and friends) instead of leaving it stuck above the composer.
    if (event.key === 'Escape' && slashOutput) {
      event.preventDefault()
      setSlashOutput(null)
      return
    }
    // Chat convention: Enter sends, Shift+Enter adds a line. With no menu
    // open, Enter takes the exact same path as the run-task button.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submitGoal()
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
    // '' is the combobox's "default model" entry; changeModel clears both
    // provider and model for it.
    void changeModel(value)
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      // relative + z-30: while a task runs the collapse animation leaves a
      // transform/opacity fill on this form, trapping the model picker's
      // dropdown inside the form's stacking context — the panels below
      // then painted over the open model list (Farid's report). Keeping
      // the whole composer above the main grid restores the dropdown.
      className={`relative z-30 flex flex-col gap-2 border-b border-line bg-surface-base px-3 py-2 ${activeTaskId ? 'motion-composer-collapse' : ''}`}
      data-testid="composer"
    >
      <div className="flex flex-wrap items-center gap-2">
        {domain === 'slide' ? (
          <SlideComposerControls />
        ) : domain === 'dokumen' ? (
          <DokumenComposerControls />
        ) : domain === 'spreadsheet' ? (
          <span className="text-[10px] text-muted" data-testid="sheet-composer-note">
            Spreadsheet: blueprint di-stage dulu di Panel Blueprint — tekan Buat untuk membangun. Mode Ask/Manual/Auto/Plan hanya milik Coding.
          </span>
        ) : (
          <>
            <span
              className="inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ borderColor: modeCssVar(composer.mode), color: modeCssVar(composer.mode) }}
              data-testid="mode-badge"
              data-mode={composer.mode}
              title="Shift+Tab cycles Ask → Manual → Auto → Plan"
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
            <span className="text-[10px] text-muted">Shift+Tab switches mode at the next turn boundary · Enter sends · Shift+Enter = new line</span>
          </>
        )}
        <span className="ml-auto text-[10px] text-muted" data-testid="composer-session-summary">
          {providers.length ? `${providers.filter((provider) => provider.enabled).length} providers · ` : ''}
          {models.length ? `${models.length} models` : 'models load from settings'}
        </span>
      </div>

      <Textarea
        ref={textareaRef}
        aria-label="task goal"
        data-testid="composer-input"
        rows={2}
        placeholder={
          domain === 'slide'
            ? 'Describe the deck to build… type /help for slash commands'
            : domain === 'dokumen'
              ? dokumenOptions.subMode === 'ekstrak'
                ? 'Tujuan ekstraksi… misalnya: ekstrak semua invoice bulan ini jadi tabel'
                : dokumenOptions.docxPath
                  ? 'Instruksi tata ulang… misalnya: margin 4-3-3-3, font Times New Roman 12pt, spasi 1.5, heading bernomor'
                  : 'Topik dokumen… misalnya: susun makalah tentang agentic framework untuk tugas kuliah'
            : domain === 'spreadsheet'
              ? 'Jelaskan spreadsheet-nya… sebut nama file .csv/.xlsx di workspace bila datanya dari file, atau minta "audit workbook ini"'
              : 'Describe the coding task… type @ to reference a file or folder, /help for slash commands'
        }
        value={composer.goal}
        onChange={(event) => {
          setComposer({ goal: event.target.value })
          setActiveSuggestion(0)
          setActiveMention(0)
          setActiveSkill(0)
          setCaret(event.target.selectionStart ?? event.target.value.length)
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onComposerKeyDown}
        onPaste={onPaste}
      />

      {mentionOpen ? (
        <div className="flex max-h-48 flex-col gap-0.5 overflow-auto" data-testid="mention-palette" role="listbox" aria-label="workspace files">
          {mentionCandidates.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={index === activeMention}
              data-testid="mention-suggestion"
              data-path={entry.path}
              data-type={entry.type}
              className={`flex items-center gap-2 rounded border px-1.5 py-0.5 text-left text-[11px] ${index === activeMention ? 'border-primary text-primary' : 'border-line text-muted'}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveMention(index)}
              onClick={() => insertMention(entry)}
            >
              <span className="truncate">{entry.path}</span>
              <span className="ml-auto shrink-0 text-[10px] text-muted">{entry.type === 'dir' ? 'folder' : 'file'}</span>
            </button>
          ))}
        </div>
      ) : null}

      {slashOpen ? (
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

      {skillOpen ? (
        <div className="flex max-h-48 flex-col gap-0.5 overflow-auto" data-testid="skill-palette" role="listbox" aria-label="skills">
          {skillCandidates.map((skill, index) => (
            <button
              key={skill.name}
              type="button"
              role="option"
              aria-selected={index === activeSkill}
              data-testid="skill-suggestion"
              data-skill={skill.name}
              className={`flex items-center gap-2 rounded border px-1.5 py-0.5 text-left text-[11px] ${index === activeSkill ? 'border-primary text-primary' : 'border-line text-muted'}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveSkill(index)}
              onClick={() => {
                setComposer({ goal: `/skill ${skill.name} ` })
                setActiveSkill(0)
                textareaRef.current?.focus()
              }}
            >
              <span className="truncate">{skill.name}</span>
              {skill.origin ? <span className="shrink-0 text-[10px] text-muted">{formatSkillOrigin(skill.origin as SkillOrigin)}</span> : null}
              <span className="ml-auto shrink-0 text-[10px] text-muted">force-load on next task</span>
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
          <ModelPicker models={models} providerId={composer.providerId} model={composer.model} onSelect={onModelSelect} />
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
          {activeRunning ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => void stopActiveTask()}
              disabled={stopping}
              data-testid="composer-stop"
              aria-label="stop the running task"
            >
              <Square className="fill-current" />
              {stopping ? 'stopping…' : 'stop'}
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={composer.submitting} data-testid="composer-submit">
              <Play />
              {composer.submitting ? 'submitting…' : 'run task'}
            </Button>
          )}
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

      {invokedSkills.length > 0 ? (
        <ul className="flex flex-wrap gap-1" data-testid="invoked-skill-chips">
          {invokedSkills.map((name) => (
            <li
              key={name}
              className="flex items-center gap-1 rounded border border-primary/50 bg-primary/10 px-1.5 py-0.5 text-[10px] text-foreground"
              data-testid="invoked-skill-chip"
              data-skill={name}
            >
              <span>skill: {name} · invoked by you</span>
              <button
                type="button"
                aria-label={`remove invoked skill ${name}`}
                onClick={() => setInvokedSkills((current) => current.filter((entry) => entry !== name))}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {slashOutput ? (
        <div className="relative" data-testid="slash-output-block">
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-surface px-2 py-1 pr-6 text-[11px] text-foreground" data-testid="slash-output">
            {slashOutput}
          </pre>
          <button
            type="button"
            aria-label="close output"
            title="Close (Esc)"
            data-testid="slash-output-close"
            className="absolute right-1 top-1 rounded border border-line bg-surface px-1 py-0.5 text-[10px] font-semibold text-foreground hover:border-primary"
            onClick={() => setSlashOutput(null)}
          >
            <X className="size-3" />
          </button>
        </div>
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

const MENTION_PATH_CHAR = /[A-Za-z0-9._/-]/

/**
 * A trailing `/skill <partial>` prefix still being typed (no task text
 * yet): the partial name filters the skill completion menu. `/skills`
 * does not match — that is the listing command, not an invocation.
 */
function activeSkillInvocation(goal: string): { query: string } | null {
  if (goal.includes('\n')) return null
  const match = /^\/skill\s+(\S*)$/.exec(goal)
  return match ? { query: match[1] ?? '' } : null
}

/**
 * A complete `/skill <name> [task…]` draft. With task text it submits as
 * a task (task = the rest); without it, the registry stages the skill.
 */
function parseSkillInvocation(goal: string): { name: string; task: string } | null {
  const match = /^\/skill\s+(\S+)(?:\s+([\s\S]+))?$/.exec(goal.trim())
  if (!match?.[1]) return null
  return { name: match[1], task: (match[2] ?? '').trim() }
}

/**
 * The @-token the caret is currently inside, if any. Mirrors core's
 * extraction rule (mentions.ts): `@` at the start of the text or right after
 * whitespace, followed by path characters — `foo@bar` is not a mention.
 * Returns the index of the `@` and the partial path typed so far.
 */
/**
 * Order @-mention matches for the palette. An empty query means "show me
 * the workspace": root-level entries first, then deeper ones (the flat
 * index is alphabetical, so without this the first screenful is one
 * subtree — cli/, cli/assets, cli/src… — and the rest of the root looks
 * missing). With a query, names starting with it win; path order breaks
 * ties so keyboard navigation stays predictable.
 */
export function rankMentionMatches(entries: WorkspaceFileEntry[], needle: string): WorkspaceFileEntry[] {
  const depth = (path: string): number => path.split('/').length
  const basename = (path: string): string => path.split('/').at(-1)?.toLowerCase() ?? ''
  return [...entries].sort((a, b) => {
    if (needle.length === 0) return depth(a.path) - depth(b.path) || a.path.localeCompare(b.path)
    const boost = (entry: WorkspaceFileEntry): number => (basename(entry.path).startsWith(needle) ? 0 : 1)
    return boost(a) - boost(b) || a.path.localeCompare(b.path)
  })
}

function activeMentionToken(goal: string, caret: number): { start: number; query: string } | null {
  if (caret <= 0 || caret > goal.length) return null
  let start = caret - 1
  while (start >= 0 && MENTION_PATH_CHAR.test(goal[start]!)) start -= 1
  if (goal[start] !== '@') return null
  if (start !== 0 && !/\s/.test(goal[start - 1]!)) return null
  return { start, query: goal.slice(start + 1, caret) }
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
